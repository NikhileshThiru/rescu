use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    freeze_account, thaw_account, FreezeAccount, Mint, ThawAccount, Token2022, TokenAccount,
};

use crate::{constants::*, error::RescuError, events::WalletFrozen, state::Declaration};

#[derive(Accounts)]
pub struct SetWalletFrozen<'info> {
    /// Oracle or admin.
    pub signer: Signer<'info>,
    #[account(has_one = mint @ RescuError::InvalidAccount)]
    pub declaration: Account<'info, Declaration>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: freeze-authority PDA.
    #[account(seeds = [SEED_AUTHORITY], bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Program<'info, Token2022>,
}

/// Uses Token-2022's native freeze: a frozen account can't send or receive at all, and
/// explorers show it as frozen.
pub fn handle_set_wallet_frozen(ctx: Context<SetWalletFrozen>, frozen: bool) -> Result<()> {
    let decl = &ctx.accounts.declaration;
    let by = ctx.accounts.signer.key();
    require!(by == decl.oracle || by == decl.admin, RescuError::Unauthorized);

    let signer_seeds: &[&[&[u8]]] = &[&[SEED_AUTHORITY, &[ctx.bumps.authority]]];
    let account = ctx.accounts.token_account.to_account_info();
    let mint = ctx.accounts.mint.to_account_info();
    let authority = ctx.accounts.authority.to_account_info();
    if frozen {
        freeze_account(CpiContext::new_with_signer(
            Token2022::id(),
            FreezeAccount { account, mint, authority },
            signer_seeds,
        ))?;
    } else {
        thaw_account(CpiContext::new_with_signer(
            Token2022::id(),
            ThawAccount { account, mint, authority },
            signer_seeds,
        ))?;
    }
    emit!(WalletFrozen {
        token_account: ctx.accounts.token_account.key(),
        frozen,
        by,
    });
    Ok(())
}
