import hashlib
import hmac
import json
import os
import re
import secrets
import time
import uuid


EARN_PERCENT = 3
REDEEM_PERCENT = 20
EXPIRY_DAYS = 90
RESTORE_EXPIRY_DAYS = 90
MAX_ADJUSTMENT = 1_000_000
MAX_REDEMPTION_PER_ORDER = 50_000
LOYALTY_CODE_RE = re.compile(r"^\d{9}$")
ACCESS_WINDOW_MS = 15 * 60 * 1000
ACCESS_SCOPE_LIMITS = {"device": 5, "ip": 5, "global": 500}


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
    percentage_limit = max(0, int(subtotal or 0)) * REDEEM_PERCENT // 100
    return min(percentage_limit, MAX_REDEMPTION_PER_ORDER)


def token_digest(token):
    if not isinstance(token, str) or not 20 <= len(token) <= 200:
        return None
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_code(value):
    if not isinstance(value, str):
        raise LoyaltyError("invalid_loyalty_id")
    code = value.strip()
    if not LOYALTY_CODE_RE.fullmatch(code):
        raise LoyaltyError("invalid_loyalty_id")
    return code


def _hmac_secret(secret=None):
    value = secret or os.environ.get("LOYALTY_HMAC_SECRET") or os.environ.get("JWT_SECRET")
    if not isinstance(value, str) or len(value) < 32:
        raise RuntimeError("LOYALTY_HMAC_SECRET (or JWT_SECRET) must be at least 32 characters")
    return value.encode("utf-8")


