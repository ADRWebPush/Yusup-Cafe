import assert from "node:assert/strict";
import test from "node:test";

import {
  MOTION,
  reducedSectionVariants,
  sectionChildVariants,
  sectionVariants,
} from "./motionSystem.js";

test("motion tokens stay within the documented timing ranges", () => {
  assert.ok(MOTION.duration.micro >= 0.12 && MOTION.duration.micro <= 0.2);
  assert.ok(MOTION.duration.component >= 0.25 && MOTION.duration.component <= 0.4);
  assert.ok(MOTION.duration.section >= 0.45 && MOTION.duration.section <= 0.65);
  assert.equal(MOTION.ease.enter.length, 4);
  assert.equal(MOTION.ease.exit.length, 4);
});

test("entrance movement stays restrained and reduced motion removes it", () => {
  assert.ok(Math.abs(sectionVariants.hidden.y) <= 24);
  assert.ok(Math.abs(sectionChildVariants.hidden.y) <= 24);
  assert.equal("y" in reducedSectionVariants.hidden, false);
  assert.equal("y" in reducedSectionVariants.visible, false);
});
