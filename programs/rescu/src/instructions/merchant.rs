use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::RescuError,
    events::{MerchantRegistered, MerchantStatusChanged},
    state::{Declaration, Merchant, MerchantStatus},
};

#[derive(Accounts)]
pub struct RegisterMerchant<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub admin: Signer<'info>,
    #[account(has_one = admin @ RescuError::Unauthorized)]
    pub declaration: Account<'info, Declaration>,
    /// CHECK: the merchant's wallet; only its address is recorded.
    pub owner: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Merchant::INIT_SPACE,
        seeds = [SEED_MERCHANT, owner.key().as_ref()],
        bump,
    )]
    pub merchant: Account<'info, Merchant>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_merchant(
    ctx: Context<RegisterMerchant>,
    category: u8,
    h3_cell: u64,
    approved: bool,
) -> Result<()> {
    require!(category <= 3, RescuError::InvalidArgument);
    let zone = ctx.accounts.declaration.mint;
    ctx.accounts.merchant.set_inner(Merchant {
        owner: ctx.accounts.owner.key(),
        zone,
        status: if approved { MerchantStatus::Approved } else { MerchantStatus::Pending },
        category,
        h3_cell,
        bump: ctx.bumps.merchant,
    });
    emit!(MerchantRegistered {
        merchant: ctx.accounts.merchant.key(),
        owner: ctx.accounts.owner.key(),
        zone,
        category,
        h3_cell,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetMerchantStatus<'info> {
    /// Oracle (suspend / reinstate) or admin.
    pub authority: Signer<'info>,
    pub declaration: Account<'info, Declaration>,
    #[account(mut, constraint = merchant.zone == declaration.mint @ RescuError::OutOfZone)]
    pub merchant: Account<'info, Merchant>,
}

pub fn handle_set_merchant_status(ctx: Context<SetMerchantStatus>, status: MerchantStatus) -> Result<()> {
    let decl = &ctx.accounts.declaration;
    let by = ctx.accounts.authority.key();
    require!(by == decl.oracle || by == decl.admin, RescuError::Unauthorized);
    ctx.accounts.merchant.status = status;
    emit!(MerchantStatusChanged {
        merchant: ctx.accounts.merchant.key(),
        status: status as u8,
        by,
    });
    Ok(())
}
