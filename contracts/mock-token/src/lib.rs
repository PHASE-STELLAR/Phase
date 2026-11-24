#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, String, Symbol,
};

/// Token errors (SEP-41 compliant)
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TokenError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InsufficientBalance = 3,
    InsufficientAllowance = 4,
    Unauthorized = 5,
    ExpiredAllowance = 6,
    InvalidAmount = 7,
    MintDisabled = 8,
}

/// Estructura para metadatos del token
#[contracttype]
pub struct TokenMetadata {
    pub decimal: u32,
    pub name: String,
    pub symbol: String,
}

/// Allowance entry with expiry
#[contracttype]
pub struct AllowanceEntry {
    pub amount: i128,
    pub expiry_ledger: u32,
}

/// Token storage keys
#[contracttype]
pub enum DataKey {
    Admin,
    Initialized,
    TotalSupply,
    Metadata,
    Balance(Address),
    Allowance(Address, Address),
    MainnetKillSwitch,
}

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    /// Inicializa el token mock con metadatos
    ///
    /// # Arguments
    /// * `env` - Entorno de ejecución
    /// * `admin` - Dirección del administrador (puede hacer mint)
    /// * `decimals` - Número de decimales (ej: 7 para Stellar)
    /// * `name` - Nombre del token
    /// * `symbol` - Símbolo del token
    pub fn initialize(
        env: Env,
        admin: Address,
        decimals: u32,
        name: String,
        symbol: String,
    ) -> Result<(), TokenError> {
        // Verificar que no esté inicializado
        if Self::is_initialized(env.clone()) {
            return Err(TokenError::AlreadyInitialized);
        }

        // Guardar admin
        env.storage().persistent().set(&DataKey::Admin, &admin);

        // Configurar metadatos del token
        let metadata = TokenMetadata {
            decimal: decimals,
            name: name.clone(),
            symbol: symbol.clone(),
        };
        env.storage().persistent().set(&DataKey::Metadata, &metadata);

        // Inicializar supply en 0
        env.storage().persistent().set(&DataKey::TotalSupply, &0i128);

        // Marcar como inicializado
        env.storage().persistent().set(&DataKey::Initialized, &true);

        // Emitir evento de inicialización
        env.events().publish(
            (Symbol::new(&env, "initialized"), admin.clone()),
            (name, symbol, decimals),
        );

        Ok(())
    }

    /// Verifica si el token está inicializado
    pub fn is_initialized(env: Env) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Initialized)
            .unwrap_or(false)
    }

    /// Acuña (mint) nuevos tokens para una dirección
    /// Solo el admin puede llamar esta función
    ///
    /// # Arguments
    /// * `env` - Entorno de ejecución
    /// * `to` - Dirección que recibirá los tokens
    /// * `amount` - Cantidad a acuñar
    pub fn mint(env: Env, to: Address, amount: i128) -> Result<(), TokenError> {
        // Verificar que esté inicializado
        if !Self::is_initialized(env.clone()) {
            return Err(TokenError::NotInitialized);
        }

        // Verificar que el admin firme
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();

        // Verificar que amount sea positivo
        if amount <= 0 {
            return Err(TokenError::MintLimitExceeded);
        }

        // Actualizar balance del destinatario
        let current_balance = Self::balance(env.clone(), to.clone());
        let new_balance = current_balance
            .checked_add(amount)
            .expect("Balance overflow");

        env.storage()
            .persistent()
            .set(&DataKey::Balance(to.clone()), &new_balance);

        // Actualizar total supply
        let current_supply: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        let new_supply = current_supply.checked_add(amount).expect("Supply overflow");

        env.storage()
            .persistent()
            .set(&DataKey::TotalSupply, &new_supply);

        // Emitir evento de mint
        env.events().publish(
            (Symbol::new(&env, "mint"), admin),
            (to.clone(), amount),
        );

        Ok(())
    }

    /// Public mint (testnet only, gated on mainnet)
    pub fn mint_public(env: Env, to: Address, amount: i128) -> Result<(), TokenError> {
        if !Self::is_initialized(env.clone()) {
            return Err(TokenError::NotInitialized);
        }

        // Mainnet kill-switch check
        let kill_switch: bool = env
            .storage()
            .persistent()
            .get(&DataKey::MainnetKillSwitch)
            .unwrap_or(false);
        if kill_switch {
            return Err(TokenError::MintDisabled);
        }

        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }

        to.require_auth();

        let current_balance = Self::balance(env.clone(), to.clone());
        let new_balance = current_balance
            .checked_add(amount)
            .ok_or(TokenError::InsufficientBalance)?;

        env.storage()
            .persistent()
            .set(&DataKey::Balance(to.clone()), &new_balance);

        let current_supply: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        let new_supply = current_supply
            .checked_add(amount)
            .ok_or(TokenError::InsufficientBalance)?;

        env.storage()
            .persistent()
            .set(&DataKey::TotalSupply, &new_supply);

        env.events().publish(
            (Symbol::new(&env, "mint"), to.clone()),
            amount,
        );

        Ok(())
    }

    /// Obtiene el balance de una dirección
    pub fn balance(env: Env, address: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(address))
            .unwrap_or(0)
    }

    /// Obtiene el total supply del token
    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    /// Obtiene el administrador del token
    pub fn admin(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Admin)
    }

    /// Transfer tokens (SEP-41 compliant)
    pub fn transfer(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), TokenError> {
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }

        from.require_auth();

        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            return Err(TokenError::InsufficientBalance);
        }

        let new_from_balance = from_balance - amount;
        let to_balance = Self::balance(env.clone(), to.clone());
        let new_to_balance = to_balance
            .checked_add(amount)
            .ok_or(TokenError::InsufficientBalance)?;

        env.storage()
            .persistent()
            .set(&DataKey::Balance(from.clone()), &new_from_balance);
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to.clone()), &new_to_balance);

        env.events().publish(
            (Symbol::new(&env, "transfer"), from),
            (to, amount),
        );

        Ok(())
    }

    /// Approve spender with optional expiry (SEP-41 compliant)
    pub fn approve(
        env: Env,
        owner: Address,
        spender: Address,
        amount: i128,
        expiry_ledger: u32,
    ) -> Result<(), TokenError> {
        if amount < 0 {
            return Err(TokenError::InvalidAmount);
        }

        owner.require_auth();

        let entry = AllowanceEntry {
            amount,
            expiry_ledger,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Allowance(owner.clone(), spender.clone()), &entry);

        env.events().publish(
            (Symbol::new(&env, "approve"), owner),
            (spender, amount),
        );

        Ok(())
    }

    /// Get allowance (returns 0 if expired)
    pub fn allowance(env: Env, owner: Address, spender: Address) -> i128 {
        if let Some(entry) = env
            .storage()
            .persistent()
            .get::<_, AllowanceEntry>(&DataKey::Allowance(owner, spender))
        {
            let current_ledger = env.ledger().sequence();
            if current_ledger > entry.expiry_ledger {
                return 0;
            }
            entry.amount
        } else {
            0
        }
    }

    /// Transfer tokens using allowance (SEP-41 compliant)
    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), TokenError> {
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }

        let current_allowance = Self::allowance(env.clone(), from.clone(), spender.clone());
        if current_allowance < amount {
            return Err(TokenError::InsufficientAllowance);
        }

        spender.require_auth();

        let new_allowance = current_allowance - amount;
        if let Some(entry) = env
            .storage()
            .persistent()
            .get::<_, AllowanceEntry>(&DataKey::Allowance(from.clone(), spender.clone()))
        {
            let updated = AllowanceEntry {
                amount: new_allowance,
                expiry_ledger: entry.expiry_ledger,
            };
            env.storage()
                .persistent()
                .set(&DataKey::Allowance(from.clone(), spender), &updated);
        }

        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            return Err(TokenError::InsufficientBalance);
        }

        let new_from_balance = from_balance - amount;
        let to_balance = Self::balance(env.clone(), to.clone());
        let new_to_balance = to_balance
            .checked_add(amount)
            .ok_or(TokenError::InsufficientBalance)?;

        env.storage()
            .persistent()
            .set(&DataKey::Balance(from.clone()), &new_from_balance);
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to.clone()), &new_to_balance);

        env.events().publish(
            (Symbol::new(&env, "transfer"), from),
            (to, amount),
        );

        Ok(())
    }

    /// Burn tokens (SEP-41 compliant)
    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), TokenError> {
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }

        from.require_auth();

        let balance = Self::balance(env.clone(), from.clone());
        if balance < amount {
            return Err(TokenError::InsufficientBalance);
        }

        let new_balance = balance - amount;
        env.storage()
            .persistent()
            .set(&DataKey::Balance(from.clone()), &new_balance);

        let current_supply: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        let new_supply = current_supply - amount;

        env.storage()
            .persistent()
            .set(&DataKey::TotalSupply, &new_supply);

        env.events().publish(
            (Symbol::new(&env, "burn"), from),
            amount,
        );

        Ok(())
    }

    /// Clawback tokens (admin only, SEP-41 compliant)
    pub fn clawback(env: Env, from: Address, amount: i128) -> Result<(), TokenError> {
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }

        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(TokenError::Unauthorized)?;

        admin.require_auth();

        let balance = Self::balance(env.clone(), from.clone());
        if balance < amount {
            return Err(TokenError::InsufficientBalance);
        }

        let new_balance = balance - amount;
        env.storage()
            .persistent()
            .set(&DataKey::Balance(from.clone()), &new_balance);

        env.events().publish(
            (Symbol::new(&env, "clawback"), from),
            amount,
        );

        Ok(())
    }

    /// Set admin (admin only)
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), TokenError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(TokenError::Unauthorized)?;

        admin.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::Admin, &new_admin);

        env.events().publish(
            (Symbol::new(&env, "set_admin"), admin),
            new_admin,
        );

        Ok(())
    }

    /// Enable mainnet kill-switch (admin only)
    pub fn enable_mainnet_kill_switch(env: Env) -> Result<(), TokenError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(TokenError::Unauthorized)?;

        admin.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::MainnetKillSwitch, &true);

        env.events().publish(
            (Symbol::new(&env, "mainnet_kill_switch_enabled"), admin),
            (),
        );

        Ok(())
    }

    /// Get token metadata
    pub fn get_metadata(env: Env) -> Option<TokenMetadata> {
        env.storage().persistent().get(&DataKey::Metadata)
    }

    /// Obtiene los decimales del token
    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Metadata)
            .map(|m: TokenMetadata| m.decimal)
            .unwrap_or(7)
    }

    /// Obtiene el nombre del token
    pub fn name(env: Env) -> String {
        env.storage()
            .persistent()
            .get(&DataKey::Metadata)
            .map(|m: TokenMetadata| m.name)
            .unwrap_or_else(|| String::from_str(&env, "MOCK"))
    }

    /// Obtiene el símbolo del token
    pub fn symbol(env: Env) -> String {
        env.storage()
            .persistent()
            .get(&DataKey::Metadata)
            .map(|m: TokenMetadata| m.symbol)
            .unwrap_or_else(|| String::from_str(&env, "MOCK"))
    }

    /// Spike 608: Exposes the pinned Soroban SDK / ABI version (`22000` for soroban-sdk 22.0.0).
    pub fn soroban_abi_version(_env: Env) -> u32 {
        22_000
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let client = MockTokenClient::new(&env, &env.register(MockToken, ()));

        let name = String::from_str(&env, "Mock Token");
        let symbol = String::from_str(&env, "MOCK");

        client.initialize(&admin, &7, &name, &symbol);
        assert!(client.is_initialized());
    }
}
