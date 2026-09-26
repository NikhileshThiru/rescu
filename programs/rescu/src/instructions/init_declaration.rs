use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};
use anchor_spl::token_interface::{
    spl_pod::optional_keys::OptionalNonZeroPubkey,
    spl_token_metadata_interface::state::TokenMetadata, token_metadata_initialize, Mint, Token2022,
    TokenMetadataInitialize,
};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::{constants::*, error::RescuError, events::DeclarationCreated, state::Declaration};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DeclarationParams {
    pub id: u64,
    pub name: String,
    pub oracle: Pubkey,
    pub per_order_cap: u64,
    pub daily_cap: u64,
    pub budget: u64,
    /// Sim seconds per real second.
    pub time_scale: u32,
    /// Sim timestamp at the moment of declaration.
    pub sim_start: i64,
    /// How long aid stays spendable, in sim seconds (30 days = 2_592_000).
    pub aid_duration: i64,
}

#[derive(Accounts)]
#[instruction(params: DeclarationParams)]
pub struct InitDeclaration<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: data-less PDA used only as a signer for mint, freeze and permanent-delegate authority.
    #[account(seeds = [SEED_AUTHORITY], bump)]
    pub authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [SEED_MINT, params.id.to_le_bytes().as_ref()],
        bump,
        mint::decimals = DECIMALS,
        mint::authority = authority,
        mint::freeze_authority = authority,
        mint::token_program = token_program,
        extensions::transfer_hook::authority = authority,
        extensions::transfer_hook::program_id = crate::ID,
        extensions::permanent_delegate::delegate = authority,
        extensions::metadata_pointer::authority = authority,
        extensions::metadata_pointer::metadata_address = mint,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        space = 8 + Declaration::INIT_SPACE,
        seeds = [SEED_DECLARATION, mint.key().as_ref()],
        bump,
    )]
    pub declaration: Account<'info, Declaration>,

    /// CHECK: created here and filled with the hook's extra-account list in the handler.
    #[account(
        init,
        payer = admin,
        space = ExtraAccountMetaList::size_of(extra_account_metas()?.len())?,
        seeds = [SEED_EXTRA_ACCOUNT_METAS, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// Accounts Token-2022 resolves and passes to the hook after its fixed five
/// (0 source, 1 mint, 2 destination, 3 authority, 4 this list).
pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    Ok(vec![
        // 5: declaration = ["decl", mint]
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: SEED_DECLARATION.to_vec() },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )?,
        // 6: sender wallet = ["wallet", source token account]; writable (spend window)
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: SEED_WALLET.to_vec() },
                Seed::AccountKey { index: 0 },
            ],
            false,
            true,
        )?,
        // 7: merchant = ["merchant", destination owner] (owner lives at bytes 32..64 of a token account)
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: SEED_MERCHANT.to_vec() },
                Seed::AccountData { account_index: 2, data_index: 32, length: 32 },
            ],
            false,
            false,
        )?,
        // 8: receiver wallet = ["wallet", destination token account]; only read to name resale attempts
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: SEED_WALLET.to_vec() },
                Seed::AccountKey { index: 2 },
            ],
            false,
            false,
        )?,
    ])
}

/// Name, symbol and URI stored on the mint itself, so explorers show "Relief Dollar · Helene 2024"
/// instead of an unknown token.
fn init_token_metadata(ctx: &Context<InitDeclaration>, id: u64, disaster: &str) -> Result<()> {
    let name = format!("Relief Dollar · {disaster}");
    let symbol = String::from("rUSD");
    let uri = format!("https://rescu.tech/api/token/{id}.json");
    let mint = ctx.accounts.mint.to_account_info();
    let authority = ctx.accounts.authority.to_account_info();

    // Token-2022 grows the mint to hold the metadata, but the lamports must already be there.
    let metadata = TokenMetadata {
        update_authority: OptionalNonZeroPubkey::try_from(Some(authority.key()))?,
        mint: mint.key(),
        name: name.clone(),
        symbol: symbol.clone(),
        uri: uri.clone(),
        additional_metadata: vec![],
    };
    let required = Rent::get()?.minimum_balance(mint.data_len() + metadata.tlv_size_of()?);
    let shortfall = required.saturating_sub(mint.lamports());
    if shortfall > 0 {
        transfer(
            CpiContext::new(
                System::id(),
                Transfer { from: ctx.accounts.admin.to_account_info(), to: mint.clone() },
            ),
            shortfall,
        )?;
    }

    let signer_seeds: &[&[&[u8]]] = &[&[SEED_AUTHORITY, &[ctx.bumps.authority]]];
    token_metadata_initialize(
        CpiContext::new_with_signer(
            Token2022::id(),
            TokenMetadataInitialize {
                program_id: ctx.accounts.token_program.to_account_info(),
                metadata: mint.clone(),
                update_authority: authority.clone(),
                mint_authority: authority,
                mint,
            },
            signer_seeds,
        ),
        name,
        symbol,
        uri,
    )
}

pub fn handle_init_declaration(ctx: Context<InitDeclaration>, params: DeclarationParams) -> Result<()> {
    require!(params.name.len() <= MAX_NAME_LEN, RescuError::InvalidArgument);
    require!(params.per_order_cap > 0, RescuError::InvalidArgument);
    require!(params.daily_cap >= params.per_order_cap, RescuError::InvalidArgument);
    require!(params.time_scale > 0, RescuError::InvalidArgument);
    require!(params.aid_duration > 0, RescuError::InvalidArgument);

    let expires_at = params
        .sim_start
        .checked_add(params.aid_duration)
        .ok_or(RescuError::MathOverflow)?;
    let now = Clock::get()?.unix_timestamp;

    ctx.accounts.declaration.set_inner(Declaration {
        id: params.id,
        mint: ctx.accounts.mint.key(),
        admin: ctx.accounts.admin.key(),
        oracle: params.oracle,
        per_order_cap: params.per_order_cap,
        daily_cap: params.daily_cap,
        expires_at,
        time_scale: params.time_scale,
        anchor_real: now,
        anchor_sim: params.sim_start,
        budget: params.budget,
        disbursed: 0,
        returned: 0,
        active: true,
        bump: ctx.bumps.declaration,
        name: params.name,
    });

    init_token_metadata(&ctx, params.id, &ctx.accounts.declaration.name.clone())?;

    let metas = extra_account_metas()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(
        &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
        &metas,
    )?;

    emit!(DeclarationCreated {
        declaration: ctx.accounts.declaration.key(),
        mint: ctx.accounts.mint.key(),
        id: params.id,
        budget: params.budget,
        expires_at,
    });
    Ok(())
}
