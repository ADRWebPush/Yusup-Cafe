import datetime as dt
import unittest
from zoneinfo import ZoneInfo

from sales_history import aggregate_sales_history


TZ = ZoneInfo("Asia/Almaty")


def ms(year, month, day, hour=12):
    return int(dt.datetime(year, month, day, hour, tzinfo=TZ).timestamp() * 1000)


class SalesHistoryTests(unittest.TestCase):
    def test_groups_sales_into_calendar_periods(self):
        result = aggregate_sales_history([
            {"ts": ms(2026, 6, 1), "status": "new", "total": 1000},
            {"ts": ms(2026, 6, 7), "status": "done", "total": 2001},
            {"ts": ms(2026, 6, 8), "status": "cooking", "total": 500},
            {"ts": ms(2026, 7, 2), "status": "ready", "total": 700},
        ], TZ)

        self.assertEqual(
            [(row["key"], row["orders"], row["revenue"], row["average"])
             for row in result["weeks"]],
            [
                ("2026-06-29", 1, 700, 700),
                ("2026-06-08", 1, 500, 500),
                ("2026-06-01", 2, 3001, 1501),
            ],
        )
        self.assertEqual(
            [(row["key"], row["orders"], row["revenue"])
             for row in result["months"]],
            [("2026-07", 1, 700), ("2026-06", 3, 3501)],
        )

    def test_excludes_cancelled_and_invalid_rows(self):
        result = aggregate_sales_history([
            {"ts": ms(2026, 6, 1), "status": "cancelled", "total": 100},
            {"ts": "bad", "status": "done", "total": 100},
            {"ts": ms(2026, 6, 1), "status": "done", "total": -1},
        ], TZ)
        self.assertEqual(result, {"weeks": [], "months": [], "years": []})


if __name__ == "__main__":
    unittest.main()
