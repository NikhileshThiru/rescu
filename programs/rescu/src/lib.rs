//! Rescu: programmable disaster aid on Solana.
//!
//! One program is the merchant registry, the treasury and the Token-2022 transfer hook.
//! Money moves three ways, none of which is a program-initiated transfer (the hook would
//! re-enter this program and the runtime forbids that):
//! - disburse: `mint_to` into enrolled residents' accounts (no hook)
//! - pay: a plain Token-2022 `transfer_checked` signed by the resident or their agent delegate
//! - clawback: permanent-delegate burn after expiry (no hook)

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use spl_discriminator::SplDiscriminate;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("GrxgRShVcGaESyztvHHtaCF8YMXVhK3Wq7AesbQCaLy5");

#[program]
pub mod rescu {
    use super::*;

    pub fn init_declaration(ctx: Context<InitDeclaration>, params: DeclarationParams) -> Result<()> {
        instructions::init_declaration::handle_init_declaration(ctx, params)
    }

    pub fn set_clock(ctx: Context<AdminUpdate>, time_scale: u32, sim_now: i64) -> Result<()> {
        instructions::admin::handle_set_clock(ctx, time_scale, sim_now)
    }

    pub fn update_rules(ctx: Context<AdminUpdate>, params: RulesParams) -> Result<()> {
        instructions::admin::handle_update_rules(ctx, params)
    }

    pub fn register_merchant(
        ctx: Context<RegisterMerchant>,
        category: u8,
        h3_cell: u64,
        approved: bool,
    ) -> Result<()> {
        instructions::merchant::handle_register_merchant(ctx, category, h3_cell, approved)
    }

    pub fn set_merchant_status(ctx: Context<SetMerchantStatus>, status: MerchantStatus) -> Result<()> {
        instructions::merchant::handle_set_merchant_status(ctx, status)
    }

    pub fn enroll_resident(ctx: Context<EnrollResident>, household_id: u64) -> Result<()> {
        instructions::resident::handle_enroll_resident(ctx, household_id)
    }

    pub fn disburse<'info>(ctx: Context<'info, Disburse<'info>>, amounts: Vec<u64>) -> Result<()> {
        instructions::resident::handle_disburse(ctx, amounts)
    }

    pub fn set_wallet_frozen(ctx: Context<SetWalletFrozen>, frozen: bool) -> Result<()> {
        instructions::oracle::handle_set_wallet_frozen(ctx, frozen)
    }

    pub fn clawback(ctx: Context<Clawback>) -> Result<()> {
        instructions::clawback::handle_clawback(ctx)
    }

    /// Token-2022 calls this on every relief-dollar transfer.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        instructions::transfer_hook::handle_transfer_hook(ctx, amount)
    }
}
