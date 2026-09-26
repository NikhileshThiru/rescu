use anchor_lang::prelude::*;

/// Relief dollars mirror USDC: 6 decimals, 1_000_000 base units = $1.
#[constant]
pub const DECIMALS: u8 = 6;

/// Program-wide PDA that is mint, freeze and permanent-delegate authority for every relief mint.
#[constant]
pub const SEED_AUTHORITY: &[u8] = b"authority";
#[constant]
pub const SEED_MINT: &[u8] = b"mint";
#[constant]
pub const SEED_DECLARATION: &[u8] = b"decl";
#[constant]
pub const SEED_WALLET: &[u8] = b"wallet";
#[constant]
pub const SEED_MERCHANT: &[u8] = b"merchant";
/// Fixed by the transfer hook interface.
#[constant]
pub const SEED_EXTRA_ACCOUNT_METAS: &[u8] = b"extra-account-metas";

/// Rolling spend window: 24 one-hour buckets.
#[constant]
pub const WINDOW_HOURS: u8 = 24;
pub const SECONDS_PER_HOUR: i64 = 3_600;

pub const MAX_NAME_LEN: usize = 32;
