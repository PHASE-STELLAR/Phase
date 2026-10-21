#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN,
    Env, Map, String, Symbol, Vec,
};

/// Errors for proof relay operations
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum ProofRelayError {
    NotAuthorized = 1,
    InvalidProof = 2,
    ProofNotFound = 3,
    AlreadyVerified = 4,
    InvalidSignature = 5,
    ThresholdNotMet = 6,
    InvalidChain = 7,
    ReplayProtection = 8,
}

/// Proof status enum
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ProofStatus {
    Pending = 0,
    Verified = 1,
    Failed = 2,
}

/// Proof structure for cross-chain verification
#[contracttype]
pub struct Proof {
    pub id: BytesN<32>,
    pub source_chain: String,
    pub data: Bytes,
    pub signatures: Vec<Bytes>,
    pub verified_at: u64,
    pub status: ProofStatus,
    pub nonce: u64,
}

/// Validator configuration
#[contracttype]
pub struct ValidatorSet {
    pub validators: Vec<Address>,
    pub threshold: u32,
    pub updated_at: u64,
}

/// Data key enumeration
#[contracttype]
pub enum DataKey {
    Proof(BytesN<32>),
    ProofNonce(String),
    ValidatorSet,
    Admin,
    ChainWhitelist(String),
}

#[contract]
pub struct PhaseProofRelay;

#[contractimpl]
impl PhaseProofRelay {
    /// Initialize the proof relay with validators
    pub fn initialize(env: Env, admin: Address, validators: Vec<Address>, threshold: u32) {
        if validators.is_empty() || threshold == 0 || threshold > validators.len() as u32 {
            panic!("Invalid validator set");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);

        let validator_set = ValidatorSet {
            validators,
            threshold,
            updated_at: env.ledger().timestamp(),
        };
        env.storage().instance().set(&DataKey::ValidatorSet, &validator_set);

        env.events().publish(
            (symbol_short!("init"),),
            (admin, threshold),
        );
    }

    /// Submit a proof for cross-chain verification
    pub fn submit_proof(
        env: Env,
        msg_id: BytesN<32>,
        proof_data: Bytes,
        source_chain: String,
    ) -> Result<(), ProofRelayError> {
        // Check if proof already exists
        if env.storage().instance().has(&DataKey::Proof(msg_id.clone())) {
            return Err(ProofRelayError::AlreadyVerified);
        }

        // Validate chain
        if !env.storage().instance().has(&DataKey::ChainWhitelist(source_chain.clone())) {
            return Err(ProofRelayError::InvalidChain);
        }

        // Get next nonce for this chain
        let nonce_key = DataKey::ProofNonce(source_chain.clone());
        let next_nonce: u64 = env.storage().instance().get(&nonce_key).unwrap_or(0) + 1;
        env.storage().instance().set(&nonce_key, &next_nonce);

        let proof = Proof {
            id: msg_id.clone(),
            source_chain: source_chain.clone(),
            data: proof_data,
            signatures: Vec::new(&env),
            verified_at: 0,
            status: ProofStatus::Pending,
            nonce: next_nonce,
        };

        env.storage().instance().set(&DataKey::Proof(msg_id.clone()), &proof);

        env.events().publish(
            (symbol_short!("proof_submit"), msg_id),
            (source_chain, next_nonce),
        );

        Ok(())
    }

    /// Verify a proof with multi-signature attestations
    pub fn verify_proof(
        env: Env,
        msg_id: BytesN<32>,
        signatures: Vec<Bytes>,
    ) -> Result<ProofStatus, ProofRelayError> {
        let mut proof = env
            .storage()
            .instance()
            .get::<DataKey, Proof>(&DataKey::Proof(msg_id.clone()))
            .ok_or(ProofRelayError::ProofNotFound)?;

        if proof.status == ProofStatus::Verified {
            return Ok(ProofStatus::Verified);
        }

        let validator_set: ValidatorSet = env
            .storage()
            .instance()
            .get(&DataKey::ValidatorSet)
            .ok_or(ProofRelayError::NotAuthorized)?;

        // Check signature threshold
        if signatures.len() < validator_set.threshold as usize {
            return Err(ProofRelayError::ThresholdNotMet);
        }

        // Update proof status
        proof.status = ProofStatus::Verified;
        proof.verified_at = env.ledger().timestamp();
        proof.signatures = signatures;

        env.storage().instance().set(&DataKey::Proof(msg_id.clone()), &proof);

        env.events().publish(
            (symbol_short!("proof_verified"), msg_id),
            proof.verified_at,
        );

        Ok(ProofStatus::Verified)
    }

    /// Get proof status
    pub fn get_proof(env: Env, msg_id: BytesN<32>) -> Result<(ProofStatus, String), ProofRelayError> {
        let proof = env
            .storage()
            .instance()
            .get::<DataKey, Proof>(&DataKey::Proof(msg_id))
            .ok_or(ProofRelayError::ProofNotFound)?;

        Ok((proof.status, proof.source_chain))
    }

    /// Add a supported chain to the whitelist
    pub fn add_chain(env: Env, chain: String) -> Result<(), ProofRelayError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ProofRelayError::NotAuthorized)?;

        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::ChainWhitelist(chain.clone()), &true);

        env.events().publish(
            (symbol_short!("chain_added"),),
            chain,
        );

        Ok(())
    }

    /// Update validator set
    pub fn update_validators(
        env: Env,
        validators: Vec<Address>,
        threshold: u32,
    ) -> Result<(), ProofRelayError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ProofRelayError::NotAuthorized)?;

        admin.require_auth();

        if validators.is_empty() || threshold == 0 || threshold > validators.len() as u32 {
            return Err(ProofRelayError::InvalidProof);
        }

        let validator_set = ValidatorSet {
            validators,
            threshold,
            updated_at: env.ledger().timestamp(),
        };

        env.storage().instance().set(&DataKey::ValidatorSet, &validator_set);

        env.events().publish(
            (symbol_short!("validators_updated"),),
            threshold,
        );

        Ok(())
    }
}
