use anchor_lang::prelude::*;

#[event]
pub struct DeclarationCreated {
    pub declaration: Pubkey,
    pub mint: Pubkey,
    pub id: u64,
    pub budget: u64,
    pub expires_at: i64,
}

#[event]
pub struct ClockSet {
    pub declaration: Pubkey,
    pub time_scale: u32,
    pub sim_now: i64,
}

#[event]
pub struct RulesUpdated {
    pub declaration: Pubkey,
    pub per_order_cap: u64,
    pub daily_cap: u64,
    pub expires_at: i64,
    pub active: bool,
}

#[event]
pub struct MerchantRegistered {
    pub merchant: Pubkey,
    pub owner: Pubkey,
    pub zone: Pubkey,
    pub category: u8,
    pub h3_cell: u64,
}

#[event]
pub struct MerchantStatusChanged {
    pub merchant: Pubkey,
    pub status: u8,
    pub by: Pubkey,
}

#[event]
pub struct ResidentEnrolled {
    pub wallet: Pubkey,
    pub owner: Pubkey,
    pub token_account: Pubkey,
    pub household_id: u64,
}

#[event]
pub struct AidDisbursed {
    pub declaration: Pubkey,
    pub recipients: u32,
    pub total: u64,
}

#[event]
pub struct WalletFrozen {
    pub token_account: Pubkey,
    pub frozen: bool,
    pub by: Pubkey,
}

#[event]
pub struct AidClawedBack {
    pub token_account: Pubkey,
    pub amount: u64,
}
