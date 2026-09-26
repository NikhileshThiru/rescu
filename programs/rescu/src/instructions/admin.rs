use anchor_lang::prelude::*;

use crate::{
    error::RescuError,
    events::{ClockSet, RulesUpdated},
    state::Declaration,
};

#[derive(Accounts)]
pub struct AdminUpdate<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin @ RescuError::Unauthorized)]
    pub declaration: Account<'info, Declaration>,
}

/// Re-anchors the declaration's sim clock: from now on sim time = `sim_now` + elapsed * `time_scale`.
/// Drives demo speed, "jump to day 31", and deterministic tests.
pub fn handle_set_clock(ctx: Context<AdminUpdate>, time_scale: u32, sim_now: i64) -> Result<()> {
    require!(time_scale > 0, RescuError::InvalidArgument);
    let decl = &mut ctx.accounts.declaration;
    decl.anchor_real = Clock::get()?.unix_timestamp;
    decl.anchor_sim = sim_now;
    decl.time_scale = time_scale;
    emit!(ClockSet { declaration: decl.key(), time_scale, sim_now });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct RulesParams {
    pub per_order_cap: Option<u64>,
    pub daily_cap: Option<u64>,
    pub expires_at: Option<i64>,
    pub active: Option<bool>,
    pub oracle: Option<Pubkey>,
    pub budget: Option<u64>,
}

pub fn handle_update_rules(ctx: Context<AdminUpdate>, params: RulesParams) -> Result<()> {
    let decl = &mut ctx.accounts.declaration;
    if let Some(v) = params.per_order_cap {
        decl.per_order_cap = v;
    }
    if let Some(v) = params.daily_cap {
        decl.daily_cap = v;
    }
    if let Some(v) = params.expires_at {
        decl.expires_at = v;
    }
    if let Some(v) = params.active {
        decl.active = v;
    }
    if let Some(v) = params.oracle {
        decl.oracle = v;
    }
    if let Some(v) = params.budget {
        require!(v >= decl.disbursed, RescuError::BudgetExceeded);
        decl.budget = v;
    }
    require!(decl.per_order_cap > 0, RescuError::InvalidArgument);
    require!(decl.daily_cap >= decl.per_order_cap, RescuError::InvalidArgument);

    emit!(RulesUpdated {
        declaration: decl.key(),
        per_order_cap: decl.per_order_cap,
        daily_cap: decl.daily_cap,
        expires_at: decl.expires_at,
        active: decl.active,
    });
    Ok(())
}
