export const LOYALTY_TOKEN_KEY = "yusup-loyalty-token-v1";
export const LOYALTY_EARN_PERCENT = 3;
export const LOYALTY_REDEEM_PERCENT = 20;

const whole = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
};

export function bonusSpendLimit(subtotal, balance, redeemPercent = LOYALTY_REDEEM_PERCENT) {
  return Math.min(
    whole(balance),
    Math.floor(whole(subtotal) * whole(redeemPercent) / 100),
  );
}

export function clampBonusUse(value, subtotal, balance, redeemPercent = LOYALTY_REDEEM_PERCENT) {
  return Math.min(whole(value), bonusSpendLimit(subtotal, balance, redeemPercent));
}

export function bonusEarnPreview(subtotal, bonusUsed = 0, earnPercent = LOYALTY_EARN_PERCENT) {
  const eligible = Math.max(0, whole(subtotal) - whole(bonusUsed));
  return Math.floor(eligible * whole(earnPercent) / 100);
}
