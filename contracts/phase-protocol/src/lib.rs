#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Bytes,
    BytesN, Env, Map, String, Symbol, Vec,
};

mod economy;

/// Errores del protocolo PHASE
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum PhaseError {
    AlreadyPhased = 1,
    InsufficientBalance = 2,
    TransferFailed = 3,
    UnauthorizedToken = 4,
    SettlementFailed = 5,
    InvalidInvoice = 6,
    InvalidCollection = 7,
    CreatorAlreadyHasCollection = 8,
    AmountBelowCollectionPrice = 9,
    InvalidCollectionMetadata = 10,
    NftNotFound = 11,
    NotNftOwner = 12,
    SelfTransfer = 13,
    /// SEP-50: `approve` / `transfer_from` sin permiso de operador o allowance.
    UnauthorizedApprover = 14,
    NotApproved = 15,
    InvalidApproval = 16,
    /// Lista enumerable del dueño desincronizada (solo debería ocurrir con WASM antiguo sin `OwnerTokenList`).
    InvalidOwnerTokenList = 17,
    // Spikes 694/697/698/699 (see src/economy.rs). Appended only; never renumber.
    CoinAlreadyRegistered = 18,
    CoinNotRegistered = 19,
    CoinNotVerified = 20,
    RewardAlreadyClaimed = 21,
    InvalidSplit = 22,
    TipBelowMinimum = 23,
    SelfDeal = 24,
    TipReplay = 25,
    EndowmentNotFound = 26,
    NothingToClaim = 27,
    EndowmentLocked = 28,
    EndowmentClosed = 29,
    DisputeOpen = 30,
    BondNotFound = 31,
    BondNotActive = 32,
    BondChallengeOpen = 33,
    BondLocked = 34,
    NotAuthorized = 35,
    InvalidAmount = 36,
    BondAlreadyPosted = 37,
    NoOpenChallenge = 38,
    InvalidSchedule = 39,
}

/// Configuración de una colección creada por un usuario (factory).
#[contracttype]
pub struct CollectionSettings {
    pub collection_id: u64,
    pub creator: Address,
    pub name: String,
    /// Precio en unidades mínimas del token LIQ (x402)
    pub price: i128,
    /// URL de arte (IPFS/https) expuesta vía `/api/metadata/[id]` y wallets; sin `"` ni `\` (ASCII imprimible ≥32).
    pub image_uri: String,
}

/// Estado PHASE — NFT por (usuario, colección).
#[contracttype]
pub struct PhaseState {
    pub token_id: u64,
    pub collection_id: u64,
    pub timestamp: u64,
    pub amount_locked: i128,
    pub token_address: Address,
    pub energy_level_bp: u32,
    pub phase_level: String,
}

#[contracttype]
pub struct PaymentRecord {
    pub invoice_id: u32,
    pub amount: i128,
    pub token: Address,
    pub payer: Address,
    pub settled: bool,
    pub timestamp: u64,
}

/// 95% creador, 5% tesorería protocolo (basis points implícitos 9500/500).
const FEE_CREATOR_BP: i128 = 95;
const FEE_DENOM: i128 = 100;

#[contracttype]
pub enum DataKey {
    PhaseCounter,
    /// Fase por usuario y colección (`0` = legado / pool global del protocolo).
    UserPhase(Address, u64),
    TokenOwner(u64),
    /// token_id → collection_id (para metadatos / consultas)
    TokenCollection(u64),
    AuthorizedToken,
    RequiredAmount,
    X402Payment(u32),
    X402InvoiceCounter,
    DelegatedAuth(Address, u64),
    CollectionCounter,
    Collection(u64),
    CreatorToCollection(Address),
    /// Lista ordenada de todos los collection_id creados por esta dirección (multi-colección).
    CreatorCollectionList(Address),
    ProtocolTreasury,
    /// Recuento de NFTs de utilidad por titular (SEP-41 / Freighter); mantenido en mint y transfer.
    Balance(Address),
    /// SEP-50 `approve`: un solo `approved` por `token_id` (revocado al transferir).
    NftApproval(u64),
    /// SEP-50 `approve_for_all`: `operator` puede actuar hasta ledger (0 = revocado).
    OperatorForAll(Address, Address),
    /// Orden estable de `token_id` por titular (enumeración estilo ERC-721 `tokenOfOwnerByIndex`).
    OwnerTokenList(Address),
    /// Rifa commit-reveal por colección (una por `collection_id`).
    Raffle(u64),
    /// Participantes en orden de entrada.
    RaffleEntrants(u64),
    /// Estado de la entrada: 1 = inscrito, 2 = reclamado (mint), 3 = reembolsado.
    RaffleEntry(u64, Address),
    /// Ranking publicado tras el sorteo: `[0, slots)` ganadores, `[slots, 2*slots)` suplentes.
    RaffleRanking(u64),
    /// Spike 574 (phase-182): pool leg declarado por el admin. Solo configuración:
    /// el ruteo real es un path payment clásico firmado por la tesorería, porque
    /// Soroban no puede emitir operaciones del DEX clásico.
    PoolLegConfig,
}

/// Configuración del pool leg (PHASELQ/XLM clásico o router Soroswap).
#[contracttype]
#[derive(Clone)]
pub struct PoolLegConfig {
    pub enabled: bool,
    /// `classic` o `soroswap` — Symbol para mantener el ABI pequeño.
    pub venue: Symbol,
    /// Pool id (32 bytes) en classic; router contract id en Soroswap.
    pub pool_id: BytesN<32>,
    pub asset_code: Symbol,
    pub asset_issuer: Address,
}

pub const RAFFLE_STATUS_OPEN: u32 = 0;
pub const RAFFLE_STATUS_DRAWN: u32 = 1;
pub const RAFFLE_STATUS_ABORTED: u32 = 2;

const RAFFLE_ENTRY_ENTERED: u32 = 1;
const RAFFLE_ENTRY_CLAIMED: u32 = 2;
const RAFFLE_ENTRY_REFUNDED: u32 = 3;

/// Límites para mantener `reveal_and_draw` dentro del presupuesto de CPU de Soroban.
pub const RAFFLE_MAX_ENTRIES: u32 = 200;
pub const RAFFLE_MAX_SLOTS: u32 = 20;

/// Sorteo justo commit-reveal:
/// `draw_seed = sha256(seed || entry_digest || beacon)`,
/// `entry_digest_{i+1} = sha256(entry_digest_i || strkey(entrant_i))` (inicial = 32 bytes cero),
/// `score(w) = sha256(draw_seed || strkey(w))`; ranking ascendente por `(score, índice de entrada)`.
/// Debe coincidir byte a byte con `computeRaffleRanking` en `lib/phase-protocol.ts`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Raffle {
    pub collection_id: u64,
    pub creator: Address,
    pub commit: BytesN<32>,
    pub slots: u32,
    /// Escrow por entrada (precio de la colección al abrir).
    pub price: i128,
    /// Último ledger que acepta entradas.
    pub close_ledger: u32,
    /// Último ledger en que el creador puede revelar; después, reembolso total.
    pub reveal_deadline: u32,
    /// Ledgers de ventana de reclamo para ganadores (y otra igual para suplentes).
    pub claim_window: u32,
    pub status: u32,
    pub entry_count: u32,
    pub entry_digest: BytesN<32>,
    pub seed: BytesN<32>,
    /// PRNG de red en el ledger de revelado (no predecible al enviar la tx).
    pub beacon: BytesN<32>,
    pub draw_seed: BytesN<32>,
    pub drawn_ledger: u32,
    pub primary_claimed: u32,
}

/// SEP-50: permiso puntual para `transfer_from`.
#[contracttype]
pub struct NftSingleApproval {
    pub approved: Address,
    pub live_until_ledger: u32,
}

#[contracttype]
pub struct X402PaymentRequirement {
    pub token: Address,
    pub amount: i128,
    pub invoice: u32,
    pub facilitator: Address,
}

const ENERGY_BP_PER_SETTLE: u32 = 500;
const ENERGY_BP_MAX: u32 = 10000;

fn str_is_safe_for_json_fragment(s: &String, max_len: u32) -> bool {
    let n = s.len();
    if n > max_len {
        return false;
    }
    if n == 0 {
        return true;
    }
    let nl = n as usize;
    let mut buf = [0u8; 256];
    if nl > buf.len() {
        return false;
    }
    s.copy_into_slice(&mut buf[..nl]);
    for &b in &buf[..nl] {
        if b == b'"' || b == b'\\' || b < 32 {
            return false;
        }
    }
    true
}

