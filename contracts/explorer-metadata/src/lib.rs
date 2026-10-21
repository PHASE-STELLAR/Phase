#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String, Symbol,
};

/// Errors for explorer metadata operations
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum ExplorerError {
    NotAuthorized = 1,
    NotFound = 2,
    InvalidMetadata = 3,
}

/// Explorer metadata for NFT collections
#[contracttype]
pub struct ExplorerMetadata {
    pub verified_issuer: Address,
    pub collection_name: String,
    pub creator: Address,
    pub created_at: u64,
    pub external_url: String,
    pub verified: bool,
}

/// Data key enumeration
#[contracttype]
pub enum DataKey {
    CollectionMetadata(u64),
    Admin,
}

#[contract]
pub struct PhaseExplorerMetadata;

#[contractimpl]
impl PhaseExplorerMetadata {
    /// Initialize the explorer metadata contract
    pub fn initialize(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.events().publish(
            (symbol_short!("init"),),
            admin,
        );
    }

    /// Set explorer metadata for a collection
    pub fn set_explorer_metadata(
        env: Env,
        caller: Address,
        collection_id: u64,
        collection_name: String,
        external_url: String,
    ) -> Result<(), ExplorerError> {
        caller.require_auth();

        // Validate inputs
        if collection_name.len() == 0 || external_url.len() == 0 {
            return Err(ExplorerError::InvalidMetadata);
        }

        let metadata = ExplorerMetadata {
            verified_issuer: caller.clone(),
            collection_name: collection_name.clone(),
            creator: caller.clone(),
            created_at: env.ledger().timestamp(),
            external_url: external_url.clone(),
            verified: false,
        };

        env.storage()
            .instance()
            .set(&DataKey::CollectionMetadata(collection_id), &metadata);

        env.events().publish(
            (symbol_short!("metadata_set"), collection_id),
            (caller, collection_name),
        );

        Ok(())
    }

    /// Verify a collection's metadata (admin only)
    pub fn verify_collection(
        env: Env,
        collection_id: u64,
    ) -> Result<(), ExplorerError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ExplorerError::NotAuthorized)?;

        admin.require_auth();

        let mut metadata = env
            .storage()
            .instance()
            .get::<DataKey, ExplorerMetadata>(&DataKey::CollectionMetadata(collection_id))
            .ok_or(ExplorerError::NotFound)?;

        metadata.verified = true;

        env.storage()
            .instance()
            .set(&DataKey::CollectionMetadata(collection_id), &metadata);

        env.events().publish(
            (symbol_short!("collection_verified"), collection_id),
            admin,
        );

        Ok(())
    }

    /// Get explorer metadata for a collection
    pub fn get_metadata(
        env: Env,
        collection_id: u64,
    ) -> Result<(String, String, bool), ExplorerError> {
        let metadata = env
            .storage()
            .instance()
            .get::<DataKey, ExplorerMetadata>(&DataKey::CollectionMetadata(collection_id))
            .ok_or(ExplorerError::NotFound)?;

        Ok((
            metadata.collection_name,
            metadata.external_url,
            metadata.verified,
        ))
    }

    /// Check if a collection is verified
    pub fn is_verified(env: Env, collection_id: u64) -> Result<bool, ExplorerError> {
        let metadata = env
            .storage()
            .instance()
            .get::<DataKey, ExplorerMetadata>(&DataKey::CollectionMetadata(collection_id))
            .ok_or(ExplorerError::NotFound)?;

        Ok(metadata.verified)
    }
}
