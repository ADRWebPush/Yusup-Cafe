import hashlib
import hmac
import json
import re
import secrets
import time
import uuid


EARN_PERCENT = 3
REDEEM_PERCENT = 20
EXPIRY_DAYS = 90
RESTORE_EXPIRY_DAYS = 90
MAX_ADJUSTMENT = 1_000_000


class LoyaltyError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def now_ms():
    return int(time.time() * 1000)


def normalize_phone(value):
    if not isinstance(value, str):
        raise LoyaltyError("invalid_phone")
    digits = re.sub(r"\D", "", value)
    if len(digits) == 10:
        digits = "7" + digits
    elif len(digits) == 11 and digits.startswith("8"):
        digits = "7" + digits[1:]
    if not 10 <= len(digits) <= 15:
        raise LoyaltyError("invalid_phone")
    return digits


def mask_phone(phone):
    phone = str(phone or "")
    if len(phone) < 4:
        return "****"
    prefix = "+" + phone[:1] if len(phone) == 11 and phone.startswith("7") else "+"
    return f"{prefix} *** *** ** {phone[-2:]}"


def earn_amount(subtotal, bonus_used=0):
    eligible = max(0, int(subtotal or 0) - max(0, int(bonus_used or 0)))
    return eligible * EARN_PERCENT // 100


def redemption_limit(subtotal):
    return max(0, int(subtotal or 0)) * REDEEM_PERCENT // 100