/// Base HTTPS donde la app sirve JSON Freighter/SEP (`GET …/api/metadata/{token_id}`).
/// Debe terminar en `/`. Por defecto producción; para ngrok / preview:
/// `PHASE_METADATA_BASE_URL=https://tu-tunel.ngrok-free.app/api/metadata/ cargo build ...`
const DEFAULT_METADATA_BASE_URL: &[u8] = match option_env!("PHASE_METADATA_BASE_URL") {
    Some(url) => url.as_bytes(),
    None => b"https://www.phasee.xyz/api/metadata/",
};

fn u64_to_dec_string(env: &Env, mut n: u64) -> String {
    if n == 0 {
        return String::from_str(env, "0");
    }
    let mut rev = [0u8; 20];
    let mut i = 0usize;
    while n > 0 && i < rev.len() {
        rev[i] = b'0' + (n % 10) as u8;
        n /= 10;
        i += 1;
    }
    let mut out = [0u8; 20];
    for j in 0..i {
        out[j] = rev[i - 1 - j];
    }
    String::from_bytes(env, &out[..i])
}

/// URI del JSON de metadata. Incluye `?c=<contract_id>` para que `/api/metadata/{id}` resuelva
/// el mismo contrato que Freighter aunque el despliegue no coincida con el default del servidor.
fn build_metadata_token_uri(env: &Env, token_id: u64) -> String {
    let mut b = Bytes::from_slice(env, DEFAULT_METADATA_BASE_URL);
    let suf = u64_to_dec_string(env, token_id);
    append_soroban_str_to_bytes(&mut b, &suf);
    append_literal_to_bytes(&mut b, b"?c=");
    let cid = env.current_contract_address().to_string();
    append_soroban_str_to_bytes(&mut b, &cid);
    let bl = b.len() as usize;
    const URI_CAP: usize = 256;
    let mut out = [0u8; URI_CAP];
    if bl > out.len() {
        return String::from_str(env, "");
    }
    b.copy_into_slice(&mut out[..bl]);
    String::from_bytes(env, &out[..bl])
}

fn append_soroban_str_to_bytes(acc: &mut Bytes, s: &String) {
    let n = s.len() as usize;
    if n == 0 {
        return;
    }
    let mut buf = [0u8; 256];
    if n > buf.len() {
        return;
    }
    s.copy_into_slice(&mut buf[..n]);
    acc.extend_from_slice(&buf[..n]);
}

fn append_literal_to_bytes(acc: &mut Bytes, lit: &[u8]) {
    acc.extend_from_slice(lit);
}

fn adjust_nft_balance_count(env: &Env, account: Address, delta: i128) {
    let key = DataKey::Balance(account);
    let cur: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    let next = cur.saturating_add(delta);
    if next <= 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &next);
    }
}

fn owner_tokens_push(env: &Env, owner: Address, token_id: u64) {
    let key = DataKey::OwnerTokenList(owner.clone());
    let mut v: Vec<u64> = match env.storage().persistent().get(&key) {
        Some(x) => x,
        None => Vec::new(env),
    };
    v.push_back(token_id);
    env.storage().persistent().set(&key, &v);
}

fn owner_tokens_remove(env: &Env, owner: Address, token_id: u64) -> Result<(), PhaseError> {
    let key = DataKey::OwnerTokenList(owner);
    let mut v: Vec<u64> = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(PhaseError::InvalidOwnerTokenList)?;
    let len = v.len();
    if len == 0 {
        return Err(PhaseError::InvalidOwnerTokenList);
    }
    let mut pos: u32 = 0;
    let mut found: Option<u32> = None;
    while pos < len {
        if v.get(pos).ok_or(PhaseError::InvalidOwnerTokenList)? == token_id {
            found = Some(pos);
            break;
        }
        pos += 1;
    }
    let idx = found.ok_or(PhaseError::InvalidOwnerTokenList)?;
    let last = len - 1;
    if idx == last {
        v.pop_back();
    } else {
        let last_tok = v.get(last).ok_or(PhaseError::InvalidOwnerTokenList)?;
        v.set(idx, last_tok);
        v.pop_back();
    }
    if v.is_empty() {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &v);
    }
    Ok(())
}

/// Escribe estado + propiedad de un NFT recién emitido; los eventos los publica cada llamador.
fn write_minted_phase(
    env: &Env,
    user: &Address,
    collection_id: u64,
    amount: i128,
    token_address: &Address,
) -> u64 {
    let counter: u64 = env
        .storage()
        .persistent()
        .get(&DataKey::PhaseCounter)
        .unwrap_or(0);
    let new_id = counter + 1;
    let phase_state = PhaseState {
        token_id: new_id,
        collection_id,
        timestamp: env.ledger().timestamp(),
        amount_locked: amount,
        token_address: token_address.clone(),
        energy_level_bp: ENERGY_BP_MAX,
        phase_level: String::from_str(env, "SOLID"),
    };
    env.storage()
        .persistent()
        .set(&DataKey::UserPhase(user.clone(), collection_id), &phase_state);
    env.storage().persistent().set(&DataKey::TokenOwner(new_id), user);
    env.storage()
        .persistent()
        .set(&DataKey::TokenCollection(new_id), &collection_id);
    env.storage().persistent().set(&DataKey::PhaseCounter, &new_id);
    adjust_nft_balance_count(env, user.clone(), 1);
    owner_tokens_push(env, user.clone(), new_id);
    new_id
}

/// Codificación canónica de una dirección para el sorteo: strkey ASCII (56 bytes, `G…` / `C…`).
fn address_strkey_bytes(env: &Env, addr: &Address) -> Bytes {
    let s = addr.to_string();
    let n = s.len() as usize;
    let mut buf = [0u8; 64];
    s.copy_into_slice(&mut buf[..n]);
    Bytes::from_slice(env, &buf[..n])
}

fn sha256_concat(env: &Env, prefix: &BytesN<32>, tail: &Bytes) -> BytesN<32> {
    let mut b = Bytes::from_array(env, &prefix.to_array());
    b.append(tail);
    env.crypto().sha256(&b).to_bytes()
}

/// Top `min(N, 2*slots)` por `(score, índice)` ascendente; selección parcial O(k·N).
fn compute_raffle_ranking(env: &Env, draw_seed: &BytesN<32>, entrants: &Vec<Address>, slots: u32) -> Vec<Address> {
    let n = entrants.len();
    let mut scores: Vec<BytesN<32>> = Vec::new(env);
    for e in entrants.iter() {
        scores.push_back(sha256_concat(env, draw_seed, &address_strkey_bytes(env, &e)));
    }
    let take = n.min(slots.saturating_mul(2));
    let mut chosen = [false; RAFFLE_MAX_ENTRIES as usize];
    let mut out: Vec<Address> = Vec::new(env);
    for _ in 0..take {
        let mut best: Option<(u32, BytesN<32>)> = None;
        for i in 0..n {
            if chosen[i as usize] {
                continue;
            }
            let s = scores.get_unchecked(i);
            let better = match &best {
                None => true,
                Some((_, bs)) => s < *bs,
            };
            if better {
                best = Some((i, s));
            }
        }
        if let Some((i, _)) = best {
            chosen[i as usize] = true;
            out.push_back(entrants.get_unchecked(i));
        }
    }
    out
}

fn load_raffle(env: &Env, collection_id: u64) -> Result<Raffle, PhaseError> {
    env.storage()
        .persistent()
        .get(&DataKey::Raffle(collection_id))
        .ok_or(PhaseError::RaffleNotFound)
}

/// Mientras la rifa esté abierta o dentro de sus ventanas de reclamo, solo se emite vía `claim_raffle_mint`.
fn raffle_gates_direct_mint(env: &Env, collection_id: u64) -> bool {
    let r: Raffle = match env.storage().persistent().get(&DataKey::Raffle(collection_id)) {
        Some(r) => r,
        None => return false,
    };
    match r.status {
        RAFFLE_STATUS_OPEN => current_ledger(env) <= r.reveal_deadline,
        RAFFLE_STATUS_DRAWN => {
            current_ledger(env) <= r.drawn_ledger.saturating_add(r.claim_window.saturating_mul(2))
        }
        _ => false,
    }
}

fn raffle_rank(env: &Env, collection_id: u64, who: &Address) -> Option<u32> {
    let ranking: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::RaffleRanking(collection_id))?;
    ranking.first_index_of(who)
}

/// Convierte `Bytes` acumulados a `String` acotada (límite típico metadatos JSON).
fn bytes_to_bounded_string(env: &Env, b: &Bytes, max: usize) -> String {
    let n = b.len() as usize;
    if n == 0 {
        return String::from_str(env, "");
    }
    let take = n.min(max).min(256);
    let mut buf = [0u8; 256];
    b.copy_into_slice(&mut buf[..take]);
    String::from_bytes(env, &buf[..take])
}

