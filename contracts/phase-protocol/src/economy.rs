//! Spikes 694 / 697 / 698 / 699 — economic primitives on top of the PHASE protocol.
//!
//! - 694 collection coins: per-collection fungible fan token registry, verified-only
//!   fan-reward mint (one per NFT, ever) and holder burn for redemption.
//! - 697 signal tips: one signed call splits a PHASELQ tip across up to
//!   `TIP_MAX_RECIPIENTS` wallets after a protocol fee; `tip_id` is the replay key.
//! - 698 endowments: donor principal is locked; only yield deposited on top of it
//!   vests (per-second, with cliff) to a named creator. Donor revoke / dispute hold.
//! - 699 listing bonds: slashable PHASELQ stake per listing, challenge with evidence
//!   hash + stake, admin adjudication (admin is expected to be a multisig account).
//!
//! Storage keys live in `EconKey` (not `DataKey`) so existing storage layouts are
//! untouched; new error codes are appended after `InvalidOwnerTokenList = 17`.

use soroban_sdk::{
    contracttype, symbol_short, token, Address, BytesN, Env, Symbol, Vec,
};

use crate::{
    CollectionSettings, DataKey, PhaseError, PhaseProtocol, PhaseProtocolArgs, PhaseProtocolClient,
};
use soroban_sdk::contractimpl;

const BPS_DENOM: i128 = 10_000;

/// 2.5% of every tip goes to the protocol treasury.
pub const TIP_FEE_BP: i128 = 250;
/// 0.1 PHASELQ (7 decimals). Below this the base fee dominates the tip.
pub const TIP_MIN_STROOPS: i128 = 1_000_000;
pub const TIP_MAX_RECIPIENTS: u32 = 8;

/// Upper bound a creator may configure as the per-NFT fan reward (1000 coins).
pub const COIN_MAX_REWARD: i128 = 10_000_000_000;

pub const BOND_MIN_STROOPS: i128 = 1_000_000;
/// Challenger must stake 10% of the bond to open a challenge.
pub const BOND_CHALLENGE_STAKE_BP: i128 = 1_000;
/// Seller cannot release the bond for 7 days after posting (challenge window).
pub const BOND_CHALLENGE_WINDOW_SECS: u64 = 7 * 24 * 60 * 60;

pub const BOND_ACTIVE: u32 = 0;
pub const BOND_RELEASED: u32 = 1;
pub const BOND_SLASHED: u32 = 2;
pub const BOND_COMPENSATED: u32 = 3;

#[contracttype]
pub enum EconKey {
    CollectionCoin(u64),
    CoinToCollection(Address),
    FanRewardClaimed(u64),
    TipUsed(BytesN<32>),
    EndowmentCounter,
    Endowment(u64),
    Bond(BytesN<32>),
}

#[contracttype]
#[derive(Clone)]
pub struct CollectionCoin {
    pub collection_id: u64,
    pub coin: Address,
    pub creator: Address,
    pub reward_per_nft: i128,
    pub verified: bool,
    pub registered_at: u64,
    pub minted: i128,
    pub redeemed: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct Endowment {
    pub id: u64,
    pub donor: Address,
    pub creator: Address,
    pub token: Address,
    pub principal: i128,
    pub principal_unlock_at: u64,
    pub principal_withdrawn: bool,
    pub yield_deposited: i128,
    pub yield_claimed: i128,
    pub start: u64,
    pub cliff_secs: u64,
    pub duration_secs: u64,
    /// 0 = not revoked. Vesting freezes at this timestamp.
    pub revoked_at: u64,
    /// Vested yield frozen at revoke time (only meaningful when `revoked_at > 0`).
    pub revoked_vested: i128,
    pub disputed: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct ListingBond {
    pub listing_ref: BytesN<32>,
    pub seller: Address,
    pub token: Address,
    pub amount: i128,
    pub posted_at: u64,
    pub unlock_at: u64,
    pub status: u32,
    pub challenger: Option<Address>,
    pub challenge_stake: i128,
    pub evidence: Option<BytesN<32>>,
}

fn admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&symbol_short!("Admin"))
        .expect("Admin not set — call initialize first")
}