def token_digest(token):
    if not isinstance(token, str) or not 20 <= len(token) <= 200:
        return None
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def install_schema(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS loyalty_accounts (
            id TEXT PRIMARY KEY,
            phone TEXT NOT NULL UNIQUE,
            token_hash TEXT UNIQUE,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS loyalty_credits (
            id BIGSERIAL PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
            order_id TEXT,
            source TEXT NOT NULL,
            amount INTEGER NOT NULL CHECK (amount >= 0),
            remaining INTEGER NOT NULL CHECK (remaining >= 0 AND remaining <= amount),
            expires_at BIGINT NOT NULL,
            created_at BIGINT NOT NULL,
            UNIQUE (order_id, source)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS loyalty_credits_available
        ON loyalty_credits (account_id, expires_at)
        WHERE remaining > 0
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS loyalty_redemptions (
            order_id TEXT NOT NULL,
            credit_id BIGINT NOT NULL REFERENCES loyalty_credits(id),
            account_id TEXT NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
            amount INTEGER NOT NULL CHECK (amount > 0),
            created_at BIGINT NOT NULL,
            restored_at BIGINT,
            PRIMARY KEY (order_id, credit_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS loyalty_events (
            id BIGSERIAL PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
            order_id TEXT,
            kind TEXT NOT NULL,
            amount INTEGER NOT NULL,
            created_at BIGINT NOT NULL,
            data JSONB NOT NULL DEFAULT '{}'::jsonb,
            UNIQUE (order_id, kind)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS loyalty_events_account
        ON loyalty_events (account_id, created_at DESC)
    """)


def _new_token():
    return secrets.token_urlsafe(32)


def account_by_token(conn, token):
    digest = token_digest(token)
    if not digest:
        return None
    return conn.execute(
        "SELECT id, phone, token_hash, created_at, updated_at "
        "FROM loyalty_accounts WHERE token_hash = %s",
        (digest,),
    ).fetchone()


def prepare_account(conn, phone, supplied_token=None, at_ms=None):
    at_ms = int(at_ms or now_ms())
    normalized = normalize_phone(phone)
    account = conn.execute(
        "SELECT id, phone, token_hash, created_at, updated_at "
        "FROM loyalty_accounts WHERE phone = %s FOR UPDATE",
        (normalized,),
    ).fetchone()

    if not account:
        issued_token = _new_token()
        account_id = "l" + uuid.uuid4().hex
        digest = token_digest(issued_token)
        conn.execute(
            "INSERT INTO loyalty_accounts "
            "(id, phone, token_hash, created_at, updated_at) "
            "VALUES (%s, %s, %s, %s, %s)",
            (account_id, normalized, digest, at_ms, at_ms),
        )
        account = {
            "id": account_id,
            "phone": normalized,
            "token_hash": digest,
            "created_at": at_ms,
            "updated_at": at_ms,
        }
        return account, issued_token, True

    supplied_digest = token_digest(supplied_token)
    authenticated = bool(
        supplied_digest
        and account.get("token_hash")
        and hmac.compare_digest(supplied_digest, account["token_hash"])
    )
    issued_token = None

    # Staff can reset a lost device. The next successful order for that phone
    # securely claims a fresh token; no plaintext token is stored server-side.
    if not account.get("token_hash"):
        issued_token = _new_token()
        digest = token_digest(issued_token)
        conn.execute(
            "UPDATE loyalty_accounts SET token_hash = %s, updated_at = %s "
            "WHERE id = %s",
            (digest, at_ms, account["id"]),
        )
        account["token_hash"] = digest
        authenticated = True

    return account, issued_token, authenticated


def available_balance(conn, account_id, at_ms=None):
    at_ms = int(at_ms or now_ms())
    row = conn.execute(
        "SELECT COALESCE(SUM(remaining), 0) AS balance "
        "FROM loyalty_credits "
        "WHERE account_id = %s AND remaining > 0 AND expires_at > %s",
        (account_id, at_ms),
    ).fetchone()
    return int((row or {}).get("balance") or 0)


def snapshot(conn, account_id, issued_token=None, at_ms=None, include_phone=False):
    at_ms = int(at_ms or now_ms())
    account = conn.execute(
        "SELECT id, phone, created_at, updated_at FROM loyalty_accounts WHERE id = %s",
        (account_id,),
    ).fetchone()
    if not account:
        raise LoyaltyError("loyalty_not_found")

    credit_row = conn.execute(
        "SELECT COALESCE(SUM(remaining), 0) AS balance, "
        "MIN(expires_at) FILTER (WHERE remaining > 0 AND expires_at > %s) AS next_expiry "
        "FROM loyalty_credits WHERE account_id = %s "
        "AND remaining > 0 AND expires_at > %s",
        (at_ms, account_id, at_ms),
    ).fetchone() or {}
    pending_rows = conn.execute(
        "SELECT data FROM orders "
        "WHERE data->>'loyaltyAccountId' = %s "
        "AND status NOT IN ('done','cancelled','expired','payment_failed')",
        (account_id,),
    ).fetchall()
    pending = sum(
        max(0, int((row.get("data") or {}).get("bonusPending") or 0))
        for row in pending_rows
    )
    events = conn.execute(
        "SELECT kind, amount, order_id, created_at, data "
        "FROM loyalty_events WHERE account_id = %s "
        "ORDER BY created_at DESC, id DESC LIMIT 40",
        (account_id,),
    ).fetchall()

    result = {
        "accountId": account["id"],
        "phone": account["phone"] if include_phone else mask_phone(account["phone"]),
        "balance": int(credit_row.get("balance") or 0),
        "pending": int(pending),
        "nextExpiry": credit_row.get("next_expiry"),
        "earnPercent": EARN_PERCENT,
        "redeemPercent": REDEEM_PERCENT,
        "expiryDays": EXPIRY_DAYS,
        "events": [{
            "kind": event["kind"],
            "amount": int(event["amount"]),
            "orderId": event.get("order_id"),
            "createdAt": int(event["created_at"]),
            "data": event.get("data") if isinstance(event.get("data"), dict) else {},
        } for event in events],
    }
    if issued_token:
        result["token"] = issued_token
    return result


def apply_redemption(conn, account_id, order_id, requested, subtotal, at_ms=None):
    at_ms = int(at_ms or now_ms())
    try:
        requested = int(requested or 0)
    except (TypeError, ValueError):
        raise LoyaltyError("invalid_bonus_amount") from None
    if requested < 0 or requested > MAX_ADJUSTMENT:
        raise LoyaltyError("invalid_bonus_amount")
    if requested == 0:
        return 0

    existing = conn.execute(
        "SELECT amount FROM loyalty_events "
        "WHERE order_id = %s AND kind = 'redeem'",
        (order_id,),
    ).fetchone()
    if existing:
        return abs(int(existing["amount"]))

    credits = conn.execute(
        "SELECT id, remaining FROM loyalty_credits "
        "WHERE account_id = %s AND remaining > 0 AND expires_at > %s "
        "ORDER BY expires_at ASC, id ASC FOR UPDATE",
        (account_id, at_ms),
    ).fetchall()
    available = sum(int(row["remaining"]) for row in credits)
    allowed = min(requested, available, redemption_limit(subtotal))
    if allowed <= 0:
        return 0

    left = allowed
    for credit in credits:
        if left <= 0:
            break
        used = min(left, int(credit["remaining"]))
        conn.execute(
            "UPDATE loyalty_credits SET remaining = remaining - %s WHERE id = %s",
            (used, credit["id"]),
        )
        conn.execute(
            "INSERT INTO loyalty_redemptions "
            "(order_id, credit_id, account_id, amount, created_at) "
            "VALUES (%s, %s, %s, %s, %s)",
            (order_id, credit["id"], account_id, used, at_ms),
        )
        left -= used

    conn.execute(
        "INSERT INTO loyalty_events "
        "(account_id, order_id, kind, amount, created_at, data) "
        "VALUES (%s, %s, 'redeem', %s, %s, %s)",
        (
            account_id,
            order_id,
            -allowed,
            at_ms,
            json.dumps({"requested": requested, "limit": redemption_limit(subtotal)}),
        ),
    )
    conn.execute(
        "UPDATE loyalty_accounts SET updated_at = %s WHERE id = %s",
        (at_ms, account_id),
    )
    return allowed


def award_order(conn, order, at_ms=None):
    account_id = order.get("loyaltyAccountId")
    if not account_id:
        return 0
    at_ms = int(at_ms or now_ms())
    amount = earn_amount(order.get("subtotal"), order.get("bonusUsed"))
    existing = conn.execute(
        "SELECT amount FROM loyalty_credits "
        "WHERE order_id = %s AND source = 'earn'",
        (order["id"],),
    ).fetchone()
    if existing:
        amount = int(existing["amount"])
        order["bonusEarned"] = amount
        order["bonusPending"] = 0
        return amount

    if amount > 0:
        expires_at = at_ms + EXPIRY_DAYS * 24 * 60 * 60 * 1000
        conn.execute(
            "INSERT INTO loyalty_credits "
            "(account_id, order_id, source, amount, remaining, expires_at, created_at) "
            "VALUES (%s, %s, 'earn', %s, %s, %s, %s)",
            (account_id, order["id"], amount, amount, expires_at, at_ms),
        )
        conn.execute(
            "INSERT INTO loyalty_events "
            "(account_id, order_id, kind, amount, created_at, data) "
            "VALUES (%s, %s, 'earn', %s, %s, %s)",
            (
                account_id,
                order["id"],
                amount,
                at_ms,
                json.dumps({"expiresAt": expires_at}),
            ),
        )
        conn.execute(
            "UPDATE loyalty_accounts SET updated_at = %s WHERE id = %s",
            (at_ms, account_id),
        )
    order["bonusEarned"] = amount
    order["bonusPending"] = 0
    return amount


def restore_order_redemption(conn, order, at_ms=None):
    account_id = order.get("loyaltyAccountId")
    if not account_id:
        return 0
    at_ms = int(at_ms or now_ms())
    existing = conn.execute(
        "SELECT amount FROM loyalty_events "
        "WHERE order_id = %s AND kind = 'restore'",
        (order["id"],),
    ).fetchone()
    if existing:
        return int(existing["amount"])

    rows = conn.execute(
        "SELECT credit_id, amount FROM loyalty_redemptions "
        "WHERE order_id = %s AND restored_at IS NULL FOR UPDATE",
        (order["id"],),
    ).fetchall()
    restored = sum(int(row["amount"]) for row in rows)
    if restored <= 0:
        return 0

    expires_at = at_ms + RESTORE_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    conn.execute(
        "INSERT INTO loyalty_credits "
        "(account_id, order_id, source, amount, remaining, expires_at, created_at) "
        "VALUES (%s, %s, 'restore', %s, %s, %s, %s)",
        (account_id, order["id"], restored, restored, expires_at, at_ms),
    )
    conn.execute(
        "UPDATE loyalty_redemptions SET restored_at = %s "
        "WHERE order_id = %s AND restored_at IS NULL",
        (at_ms, order["id"]),
    )
    conn.execute(
        "INSERT INTO loyalty_events "
        "(account_id, order_id, kind, amount, created_at, data) "
        "VALUES (%s, %s, 'restore', %s, %s, %s)",
        (
            account_id,
            order["id"],
            restored,
            at_ms,
            json.dumps({"expiresAt": expires_at}),
        ),
    )
    conn.execute(
        "UPDATE loyalty_accounts SET updated_at = %s WHERE id = %s",
        (at_ms, account_id),
    )
    return restored


def admin_report(conn, at_ms=None):
    at_ms = int(at_ms or now_ms())
    rows = conn.execute(
        "SELECT a.id, a.phone, a.created_at, a.updated_at, "
        "COALESCE(SUM(c.amount), 0) AS issued, "
        "COALESCE(SUM(CASE WHEN c.remaining > 0 AND c.expires_at > %s "
        "THEN c.remaining ELSE 0 END), 0) AS balance "
        "FROM loyalty_accounts a "
        "LEFT JOIN loyalty_credits c ON c.account_id = a.id "
        "GROUP BY a.id, a.phone, a.created_at, a.updated_at "
        "ORDER BY a.updated_at DESC LIMIT 250",
        (at_ms,),
    ).fetchall()
    redeemed_row = conn.execute(
        "SELECT COALESCE(SUM(-amount), 0) AS redeemed "
        "FROM loyalty_events WHERE kind = 'redeem'"
    ).fetchone() or {}
    recent = conn.execute(
        "SELECT e.kind, e.amount, e.order_id, e.created_at, e.data, "
        "a.phone, a.id AS account_id "
        "FROM loyalty_events e JOIN loyalty_accounts a ON a.id = e.account_id "
        "ORDER BY e.created_at DESC, e.id DESC LIMIT 100"
    ).fetchall()
    accounts = [{
        "id": row["id"],
        "phone": row["phone"],
        "balance": int(row["balance"] or 0),
        "issued": int(row["issued"] or 0),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    } for row in rows]
    return {
        "settings": {
            "earnPercent": EARN_PERCENT,
            "redeemPercent": REDEEM_PERCENT,
            "expiryDays": EXPIRY_DAYS,
        },
        "summary": {
            "customers": len(accounts),
            "available": sum(item["balance"] for item in accounts),
            "issued": sum(item["issued"] for item in accounts),
            "redeemed": int(redeemed_row.get("redeemed") or 0),
        },
        "accounts": accounts,
        "events": [{
            "accountId": row["account_id"],
            "phone": row["phone"],
            "kind": row["kind"],
            "amount": int(row["amount"]),
            "orderId": row.get("order_id"),
            "createdAt": int(row["created_at"]),
            "data": row.get("data") if isinstance(row.get("data"), dict) else {},
        } for row in recent],
    }


def adjust_account(conn, account_id, amount, note="", at_ms=None):
    at_ms = int(at_ms or now_ms())
    try:
        amount = int(amount)
    except (TypeError, ValueError):
        raise LoyaltyError("invalid_bonus_amount") from None
    if amount == 0 or abs(amount) > MAX_ADJUSTMENT:
        raise LoyaltyError("invalid_bonus_amount")
    note = str(note or "").strip()[:240]
    if not note:
        raise LoyaltyError("adjustment_note_required")
    account = conn.execute(
        "SELECT id FROM loyalty_accounts WHERE id = %s FOR UPDATE",
        (account_id,),
    ).fetchone()
    if not account:
        raise LoyaltyError("loyalty_not_found")

    if amount > 0:
        expires_at = at_ms + EXPIRY_DAYS * 24 * 60 * 60 * 1000
        conn.execute(
            "INSERT INTO loyalty_credits "
            "(account_id, order_id, source, amount, remaining, expires_at, created_at) "
            "VALUES (%s, NULL, 'adjustment', %s, %s, %s, %s)",
            (account_id, amount, amount, expires_at, at_ms),
        )
    else:
        needed = -amount
        credits = conn.execute(
            "SELECT id, remaining FROM loyalty_credits "
            "WHERE account_id = %s AND remaining > 0 AND expires_at > %s "
            "ORDER BY expires_at ASC, id ASC FOR UPDATE",
            (account_id, at_ms),
        ).fetchall()
        if sum(int(row["remaining"]) for row in credits) < needed:
            raise LoyaltyError("insufficient_bonus_balance")
        for credit in credits:
            if needed <= 0:
                break
            used = min(needed, int(credit["remaining"]))
            conn.execute(
                "UPDATE loyalty_credits SET remaining = remaining - %s WHERE id = %s",
                (used, credit["id"]),
            )
            needed -= used

    conn.execute(
        "INSERT INTO loyalty_events "
        "(account_id, order_id, kind, amount, created_at, data) "
        "VALUES (%s, NULL, 'adjustment', %s, %s, %s)",
        (account_id, amount, at_ms, json.dumps({"note": note})),
    )
    conn.execute(
        "UPDATE loyalty_accounts SET updated_at = %s WHERE id = %s",
        (at_ms, account_id),
    )
    return available_balance(conn, account_id, at_ms)


def reset_access(conn, account_id, at_ms=None):
    at_ms = int(at_ms or now_ms())
    row = conn.execute(
        "UPDATE loyalty_accounts SET token_hash = NULL, updated_at = %s "
        "WHERE id = %s RETURNING id",
        (at_ms, account_id),
    ).fetchone()
    if not row:
        raise LoyaltyError("loyalty_not_found")