def code_digest(code, secret=None):
    normalized = normalize_code(code)
    return hmac.new(
        _hmac_secret(secret),
        f"yusup-loyalty-code-v2:{normalized}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def mask_code(code):
    normalized = normalize_code(code)
    return f"{normalized[:2]}******{normalized[-1]}"


def generate_code():
    return f"{secrets.randbelow(1_000_000_000):09d}"


def _scope_digest(kind, value):
    return hmac.new(
        _hmac_secret(),
        f"yusup-loyalty-attempt:{kind}:{value}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _access_scopes(remote_address, device_id):
    scopes = [("global", "global", ACCESS_SCOPE_LIMITS["global"])]
    if remote_address:
        scopes.append(("ip", _scope_digest("ip", remote_address), ACCESS_SCOPE_LIMITS["ip"]))
    if isinstance(device_id, str) and 16 <= len(device_id) <= 100:
        scopes.append(("device", _scope_digest("device", device_id), ACCESS_SCOPE_LIMITS["device"]))
    return scopes


def access_is_limited(conn, remote_address, device_id, at_ms=None):
    at_ms = int(at_ms or now_ms())
    cutoff = at_ms - ACCESS_WINDOW_MS
    for kind, scope, limit in _access_scopes(remote_address, device_id):
        row = conn.execute(
            "SELECT failures, window_started FROM loyalty_access_attempts WHERE scope = %s",
            (scope,),
        ).fetchone()
        if row and int(row["window_started"]) > cutoff and int(row["failures"]) >= limit:
            return True
    return False


def record_access_failure(conn, remote_address, device_id, at_ms=None):
    at_ms = int(at_ms or now_ms())
    cutoff = at_ms - ACCESS_WINDOW_MS
    conn.execute(
        "DELETE FROM loyalty_access_attempts WHERE updated_at <= %s",
        (at_ms - 30 * 24 * 60 * 60 * 1000,),
    )
    for _kind, scope, _limit in _access_scopes(remote_address, device_id):
        conn.execute(
            "INSERT INTO loyalty_access_attempts (scope, failures, window_started, updated_at) "
            "VALUES (%s, 1, %s, %s) "
            "ON CONFLICT (scope) DO UPDATE SET "
            "failures = CASE WHEN loyalty_access_attempts.window_started <= %s "
            "THEN 1 ELSE loyalty_access_attempts.failures + 1 END, "
            "window_started = CASE WHEN loyalty_access_attempts.window_started <= %s "
            "THEN EXCLUDED.window_started ELSE loyalty_access_attempts.window_started END, "
            "updated_at = EXCLUDED.updated_at",
            (scope, at_ms, at_ms, cutoff, cutoff),
        )


def install_schema(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS loyalty_accounts (
            id TEXT PRIMARY KEY,
            phone TEXT NOT NULL,
            token_hash TEXT UNIQUE,
            code_hash TEXT,
            code_hint TEXT,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL
        )
    """)
    # Safe in-place migration from the original phone-bound scheme. Phone is
    # retained for staff contact/search, but is no longer unique or usable as
    # proof of ownership. token_hash remains temporarily for one-time migration
    # of customers who still have an old browser token.
    conn.execute("ALTER TABLE loyalty_accounts ADD COLUMN IF NOT EXISTS code_hash TEXT")
    conn.execute("ALTER TABLE loyalty_accounts ADD COLUMN IF NOT EXISTS code_hint TEXT")
    conn.execute("ALTER TABLE loyalty_accounts DROP CONSTRAINT IF EXISTS loyalty_accounts_phone_key")
    conn.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS loyalty_accounts_code_hash
        ON loyalty_accounts (code_hash) WHERE code_hash IS NOT NULL
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
    conn.execute("""
        CREATE TABLE IF NOT EXISTS loyalty_access_attempts (
            scope TEXT PRIMARY KEY,
            failures INTEGER NOT NULL,
            window_started BIGINT NOT NULL,
            updated_at BIGINT NOT NULL
        )
    """)


def account_by_token(conn, token):
    digest = token_digest(token)
    if not digest:
        return None
    return conn.execute(
        "SELECT id, phone, token_hash, code_hash, code_hint, created_at, updated_at "
        "FROM loyalty_accounts WHERE token_hash = %s",
        (digest,),
    ).fetchone()


def account_by_code(conn, code, for_update=False):
    digest = code_digest(code)
    suffix = " FOR UPDATE" if for_update else ""
    return conn.execute(
        "SELECT id, phone, token_hash, code_hash, code_hint, created_at, updated_at "
        f"FROM loyalty_accounts WHERE code_hash = %s{suffix}",
        (digest,),
    ).fetchone()


def _unique_code(conn):
    for _attempt in range(20):
        code = generate_code()
        digest = code_digest(code)
        exists = conn.execute(
            "SELECT 1 FROM loyalty_accounts WHERE code_hash = %s",
            (digest,),
        ).fetchone()
        if not exists:
            return code, digest
    raise LoyaltyError("loyalty_id_generation_failed")


def create_account(conn, phone, at_ms=None):
    at_ms = int(at_ms or now_ms())
    normalized = normalize_phone(phone)
    code, digest = _unique_code(conn)
    account_id = "l" + uuid.uuid4().hex
    hint = mask_code(code)
    conn.execute(
        "INSERT INTO loyalty_accounts "
        "(id, phone, token_hash, code_hash, code_hint, created_at, updated_at) "
        "VALUES (%s, %s, NULL, %s, %s, %s, %s)",
        (account_id, normalized, digest, hint, at_ms, at_ms),
    )
    account = {
        "id": account_id,
        "phone": normalized,
        "token_hash": None,
        "code_hash": digest,
        "code_hint": hint,
        "created_at": at_ms,
        "updated_at": at_ms,
    }
    return account, code


def rotate_account_code(conn, account_id, at_ms=None, revoke_legacy=True):
    at_ms = int(at_ms or now_ms())
    account = conn.execute(
        "SELECT id FROM loyalty_accounts WHERE id = %s FOR UPDATE",
        (account_id,),
    ).fetchone()
    if not account:
        raise LoyaltyError("loyalty_not_found")
    code, digest = _unique_code(conn)
    hint = mask_code(code)
    if revoke_legacy:
        conn.execute(
            "UPDATE loyalty_accounts SET code_hash = %s, code_hint = %s, "
            "token_hash = NULL, updated_at = %s WHERE id = %s",
            (digest, hint, at_ms, account_id),
        )
    else:
        conn.execute(
            "UPDATE loyalty_accounts SET code_hash = %s, code_hint = %s, "
            "updated_at = %s WHERE id = %s",
            (digest, hint, at_ms, account_id),
        )
    return code


def available_balance(conn, account_id, at_ms=None):
    at_ms = int(at_ms or now_ms())
    row = conn.execute(
        "SELECT COALESCE(SUM(remaining), 0) AS balance "
        "FROM loyalty_credits "
        "WHERE account_id = %s AND remaining > 0 AND expires_at > %s",
        (account_id, at_ms),
    ).fetchone()
    return int((row or {}).get("balance") or 0)


def snapshot(conn, account_id, issued_code=None, at_ms=None, include_phone=False):
    at_ms = int(at_ms or now_ms())
    account = conn.execute(
        "SELECT id, phone, code_hint, created_at, updated_at FROM loyalty_accounts WHERE id = %s",
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
        "maskedCode": account.get("code_hint") or "Legacy account",
        "balance": int(credit_row.get("balance") or 0),
        "pending": int(pending),
        "nextExpiry": credit_row.get("next_expiry"),
        "earnPercent": EARN_PERCENT,
        "redeemPercent": REDEEM_PERCENT,
        "maxRedemptionPerOrder": MAX_REDEMPTION_PER_ORDER,
        "expiryDays": EXPIRY_DAYS,
        "events": [{
            "kind": event["kind"],
            "amount": int(event["amount"]),
            "orderId": event.get("order_id"),
            "createdAt": int(event["created_at"]),
            "data": event.get("data") if isinstance(event.get("data"), dict) else {},
        } for event in events],
    }
    if include_phone:
        result["phone"] = account["phone"]
    if issued_code:
        result["code"] = issued_code
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
        "SELECT a.id, a.phone, a.code_hint, a.created_at, a.updated_at, "
        "COALESCE(SUM(c.amount), 0) AS issued, "
        "COALESCE(SUM(CASE WHEN c.remaining > 0 AND c.expires_at > %s "
        "THEN c.remaining ELSE 0 END), 0) AS balance "
        "FROM loyalty_accounts a "
        "LEFT JOIN loyalty_credits c ON c.account_id = a.id "
        "GROUP BY a.id, a.phone, a.code_hint, a.created_at, a.updated_at "
        "ORDER BY a.updated_at DESC LIMIT 250",
        (at_ms,),
    ).fetchall()
    redeemed_row = conn.execute(
        "SELECT COALESCE(SUM(-amount), 0) AS redeemed "
        "FROM loyalty_events WHERE kind = 'redeem'"
    ).fetchone() or {}
    recent = conn.execute(
        "SELECT e.kind, e.amount, e.order_id, e.created_at, e.data, "
        "a.phone, a.code_hint, a.id AS account_id "
        "FROM loyalty_events e JOIN loyalty_accounts a ON a.id = e.account_id "
        "ORDER BY e.created_at DESC, e.id DESC LIMIT 100"
    ).fetchall()
    accounts = [{
        "id": row["id"],
        "phone": row["phone"],
        "maskedCode": row.get("code_hint") or "Legacy account",
        "balance": int(row["balance"] or 0),
        "issued": int(row["issued"] or 0),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    } for row in rows]
    return {
        "settings": {
            "earnPercent": EARN_PERCENT,
            "redeemPercent": REDEEM_PERCENT,
            "maxRedemptionPerOrder": MAX_REDEMPTION_PER_ORDER,
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
            "maskedCode": row.get("code_hint") or "Legacy account",
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