fn authorized_token(env: &Env) -> Address {
    env.storage()
        .persistent()
        .get(&DataKey::AuthorizedToken)
        .expect("Contract not initialized")
}

fn treasury(env: &Env) -> Address {
    env.storage()
        .persistent()
        .get(&DataKey::ProtocolTreasury)
        .expect("Treasury not set")
}

fn bps_of(amount: i128, bps: i128) -> i128 {
    amount.checked_mul(bps).map(|v| v / BPS_DENOM).unwrap_or(0)
}

/// Vested yield at `now`: zero before the cliff, linear in seconds up to `duration_secs`.
pub fn vested_yield(e: &Endowment, now: u64) -> i128 {
    if e.revoked_at > 0 {
        return e.revoked_vested;
    }
    let elapsed = now.saturating_sub(e.start);
    if elapsed < e.cliff_secs {
        return 0;
    }
    if elapsed >= e.duration_secs {
        return e.yield_deposited;
    }
    e.yield_deposited
        .checked_mul(elapsed as i128)
        .map(|v| v / e.duration_secs as i128)
        .unwrap_or(0)
}

fn load_endowment(env: &Env, id: u64) -> Result<Endowment, PhaseError> {
    env.storage()
        .persistent()
        .get(&EconKey::Endowment(id))
        .ok_or(PhaseError::EndowmentNotFound)
}

fn save_endowment(env: &Env, e: &Endowment) {
    env.storage().persistent().set(&EconKey::Endowment(e.id), e);
}

fn load_bond(env: &Env, listing_ref: &BytesN<32>) -> Result<ListingBond, PhaseError> {
    env.storage()
        .persistent()
        .get(&EconKey::Bond(listing_ref.clone()))
        .ok_or(PhaseError::BondNotFound)
}

fn save_bond(env: &Env, b: &ListingBond) {
    env.storage()
        .persistent()
        .set(&EconKey::Bond(b.listing_ref.clone()), b);
}

/// Freezes vesting at `now` and returns the unvested yield to the donor.
fn revoke_endowment(env: &Env, e: &mut Endowment, now: u64) {
    let vested = vested_yield(e, now);
    let unvested = e.yield_deposited.saturating_sub(vested);
    e.revoked_vested = vested;
    e.revoked_at = now.max(1);
    if unvested > 0 {
        token::Client::new(env, &e.token).transfer(
            &env.current_contract_address(),
            &e.donor,
            &unvested,
        );
    }
}

#[contractimpl]
impl PhaseProtocol {
    // ── Spike 694: collection coins ─────────────────────────────────────────

    /// Creator binds an existing SAC/token as the fan coin for one of their collections.
    /// For `claim_fan_reward` to mint, the coin's SAC admin must be this contract.
    pub fn register_collection_coin(
        env: Env,
        creator: Address,
        collection_id: u64,
        coin: Address,
        reward_per_nft: i128,
    ) -> Result<(), PhaseError> {
        creator.require_auth();
        let settings: CollectionSettings = env
            .storage()
            .persistent()
            .get(&DataKey::Collection(collection_id))
            .ok_or(PhaseError::InvalidCollection)?;
        if settings.creator != creator {
            return Err(PhaseError::NotAuthorized);
        }
        if reward_per_nft <= 0 || reward_per_nft > COIN_MAX_REWARD {
            return Err(PhaseError::InvalidAmount);
        }
        // A coin may never impersonate the settlement token or back two collections.
        if coin == authorized_token(&env) {
            return Err(PhaseError::UnauthorizedToken);
        }
        if env.storage().persistent().has(&EconKey::CollectionCoin(collection_id))
            || env.storage().persistent().has(&EconKey::CoinToCollection(coin.clone()))
        {
            return Err(PhaseError::CoinAlreadyRegistered);
        }
        let record = CollectionCoin {
            collection_id,
            coin: coin.clone(),
            creator: creator.clone(),
            reward_per_nft,
            verified: false,
            registered_at: env.ledger().timestamp(),
            minted: 0,
            redeemed: 0,
        };
        env.storage()
            .persistent()
            .set(&EconKey::CollectionCoin(collection_id), &record);
        env.storage()
            .persistent()
            .set(&EconKey::CoinToCollection(coin.clone()), &collection_id);
        env.events().publish(
            (Symbol::new(&env, "coin_registered"), creator),
            (collection_id, coin, reward_per_nft),
        );
        Ok(())
    }