/// `name` alineado con [lib/phase-nft-metadata-build.ts] (colección > 0 + nombre o "Phase").
fn build_token_display_name(env: &Env, token_id: u64) -> String {
    let col_id_opt: Option<u64> = env.storage().persistent().get(&DataKey::TokenCollection(token_id));
    let mut acc = Bytes::from_slice(env, b"");
    match col_id_opt {
        Some(cid) if cid > 0 => {
            let coll_name: String =
                if let Some(settings) = env
                    .storage()
                    .persistent()
                    .get::<DataKey, CollectionSettings>(&DataKey::Collection(cid))
                {
                    if settings.name.len() > 0 {
                        settings.name
                    } else {
                        String::from_str(env, "Phase")
                    }
                } else {
                    String::from_str(env, "Phase")
                };
            append_soroban_str_to_bytes(&mut acc, &coll_name);
            append_literal_to_bytes(&mut acc, b" Artifact #");
        }
        _ => {
            append_literal_to_bytes(&mut acc, b"Phase Artifact #");
        }
    }
    let suf = u64_to_dec_string(env, token_id);
    append_soroban_str_to_bytes(&mut acc, &suf);
    bytes_to_bounded_string(env, &acc, 256)
}

/// `description` alineado con el JSON off-chain (nivel PHASE opcional).
fn build_metadata_description_string(env: &Env, phase_level: Option<String>) -> String {
    let base = String::from_str(env, "Forged on Soroban via x402 AI Protocol");
    match phase_level {
        Some(pl) if pl.len() > 0 => {
            let mut acc = Bytes::from_slice(env, b"");
            append_soroban_str_to_bytes(&mut acc, &base);
            append_literal_to_bytes(&mut acc, b" \xC2\xB7 PHASE level ");
            append_soroban_str_to_bytes(&mut acc, &pl);
            bytes_to_bounded_string(env, &acc, 512)
        }
        _ => base,
    }
}

/// `image`: solo URI on-chain de la colección (sin resolver OG/site; el GET `/api/metadata` puede enriquecer).
fn build_token_image_raw_string(env: &Env, token_id: u64) -> String {
    let col_id_opt: Option<u64> = env.storage().persistent().get(&DataKey::TokenCollection(token_id));
    match col_id_opt {
        Some(cid) if cid > 0 => {
            if let Some(settings) = env
                .storage()
                .persistent()
                .get::<DataKey, CollectionSettings>(&DataKey::Collection(cid))
            {
                settings.image_uri
            } else {
                String::from_str(env, "")
            }
        }
        _ => String::from_str(env, ""),
    }
}

/// Convierte `ipfs://<cid>` → `https://ipfs.io/ipfs/<cid>`.
/// Deja URLs HTTPS y strings vacíos sin cambios.
fn resolve_image_to_https(env: &Env, raw: &String) -> String {
    const IPFS_PREFIX: &[u8] = b"ipfs://";
    const HTTPS_GATEWAY: &[u8] = b"https://ipfs.io/ipfs/";

    let n = raw.len() as usize;
    if n == 0 {
        return raw.clone();
    }
    let mut buf = [0u8; 512];
    if n > buf.len() {
        return raw.clone();
    }
    raw.copy_into_slice(&mut buf[..n]);

    if n > IPFS_PREFIX.len() && &buf[..IPFS_PREFIX.len()] == IPFS_PREFIX {
        let cid_bytes = &buf[IPFS_PREFIX.len()..n];
        let mut out = Bytes::from_slice(env, HTTPS_GATEWAY);
        out.extend_from_slice(cid_bytes);
        let out_len = out.len() as usize;
        let mut out_buf = [0u8; 512];
        if out_len > out_buf.len() {
            return raw.clone();
        }
        out.copy_into_slice(&mut out_buf[..out_len]);
        String::from_bytes(env, &out_buf[..out_len])
    } else {
        raw.clone()
    }
}

/// SEP-50: construye propiedades del NFT como JSON string.
/// Incluye: collection, token_id, phase_level, rarity, created_at.
fn build_metadata_properties(env: &Env, token_id: u64, phase_level: Option<String>) -> String {
    let mut props = Bytes::from_slice(env, b"{");
    append_literal_to_bytes(&mut props, b"\"token_id\":");
    let id_str = u64_to_dec_string(env, token_id);
    append_soroban_str_to_bytes(&mut props, &id_str);

    if let Some(level) = phase_level {
        if level.len() > 0 {
            append_literal_to_bytes(&mut props, b",\"phase_level\":\"");
            append_soroban_str_to_bytes(&mut props, &level);
            append_literal_to_bytes(&mut props, b"\"");
        }
    }

    let col_id_opt: Option<u64> = env.storage().persistent().get(&DataKey::TokenCollection(token_id));
    if let Some(cid) = col_id_opt {
        if cid > 0 {
            append_literal_to_bytes(&mut props, b",\"collection_id\":");
            let cid_str = u64_to_dec_string(env, cid);
            append_soroban_str_to_bytes(&mut props, &cid_str);
        }
    }

    append_literal_to_bytes(&mut props, b"}");
    bytes_to_bounded_string(env, &props, 512)
}

/// Eventos alineados con OpenZeppelin / borrador SEP-50 para indexadores y wallets que lean por eventos.
/// SEP-50 mint event: topics=["mint", recipient], data=token_id (u64)
fn emit_indexer_mint(env: &Env, to: Address, token_id: u64) {
    env.events().publish((symbol_short!("mint"), to), token_id);
}

/// SEP-50 transfer event: topics=["transfer", from, to], data=token_id (u64)
fn emit_indexer_transfer(env: &Env, from: Address, to: Address, token_id: u64) {
    env.events().publish((symbol_short!("transfer"), from, to), token_id);
}

fn current_ledger(env: &Env) -> u32 {
    env.ledger().sequence()
}

fn is_approval_live(live_until: u32, env: &Env) -> bool {
    live_until > 0 && live_until >= current_ledger(env)
}

fn get_approved_valid(env: &Env, token_id: u64) -> Option<Address> {
    let a: NftSingleApproval = env.storage().persistent().get(&DataKey::NftApproval(token_id))?;
    if is_approval_live(a.live_until_ledger, env) {
        Some(a.approved)
    } else {
        None
    }
}

fn is_approved_for_all_valid(env: &Env, owner: Address, operator: Address) -> bool {
    let until: u32 = match env
        .storage()
        .persistent()
        .get(&DataKey::OperatorForAll(owner.clone(), operator.clone()))
    {
        Some(u) => u,
        None => return false,
    };
    until > 0 && until >= current_ledger(env)
}

/// SEP-50 approve event: topics=["approve", owner, token_id], data=(approved, live_until_ledger)
fn emit_sep_approve(env: &Env, owner: Address, token_id: u64, approved: Address, live_until: u32) {
    env.events().publish(
        (Symbol::new(env, "approve"), owner, token_id),
        (approved, live_until),
    );
}

fn emit_sep_approve_for_all(env: &Env, owner: Address, operator: Address, live_until: u32) {
    env.events().publish(
        (Symbol::new(env, "approve_for_all"), owner),
        (operator, live_until),
    );
}

#[contract]
pub struct PhaseProtocol;

#[contractimpl]
impl PhaseProtocol {
    /// `protocol_treasury` recibe el 5% de cada settle en colecciones con creador (collection_id > 0).
    pub fn initialize(env: Env, admin: Address, token_address: Address, required_amount: i128, protocol_treasury: Address) {
        admin.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::AuthorizedToken, &token_address);

        env.storage()
            .persistent()
            .set(&DataKey::RequiredAmount, &required_amount);

        env.storage().persistent().set(&DataKey::PhaseCounter, &0u64);

        env.storage()
            .persistent()
            .set(&DataKey::X402InvoiceCounter, &0u32);

        env.storage().persistent().set(&DataKey::CollectionCounter, &0u64);

        env.storage()
            .persistent()
            .set(&DataKey::ProtocolTreasury, &protocol_treasury);

        env.events().publish(
            (Symbol::new(&env, "initialized"), admin.clone()),
            (token_address, required_amount),
        );

