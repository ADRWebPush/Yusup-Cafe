"""Calendar-period aggregation for the permanent admin sales archive."""

import datetime as dt


EXCLUDED_SALE_STATUSES = frozenset({
    "cancelled",
    "awaiting_confirmation",
    "pending_payment",
    "expired",
    "payment_failed",
})


def _period_bounds(local_date, period):
    midnight = local_date.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "weeks":
        start = midnight - dt.timedelta(days=midnight.weekday())
        end = start + dt.timedelta(days=7)
        key = start.strftime("%Y-%m-%d")
    elif period == "months":
        start = midnight.replace(day=1)
        if start.month == 12:
            end = start.replace(year=start.year + 1, month=1)
        else:
            end = start.replace(month=start.month + 1)
        key = start.strftime("%Y-%m")
    else:
        start = midnight.replace(month=1, day=1)
        end = start.replace(year=start.year + 1)
        key = str(start.year)
    return key, start, end


def _epoch_ms(value):
    return int(value.timestamp() * 1000)


def aggregate_sales_history(rows, timezone):
    """Group archived order snapshots into calendar weeks, months, and years."""
    grouped = {"weeks": {}, "months": {}, "years": {}}

    for row in rows or []:
        status = str(row.get("status") or "")
        if status in EXCLUDED_SALE_STATUSES:
            continue
        try:
            timestamp = int(row.get("ts"))
            total = int(round(float(row.get("total"))))
        except (TypeError, ValueError, OverflowError):
            continue
        if timestamp < 0 or total < 0:
            continue

        local_date = dt.datetime.fromtimestamp(timestamp / 1000, timezone)
        for period in grouped:
            key, start, end = _period_bounds(local_date, period)
            bucket = grouped[period].setdefault(key, {
                "key": key,
                "start": _epoch_ms(start),
                "end": _epoch_ms(end),
                "orders": 0,
                "revenue": 0,
            })
            bucket["orders"] += 1
            bucket["revenue"] += total

    result = {}
    for period, buckets in grouped.items():
        items = sorted(
            buckets.values(), key=lambda item: item["start"], reverse=True
        )
        for item in items:
            item["average"] = (
                (item["revenue"] + item["orders"] // 2) // item["orders"]
                if item["orders"] else 0
            )
        result[period] = items
    return result
