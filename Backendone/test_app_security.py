import importlib
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


os.environ.setdefault("DATABASE_URL", "postgresql://localhost/test")
os.environ.setdefault("JWT_SECRET", "test-secret-that-is-at-least-32-characters")
os.environ.setdefault("OWNER_USER", "test-owner")
os.environ.setdefault("OWNER_PASS_HASH", "$argon2id$v=19$m=65536,t=3,p=4$test$test")
os.environ.setdefault("TURNSTILE_SECRET", "test-turnstile-secret")

BACKEND_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND_DIR))


class _BootConnection:
    def __init__(self):
        self.query = ""

    def execute(self, query, *args):
        self.query = query
        return self

    def fetchone(self):
        if "menu_initialized" in self.query:
            return {"exists": 1}
        return None

    def commit(self):
        pass

    def close(self):
        pass


db = importlib.import_module("db")
db.get_db = lambda: _BootConnection()
app_module = importlib.import_module("app")


class _MenuConnection:
    def __init__(self, items):
        self.rows = [{"id": item["id"], "data": item} for item in items]

    def execute(self, query, *args):
        return self

    def fetchall(self):
        return self.rows


class OrderSecurityTests(unittest.TestCase):
    def test_health_endpoint_is_available(self):
        response = app_module.app.test_client().get(
            "/api/health", base_url="https://localhost"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"ok": True})

    def test_client_price_is_replaced_by_menu_price(self):
        menu = [{
            "id": "dish-1",
            "name": {"en": "Dish", "ru": "Dish", "kz": "Dish"},
            "price": 2500,
            "available": True,
        }]
        items = app_module.authoritative_order_items(
            _MenuConnection(menu),
            [{"id": "dish-1", "price": 1, "qty": 2}],
        )
        self.assertEqual(items[0]["price"], 2500)
        self.assertEqual(items[0]["qty"], 2)

    def test_unavailable_item_is_rejected(self):
        menu = [{
            "id": "dish-1",
            "name": {"en": "Dish"},
            "price": 2500,
            "available": False,
        }]
        with self.assertRaisesRegex(ValueError, "menu_item_unavailable"):
            app_module.authoritative_order_items(
                _MenuConnection(menu),
                [{"id": "dish-1", "price": 2500, "qty": 1}],
            )

    def test_size_must_be_an_approved_menu_option(self):
        menu = [{
            "id": "drink-1",
            "name": {"en": "Tea"},
            "price": 500,
            "available": True,
            "sizes": [
                {"label": "Small", "price": 500},
                {"label": "Large", "price": 800},
            ],
        }]
        items = app_module.authoritative_order_items(
            _MenuConnection(menu),
            [{
                "id": "drink-1",
                "price": 1,
                "qty": 1,
                "sizeLabel": "Large",
            }],
        )
        self.assertEqual(items[0]["price"], 800)
        self.assertEqual(items[0]["sizeLabel"], "Large")

    def test_only_bounded_order_fields_are_kept(self):
        body = {
            "id": "o12345678901234567890",
            "num": 101,
            "type": "pickup",
            "name": "Customer",
            "phone": "+7 700 000 00 00",
            "comment": "",
            "captcha": "one-time-token",
            "unexpected": {"large": "client-controlled"},
            "paymentMethod": "at_table",
        }
        order = app_module.normalize_order_request(body)
        self.assertNotIn("captcha", order)
        self.assertNotIn("unexpected", order)
        self.assertEqual(order["type"], "pickup")

    def test_seed_menu_has_unique_ids_and_valid_prices(self):
        seed = json.loads(
            (BACKEND_DIR / "menu_seed.json").read_text(encoding="utf-8")
        )
        self.assertEqual(len(seed), len({item["id"] for item in seed}))
        self.assertTrue(all(
            isinstance(item.get("price"), int) and item["price"] > 0
            for item in seed
        ))

    def test_turnstile_network_failure_is_closed(self):
        with patch.object(
            app_module.http_requests,
            "post",
            side_effect=app_module.http_requests.RequestException("offline"),
        ):
            self.assertFalse(app_module.turnstile_ok("token", "127.0.0.1"))


if __name__ == "__main__":
    unittest.main()
