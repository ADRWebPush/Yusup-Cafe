import test from "node:test";
import assert from "node:assert/strict";
import {
  bonusEarnPreview,
  bonusSpendLimit,
  clampBonusUse,
  isValidLoyaltyCode,
  normalizeLoyaltyCodeInput,
} from "./loyalty.js";

test("bonus spending is capped at 35 percent and the available balance", () => {
  assert.equal(bonusSpendLimit(10_000, 9_000), 3_500);
  assert.equal(bonusSpendLimit(10_000, 750), 750);
});

test("bonus input is clamped to whole non-negative values", () => {
  assert.equal(clampBonusUse(4_500, 10_000, 9_000), 3_500);
  assert.equal(clampBonusUse(-20, 10_000, 9_000), 0);
  assert.equal(clampBonusUse("850.9", 10_000, 9_000), 850);
});

test("earning uses the eligible subtotal after redeemed bonuses", () => {
  assert.equal(bonusEarnPreview(10_000), 300);
  assert.equal(bonusEarnPreview(10_000, 2_000), 240);
});

test("bonus spending also respects the absolute per-order cap", () => {
  assert.equal(bonusSpendLimit(1_000_000, 900_000), 50_000);
});

test("loyalty IDs contain nine digits", () => {
  assert.equal(isValidLoyaltyCode("123456789"), true);
  assert.equal(isValidLoyaltyCode("12345678"), false);
  assert.equal(isValidLoyaltyCode("1234567890"), false);
  assert.equal(isValidLoyaltyCode("12345678!"), false);
  assert.equal(normalizeLoyaltyCodeInput(" 1234 56789extra"), "123456789");
});
