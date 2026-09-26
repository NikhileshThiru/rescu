use anchor_lang::prelude::*;

use crate::{constants::*, error::RescuError};

/// One disaster declaration = one relief-dollar mint with its own rules and clock.
#[account]
#[derive(InitSpace)]
pub struct Declaration {
    pub id: u64,
    pub mint: Pubkey,
    /// Government / treasury key: declares, enrolls, disburses, sets rules.
    pub admin: Pubkey,
    /// Oracle key: can suspend merchants and freeze wallets, cannot move money.
    pub oracle: Pubkey,
    pub per_order_cap: u64,
    pub daily_cap: u64,
    /// Aid stops being spendable at this sim timestamp; unspent aid can then be clawed back.
    pub expires_at: i64,
    /// Sim seconds per real second (1 = real time, 1440 = one sim day per real minute).
    pub time_scale: u32,
    /// Real unix timestamp at which the sim clock was last anchored.
    pub anchor_real: i64,
    /// Sim unix timestamp at `anchor_real`.
    pub anchor_sim: i64,
    pub budget: u64,
    pub disbursed: u64,
    pub returned: u64,
    pub active: bool,
    pub bump: u8,
    #[max_len(MAX_NAME_LEN)]
    pub name: String,
}

impl Declaration {
    /// Sim time derived from the chain clock. Every rule (window, expiry) runs on this.
    pub fn sim_now(&self, real_now: i64) -> i64 {
        let elapsed = real_now.saturating_sub(self.anchor_real);
        self.anchor_sim
            .saturating_add(elapsed.saturating_mul(i64::from(self.time_scale)))
    }
}

/// Per-resident spend state. Keyed by the resident's relief-dollar token account so it
/// resolves the same way whether the resident or their agent (SPL delegate) signs.
#[account]
#[derive(InitSpace)]
pub struct WalletState {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub token_account: Pubkey,
    pub household_id: u64,
    /// Sim hour (unix seconds / 3600) of the most recent spend.
    pub last_hour: i64,
    /// Spend per sim hour, ring-indexed by `hour % 24`.
    pub hourly_spend: [u64; 24],
    pub total_spent: u64,
    pub bump: u8,
}

impl WalletState {
    /// Advances the ring to `hour` (zeroing buckets that fell out of the trailing 24h) and
    /// returns what was spent in the trailing 24h. Time never runs backwards here, so moving
    /// the clock back can't free up cap.
    pub fn roll_to(&mut self, hour: i64) -> u64 {
        let hour = hour.max(self.last_hour);
        let window = i64::from(WINDOW_HOURS);
        if hour - self.last_hour >= window {
            self.hourly_spend = [0; 24];
        } else {
            for h in (self.last_hour + 1)..=hour {
                self.hourly_spend[h.rem_euclid(window) as usize] = 0;
            }
        }
        self.last_hour = hour;
        self.hourly_spend.iter().sum()
    }

    /// Records a spend at `hour` if it keeps the trailing-24h total within `daily_cap`.
    pub fn try_spend(&mut self, hour: i64, amount: u64, daily_cap: u64) -> Result<()> {
        let spent = self.roll_to(hour);
        let after = spent.checked_add(amount).ok_or(RescuError::MathOverflow)?;
        require!(after <= daily_cap, RescuError::OverDailyCap);
        let slot = self.last_hour.rem_euclid(i64::from(WINDOW_HOURS)) as usize;
        self.hourly_spend[slot] = self.hourly_spend[slot]
            .checked_add(amount)
            .ok_or(RescuError::MathOverflow)?;
        self.total_spent = self
            .total_spent
            .checked_add(amount)
            .ok_or(RescuError::MathOverflow)?;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MerchantStatus {
    Pending,
    Approved,
    Suspended,
}

#[account]
#[derive(InitSpace)]
pub struct Merchant {
    /// Merchant wallet; payments go to its relief-dollar token account.
    pub owner: Pubkey,
    /// Mint of the declaration this merchant is approved to serve.
    pub zone: Pubkey,
    pub status: MerchantStatus,
    /// 0 pharmacy, 1 grocery, 2 hardware, 3 general (display only).
    pub category: u8,
    pub h3_cell: u64,
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAP: u64 = 300;

    fn wallet() -> WalletState {
        WalletState {
            mint: Pubkey::default(),
            owner: Pubkey::default(),
            token_account: Pubkey::default(),
            household_id: 0,
            last_hour: 0,
            hourly_spend: [0; 24],
            total_spent: 0,
            bump: 0,
        }
    }

    #[test]
    fn caps_trailing_24h() {
        let mut w = wallet();
        let h = 480_000;
        w.try_spend(h, 150, CAP).unwrap();
        w.try_spend(h + 12, 150, CAP).unwrap();
        assert!(w.try_spend(h + 12, 1, CAP).is_err());
        assert!(w.try_spend(h + 23, 1, CAP).is_err());
    }

    #[test]
    fn rolls_off_one_bucket_at_a_time() {
        let mut w = wallet();
        let h = 480_000;
        w.try_spend(h, 150, CAP).unwrap();
        w.try_spend(h + 12, 150, CAP).unwrap();
        // 24h after the first spend it leaves the window; the second one is still inside.
        assert!(w.try_spend(h + 24, 151, CAP).is_err());
        w.try_spend(h + 24, 150, CAP).unwrap();
        assert_eq!(w.total_spent, 450);
    }

    #[test]
    fn no_double_window_across_a_boundary() {
        // A tumbling window would allow 300 at 23:59 and 300 again at 00:01.
        let mut w = wallet();
        let h = 480_023;
        w.try_spend(h, 300, CAP).unwrap();
        assert!(w.try_spend(h + 1, 300, CAP).is_err());
        assert!(w.try_spend(h + 23, 1, CAP).is_err());
        w.try_spend(h + 24, 300, CAP).unwrap();
    }

    #[test]
    fn long_gap_clears_everything() {
        let mut w = wallet();
        w.try_spend(480_000, 300, CAP).unwrap();
        w.try_spend(480_000 + 1_000, 300, CAP).unwrap();
    }

    #[test]
    fn clock_rewind_does_not_free_cap() {
        let mut w = wallet();
        w.try_spend(480_010, 300, CAP).unwrap();
        assert!(w.try_spend(479_000, 1, CAP).is_err());
    }

    #[test]
    fn sim_clock_scales_from_anchor() {
        let d = Declaration {
            id: 0,
            mint: Pubkey::default(),
            admin: Pubkey::default(),
            oracle: Pubkey::default(),
            per_order_cap: 0,
            daily_cap: 0,
            expires_at: 0,
            time_scale: 1_440,
            anchor_real: 1_000,
            anchor_sim: 5_000,
            budget: 0,
            disbursed: 0,
            returned: 0,
            active: true,
            bump: 0,
            name: String::new(),
        };
        assert_eq!(d.sim_now(1_000), 5_000);
        assert_eq!(d.sim_now(1_060), 5_000 + 86_400);
    }
}
