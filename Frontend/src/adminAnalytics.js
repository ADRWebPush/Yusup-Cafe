const startOfLocalDay = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const NON_SALE_STATUSES = new Set([
  "cancelled",
  "awaiting_confirmation",
  "pending_payment",
  "expired",
  "payment_failed",
]);

export function salesTotalsForPeriods(orders, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const dayStart = startOfLocalDay(nowDate);
  const mondayOffset = (nowDate.getDay() + 6) % 7;
  const weekStart = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate() - mondayOffset,
  ).getTime();
  const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime();
  const yearStart = new Date(nowDate.getFullYear(), 0, 1).getTime();

  const totals = {
    todayOrders: 0,
    todayRevenue: 0,
    weekRevenue: 0,
    monthRevenue: 0,
    yearRevenue: 0,
    averageToday: 0,
  };

  for (const order of Array.isArray(orders) ? orders : []) {
    if (!order || NON_SALE_STATUSES.has(order.status)) continue;
    const timestamp = Number(order.ts);
    const total = Number(order.total);
    if (!Number.isFinite(timestamp) || !Number.isFinite(total)
        || timestamp > nowMs || timestamp < yearStart) {
      continue;
    }

    totals.yearRevenue += total;
    if (timestamp >= monthStart) totals.monthRevenue += total;
    if (timestamp >= weekStart) totals.weekRevenue += total;
    if (timestamp >= dayStart) {
      totals.todayOrders += 1;
      totals.todayRevenue += total;
    }
  }

  totals.averageToday = totals.todayOrders
    ? Math.round(totals.todayRevenue / totals.todayOrders)
    : 0;
  return totals;
}
