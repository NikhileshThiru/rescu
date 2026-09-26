use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{mint_to, Mint, MintTo, Token2022, TokenAccount},
};

use crate::{
    constants::*,
    error::RescuError,
    events::{AidDisbursed, ResidentEnrolled},
    state::{Declaration, WalletState},
};

#[derive(Accounts)]
pub struct EnrollResident<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub admin: Signer<'info>,
    #[account(
        has_one = admin @ RescuError::Unauthorized,
        has_one = mint @ RescuError::InvalidAccount,
    )]
    pub declaration: Account<'info, Declaration>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: the resident's wallet address.
    pub owner: UncheckedAccount<'info>,
    /// Must be the resident's associated token account: Token-2022 ATAs carry ImmutableOwner,
    /// so a resident can't sell the whole account by reassigning its owner.
    #[account(
        associated_token::mint = mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + WalletState::INIT_SPACE,
        seeds = [SEED_WALLET, token_account.key().as_ref()],
        bump,
    )]
    pub wallet: Account<'info, WalletState>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_enroll_resident(ctx: Context<EnrollResident>, household_id: u64) -> Result<()> {
    ctx.accounts.wallet.set_inner(WalletState {
        mint: ctx.accounts.mint.key(),
        owner: ctx.accounts.owner.key(),
        token_account: ctx.accounts.token_account.key(),
        household_id,
        last_hour: 0,
        hourly_spend: [0; 24],
        total_spent: 0,
        bump: ctx.bumps.wallet,
    });
    emit!(ResidentEnrolled {
        wallet: ctx.accounts.wallet.key(),
        owner: ctx.accounts.owner.key(),
        token_account: ctx.accounts.token_account.key(),
        household_id,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Disburse<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin @ RescuError::Unauthorized,
        has_one = mint @ RescuError::InvalidAccount,
    )]
    pub declaration: Account<'info, Declaration>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: mint-authority PDA; signs the mint_to CPIs.
    #[account(seeds = [SEED_AUTHORITY], bump)]
    pub authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    // remaining_accounts: [wallet_state, token_account] per recipient, same order as `amounts`.
}

/// Mints aid straight into enrolled residents' accounts. `mint_to` doesn't run the transfer
/// hook, so a batch is cheap and never touches the spend window.
pub fn handle_disburse<'info>(ctx: Context<'info, Disburse<'info>>, amounts: Vec<u64>) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    require!(!amounts.is_empty(), RescuError::InvalidArgument);
    require!(remaining.len() == amounts.len() * 2, RescuError::InvalidArgument);

    let decl = &ctx.accounts.declaration;
    require!(decl.active, RescuError::DeclarationInactive);
    let now = decl.sim_now(Clock::get()?.unix_timestamp);
    require!(now < decl.expires_at, RescuError::AidExpired);

    let total = amounts
        .iter()
        .try_fold(0u64, |acc, a| acc.checked_add(*a))
        .ok_or(RescuError::MathOverflow)?;
    let disbursed = decl.disbursed.checked_add(total).ok_or(RescuError::MathOverflow)?;
    require!(disbursed <= decl.budget, RescuError::BudgetExceeded);

    let mint_key = ctx.accounts.mint.key();
    let signer_seeds: &[&[&[u8]]] = &[&[SEED_AUTHORITY, &[ctx.bumps.authority]]];

    for (pair, amount) in remaining.chunks_exact(2).zip(amounts.iter()) {
        let (wallet_info, token_info) = (&pair[0], &pair[1]);
        require_keys_eq!(*wallet_info.owner, crate::ID, RescuError::NotAResident);
        let wallet = WalletState::try_deserialize(&mut &wallet_info.try_borrow_data()?[..])
            .map_err(|_| error!(RescuError::NotAResident))?;
        require_keys_eq!(wallet.mint, mint_key, RescuError::InvalidAccount);
        require_keys_eq!(wallet.token_account, token_info.key(), RescuError::InvalidAccount);

        mint_to(
            CpiContext::new_with_signer(
                Token2022::id(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: token_info.clone(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
                signer_seeds,
            ),
            *amount,
        )?;
    }

    let decl = &mut ctx.accounts.declaration;
    decl.disbursed = disbursed;
    emit!(AidDisbursed {
        declaration: decl.key(),
        recipients: amounts.len() as u32,
        total,
    });
    Ok(())
}
