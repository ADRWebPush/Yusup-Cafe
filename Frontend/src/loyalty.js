export const LOYALTY_CODE_KEY = "yusup-loyalty-code-v2";
export const LEGACY_LOYALTY_TOKEN_KEY = "yusup-loyalty-token-v1";
export const LOYALTY_DEVICE_KEY = "yusup-loyalty-device-v1";
export const LOYALTY_EARN_PERCENT = 3;
export const LOYALTY_REDEEM_PERCENT = 20;
export const LOYALTY_MAX_REDEMPTION = 50_000;
export const LOYALTY_CODE_PATTERN = /^\d{9}$/;

const whole = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
};

export function bonusSpendLimit(
  subtotal,
  balance,
  redeemPercent = LOYALTY_REDEEM_PERCENT,
  absoluteLimit = LOYALTY_MAX_REDEMPTION,
) {
  return Math.min(
    whole(balance),
    Math.floor(whole(subtotal) * whole(redeemPercent) / 100),
    whole(absoluteLimit),
  );
}

export function clampBonusUse(
  value,
  subtotal,
  balance,
  redeemPercent = LOYALTY_REDEEM_PERCENT,
  absoluteLimit = LOYALTY_MAX_REDEMPTION,
) {
  return Math.min(whole(value), bonusSpendLimit(subtotal, balance, redeemPercent, absoluteLimit));
}

export function bonusEarnPreview(subtotal, bonusUsed = 0, earnPercent = LOYALTY_EARN_PERCENT) {
  const eligible = Math.max(0, whole(subtotal) - whole(bonusUsed));
  return Math.floor(eligible * whole(earnPercent) / 100);
}

export function normalizeLoyaltyCodeInput(value) {
  return String(value || "")
    .replace(/\s/g, "")
    .split("")
    .filter((character) => /\d/.test(character))
    .join("")
    .slice(0, 9);
}

export function isValidLoyaltyCode(value) {
  return LOYALTY_CODE_PATTERN.test(String(value || "").trim());
}
