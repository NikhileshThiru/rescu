use anchor_lang::prelude::*;

// Order is part of the client contract (codes 6000+). Append only.
#[error_code]
pub enum RescuError {
    #[msg("Hook was called outside a real token transfer")]
    NotTransferring,
    #[msg("This mint is not a Rescu relief dollar")]
    UnknownDeclaration,
    #[msg("This disaster declaration is closed")]
    DeclarationInactive,
    #[msg("This aid has expired")]
    AidExpired,
    #[msg("Sender is not an enrolled resident")]
    NotAResident,
    #[msg("Recipient is not a registered merchant")]
    NotRegisteredMerchant,
    #[msg("Aid can't be sent to another resident")]
    ResaleBlocked,
    #[msg("Merchant is outside this disaster zone")]
    OutOfZone,
    #[msg("Merchant is not approved yet")]
    MerchantNotApproved,
    #[msg("Merchant is suspended")]
    MerchantSuspended,
    #[msg("Order is over the per-order cap")]
    OverOrderCap,
    #[msg("Order would go over the 24-hour spending cap")]
    OverDailyCap,
    #[msg("Signer is not allowed to do this")]
    Unauthorized,
    #[msg("Aid has not expired yet")]
    ClawbackTooEarly,
    #[msg("Disbursement would exceed the declared budget")]
    BudgetExceeded,
    #[msg("Account does not belong to this declaration")]
    InvalidAccount,
    #[msg("Invalid argument")]
    InvalidArgument,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
