import test from "node:test";
import assert from "node:assert/strict";
import {
  bonusEarnPreview,
  bonusSpendLimit,
  clampBonusUse,
} from "./loyalty.js";

test("bonus spending is capped at 20 percent and the available balance", () => {
  assert.equal(bonusSpendLimit(10_000, 9_000), 2_000);
  assert.equal(bonusSpendLimit(10_000, 750), 750);
});

test("bonus input is clamped to whole non-negative values", () => {
  assert.equal(clampBonusUse(4_500, 10_000, 9_000), 2_000);
  assert.equal(clampBonusUse(-20, 10_000, 9_000), 0);
  assert.equal(clampBonusUse("850.9", 10_000, 9_000), 850);
});

test("earning uses the eligible subtotal after redeemed bonuses", () => {
  assert.equal(bonusEarnPreview(10_000), 300);
  assert.equal(bonusEarnPreview(10_000, 2_000), 240);
});
