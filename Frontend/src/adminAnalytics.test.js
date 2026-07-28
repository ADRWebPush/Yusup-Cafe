import test from "node:test";
import assert from "node:assert/strict";

import { salesTotalsForPeriods } from "./adminAnalytics.js";


test("calculates local calendar totals and excludes cancelled orders", () => {
  const now = new Date(2026, 6, 28, 12, 0, 0);
  const at = (year, month, day) => new Date(year, month, day, 10, 0, 0).getTime();
  const totals = salesTotalsForPeriods([
    { ts: at(2026, 6, 28), status: "done", total: 1000 },
    { ts: at(2026, 6, 27), status: "ready", total: 500 },
    { ts: at(2026, 6, 1), status: "done", total: 700 },
    { ts: at(2026, 0, 4), status: "done", total: 300 },
    { ts: at(2026, 6, 28), status: "cancelled", total: 9999 },
  ], now);

  assert.deepEqual(totals, {
    todayOrders: 1,
    todayRevenue: 1000,
    weekRevenue: 1500,
    monthRevenue: 2200,
    yearRevenue: 2500,
    averageToday: 1000,
  });
});
