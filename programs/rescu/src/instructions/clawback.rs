use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    burn_checked, thaw_account, BurnChecked, Mint, ThawAccount, Token2022, TokenAccount,
};

use crate::{
    constants::*,
    error::RescuError,
    events::AidClawedBack,
    state::{Declaration, WalletState},
};

#[derive(Accounts)]
pub struct Clawback<'info> {
    /// Anyone can crank this once aid has expired; funds can only be burned, never redirected.
    pub caller: Signer<'info>,
    #[account(mut, has_one = mint @ RescuError::InvalidAccount)]
    pub declaration: Account<'info, Declaration>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: permanent-delegate + freeze-authority PDA.
    #[account(seeds = [SEED_AUTHORITY], bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,
    /// Only resident balances are clawed back; merchants keep what they earned.
    #[account(
        seeds = [SEED_WALLET, token_account.key().as_ref()],
        bump = wallet.bump,
    )]
    pub wallet: Account<'info, WalletState>,
    pub token_program: Program<'info, Token2022>,
}

/// Returns unspent aid to the treasury after expiry by burning it with the permanent
/// delegate (the relief dollar is backed 1:1, so burning releases the backing).
pub fn handle_clawback(ctx: Context<Clawback>) -> Result<()> {
    let now = ctx.accounts.declaration.sim_now(Clock::get()?.unix_timestamp);
    require!(now >= ctx.accounts.declaration.expires_at, RescuError::ClawbackTooEarly);

    let amount = ctx.accounts.token_account.amount;
    if amount == 0 {
        return Ok(());
    }

    let signer_seeds: &[&[&[u8]]] = &[&[SEED_AUTHORITY, &[ctx.bumps.authority]]];
    // Token-2022 refuses to burn from a frozen account, even for the permanent delegate.
    if ctx.accounts.token_account.is_frozen() {
        thaw_account(CpiContext::new_with_signer(
            Token2022::id(),
            ThawAccount {
                account: ctx.accounts.token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
            signer_seeds,
        ))?;
    }
    burn_checked(
        CpiContext::new_with_signer(
            Token2022::id(),
            BurnChecked {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.token_account.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        DECIMALS,
    )?;

    let decl = &mut ctx.accounts.declaration;
    decl.returned = decl.returned.checked_add(amount).ok_or(RescuError::MathOverflow)?;
    emit!(AidClawedBack {
        token_account: ctx.accounts.token_account.key(),
        amount,
    });
    Ok(())
}
