import unittest

from loyalty import (
    LoyaltyError,
    adjust_account,
    apply_redemption,
    code_digest,
    earn_amount,
    generate_code,
    mask_code,
    normalize_code,
    normalize_phone,
    redemption_limit,
    token_digest,
)


class _Result:
    def __init__(self, one=None, many=None):
        self.one = one
        self.many = many or []

    def fetchone(self):
        return self.one

    def fetchall(self):
        return self.many


class _RedemptionConnection:
    def __init__(self):
        self.credits = [
            {"id": 1, "account_id": "account-1", "remaining": 1500, "expires_at": 2000},
            {"id": 2, "account_id": "account-1", "remaining": 1000, "expires_at": 3000},
        ]
        self.events = []
        self.redemptions = []

    def execute(self, query, args=()):
        sql = " ".join(query.split())
        if sql.startswith("SELECT amount FROM loyalty_events"):
            order_id = args[0]
            event = next(
                (item for item in self.events
                 if item["order_id"] == order_id and item["kind"] == "redeem"),
                None,
            )
            return _Result({"amount": event["amount"]} if event else None)
        if sql.startswith("SELECT id, remaining FROM loyalty_credits"):
            account_id, at_ms = args
            rows = [
                {"id": item["id"], "remaining": item["remaining"]}
                for item in sorted(self.credits, key=lambda item: (item["expires_at"], item["id"]))
                if item["account_id"] == account_id
                and item["remaining"] > 0
                and item["expires_at"] > at_ms
            ]
            return _Result(many=rows)
        if sql.startswith("UPDATE loyalty_credits SET remaining = remaining -"):
            used, credit_id = args
            next(item for item in self.credits if item["id"] == credit_id)["remaining"] -= used
            return _Result()
        if sql.startswith("INSERT INTO loyalty_redemptions"):
            order_id, credit_id, account_id, amount, created_at = args
            self.redemptions.append({
                "order_id": order_id,
                "credit_id": credit_id,
                "account_id": account_id,
                "amount": amount,
                "created_at": created_at,
            })
            return _Result()
        if sql.startswith("INSERT INTO loyalty_events"):
            account_id, order_id, amount, created_at, data = args
            self.events.append({
                "account_id": account_id,
                "order_id": order_id,
                "kind": "redeem",
                "amount": amount,
                "created_at": created_at,
                "data": data,
            })
            return _Result()
        if sql.startswith("UPDATE loyalty_accounts SET updated_at"):
            return _Result()
        raise AssertionError(f"Unexpected SQL in test: {sql}")


class LoyaltyRuleTests(unittest.TestCase):
    def test_normalizes_kazakhstan_phone_numbers(self):
        self.assertEqual(normalize_phone("+7 (701) 234-56-78"), "77012345678")
        self.assertEqual(normalize_phone("8 701 234 56 78"), "77012345678")
        self.assertEqual(normalize_phone("7012345678"), "77012345678")
        with self.assertRaises(LoyaltyError):
            normalize_phone("123")

    def test_token_digest_rejects_short_tokens(self):
        self.assertIsNone(token_digest("short"))
        self.assertEqual(token_digest("a" * 32), token_digest("a" * 32))
        self.assertNotEqual(token_digest("a" * 32), token_digest("b" * 32))

    def test_loyalty_code_format_mask_and_keyed_digest(self):
        code = "12345678!"
        self.assertEqual(normalize_code(f" {code} "), code)
        self.assertEqual(mask_code(code), "12******!")
        digest = code_digest(code, secret="a" * 32)
        self.assertEqual(digest, code_digest(code, secret="a" * 32))
        self.assertNotEqual(digest, code_digest(code, secret="b" * 32))
        with self.assertRaises(LoyaltyError):
            normalize_code("1234567!")

    def test_generated_loyalty_codes_have_eight_digits_and_one_sign(self):
        for _ in range(50):
            self.assertRegex(generate_code(), r"^\d{8}[!@#$%_+=\)/]$")

    def test_earning_and_redemption_limits_use_whole_tenge(self):
        self.assertEqual(earn_amount(10_000), 300)
        self.assertEqual(earn_amount(10_000, 2_000), 240)
        self.assertEqual(redemption_limit(10_003), 2_000)
        self.assertEqual(redemption_limit(1_000_000), 50_000)

    def test_staff_adjustment_requires_an_audit_note(self):
        with self.assertRaisesRegex(LoyaltyError, "adjustment_note_required"):
            adjust_account(None, "account-1", 500, "   ", at_ms=1000)

    def test_redemption_is_fifo_capped_and_idempotent(self):
        conn = _RedemptionConnection()
        used = apply_redemption(
            conn, "account-1", "order-1", requested=3000, subtotal=10_000, at_ms=1000
        )
        self.assertEqual(used, 2000)
        self.assertEqual([item["remaining"] for item in conn.credits], [0, 500])
        self.assertEqual([item["amount"] for item in conn.redemptions], [1500, 500])
        self.assertEqual(conn.events[0]["amount"], -2000)

        used_again = apply_redemption(
            conn, "account-1", "order-1", requested=3000, subtotal=10_000, at_ms=1000
        )
        self.assertEqual(used_again, 2000)
        self.assertEqual([item["remaining"] for item in conn.credits], [0, 500])
        self.assertEqual(len(conn.redemptions), 2)


if __name__ == "__main__":
    unittest.main()