        // Store admin for in-place WASM upgrades.
        env.storage().instance().set(&symbol_short!("Admin"), &admin);
    }

    /// Replace the contract WASM in-place (preserves all storage). Only callable by the
    /// admin address stored during `initialize`.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("Admin"))
            .expect("Admin not set — call initialize first");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Creador registra una colección. Una misma dirección puede tener múltiples colecciones.
    /// Devuelve `collection_id` para `/chamber?collection=ID`.
    pub fn create_collection(
        env: Env,
        creator: Address,
        name: String,
        price: i128,
        image_uri: String,
    ) -> Result<u64, PhaseError> {
        creator.require_auth();

        if price <= 0 {
            return Err(PhaseError::AmountBelowCollectionPrice);
        }

        if !str_is_safe_for_json_fragment(&name, 64) || !str_is_safe_for_json_fragment(&image_uri, 256) {
            return Err(PhaseError::InvalidCollectionMetadata);
        }

        let mut c: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::CollectionCounter)
            .unwrap_or(0);
        c = c.saturating_add(1);

        let settings = CollectionSettings {
            collection_id: c,
            creator: creator.clone(),
            name,
            price,
            image_uri,
        };

        env.storage().persistent().set(&DataKey::Collection(c), &settings);
        env.storage()
            .persistent()
            .set(&DataKey::CollectionCounter, &c);

        // Append to the per-creator list, migrating any pre-existing single-id entry.
        let list_key = DataKey::CreatorCollectionList(creator.clone());
        let mut list: Vec<u64> = env
            .storage()
            .persistent()
            .get(&list_key)
            .unwrap_or_else(|| Vec::new(&env));

        if list.is_empty() {
            // Migrate legacy single-entry from old DataKey::CreatorToCollection if present.
            if let Some(old_id) = env
                .storage()
                .persistent()
                .get::<DataKey, u64>(&DataKey::CreatorToCollection(creator.clone()))
            {
                list.push_back(old_id);
            }
        }

        list.push_back(c);
        env.storage().persistent().set(&list_key, &list);

        env.events().publish(
            (Symbol::new(&env, "collection_created"), creator),
            (c, settings.price),
        );

        Ok(c)
    }

    pub fn get_collection(env: Env, collection_id: u64) -> Option<CollectionSettings> {
        if collection_id == 0 {
            return None;
        }
        env.storage().persistent().get(&DataKey::Collection(collection_id))
    }

    /// Devuelve el primer collection_id del creador (backward compat).
    /// Usa `get_creator_collection_ids` para obtener todos.
    pub fn get_creator_collection_id(env: Env, creator: Address) -> Option<u64> {
        // Prefer the new multi-collection list.
        if let Some(list) = env
            .storage()
            .persistent()
            .get::<DataKey, Vec<u64>>(&DataKey::CreatorCollectionList(creator.clone()))
        {
            return list.first();
        }
        // Fall back to legacy single-entry key.
        env.storage()
            .persistent()
            .get(&DataKey::CreatorToCollection(creator))
    }

    /// Devuelve todos los collection_id del creador (puede ser múltiples).
    pub fn get_creator_collection_ids(env: Env, creator: Address) -> Vec<u64> {
        if let Some(list) = env
            .storage()
            .persistent()
            .get::<DataKey, Vec<u64>>(&DataKey::CreatorCollectionList(creator.clone()))
        {
            return list;
        }
        // Fall back: wrap legacy single-entry if present.
        let mut v: Vec<u64> = Vec::new(&env);
        if let Some(old_id) = env
            .storage()
            .persistent()
            .get::<DataKey, u64>(&DataKey::CreatorToCollection(creator))
        {
            v.push_back(old_id);
        }
        v
    }

    pub fn get_total_collections(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::CollectionCounter)
            .unwrap_or(0)
    }

    fn required_for_collection(env: &Env, collection_id: u64) -> Result<i128, PhaseError> {
        if collection_id == 0 {
            Ok(env
                .storage()
                .persistent()
                .get(&DataKey::RequiredAmount)
                .expect("Required amount not set"))
        } else {
            let s: CollectionSettings = env
                .storage()
                .persistent()
                .get(&DataKey::Collection(collection_id))
                .ok_or(PhaseError::InvalidCollection)?;
            Ok(s.price)
        }
    }

    pub fn initiate_phase(
        env: Env,
        user: Address,
        token_address: Address,
        collection_id: u64,
    ) -> Result<u64, PhaseError> {
        user.require_auth();

        let user_phase_key = DataKey::UserPhase(user.clone(), collection_id);
        if env.storage().persistent().has(&user_phase_key) {
            return Err(PhaseError::AlreadyPhased);
        }
        if raffle_gates_direct_mint(&env, collection_id) {
            return Err(PhaseError::RaffleMintGated);
        }

        let authorized_token: Address = env
            .storage()
            .persistent()
            .get(&DataKey::AuthorizedToken)
            .expect("Contract not initialized");

        if token_address != authorized_token {
            return Err(PhaseError::UnauthorizedToken);
        }

        let required_amount = Self::required_for_collection(&env, collection_id)?;

        let token_client = token::Client::new(&env, &token_address);
        let user_balance = token_client.balance(&user);

        if user_balance < required_amount {
            return Err(PhaseError::InsufficientBalance);
        }

        let contract_address = env.current_contract_address();
        token_client.transfer(&user, &contract_address, &required_amount);

        let new_id = write_minted_phase(&env, &user, collection_id, required_amount, &token_address);

        env.events().publish(
            (Symbol::new(&env, "phase_initiated"), user.clone()),
            (new_id, required_amount),
        );
        env.events().publish(
            (Symbol::new(&env, "phase_nft_minted"), user.clone()),
            (new_id, required_amount),
        );
        emit_indexer_mint(&env, user, new_id);

        Ok(new_id)
    }

    /// x402 settle. `collection_id == 0`: legado, fondos en contrato. `collection_id > 0`: 95% creador, 5% tesorería PHASE.
    pub fn settle(
        env: Env,
        user: Address,
        token_address: Address,
        amount: i128,
        invoice_id: u32,
        collection_id: u64,
    ) -> Result<bool, PhaseError> {
        let authorized_token: Address = env
            .storage()
            .persistent()
            .get(&DataKey::AuthorizedToken)
            .expect("Contract not initialized");

        if token_address != authorized_token {
            return Err(PhaseError::UnauthorizedToken);
        }

        let payment_key = DataKey::X402Payment(invoice_id);
        if env.storage().persistent().has(&payment_key) {
            let existing: PaymentRecord = env.storage().persistent().get(&payment_key).unwrap();
            if existing.settled {
                return Err(PhaseError::SettlementFailed);
            }
        }

        user.require_auth();

        if !env
            .storage()
            .persistent()
            .has(&DataKey::UserPhase(user.clone(), collection_id))
            && raffle_gates_direct_mint(&env, collection_id)
        {
            return Err(PhaseError::RaffleMintGated);
        }

        let min_price = Self::required_for_collection(&env, collection_id)?;
        if amount < min_price {
            return Err(PhaseError::AmountBelowCollectionPrice);
        }

        let token_client = token::Client::new(&env, &token_address);
        let user_balance = token_client.balance(&user);

        if user_balance < amount {
            return Err(PhaseError::InsufficientBalance);
        }

        let contract_address = env.current_contract_address();
        token_client.transfer(&user, &contract_address, &amount);

        if collection_id > 0 {
            let settings: CollectionSettings = env
                .storage()
                .persistent()
                .get(&DataKey::Collection(collection_id))
                .ok_or(PhaseError::InvalidCollection)?;

            let treasury: Address = env
                .storage()
                .persistent()
                .get(&DataKey::ProtocolTreasury)
                .expect("Treasury not set");

            let creator_share = amount * FEE_CREATOR_BP / FEE_DENOM;
            let protocol_share = amount.saturating_sub(creator_share);

            if creator_share > 0 {
                token_client.transfer(&contract_address, &settings.creator, &creator_share);
            }
            if protocol_share > 0 {
                token_client.transfer(&contract_address, &treasury, &protocol_share);
            }
        }

        let payment_record = PaymentRecord {
            invoice_id,
            amount,
            token: token_address.clone(),
            payer: user.clone(),
            settled: true,
            timestamp: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&payment_key, &payment_record);

        let user_phase_key = DataKey::UserPhase(user.clone(), collection_id);
        if env.storage().persistent().has(&user_phase_key) {
            let mut state: PhaseState = env.storage().persistent().get(&user_phase_key).unwrap();
            let next = state
                .energy_level_bp
                .saturating_add(ENERGY_BP_PER_SETTLE);
            state.energy_level_bp = if next > ENERGY_BP_MAX {
                ENERGY_BP_MAX
            } else {
                next
            };
            env.storage().persistent().set(&user_phase_key, &state);
        } else {
            let new_id = write_minted_phase(&env, &user, collection_id, amount, &token_address);

            env.events().publish(
                (Symbol::new(&env, "phase_nft_minted"), user.clone()),
                (new_id, amount),
            );
            env.events().publish(
                (Symbol::new(&env, "phase_minted"), user.clone()),
                (new_id, amount),
            );
            emit_indexer_mint(&env, user.clone(), new_id);
        }

        env.events().publish(
            (Symbol::new(&env, "x402_settled"), user),
            (invoice_id, amount),
        );

        Ok(true)
    }

    pub fn create_invoice(env: Env, amount: i128, token: Address) -> Result<u32, PhaseError> {
        let mut counter: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::X402InvoiceCounter)
            .unwrap_or(0);

        counter = counter + 1;

        env.storage()
            .persistent()
            .set(&DataKey::X402InvoiceCounter, &counter);

        let payment = PaymentRecord {
            invoice_id: counter,
            amount,
            token,
            payer: Address::from_str(&env, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"),
            settled: false,
            timestamp: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::X402Payment(counter), &payment);

        Ok(counter)
    }

    pub fn get_invoice_status(env: Env, invoice_id: u32) -> Option<PaymentRecord> {
        let payment_key = DataKey::X402Payment(invoice_id);
        env.storage().persistent().get(&payment_key)
    }

    pub fn get_user_phase(env: Env, user: Address, collection_id: u64) -> Option<PhaseState> {
        let user_phase_key = DataKey::UserPhase(user, collection_id);
        env.storage().persistent().get(&user_phase_key)
    }

    pub fn has_phased(env: Env, user: Address, collection_id: u64) -> bool {
        let user_phase_key = DataKey::UserPhase(user, collection_id);
        env.storage().persistent().has(&user_phase_key)
    }

    pub fn get_total_phases(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::PhaseCounter)
            .unwrap_or(0)
    }

    /// NFTs emitidos para `collection_id` (recorre `TokenCollection` de `1..=phase_counter`).
    pub fn get_total_minted(env: Env, collection_id: u64) -> u64 {
        let total: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::PhaseCounter)
            .unwrap_or(0);
        let mut count = 0u64;
        let mut id = 1u64;
        while id <= total {
            if let Some(cid) = env
                .storage()
                .persistent()
                .get::<DataKey, u64>(&DataKey::TokenCollection(id))
            {
                if cid == collection_id {
                    count = count.saturating_add(1);
                }
            }
            id = id.saturating_add(1);
        }
        count
    }

    /// Tope de serie para monitor de escasez en UI (constante del protocolo PHASE).
    pub fn get_collection_supply_cap(_env: Env, _collection_id: u64) -> u64 {
        10_000u64
    }

    pub fn get_config(env: Env) -> (Address, i128) {
        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::AuthorizedToken)
            .expect("Contract not initialized");

        let required_amount: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::RequiredAmount)
            .expect("Required amount not set");

        (token_address, required_amount)
    }

    pub fn get_protocol_treasury(env: Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::ProtocolTreasury)
            .expect("Treasury not set")
    }

    pub fn get_facilitator(env: Env) -> Address {
        env.current_contract_address()
    }

    /// Spike 574 (phase-182): declara el pool leg. Admin-only y aditivo; no
    /// cambia `settle`. Un `pool_id` todo-cero se rechaza para que un error de
    /// configuración no se lea como "pool " + 64 ceros.
    pub fn set_pool_leg(env: Env, admin: Address, config: PoolLegConfig) {
        let stored: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("Admin"))
            .expect("Admin not set — call initialize first");
        if stored != admin {
            panic!("only admin can set the pool leg");
        }
        admin.require_auth();
        if config.pool_id == BytesN::from_array(&env, &[0u8; 32]) {
            panic!("pool leg requires a non-zero pool id");
        }
        env.storage()
            .persistent()
            .set(&DataKey::PoolLegConfig, &config.clone());
        env.events().publish(
            (Symbol::new(&env, "pool_leg_set"), admin),
            (config.enabled, config.venue, config.pool_id),
        );
    }

    /// Lectura del pool leg. `None` cuando la integración está apagada o nunca
    /// se configuró; los clientes deben tratar `None` como "sin pool leg".
    pub fn get_pool_leg(env: Env) -> Option<PoolLegConfig> {
        env.storage().persistent().get(&DataKey::PoolLegConfig)
    }

    /// Desactiva el pool leg sin borrar la configuración (rollback barato).
    pub fn clear_pool_leg(env: Env, admin: Address) {
        let stored: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("Admin"))
            .expect("Admin not set — call initialize first");
        if stored != admin {
            panic!("only admin can clear the pool leg");
        }
        admin.require_auth();
        if let Some(mut config) = env
            .storage()
            .persistent()
            .get::<DataKey, PoolLegConfig>(&DataKey::PoolLegConfig)
        {
            config.enabled = false;
            env.storage()
                .persistent()
                .set(&DataKey::PoolLegConfig, &config);
        }
    }

    /// Colección (Freighter / SEP-0050 / SEP-41 metadata): lectura on-chain sin estado.
    pub fn name(env: Env) -> String {
        String::from_str(&env, "Phase Artifact")
    }

    /// Símbolo corto del NFT de utilidad (Freighter collectibles).
    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "PHASE")
    }

    // --- FUNCIONES ESTÁNDAR SEP-41 REQUERIDAS POR FREIGHTER ---

    /// Freighter usa esto para saber si el token es divisible. NFT → 0.
    pub fn decimals(env: Env) -> u32 {
        let _ = env;
        0
    }

    pub fn get_phase_level(env: Env, token_id: u64) -> Option<String> {
        let owner: Address = env.storage().persistent().get(&DataKey::TokenOwner(token_id))?;
        let col: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::TokenCollection(token_id))?;
        let state: PhaseState = env
            .storage()
            .persistent()
            .get(&DataKey::UserPhase(owner, col))?;
        if state.token_id == token_id {
            Some(state.phase_level)
        } else {
            None
        }
    }

    /// Freighter: cuántos NFTs tiene la cuenta en total (contador persistente, misma clave que el mint/transfer mantienen).
    pub fn balance(env: Env, id: Address) -> i128 {
        let key = DataKey::Balance(id);
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    /// Enumeración por titular (ERC-721 `tokenOfOwnerByIndex`): `index` en `[0, balance(owner))`.
    /// Orden estable por orden de incorporación a la lista del dueño (mint / recepción por transfer).
    pub fn token_of_owner_by_index(env: Env, owner: Address, index: u32) -> Option<u64> {
        let key = DataKey::OwnerTokenList(owner);
        let v: Vec<u64> = env.storage().persistent().get(&key)?;
        if index >= v.len() {
            return None;
        }
        v.get(index)
    }

    /// SEP-0050 / Freighter: `token_id` como `u32` (tipo estándar que usan los clientes).
    pub fn owner_of(env: Env, token_id: u32) -> Address {
        match env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::TokenOwner(token_id as u64))
        {
            Some(a) => a,
            None => panic!("Phase NFT: invalid token id"),
        }
    }

    /// Alias `u64` para clientes que invocan con entero de 64 bits (backwards compat).
    pub fn owner_of_u64(env: Env, token_id: u64) -> Address {
        Self::owner_of(env, token_id as u32)
    }

    /// `token_id` → `collection_id` (0 = pool protocolo). Lectura para indexadores y `/api/metadata`.
    pub fn get_token_collection_id(env: Env, token_id: u64) -> Option<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::TokenCollection(token_id))
    }

    /// Alias **SEP-41 / Freighter**: misma firma que suelen exponer los NFT Soroban para descubrimiento en wallet.
    /// Si `from == to`, es un **no-op** autenticado (el token sigue en la misma cuenta) para forzar una tx visible
    /// al indexador cuando el mint existió pero la wallet no mostraba el collectible.
    pub fn transfer(env: Env, from: Address, to: Address, token_id: u64) -> Result<(), PhaseError> {
        if from == to {
            from.require_auth();
            let current: Address = env
                .storage()
                .persistent()
                .get(&DataKey::TokenOwner(token_id))
                .ok_or(PhaseError::NftNotFound)?;
            if current != from {
                return Err(PhaseError::NotNftOwner);
            }
            emit_indexer_transfer(&env, from.clone(), to.clone(), token_id);
            return Ok(());
        }
        Self::transfer_phase_nft(env, from, to, token_id)
    }

    /// Mismo comportamiento que `transfer`; nombre usado en varios ejemplos / tooling Soroban (`xfer`).
    pub fn xfer(env: Env, from: Address, to: Address, token_id: u64) -> Result<(), PhaseError> {
        Self::transfer(env, from, to, token_id)
    }

    /// Cuerpo común de transferencia de NFT (SEP-50: `transfer` / `transfer_from`); limpia `NftApproval`.
    fn transfer_phase_nft_body(env: &Env, from: Address, to: Address, token_id: u64) -> Result<(), PhaseError> {
        if from == to {
            return Err(PhaseError::SelfTransfer);
        }
        let current: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenOwner(token_id))
            .ok_or(PhaseError::NftNotFound)?;
        if current != from {
            return Err(PhaseError::NotNftOwner);
        }
        let collection_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::TokenCollection(token_id))
            .ok_or(PhaseError::NftNotFound)?;
        let state: PhaseState = env
            .storage()
            .persistent()
            .get(&DataKey::UserPhase(from.clone(), collection_id))
            .ok_or(PhaseError::NftNotFound)?;
        if state.token_id != token_id {
            return Err(PhaseError::NftNotFound);
        }
        owner_tokens_remove(env, from.clone(), token_id)?;
        adjust_nft_balance_count(env, from.clone(), -1);
        adjust_nft_balance_count(env, to.clone(), 1);
        env.storage()
            .persistent()
            .remove(&DataKey::UserPhase(from.clone(), collection_id));
        env.storage().persistent().set(&DataKey::TokenOwner(token_id), &to);
        env.storage()
            .persistent()
            .set(&DataKey::UserPhase(to.clone(), collection_id), &state);
        env.storage().persistent().remove(&DataKey::NftApproval(token_id));
        owner_tokens_push(env, to.clone(), token_id);
        Ok(())
    }

    /// Transfiere el NFT de utilidad PHASE a otra cuenta. El pago en PHASER_LIQ se acuerda P2P;
    /// esta llamada solo mueve la propiedad on-chain (`TokenOwner` + `UserPhase`).
    pub fn transfer_phase_nft(env: Env, from: Address, to: Address, token_id: u64) -> Result<(), PhaseError> {
        from.require_auth();
        Self::transfer_phase_nft_body(&env, from.clone(), to.clone(), token_id)?;
        env.events().publish(
            (Symbol::new(&env, "phase_nft_transferred"), from.clone()),
            (token_id, to.clone()),
        );
        emit_indexer_transfer(&env, from, to, token_id);
        Ok(())
    }

    /// SEP-50: tercero autorizado (`spender`) transfiere en nombre del dueño.
    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        token_id: u64,
    ) -> Result<(), PhaseError> {
        spender.require_auth();
        if from == to {
            return Err(PhaseError::SelfTransfer);
        }
        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenOwner(token_id))
            .ok_or(PhaseError::NftNotFound)?;
        if owner != from {
            return Err(PhaseError::NotNftOwner);
        }
        let allowed = spender == from
            || get_approved_valid(&env, token_id).as_ref() == Some(&spender)
            || is_approved_for_all_valid(&env, from.clone(), spender.clone());
        if !allowed {
            return Err(PhaseError::NotApproved);
        }
        Self::transfer_phase_nft_body(&env, from.clone(), to.clone(), token_id)?;
        env.events().publish(
            (Symbol::new(&env, "phase_nft_transferred"), from.clone()),
            (token_id, to.clone()),
        );
        emit_indexer_transfer(&env, from, to, token_id);
        Ok(())
    }

    /// SEP-50: permiso puntual para `transfer_from`.
    pub fn approve(
        env: Env,
        approver: Address,
        approved: Address,
        token_id: u64,
        live_until_ledger: u32,
    ) -> Result<(), PhaseError> {
        approver.require_auth();
        let owner: Address = Self::owner_of(env.clone(), token_id as u32);
        let can_approve = approver == owner || is_approved_for_all_valid(&env, owner.clone(), approver.clone());
        if !can_approve {
            return Err(PhaseError::UnauthorizedApprover);
        }
        if live_until_ledger != 0 && live_until_ledger < current_ledger(&env) {
            return Err(PhaseError::InvalidApproval);
        }
        if live_until_ledger == 0 {
            env.storage().persistent().remove(&DataKey::NftApproval(token_id));
        } else {
            env.storage().persistent().set(
                &DataKey::NftApproval(token_id),
                &NftSingleApproval {
                    approved: approved.clone(),
                    live_until_ledger,
                },
            );
        }
        emit_sep_approve(&env, owner, token_id, approved, live_until_ledger);
        Ok(())
    }

    /// SEP-50: operador para todos los NFT del `owner`.
    pub fn approve_for_all(
        env: Env,
        owner: Address,
        operator: Address,
        live_until_ledger: u32,
    ) -> Result<(), PhaseError> {
        owner.require_auth();
        if live_until_ledger != 0 && live_until_ledger < current_ledger(&env) {
            return Err(PhaseError::InvalidApproval);
        }
        if live_until_ledger == 0 {
            env.storage()
                .persistent()
                .remove(&DataKey::OperatorForAll(owner.clone(), operator.clone()));
        } else {
            env.storage().persistent().set(
                &DataKey::OperatorForAll(owner.clone(), operator.clone()),
                &live_until_ledger,
            );
        }
        emit_sep_approve_for_all(&env, owner.clone(), operator.clone(), live_until_ledger);
        Ok(())
    }

    /// SEP-50: cuenta permitida para `token_id` (expirada ⇒ `None`).
    pub fn get_approved(env: Env, token_id: u64) -> Option<Address> {
        if env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::TokenOwner(token_id))
            .is_none()
        {
            panic!("Phase NFT: invalid token id");
        }
        get_approved_valid(&env, token_id)
    }

    /// SEP-50: `operator` puede gestionar todos los activos de `owner`.
    pub fn is_approved_for_all(env: Env, owner: Address, operator: Address) -> bool {
        is_approved_for_all_valid(&env, owner, operator)
    }

    pub fn total_supply(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::PhaseCounter)
            .unwrap_or(0)
    }

    /// SEP-0050: URI HTTPS del JSON de metadata. `token_id` como `u32` (estándar Freighter).
    pub fn token_uri(env: Env, token_id: u32) -> String {
        if env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::TokenOwner(token_id as u64))
            .is_none()
        {
            panic!("Phase NFT: invalid token id");
        }
        build_metadata_token_uri(&env, token_id as u64)
    }

    /// Alias `u64` para backwards compat.
    pub fn token_uri_u64(env: Env, token_id: u64) -> String {
        Self::token_uri(env, token_id as u32)
    }

    /// SEP-0050: metadatos como `Map<Symbol, String>`. `image` resuelto a HTTPS (ipfs:// → gateway).
    /// Incluye campos requeridos: name, description, image, mime_type, properties.
    pub fn token_metadata(env: Env, token_id: u32) -> Map<Symbol, String> {
        if env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::TokenOwner(token_id as u64))
            .is_none()
        {
            panic!("Phase NFT: invalid token id");
        }
        let name = build_token_display_name(&env, token_id as u64);
        let phase_level = Self::get_phase_level(env.clone(), token_id as u64);
        let description = build_metadata_description_string(&env, phase_level.clone());
        let raw_image = build_token_image_raw_string(&env, token_id as u64);
        let image = resolve_image_to_https(&env, &raw_image);
        let mut m = Map::new(&env);
        m.set(Symbol::new(&env, "name"), name);
        m.set(Symbol::new(&env, "description"), description);
        m.set(Symbol::new(&env, "image"), image);
        m.set(Symbol::new(&env, "mime_type"), String::from_str(&env, "image/png"));
        let props = build_metadata_properties(&env, token_id as u64, phase_level);
        m.set(Symbol::new(&env, "properties"), props);
        m
    }

    /// Alias `u64` para backwards compat.
    pub fn token_metadata_u64(env: Env, token_id: u64) -> Map<Symbol, String> {
        Self::token_metadata(env, token_id as u32)
    }

    /// Spike 673: reserva atómica de la siguiente edición (falla si el cap está agotado).
    /// Llamar antes de `initiate_phase` para serializar mints concurrentes bajo supply limitada.
    pub fn mint_next_edition(env: Env, collection_id: u64) -> Result<u64, PhaseError> {
        let cap: u64 = env.storage().persistent().get(&DataKey::EditionCap(collection_id)).unwrap_or(10_000u64);
        let cur: u64 = env.storage().persistent().get(&DataKey::EditionCounter(collection_id)).unwrap_or(0);
        let next = cur.saturating_add(1);
        if next > cap {
            return Err(PhaseError::EditionSupplyExhausted);
        }
        env.storage().persistent().set(&DataKey::EditionCounter(collection_id), &next);
        env.events().publish((Symbol::new(&env, "edition_reserved"), collection_id), next);
        Ok(next)
    }

    /// Spike 673: fija el cap de ediciones de una colección (solo creador). None = legacy 10_000.
    pub fn set_edition_cap(env: Env, creator: Address, collection_id: u64, cap: u64) -> Result<(), PhaseError> {
        creator.require_auth();
        let settings: CollectionSettings = env.storage().persistent().get(&DataKey::Collection(collection_id)).ok_or(PhaseError::InvalidCollection)?;
        if settings.creator != creator {
            return Err(PhaseError::UnauthorizedApprover);
        }
        env.storage().persistent().set(&DataKey::EditionCap(collection_id), &cap);
        Ok(())
    }

    /// Spike 674: compromete payees N-way (suma bps <= 10000, máx 20). Solo creador.
    pub fn set_split_payees(env: Env, creator: Address, collection_id: u64, payees: Vec<(Address, u32)>) -> Result<(), PhaseError> {
        creator.require_auth();
        let settings: CollectionSettings = env.storage().persistent().get(&DataKey::Collection(collection_id)).ok_or(PhaseError::InvalidCollection)?;
        if settings.creator != creator {
            return Err(PhaseError::UnauthorizedApprover);
        }
        if payees.len() > 20 {
            return Err(PhaseError::InvalidSplitPayees);
        }
        let mut total: u32 = 0;
        let mut i: u32 = 0;
        while i < payees.len() {
            let (_, bps) = payees.get(i).unwrap();
            total = total.saturating_add(bps);
            i += 1;
        }
        if total > 10_000 {
            return Err(PhaseError::InvalidSplitPayees);
        }
        env.storage().persistent().set(&DataKey::SplitPayees(collection_id), &payees);
        Ok(())
    }

    /// Spike 672: fija la ventana del drop (timestamps ledger). Solo creador.
    pub fn set_drop_window(env: Env, creator: Address, collection_id: u64, start_at: u64, end_at: u64) -> Result<(), PhaseError> {
        creator.require_auth();
        let settings: CollectionSettings = env.storage().persistent().get(&DataKey::Collection(collection_id)).ok_or(PhaseError::InvalidCollection)?;
        if settings.creator != creator {
            return Err(PhaseError::UnauthorizedApprover);
        }
        if end_at != 0 && end_at < start_at {
            return Err(PhaseError::InvalidCollectionMetadata);
        }
        env.storage().persistent().set(&DataKey::DropWindow(collection_id), &(start_at, end_at));
        Ok(())
    }

    /// Spike 672: gate de ventana — revierte con DropNotLive fuera de [start, end].
    pub fn assert_drop_live(env: Env, collection_id: u64) -> Result<(), PhaseError> {
        if let Some((start, end)) = env.storage().persistent().get::<DataKey, (u64, u64)>(&DataKey::DropWindow(collection_id)) {
            let now = env.ledger().timestamp();
            if now < start || (end != 0 && now > end) {
                return Err(PhaseError::DropNotLive);
            }
        }
        Ok(())
    }

    /// Spike 675: fija config Dutch (start >= floor). Solo creador.
    pub fn set_dutch_config(env: Env, creator: Address, collection_id: u64, start_price: i128, floor_price: i128, end_at: u64) -> Result<(), PhaseError> {
        creator.require_auth();
        let settings: CollectionSettings = env.storage().persistent().get(&DataKey::Collection(collection_id)).ok_or(PhaseError::InvalidCollection)?;
        if settings.creator != creator {
            return Err(PhaseError::UnauthorizedApprover);
        }
        if start_price < floor_price || floor_price <= 0 {
            return Err(PhaseError::AmountBelowCollectionPrice);
        }
        env.storage().persistent().set(&DataKey::DutchConfig(collection_id), &(start_price, floor_price, end_at));
        Ok(())
    }

    /// Spike 675: quote determinista price(t) = max(floor, start - tick*elapsed). Tick lineal por tiempo.
    pub fn dutch_quote(env: Env, collection_id: u64, start_at: u64) -> Result<i128, PhaseError> {
        if let Some((start, floor, end)) = env.storage().persistent().get::<DataKey, (i128, i128, u64)>(&DataKey::DutchConfig(collection_id)) {
            let now = env.ledger().timestamp();
            if now >= end {
                return Ok(floor);
            }
            if now <= start_at || end <= start_at {
                return Ok(start);
            }
            let elapsed = (now - start_at) as i128;
            let span = (end - start_at) as i128;
            let drop = (start - floor) * elapsed / span;
            let q = start - drop;
            return Ok(if q < floor { floor } else { q });
        }
        Self::required_for_collection(&env, collection_id)
    }

    pub fn get_energy_level_bp(env: Env, user: Address, collection_id: u64) -> Option<u32> {
        let key = DataKey::UserPhase(user, collection_id);
        env.storage()
            .persistent()
            .get::<DataKey, PhaseState>(&key)
            .map(|s| s.energy_level_bp)
    }

    // --- RIFA COMMIT-REVEAL ---

    /// El creador compromete `commit = sha256(seed)` antes de abrir entradas.
    pub fn open_raffle(
        env: Env,
        creator: Address,
        collection_id: u64,
        commit: BytesN<32>,
        slots: u32,
        close_ledger: u32,
        reveal_deadline: u32,
        claim_window: u32,
    ) -> Result<(), PhaseError> {
        creator.require_auth();
        let settings: CollectionSettings = env
            .storage()
            .persistent()
            .get(&DataKey::Collection(collection_id))
            .ok_or(PhaseError::InvalidCollection)?;
        if settings.creator != creator {
            return Err(PhaseError::InvalidCollection);
        }
        if env.storage().persistent().has(&DataKey::Raffle(collection_id)) {
            return Err(PhaseError::RaffleAlreadyExists);
        }
        if slots == 0
            || slots > RAFFLE_MAX_SLOTS
            || close_ledger <= current_ledger(&env)
            || reveal_deadline <= close_ledger
            || claim_window == 0
        {
            return Err(PhaseError::RaffleInvalidParams);
        }
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        let raffle = Raffle {
            collection_id,
            creator: creator.clone(),
            commit: commit.clone(),
            slots,
            price: settings.price,
            close_ledger,
            reveal_deadline,
            claim_window,
            status: RAFFLE_STATUS_OPEN,
            entry_count: 0,
            entry_digest: zero.clone(),
            seed: zero.clone(),
            beacon: zero.clone(),
            draw_seed: zero,
            drawn_ledger: 0,
            primary_claimed: 0,
        };
        env.storage().persistent().set(&DataKey::Raffle(collection_id), &raffle);
        env.storage()
            .persistent()
            .set(&DataKey::RaffleEntrants(collection_id), &Vec::<Address>::new(&env));
        env.events().publish(
            (Symbol::new(&env, "raffle_opened"), collection_id),
            (creator, commit, slots, close_ledger, reveal_deadline),
        );
        Ok(())
    }

    /// Una entrada por wallet; el precio queda en escrow del contrato hasta reclamo o reembolso.
    pub fn enter_raffle(env: Env, entrant: Address, collection_id: u64) -> Result<u32, PhaseError> {
        entrant.require_auth();
        let mut r = load_raffle(&env, collection_id)?;
        if r.status != RAFFLE_STATUS_OPEN || current_ledger(&env) > r.close_ledger {
            return Err(PhaseError::RaffleClosed);
        }
        if entrant == r.creator {
            return Err(PhaseError::RaffleSelfEntry);
        }
        let entry_key = DataKey::RaffleEntry(collection_id, entrant.clone());
        if env.storage().persistent().has(&entry_key) {
            return Err(PhaseError::RaffleAlreadyEntered);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::UserPhase(entrant.clone(), collection_id))
        {
            return Err(PhaseError::AlreadyPhased);
        }
        if r.entry_count >= RAFFLE_MAX_ENTRIES {
            return Err(PhaseError::RaffleFull);
        }

        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::AuthorizedToken)
            .expect("Contract not initialized");
        let token_client = token::Client::new(&env, &token_address);
        if token_client.balance(&entrant) < r.price {
            return Err(PhaseError::InsufficientBalance);
        }
        token_client.transfer(&entrant, &env.current_contract_address(), &r.price);

        r.entry_digest = sha256_concat(&env, &r.entry_digest, &address_strkey_bytes(&env, &entrant));
        r.entry_count += 1;
        let entrants_key = DataKey::RaffleEntrants(collection_id);
        let mut entrants: Vec<Address> = env
            .storage()
            .persistent()
            .get(&entrants_key)
            .unwrap_or_else(|| Vec::new(&env));
        entrants.push_back(entrant.clone());
        env.storage().persistent().set(&entrants_key, &entrants);
        env.storage().persistent().set(&entry_key, &RAFFLE_ENTRY_ENTERED);
        env.storage().persistent().set(&DataKey::Raffle(collection_id), &r);

        env.events().publish(
            (Symbol::new(&env, "raffle_entered"), collection_id),
            (entrant, r.entry_count),
        );
        Ok(r.entry_count)
    }

    /// Revela `seed` (verificado contra `commit`), mezcla el digest de entradas y el PRNG de red,
    /// y publica el ranking. Permisionado por conocimiento de la semilla, no por firma.
    pub fn reveal_and_draw(env: Env, collection_id: u64, seed: BytesN<32>) -> Result<Vec<Address>, PhaseError> {
        let mut r = load_raffle(&env, collection_id)?;
        if r.status != RAFFLE_STATUS_OPEN {
            return Err(PhaseError::RaffleClosed);
        }
        let now = current_ledger(&env);
        if now <= r.close_ledger {
            return Err(PhaseError::RaffleNotClosed);
        }
        if now > r.reveal_deadline {
            return Err(PhaseError::RaffleRevealExpired);
        }
        let seed_bytes = Bytes::from_array(&env, &seed.to_array());
        if env.crypto().sha256(&seed_bytes).to_bytes() != r.commit {
            return Err(PhaseError::RaffleCommitMismatch);
        }

        let beacon: BytesN<32> = env.prng().gen();
        let mut mix = Bytes::from_array(&env, &r.entry_digest.to_array());
        mix.append(&Bytes::from_array(&env, &beacon.to_array()));
        let draw_seed = sha256_concat(&env, &seed, &mix);

        let entrants: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::RaffleEntrants(collection_id))
            .unwrap_or_else(|| Vec::new(&env));
        let ranking = compute_raffle_ranking(&env, &draw_seed, &entrants, r.slots);

        r.status = RAFFLE_STATUS_DRAWN;
        r.seed = seed.clone();
        r.beacon = beacon.clone();
        r.draw_seed = draw_seed.clone();
        r.drawn_ledger = now;
        env.storage().persistent().set(&DataKey::Raffle(collection_id), &r);
        env.storage()
            .persistent()
            .set(&DataKey::RaffleRanking(collection_id), &ranking);

        env.events().publish(
            (Symbol::new(&env, "raffle_drawn"), collection_id),
            (seed, beacon, draw_seed, r.entry_count),
        );
        Ok(ranking)
    }

    /// Ganadores (`rank < slots`) reclaman en `(drawn, drawn + claim_window]`; suplentes cubren los cupos
    /// no reclamados en la segunda ventana, en orden de ranking.
    pub fn claim_raffle_mint(env: Env, winner: Address, collection_id: u64) -> Result<u64, PhaseError> {
        winner.require_auth();
        let mut r = load_raffle(&env, collection_id)?;
        if r.status != RAFFLE_STATUS_DRAWN {
            return Err(PhaseError::RaffleNotDrawn);
        }
        let entry_key = DataKey::RaffleEntry(collection_id, winner.clone());
        match env.storage().persistent().get::<DataKey, u32>(&entry_key) {
            Some(RAFFLE_ENTRY_ENTERED) => {}
            Some(RAFFLE_ENTRY_CLAIMED) => return Err(PhaseError::RaffleAlreadyClaimed),
            _ => return Err(PhaseError::RaffleNotAWinner),
        }
        let rank = raffle_rank(&env, collection_id, &winner).ok_or(PhaseError::RaffleNotAWinner)?;
        let now = current_ledger(&env);
        let primary_end = r.drawn_ledger.saturating_add(r.claim_window);
        if rank < r.slots {
            if now > primary_end {
                return Err(PhaseError::RaffleClaimWindowClosed);
            }
            r.primary_claimed += 1;
        } else {
            if now <= primary_end || now > primary_end.saturating_add(r.claim_window) {
                return Err(PhaseError::RaffleClaimWindowClosed);
            }
            if rank - r.slots >= r.slots - r.primary_claimed {
                return Err(PhaseError::RaffleNotAWinner);
            }
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::UserPhase(winner.clone(), collection_id))
        {
            return Err(PhaseError::AlreadyPhased);
        }

        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::AuthorizedToken)
            .expect("Contract not initialized");
        let token_client = token::Client::new(&env, &token_address);
        let treasury: Address = env
            .storage()
            .persistent()
            .get(&DataKey::ProtocolTreasury)
            .expect("Treasury not set");
        let contract_address = env.current_contract_address();
        let creator_share = r.price * FEE_CREATOR_BP / FEE_DENOM;
        let protocol_share = r.price.saturating_sub(creator_share);
        if creator_share > 0 {
            token_client.transfer(&contract_address, &r.creator, &creator_share);
        }
        if protocol_share > 0 {
            token_client.transfer(&contract_address, &treasury, &protocol_share);
        }

        let new_id = write_minted_phase(&env, &winner, collection_id, r.price, &token_address);
        env.storage().persistent().set(&entry_key, &RAFFLE_ENTRY_CLAIMED);
        env.storage().persistent().set(&DataKey::Raffle(collection_id), &r);

        env.events().publish(
            (Symbol::new(&env, "raffle_claimed"), collection_id),
            (winner.clone(), new_id, rank),
        );
        env.events().publish(
            (Symbol::new(&env, "phase_nft_minted"), winner.clone()),
            (new_id, r.price),
        );
        emit_indexer_mint(&env, winner, new_id);
        Ok(new_id)
    }

    /// Devuelve el escrow al participante (permisionless; los fondos solo van al `entrant`):
    /// no ranqueado tras el sorteo, ranqueado sin reclamar tras ambas ventanas, o rifa abortada
    /// porque el creador no reveló antes de `reveal_deadline`.
    pub fn refund_raffle_entry(env: Env, entrant: Address, collection_id: u64) -> Result<(), PhaseError> {
        let mut r = load_raffle(&env, collection_id)?;
        let entry_key = DataKey::RaffleEntry(collection_id, entrant.clone());
        if env.storage().persistent().get::<DataKey, u32>(&entry_key) != Some(RAFFLE_ENTRY_ENTERED) {
            return Err(PhaseError::RaffleRefundUnavailable);
        }
        let now = current_ledger(&env);
        let eligible = match r.status {
            RAFFLE_STATUS_OPEN if now > r.reveal_deadline => {
                r.status = RAFFLE_STATUS_ABORTED;
                env.storage().persistent().set(&DataKey::Raffle(collection_id), &r);
                env.events()
                    .publish((Symbol::new(&env, "raffle_aborted"), collection_id), r.entry_count);
                true
            }
            RAFFLE_STATUS_ABORTED => true,
            RAFFLE_STATUS_DRAWN => match raffle_rank(&env, collection_id, &entrant) {
                None => true,
                Some(_) => now > r.drawn_ledger.saturating_add(r.claim_window.saturating_mul(2)),
            },
            _ => false,
        };
        if !eligible {
            return Err(PhaseError::RaffleRefundUnavailable);
        }

        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::AuthorizedToken)
            .expect("Contract not initialized");
        token::Client::new(&env, &token_address).transfer(
            &env.current_contract_address(),
            &entrant,
            &r.price,
        );
        env.storage().persistent().set(&entry_key, &RAFFLE_ENTRY_REFUNDED);
        env.events().publish(
            (Symbol::new(&env, "raffle_refunded"), collection_id),
            (entrant, r.price),
        );
        Ok(())
    }

    pub fn get_raffle(env: Env, collection_id: u64) -> Option<Raffle> {
        env.storage().persistent().get(&DataKey::Raffle(collection_id))
    }

    /// Paginado por índice de entrada (orden canónico para recomputar `entry_digest`).
    pub fn get_raffle_entrants(env: Env, collection_id: u64, start: u32, limit: u32) -> Vec<Address> {
        let all: Vec<Address> = match env
            .storage()
            .persistent()
            .get(&DataKey::RaffleEntrants(collection_id))
        {
            Some(v) => v,
            None => return Vec::new(&env),
        };
        let end = start.saturating_add(limit.min(RAFFLE_MAX_ENTRIES)).min(all.len());
        if start >= end {
            return Vec::new(&env);
        }
        all.slice(start..end)
    }

    pub fn get_raffle_ranking(env: Env, collection_id: u64) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::RaffleRanking(collection_id))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// 0 = sin entrada, 1 = inscrito, 2 = reclamado, 3 = reembolsado.
    pub fn get_raffle_entry_status(env: Env, collection_id: u64, entrant: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::RaffleEntry(collection_id, entrant))
            .unwrap_or(0)
    }

    /// Spike 608: Exposes the pinned Soroban SDK / ABI version (`22000` for soroban-sdk 22.0.0)
    /// so grouped dependency updates and staging dry-runs can verify WASM ABI parity.
    pub fn soroban_abi_version(_env: Env) -> u32 {
        22_000
    }
}

#[cfg(test)]
mod test;
