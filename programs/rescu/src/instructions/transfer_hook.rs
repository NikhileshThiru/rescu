use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use spl_token_2022_interface::{
    extension::{transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions},
    state::Account as SplTokenAccount,
};

use crate::{
    constants::*,
    error::RescuError,
    state::{Declaration, Merchant, MerchantStatus, WalletState},
};

/// Account order is fixed by the transfer hook interface; 5..=8 come from `extra_account_metas`.
#[derive(Accounts)]
pub struct TransferHook<'info> {
    /// CHECK: parsed and validated in the handler.
    pub source: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: parsed and validated in the handler.
    pub destination: UncheckedAccount<'info>,
    /// CHECK: owner or delegate; Token-2022 has already checked its signature/allowance.
    pub authority: UncheckedAccount<'info>,
    /// CHECK: address pinned by seeds.
    #[account(seeds = [SEED_EXTRA_ACCOUNT_METAS, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    /// CHECK: may not exist (unknown mint); validated in the handler.
    pub declaration: UncheckedAccount<'info>,
    /// CHECK: may not exist (sender isn't a resident); validated in the handler.
    #[account(mut)]
    pub sender_wallet: UncheckedAccount<'info>,
    /// CHECK: may not exist (recipient isn't a merchant); validated in the handler.
    pub merchant: UncheckedAccount<'info>,
    /// CHECK: may not exist; only used to name resale attempts.
    pub receiver_wallet: UncheckedAccount<'info>,
}

struct TokenAccountView {
    owner: Pubkey,
    transferring: bool,
}

fn read_token_account(info: &AccountInfo, mint: &Pubkey) -> Result<TokenAccountView> {
    require_keys_eq!(*info.owner, spl_token_2022_interface::ID, RescuError::InvalidAccount);
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<SplTokenAccount>::unpack(&data)?;
    require_keys_eq!(state.base.mint, *mint, RescuError::InvalidAccount);
    let transferring = state
        .get_extension::<TransferHookAccount>()
        .map(|ext| bool::from(ext.transferring))
        .unwrap_or(false);
    Ok(TokenAccountView { owner: state.base.owner, transferring })
}

/// Deserializes one of our accounts if it exists, `None` if it was never created.
fn load<T: AccountDeserialize>(info: &AccountInfo) -> Result<Option<T>> {
    if info.owner != &crate::ID || info.data_is_empty() {
        return Ok(None);
    }
    let data = info.try_borrow_data()?;
    Ok(Some(T::try_deserialize(&mut &data[..])?))
}

pub fn handle_transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
    let a = &ctx.accounts;
    let mint = a.mint.key();

    // 1. Only act inside a real Token-2022 transfer of a relief mint. Without this anyone could
    //    call the hook directly and burn through a victim's daily cap.
    let source = read_token_account(&a.source, &mint)?;
    require!(source.transferring, RescuError::NotTransferring);
    let destination = read_token_account(&a.destination, &mint)?;

    let decl: Declaration = load(&a.declaration)?.ok_or(RescuError::UnknownDeclaration)?;
    require_keys_eq!(decl.mint, mint, RescuError::UnknownDeclaration);
    let decl_key = Pubkey::create_program_address(
        &[SEED_DECLARATION, mint.as_ref(), &[decl.bump]],
        &crate::ID,
    )
    .map_err(|_| error!(RescuError::UnknownDeclaration))?;
    require_keys_eq!(decl_key, a.declaration.key(), RescuError::UnknownDeclaration);

    // 2. Declaration still open.
    require!(decl.active, RescuError::DeclarationInactive);
    let now = decl.sim_now(Clock::get()?.unix_timestamp);
    require!(now < decl.expires_at, RescuError::AidExpired);

    // 3. Sender must be an enrolled resident of this declaration.
    let mut wallet: WalletState = load(&a.sender_wallet)?.ok_or(RescuError::NotAResident)?;
    require_keys_eq!(wallet.token_account, a.source.key(), RescuError::NotAResident);
    require_keys_eq!(wallet.mint, mint, RescuError::NotAResident);
    let wallet_key = Pubkey::create_program_address(
        &[SEED_WALLET, a.source.key().as_ref(), &[wallet.bump]],
        &crate::ID,
    )
    .map_err(|_| error!(RescuError::NotAResident))?;
    require_keys_eq!(wallet_key, a.sender_wallet.key(), RescuError::NotAResident);

    // 4. Recipient must be an approved merchant in this zone.
    match load::<Merchant>(&a.merchant)? {
        None => {
            let receiver: Option<WalletState> = load(&a.receiver_wallet)?;
            if receiver.is_some_and(|w| w.token_account == a.destination.key()) {
                return err!(RescuError::ResaleBlocked);
            }
            return err!(RescuError::NotRegisteredMerchant);
        }
        Some(merchant) => {
            require_keys_eq!(merchant.owner, destination.owner, RescuError::NotRegisteredMerchant);
            require_keys_eq!(merchant.zone, mint, RescuError::OutOfZone);
            match merchant.status {
                MerchantStatus::Approved => {}
                MerchantStatus::Pending => return err!(RescuError::MerchantNotApproved),
                MerchantStatus::Suspended => return err!(RescuError::MerchantSuspended),
            }
        }
    }

    // 5. Spending caps. Only the sender's own wallet state is written, so purchases by
    //    different residents never contend for the same account.
    require!(amount <= decl.per_order_cap, RescuError::OverOrderCap);
    wallet.try_spend(now.div_euclid(SECONDS_PER_HOUR), amount, decl.daily_cap)?;

    let mut data = a.sender_wallet.try_borrow_mut_data()?;
    wallet.try_serialize(&mut &mut data[..])?;
    Ok(())
}