    /// Admin verification badge. Unverified coins cannot mint fan rewards.
    pub fn verify_collection_coin(
        env: Env,
        collection_id: u64,
        verified: bool,
    ) -> Result<(), PhaseError> {
        admin(&env).require_auth();
        let mut record: CollectionCoin = env
            .storage()
            .persistent()
            .get(&EconKey::CollectionCoin(collection_id))
            .ok_or(PhaseError::CoinNotRegistered)?;
        record.verified = verified;
        env.storage()
            .persistent()
            .set(&EconKey::CollectionCoin(collection_id), &record);
        env.events().publish(
            (Symbol::new(&env, "coin_verified"), collection_id),
            verified,
        );
        Ok(())
    }

    pub fn get_collection_coin(env: Env, collection_id: u64) -> Option<CollectionCoin> {
        env.storage()
            .persistent()
            .get(&EconKey::CollectionCoin(collection_id))
    }

    pub fn get_coin_collection_id(env: Env, coin: Address) -> Option<u64> {
        env.storage().persistent().get(&EconKey::CoinToCollection(coin))
    }

    /// Current owner of `token_id` claims the collection's fan reward. Keyed on the NFT,
    /// not the wallet, so transferring the NFT around cannot farm repeated rewards.
    pub fn claim_fan_reward(env: Env, user: Address, token_id: u64) -> Result<i128, PhaseError> {
        user.require_auth();
        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenOwner(token_id))
            .ok_or(PhaseError::NftNotFound)?;
        if owner != user {
            return Err(PhaseError::NotNftOwner);
        }
        let collection_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::TokenCollection(token_id))
            .ok_or(PhaseError::InvalidCollection)?;
        let mut record: CollectionCoin = env
            .storage()
            .persistent()
            .get(&EconKey::CollectionCoin(collection_id))
            .ok_or(PhaseError::CoinNotRegistered)?;
        if !record.verified {
            return Err(PhaseError::CoinNotVerified);
        }
        let claimed_key = EconKey::FanRewardClaimed(token_id);
        if env.storage().persistent().has(&claimed_key) {
            return Err(PhaseError::RewardAlreadyClaimed);
        }
        // Mark before the external call so a re-entrant mint cannot double-claim.
        env.storage().persistent().set(&claimed_key, &user);
        token::StellarAssetClient::new(&env, &record.coin).mint(&user, &record.reward_per_nft);
        record.minted = record.minted.saturating_add(record.reward_per_nft);
        env.storage()
            .persistent()
            .set(&EconKey::CollectionCoin(collection_id), &record);
        env.events().publish(
            (Symbol::new(&env, "fan_reward"), user),
            (collection_id, token_id, record.reward_per_nft),
        );
        Ok(record.reward_per_nft)
    }

    pub fn is_fan_reward_claimed(env: Env, token_id: u64) -> bool {
        env.storage()
            .persistent()
            .has(&EconKey::FanRewardClaimed(token_id))
    }

    /// Holder burns coins to redeem an off-chain perk; the burn event is the receipt.
    pub fn redeem_collection_coin(
        env: Env,
        holder: Address,
        collection_id: u64,
        amount: i128,
    ) -> Result<(), PhaseError> {
        holder.require_auth();
        if amount <= 0 {
            return Err(PhaseError::InvalidAmount);
        }
        let mut record: CollectionCoin = env
            .storage()
            .persistent()
            .get(&EconKey::CollectionCoin(collection_id))
            .ok_or(PhaseError::CoinNotRegistered)?;
        token::Client::new(&env, &record.coin).burn(&holder, &amount);
        record.redeemed = record.redeemed.saturating_add(amount);
        env.storage()
            .persistent()
            .set(&EconKey::CollectionCoin(collection_id), &record);
        env.events().publish(
            (Symbol::new(&env, "coin_redeemed"), holder),
            (collection_id, amount),
        );
        Ok(())
    }

    // ── Spike 697: P2P signal tips ──────────────────────────────────────────

    /// Splits `amount` PHASELQ from `tipper` across `recipients` by `shares_bps` (sum 10000)
    /// after `TIP_FEE_BP` to the treasury. Rounding dust goes to the first recipient.
    pub fn tip_signal(
        env: Env,
        tipper: Address,
        tip_id: BytesN<32>,
        recipients: Vec<Address>,
        shares_bps: Vec<u32>,
        amount: i128,
    ) -> Result<i128, PhaseError> {
        tipper.require_auth();
        if amount < TIP_MIN_STROOPS {
            return Err(PhaseError::TipBelowMinimum);
        }
        let n = recipients.len();
        if n == 0 || n > TIP_MAX_RECIPIENTS || n != shares_bps.len() {
            return Err(PhaseError::InvalidSplit);
        }
        let used_key = EconKey::TipUsed(tip_id.clone());
        if env.storage().persistent().has(&used_key) {
            return Err(PhaseError::TipReplay);
        }
        let mut total_bps: u32 = 0;
        for i in 0..n {
            let r = recipients.get_unchecked(i);
            if r == tipper {
                return Err(PhaseError::SelfDeal);
            }
            for j in 0..i {
                if recipients.get_unchecked(j) == r {
                    return Err(PhaseError::InvalidSplit);
                }
            }
            let bps = shares_bps.get_unchecked(i);
            if bps == 0 {
                return Err(PhaseError::InvalidSplit);
            }
            total_bps = total_bps.saturating_add(bps);
        }
        if total_bps != BPS_DENOM as u32 {
            return Err(PhaseError::InvalidSplit);
        }

        env.storage().persistent().set(&used_key, &tipper);

        let client = token::Client::new(&env, &authorized_token(&env));
        let fee = bps_of(amount, TIP_FEE_BP);
        let net = amount - fee;
        let mut paid: i128 = 0;
        let mut shares: Vec<i128> = Vec::new(&env);
        for i in 0..n {
            let share = bps_of(net, shares_bps.get_unchecked(i) as i128);
            shares.push_back(share);
            paid += share;
        }
        let dust = net - paid;
        if fee > 0 {
            client.transfer(&tipper, &treasury(&env), &fee);
        }
        for i in 0..n {
            let mut share = shares.get_unchecked(i);
            if i == 0 {
                share += dust;
            }
            if share > 0 {
                client.transfer(&tipper, &recipients.get_unchecked(i), &share);
            }
        }
        env.events().publish(
            (Symbol::new(&env, "tip"), tipper),
            (tip_id, amount, fee),
        );
        Ok(net)
    }

    pub fn is_tip_used(env: Env, tip_id: BytesN<32>) -> bool {
        env.storage().persistent().has(&EconKey::TipUsed(tip_id))
    }

    // ── Spike 698: creator endowments ───────────────────────────────────────

    /// Donor locks `principal` of the settlement token until `principal_lock_secs` from now.
    /// Only yield later deposited with `fund_endowment_yield` vests to `creator`.
    pub fn create_endowment(
        env: Env,
        donor: Address,
        creator: Address,
        principal: i128,
        principal_lock_secs: u64,
        cliff_secs: u64,
        duration_secs: u64,
    ) -> Result<u64, PhaseError> {
        donor.require_auth();
        if donor == creator {
            return Err(PhaseError::SelfDeal);
        }
        if principal <= 0 {
            return Err(PhaseError::InvalidAmount);
        }
        if duration_secs == 0 || cliff_secs > duration_secs {
            return Err(PhaseError::InvalidSchedule);
        }
        let tok = authorized_token(&env);
        token::Client::new(&env, &tok).transfer(
            &donor,
            &env.current_contract_address(),
            &principal,
        );
        let id: u64 = env
            .storage()
            .persistent()
            .get(&EconKey::EndowmentCounter)
            .unwrap_or(0u64)
            + 1;
        env.storage().persistent().set(&EconKey::EndowmentCounter, &id);
        let now = env.ledger().timestamp();
        let e = Endowment {
            id,
            donor: donor.clone(),
            creator: creator.clone(),
            token: tok,
            principal,
            principal_unlock_at: now.saturating_add(principal_lock_secs),
            principal_withdrawn: false,
            yield_deposited: 0,
            yield_claimed: 0,
            start: now,
            cliff_secs,
            duration_secs,
            revoked_at: 0,
            revoked_vested: 0,
            disputed: false,
        };
        save_endowment(&env, &e);
        env.events().publish(
            (Symbol::new(&env, "endow_created"), donor, creator),
            (id, principal),
        );
        Ok(id)
    }

    /// Yield-source interface (treasury, Blend adapter, or any funder). Adds vestable yield.
    pub fn fund_endowment_yield(
        env: Env,
        funder: Address,
        endowment_id: u64,
        amount: i128,
    ) -> Result<(), PhaseError> {
        funder.require_auth();
        if amount <= 0 {
            return Err(PhaseError::InvalidAmount);
        }
        let mut e = load_endowment(&env, endowment_id)?;
        if e.revoked_at > 0 {
            return Err(PhaseError::EndowmentClosed);
        }
        token::Client::new(&env, &e.token).transfer(
            &funder,
            &env.current_contract_address(),
            &amount,
        );
        e.yield_deposited = e.yield_deposited.saturating_add(amount);
        save_endowment(&env, &e);
        env.events().publish(
            (Symbol::new(&env, "endow_yield"), funder),
            (endowment_id, amount),
        );
        Ok(())
    }

    /// Creator claims vested-but-unclaimed yield. Blocked while a dispute is open.
    pub fn claim_endowment_yield(env: Env, endowment_id: u64) -> Result<i128, PhaseError> {
        let mut e = load_endowment(&env, endowment_id)?;
        e.creator.require_auth();
        if e.disputed {
            return Err(PhaseError::DisputeOpen);
        }
        let claimable = vested_yield(&e, env.ledger().timestamp()).saturating_sub(e.yield_claimed);
        if claimable <= 0 {
            return Err(PhaseError::NothingToClaim);
        }
        e.yield_claimed = e.yield_claimed.saturating_add(claimable);
        save_endowment(&env, &e);
        token::Client::new(&env, &e.token).transfer(
            &env.current_contract_address(),
            &e.creator,
            &claimable,
        );
        env.events().publish(
            (Symbol::new(&env, "endow_claim"), e.creator.clone()),
            (endowment_id, claimable),
        );
        Ok(claimable)
    }

    /// Donor clawback: freezes vesting now and returns unvested yield. Principal stays
    /// locked until `principal_unlock_at` (the donor's commitment).
    pub fn revoke_endowment(env: Env, endowment_id: u64) -> Result<(), PhaseError> {
        let mut e = load_endowment(&env, endowment_id)?;
        e.donor.require_auth();
        if e.revoked_at > 0 {
            return Err(PhaseError::EndowmentClosed);
        }
        revoke_endowment(&env, &mut e, env.ledger().timestamp());
        save_endowment(&env, &e);
        env.events().publish(
            (Symbol::new(&env, "endow_revoked"), e.donor.clone()),
            (endowment_id, e.revoked_vested),
        );
        Ok(())
    }

    pub fn withdraw_endowment_principal(env: Env, endowment_id: u64) -> Result<i128, PhaseError> {
        let mut e = load_endowment(&env, endowment_id)?;
        e.donor.require_auth();
        if e.principal_withdrawn {
            return Err(PhaseError::EndowmentClosed);
        }
        if env.ledger().timestamp() < e.principal_unlock_at {
            return Err(PhaseError::EndowmentLocked);
        }
        if e.disputed {
            return Err(PhaseError::DisputeOpen);
        }
        e.principal_withdrawn = true;
        save_endowment(&env, &e);
        token::Client::new(&env, &e.token).transfer(
            &env.current_contract_address(),
            &e.donor,
            &e.principal,
        );
        env.events().publish(
            (Symbol::new(&env, "endow_withdraw"), e.donor.clone()),
            (endowment_id, e.principal),
        );
        Ok(e.principal)
    }

    /// Donor flags creator inactivity: freezes creator claims until admin resolves.
    pub fn open_endowment_dispute(env: Env, endowment_id: u64) -> Result<(), PhaseError> {
        let mut e = load_endowment(&env, endowment_id)?;
        e.donor.require_auth();
        if e.revoked_at > 0 {
            return Err(PhaseError::EndowmentClosed);
        }
        if e.disputed {
            return Err(PhaseError::DisputeOpen);
        }
        e.disputed = true;
        save_endowment(&env, &e);
        env.events().publish(
            (Symbol::new(&env, "endow_dispute"), e.donor.clone()),
            (endowment_id, true),
        );
        Ok(())
    }

    /// Admin resolution. `uphold = true` revokes (unvested yield back to donor) and unlocks
    /// principal immediately; `false` simply lifts the hold.
    pub fn resolve_endowment_dispute(
        env: Env,
        endowment_id: u64,
        uphold: bool,
    ) -> Result<(), PhaseError> {
        admin(&env).require_auth();
        let mut e = load_endowment(&env, endowment_id)?;
        if !e.disputed {
            return Err(PhaseError::NoOpenChallenge);
        }
        e.disputed = false;
        if uphold {
            let now = env.ledger().timestamp();
            revoke_endowment(&env, &mut e, now);
            e.principal_unlock_at = now;
        }
        save_endowment(&env, &e);
        env.events().publish(
            (Symbol::new(&env, "endow_dispute"), e.donor.clone()),
            (endowment_id, false, uphold),
        );
        Ok(())
    }

    pub fn get_endowment(env: Env, endowment_id: u64) -> Option<Endowment> {
        env.storage().persistent().get(&EconKey::Endowment(endowment_id))
    }

    /// (vested, claimed, locked principal) — what balance UIs show as locked vs liquid.
    pub fn get_endowment_vesting(env: Env, endowment_id: u64) -> Result<(i128, i128, i128), PhaseError> {
        let e = load_endowment(&env, endowment_id)?;
        let locked = if e.principal_withdrawn { 0 } else { e.principal };
        Ok((vested_yield(&e, env.ledger().timestamp()), e.yield_claimed, locked))
    }

    // ── Spike 699: slashable listing bonds ──────────────────────────────────

    /// `listing_ref` = sha256 of the off-chain listing id, so the contract never stores the id.
    pub fn post_listing_bond(
        env: Env,
        seller: Address,
        listing_ref: BytesN<32>,
        amount: i128,
    ) -> Result<(), PhaseError> {
        seller.require_auth();
        if amount < BOND_MIN_STROOPS {
            return Err(PhaseError::InvalidAmount);
        }
        if env.storage().persistent().has(&EconKey::Bond(listing_ref.clone())) {
            return Err(PhaseError::BondAlreadyPosted);
        }
        let tok = authorized_token(&env);
        token::Client::new(&env, &tok).transfer(&seller, &env.current_contract_address(), &amount);
        let now = env.ledger().timestamp();
        let b = ListingBond {
            listing_ref: listing_ref.clone(),
            seller: seller.clone(),
            token: tok,
            amount,
            posted_at: now,
            unlock_at: now.saturating_add(BOND_CHALLENGE_WINDOW_SECS),
            status: BOND_ACTIVE,
            challenger: None,
            challenge_stake: 0,
            evidence: None,
        };
        save_bond(&env, &b);
        env.events().publish(
            (Symbol::new(&env, "bond_posted"), seller),
            (listing_ref, amount),
        );
        Ok(())
    }

    pub fn challenge_listing_bond(
        env: Env,
        challenger: Address,
        listing_ref: BytesN<32>,
        evidence_hash: BytesN<32>,
    ) -> Result<i128, PhaseError> {
        challenger.require_auth();
        let mut b = load_bond(&env, &listing_ref)?;
        if b.status != BOND_ACTIVE {
            return Err(PhaseError::BondNotActive);
        }
        if b.challenger.is_some() {
            return Err(PhaseError::BondChallengeOpen);
        }
        if challenger == b.seller {
            return Err(PhaseError::SelfDeal);
        }
        let stake = bps_of(b.amount, BOND_CHALLENGE_STAKE_BP).max(1);
        token::Client::new(&env, &b.token).transfer(
            &challenger,
            &env.current_contract_address(),
            &stake,
        );
        b.challenger = Some(challenger.clone());
        b.challenge_stake = stake;
        b.evidence = Some(evidence_hash.clone());
        save_bond(&env, &b);
        env.events().publish(
            (Symbol::new(&env, "bond_challenged"), challenger),
            (listing_ref, evidence_hash, stake),
        );
        Ok(stake)
    }

    /// Admin verdict on an open challenge. Rejecting forfeits the challenger stake to the
    /// seller. Slashing takes `slash_bps` of the bond: `compensate_bps` of that goes to the
    /// challenger, the rest to the treasury; the unslashed remainder returns to the seller.
    pub fn adjudicate_listing_bond(
        env: Env,
        listing_ref: BytesN<32>,
        slash: bool,
        slash_bps: u32,
        compensate_bps: u32,
    ) -> Result<u32, PhaseError> {
        admin(&env).require_auth();
        let mut b = load_bond(&env, &listing_ref)?;
        if b.status != BOND_ACTIVE {
            return Err(PhaseError::BondNotActive);
        }
        let challenger = b.challenger.clone().ok_or(PhaseError::NoOpenChallenge)?;
        let client = token::Client::new(&env, &b.token);
        let me = env.current_contract_address();
        if !slash {
            if b.challenge_stake > 0 {
                client.transfer(&me, &b.seller, &b.challenge_stake);
            }
            b.challenger = None;
            b.challenge_stake = 0;
            save_bond(&env, &b);
            env.events().publish(
                (Symbol::new(&env, "bond_adjudicated"), challenger),
                (listing_ref, BOND_ACTIVE, 0i128),
            );
            return Ok(BOND_ACTIVE);
        }
        if slash_bps == 0 || slash_bps as i128 > BPS_DENOM || compensate_bps as i128 > BPS_DENOM {
            return Err(PhaseError::InvalidSplit);
        }
        let slashed = bps_of(b.amount, slash_bps as i128);
        let compensation = bps_of(slashed, compensate_bps as i128);
        let to_treasury = slashed - compensation;
        let to_seller = b.amount - slashed;
        b.status = if compensation > 0 { BOND_COMPENSATED } else { BOND_SLASHED };
        let stake = b.challenge_stake;
        b.challenge_stake = 0;
        save_bond(&env, &b);
        if compensation + stake > 0 {
            client.transfer(&me, &challenger, &(compensation + stake));
        }
        if to_treasury > 0 {
            client.transfer(&me, &treasury(&env), &to_treasury);
        }
        if to_seller > 0 {
            client.transfer(&me, &b.seller, &to_seller);
        }
        env.events().publish(
            (Symbol::new(&env, "bond_adjudicated"), challenger),
            (listing_ref, b.status, slashed),
        );
        Ok(b.status)
    }

    /// Seller recovers the full bond after the challenge window with no open challenge.
    pub fn release_listing_bond(env: Env, listing_ref: BytesN<32>) -> Result<i128, PhaseError> {
        let mut b = load_bond(&env, &listing_ref)?;
        b.seller.require_auth();
        if b.status != BOND_ACTIVE {
            return Err(PhaseError::BondNotActive);
        }
        if b.challenger.is_some() {
            return Err(PhaseError::BondChallengeOpen);
        }
        if env.ledger().timestamp() < b.unlock_at {
            return Err(PhaseError::BondLocked);
        }
        b.status = BOND_RELEASED;
        save_bond(&env, &b);
        token::Client::new(&env, &b.token).transfer(
            &env.current_contract_address(),
            &b.seller,
            &b.amount,
        );
        env.events().publish(
            (Symbol::new(&env, "bond_released"), b.seller.clone()),
            (listing_ref, b.amount),
        );
        Ok(b.amount)
    }

    pub fn get_listing_bond(env: Env, listing_ref: BytesN<32>) -> Option<ListingBond> {
        env.storage().persistent().get(&EconKey::Bond(listing_ref))
    }
}
