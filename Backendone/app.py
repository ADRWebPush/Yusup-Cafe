from flask import Flask, jsonify, request
import requests as http_requests
from flask_cors import CORS
import sqlite3
import json
import os
import time
import datetime as dt
import re
from zoneinfo import ZoneInfo

app = Flask(__name__)
# Menu photos are embedded as compressed data URLs. Cap the complete request
# so malformed or hostile JSON cannot consume unbounded worker memory.
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

limiter = Limiter(get_remote_address, app=app,
                  default_limits=["600 per hour"])
from flask_talisman import Talisman
Talisman(app, force_https=True, strict_transport_security=True,
         content_security_policy=None)   # set a stricter policy later
# Allowed browser origins. Set CORS_ORIGINS to a comma-separated list of the
# frontend URLs for THIS deployment (e.g. "https://yusup.example,https://www.yusup.example").
# Falls back to localhost dev only, so a fresh deploy never silently inherits
# the original project's domains.
_cors_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()]
CORS(app,
     origins=_cors_origins,
     supports_credentials=True)

from db import get_db
from loyalty import (
    LoyaltyError,
    access_is_limited,
    account_by_code,
    account_by_token,
    admin_report as loyalty_admin_report,
    adjust_account as adjust_loyalty_account,
    apply_redemption,
    award_order,
    create_account as create_loyalty_account,
    earn_amount,
    install_schema as install_loyalty_schema,
    normalize_phone as normalize_loyalty_phone,
    record_access_failure,
    restore_order_redemption,
    rotate_account_code,
    snapshot as loyalty_snapshot,
)
from sales_history import aggregate_sales_history

def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS menu (
            id TEXT PRIMARY KEY,
            data JSONB NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY,
            num INTEGER NOT NULL,
            ts BIGINT NOT NULL,
            status TEXT NOT NULL,
            payment_id TEXT,
            data JSONB NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sales_history (
            order_id TEXT PRIMARY KEY,
            ts BIGINT NOT NULL,
            status TEXT NOT NULL,
            total BIGINT NOT NULL,
            updated_at BIGINT NOT NULL
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS sales_history_ts
        ON sales_history (ts)
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS table_occupancy (
            table_number INTEGER PRIMARY KEY CHECK (table_number BETWEEN 1 AND 30),
            occupied_until BIGINT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            data JSONB NOT NULL
        )
    """)
    menu_marker = conn.execute(
        "SELECT 1 FROM settings WHERE key = 'menu_initialized'"
    ).fetchone()
    if not menu_marker:
        has_menu = conn.execute("SELECT 1 FROM menu LIMIT 1").fetchone()
        if not has_menu:
            seed_path = os.path.join(os.path.dirname(__file__), "menu_seed.json")
            with open(seed_path, encoding="utf-8") as seed_file:
                seed_items = validate_menu_payload(json.load(seed_file))
            for idx, item in enumerate(seed_items):
                item["sortOrder"] = idx
                conn.execute(
                    "INSERT INTO menu (id, data) VALUES (%s, %s) "
                    "ON CONFLICT (id) DO NOTHING",
                    (item["id"], json.dumps(item)),
                )
        conn.execute(
            "INSERT INTO settings (key, data) VALUES ('menu_initialized', %s) "
            "ON CONFLICT (key) DO NOTHING",
            (json.dumps({"version": 1}),),
        )
    conn.execute("""
        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            order_id TEXT NOT NULL,
            status TEXT,
            message TEXT NOT NULL,
            ts BIGINT NOT NULL,
            read_status BOOLEAN NOT NULL DEFAULT FALSE
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ledger (
            id INTEGER PRIMARY KEY DEFAULT 1,
            accrued BIGINT NOT NULL DEFAULT 0,
            paid BIGINT NOT NULL DEFAULT 0,
            balance BIGINT NOT NULL DEFAULT 0,
            history JSONB NOT NULL DEFAULT '[]'::jsonb
        )
    """)
    conn.execute("""
        INSERT INTO ledger (id, accrued, paid, balance, history)
        VALUES (1, 0, 0, 0, '[]'::jsonb)
        ON CONFLICT (id) DO NOTHING
    """)
    install_loyalty_schema(conn)
    conn.commit()
    conn.close()

# ── MENU ──────────────────────────────────────────
from auth import check_login, require_owner, is_owner_request


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"ok": True})


@app.route("/api/login", methods=["POST"])
@limiter.limit("5 per minute; 30 per hour")  # slow brute-force attempts to a crawl
def login():
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify(error="invalid request"), 400
    token = check_login(body.get("username"), body.get("password"))
    if not token:
        return jsonify(error="wrong username or password"), 401
    return jsonify(token=token)


@app.route("/api/auth/check", methods=["GET"])
@require_owner
def auth_check():
    # Lets the frontend validate a stored token before entering the admin
    # panel (tokens expire after 12h; without this check the panel opened
    # with a dead token and every write silently failed with 401).
    return jsonify({"ok": True})


def loyalty_code():
    return request.headers.get("X-Loyalty-Code", "").strip()


def loyalty_device_id():
    return request.headers.get("X-Loyalty-Device", "").strip()


def loyalty_token():
    """Legacy browser token, accepted once so existing balances can migrate."""
    return request.headers.get("X-Loyalty-Token", "").strip()


def loyalty_account_from_request(conn, for_update=False):
    code = loyalty_code()
    if not code:
        return None
    device_id = loyalty_device_id()
    if access_is_limited(conn, request.remote_addr, device_id):
        raise LoyaltyError("loyalty_rate_limited")
    try:
        account = account_by_code(conn, code, for_update=for_update)
    except LoyaltyError:
        account = None
    if not account:
        record_access_failure(conn, request.remote_addr, device_id)
        raise LoyaltyError("invalid_loyalty_id")
    return account


def loyalty_error_response(exc):
    if exc.code == "loyalty_rate_limited":
        return jsonify({"error": "loyalty_rate_limited"}), 429
    # Never reveal whether any part of a supplied code matched.
    return jsonify({"error": "invalid_loyalty_id"}), 401


@app.route("/api/loyalty/me", methods=["GET"])
@limiter.limit("60 per minute")
def get_loyalty_account():
    conn = get_db()
    try:
        issued_code = None
        account = loyalty_account_from_request(conn)
        if not account and loyalty_token():
            account = account_by_token(conn, loyalty_token())
            if account:
                # One-time migration: the old token is revoked as the new
                # customer-held code is issued.
                issued_code = rotate_account_code(conn, account["id"])
        if not account:
            conn.close()
            return jsonify({"error": "invalid_loyalty_id"}), 401
        result = loyalty_snapshot(conn, account["id"], issued_code=issued_code)
        if issued_code:
            conn.commit()
    except LoyaltyError as exc:
        # Failed-attempt counters intentionally survive the rejected request.
        conn.commit()
        conn.close()
        return loyalty_error_response(exc)
    conn.close()
    return jsonify(result)


@app.route("/api/loyalty/rotate", methods=["POST"])
@limiter.limit("5 per hour")
def rotate_loyalty_code():
    conn = get_db()
    try:
        account = loyalty_account_from_request(conn, for_update=True)
        if not account:
            raise LoyaltyError("invalid_loyalty_id")
        issued_code = rotate_account_code(conn, account["id"])
        result = loyalty_snapshot(conn, account["id"], issued_code=issued_code)
        conn.commit()
    except LoyaltyError as exc:
        conn.commit()
        conn.close()
        return loyalty_error_response(exc)
    conn.close()
    return jsonify(result)


@app.route("/api/admin/loyalty", methods=["GET"])
@require_owner
def get_loyalty_admin():
    conn = get_db()
    result = loyalty_admin_report(conn)
    conn.close()
    return jsonify(result)


@app.route("/api/admin/loyalty/<account_id>/adjust", methods=["POST"])
@require_owner
def adjust_loyalty_admin(account_id):
    body = request.get_json(silent=True) or {}
    conn = get_db()
    try:
        balance = adjust_loyalty_account(
            conn, account_id, body.get("amount"), body.get("note")
        )
        conn.commit()
    except LoyaltyError as exc:
        conn.rollback()
        conn.close()
        status = 404 if exc.code == "loyalty_not_found" else 400
        return jsonify({"error": exc.code}), status
    conn.close()
    return jsonify({"ok": True, "balance": balance})


@app.route("/api/menu", methods=["GET"])
def get_menu():
    conn = get_db()
    rows = conn.execute("""
        SELECT data FROM menu
        ORDER BY COALESCE((data->>'sortOrder')::int, 999999), id
    """).fetchall()
    conn.close()
    items = [r["data"] for r in rows]
    return jsonify(items)


IMG_RE = re.compile(r"^data:image/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$")


@app.route("/api/menu", methods=["POST"])
@require_owner
def save_menu():
    try:
        items = validate_menu_payload(request.get_json(silent=True))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    conn = get_db()
    conn.execute("DELETE FROM menu")
    for idx, item in enumerate(items):
        item["sortOrder"] = idx
        conn.execute(
            "INSERT INTO menu (id, data) VALUES (%s, %s)",
            (item["id"], json.dumps(item))
        )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


def validate_menu_payload(raw_items):
    """Validate the complete replacement before the existing menu is deleted."""
    if not isinstance(raw_items, list) or len(raw_items) > 500:
        raise ValueError("menu_must_be_a_list")
    items = []
    seen = set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise ValueError("invalid_menu_item")
        item = dict(raw)
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id.strip() or len(item_id) > 120:
            raise ValueError("invalid_menu_item_id")
        item_id = item_id.strip()
        if item_id in seen:
            raise ValueError("duplicate_menu_item_id")
        seen.add(item_id)
        item["id"] = item_id
        image = item.get("image")
        if image is not None and image != "":
            # Menu photos are stored as compressed browser-generated data URLs.
            # Reject the entire mutation instead of silently discarding a bad
            # image while telling staff that their save succeeded.
            if (not isinstance(image, str) or len(image) > 1_500_000
                    or not IMG_RE.fullmatch(image)):
                raise ValueError("invalid_menu_image")
        elif "image" in item:
            item["image"] = None
        items.append(item)
    return items

# ── ORDERS ────────────────────────────────────────

# Fields anyone may see on the public order board. Everything else —
# customer name, phone, delivery address, map coordinates, table number,
# booking details, payment method — needs the owner login. The order id
# and exact ms timestamp are also withheld: together they would let a
# stranger reconstruct ids and read full orders via GET /api/orders/<id>.
PUBLIC_ORDER_FIELDS = (
    "num", "status", "type", "items", "subtotal", "serviceFee",
    "deliveryFee", "total", "estimated_ready_at", "preparation_started_at",
    "ready_at", "completed_at", "cancelled_at", "scheduledFor",
)

def public_order_view(o):
    slim = {k: o[k] for k in PUBLIC_ORDER_FIELDS if k in o}
    if isinstance(o.get("ts"), (int, float)):
        slim["ts"] = int(o["ts"] // 60000) * 60000  # minute precision only
    return slim

@app.route("/api/orders", methods=["GET"])
def get_orders():
    conn = get_db()
    rows = conn.execute(
        "SELECT data FROM orders "
        "WHERE status NOT IN ('pending_payment','expired','payment_failed') "
        "ORDER BY ts DESC"
    ).fetchall()
    conn.close()
    orders = [r["data"] for r in rows]
    if is_owner_request(request):
        return jsonify(orders)
    return jsonify([public_order_view(o) for o in orders])


@app.route("/api/orders/<order_id>", methods=["GET"])
def get_order(order_id):
    # A customer's own tracking screen. Possession of the id is the access
    # key: ids are generated with crypto.randomUUID() in the customer's
    # browser and never appear in any public response, so only the browser
    # that placed the order (or the owner) can know one.
    conn = get_db()
    row = conn.execute("SELECT data FROM orders WHERE id = %s", (order_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify(error="not found"), 404
    return jsonify(row["data"])


# 1. Standalone Turnstile Helper Function (No decorators here!)
def turnstile_ok(token, ip):
    if not isinstance(token, str) or not token or len(token) > 4096:
        return False
    try:
        r = http_requests.post(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            data={"secret": os.environ["TURNSTILE_SECRET"],
                  "response": token, "remoteip": ip},
            timeout=5,
        )
        r.raise_for_status()
        return r.json().get("success", False)
    except (http_requests.RequestException, ValueError):
        return False


# Kazakhstan uses a single UTC+5 zone nationwide (incl. Shymkent) since the
# 2024 unification, so Asia/Almaty is correct for the whole country.
CAFE_TZ = ZoneInfo("Asia/Almaty")
DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
DEFAULT_HOURS = {day: "08:00-01:00" for day in DAY_KEYS}
TABLE_IDS = {"t4", "t8", "t12", "t16", "t20", "t25", "t30"}
HOURS_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$")


def _hours_range(value):
    """Return an opening range in minutes, or None for malformed input."""
    if not isinstance(value, str) or not HOURS_RE.fullmatch(value):
        return None
    open_s, close_s = value.split("-")
    oh, om = (int(x) for x in open_s.split(":"))
    ch, cm = (int(x) for x in close_s.split(":"))
    return oh * 60 + om, ch * 60 + cm


# Authoritative "is the cafe open right now" check — computed here, not in
# the browser, so it can't be spoofed by a visitor's system clock/timezone
# and stays correct regardless of which timezone a customer is browsing
# from. A manual isOpen=False (staff override, e.g. a holiday) always wins;
# otherwise today's configured hours string ("HH:MM-HH:MM") is checked
# against the current Almaty time, with overnight ranges (close < open,
# e.g. "08:00-01:00") handled by wraparound.
def cafe_is_open(settings, now=None):
    if settings and settings.get("isOpen") is False:
        return False
    hours = (settings or {}).get("hours") or {}
    now = now or dt.datetime.now(CAFE_TZ)
    now_min = now.hour * 60 + now.minute
    today_idx = now.weekday()
    today_range = _hours_range(hours.get(DAY_KEYS[today_idx])) or _hours_range(DEFAULT_HOURS[DAY_KEYS[today_idx]])
    open_min, close_min = today_range
    if open_min == close_min:
        return True  # e.g. "00:00-00:00" — open 24 hours
    if open_min < close_min:
        if open_min <= now_min < close_min:
            return True
    elif now_min >= open_min:
        # Overnight ranges belong to the day on which they open. Monday's
        # 08:00-01:00 therefore covers Monday evening, not Tuesday evening.
        return True

    # After midnight, the still-open shift belongs to yesterday. Looking only
    # at today's row gives the wrong result as soon as daily hours differ.
    prev_idx = (today_idx - 1) % len(DAY_KEYS)
    prev_range = _hours_range(hours.get(DAY_KEYS[prev_idx])) or _hours_range(DEFAULT_HOURS[DAY_KEYS[prev_idx]])
    prev_open, prev_close = prev_range
    return prev_open > prev_close and now_min < prev_close


# The cafe's Kaspi payment page. Env-only on purpose: nothing user-writable
# (settings PUT, order data, admin forms) may ever control where customers
# send money. Allowlisted to Kaspi domains as defense in depth.
def kaspi_pay_url():
    url = os.environ.get("KASPI_PAY_URL", "").strip()
    if url.startswith("https://pay.kaspi.kz/") or url.startswith("https://kaspi.kz/"):
        return url
    return ""


# Service charge for waiter-served dine-in orders only.
# To-go and delivery have no waiter, so no fee.
SERVICE_FEE_RATE = 0
SERVICE_FEE_TYPES = {"table"}
PLATFORM_COMMISSION_RATE = 0.01

# Delivery pricing: concentric zones around the restaurant. The fee is
# decided by which ring the client's map pin falls in; outside the last ring
# the order is refused. Radii and fees are staff-editable via cafe settings.
# Computed here, never trusted from the client, so a tampered request cannot
# dodge the charge or order
# from another city.
import math

MAX_DELIVERY_ZONES = 8
DELIVERY_DEFAULTS = {
    # Yusup Cafe, Sayram. 2GIS publishes coordinates as longitude, latitude.
    # ring centre is code-controlled only (no admin UI sets it), so it always
    # comes from here and can never drift from a stale stored value.
    "lat": 42.434279, "lng": 69.825314,
    "zones": [{"km": 2, "fee": 0}, {"km": 4, "fee": 300}, {"km": 6, "fee": 500}],
}


def delivery_cfg(settings):
    d = (settings or {}).get("delivery") or {}
    raw = d.get("zones")
    candidate = []
    if isinstance(raw, list) and 1 <= len(raw) <= MAX_DELIVERY_ZONES:
        for zone in raw:
            if not isinstance(zone, dict):
                candidate = []
                break
            try:
                km = float(zone.get("km"))
                fee = int(zone.get("fee"))
            except (TypeError, ValueError):
                candidate = []
                break
            candidate.append({"km": km, "fee": fee})
    valid = (
        bool(candidate)
        and all(0 < zone["km"] <= 100 and 0 <= zone["fee"] <= 100_000
                for zone in candidate)
        and all(candidate[index - 1]["km"] < candidate[index]["km"]
                for index in range(1, len(candidate)))
    )
    zones = candidate if valid else [dict(zone) for zone in DELIVERY_DEFAULTS["zones"]]
    # Centre is always the code constant — staff edit radii, never the centre.
    return {"lat": DELIVERY_DEFAULTS["lat"], "lng": DELIVERY_DEFAULTS["lng"], "zones": zones}


def haversine_km(lat1, lng1, lat2, lng2):
    rad = math.radians
    a = (math.sin(rad(lat2 - lat1) / 2) ** 2
         + math.cos(rad(lat1)) * math.cos(rad(lat2)) * math.sin(rad(lng2 - lng1) / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(a))


def delivery_fee_for(cfg, lat, lng):
    """Fee for a point, or None when it lies outside every zone."""
    dist = haversine_km(cfg["lat"], cfg["lng"], lat, lng)
    for z in sorted(cfg["zones"], key=lambda z: z["km"]):
        if dist <= z["km"]:
            return z["fee"]
    return None


# ── TABLE BOOKING AVAILABILITY ─────────────────────────────────────────
# A booking occupies its table for a TIME SPAN on its date, not the whole
# day: from the client's arrival until the departure time staff record
# during the confirmation call (a default stay until then), plus a cleaning
# buffer before the next party. Each table size can exist in several
# physical copies (settings.tableCounts), so the same slot fits that many
# parties at once.
BOOKING_BUFFER_MIN = 20        # cleaning gap before the next party arrives
BOOKING_MIN_VISIT_MIN = 60     # shorter windows are not offered at all
BOOKING_DEFAULT_STAY_MIN = 180  # assumed stay until staff record departure


def _hhmm_to_min(s):
    try:
        h, m = str(s).split(":")
        v = int(h) * 60 + int(m)
        return v if 0 <= v < 24 * 60 else None
    except (ValueError, AttributeError):
        return None


def _min_to_hhmm(v):
    return "%02d:%02d" % (v // 60, v % 60)


def table_counts(settings):
    """Physical tables per size id; anything missing or invalid counts as 1."""
    raw = (settings or {}).get("tableCounts") or {}
    out = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            try:
                out[k] = max(1, min(99, int(v)))
            except (TypeError, ValueError):
                pass
    return out


def normalize_cafe_settings(raw, current=None):
    """Return the persisted, staff-editable settings or reject bad input.

    Computed/public response fields such as effectiveOpen, kaspiPayUrl and the
    delivery centre are deliberately not persisted from the browser.
    """
    if not isinstance(raw, dict):
        raise ValueError("settings_must_be_an_object")
    current = current if isinstance(current, dict) else {}

    is_open = raw.get("isOpen", current.get("isOpen", True))
    if not isinstance(is_open, bool):
        raise ValueError("invalid_open_override")

    saved_hours = current.get("hours") if isinstance(current.get("hours"), dict) else {}
    incoming_hours = raw.get("hours", {})
    if not isinstance(incoming_hours, dict):
        raise ValueError("invalid_hours")
    hours = {}
    for day in DAY_KEYS:
        value = incoming_hours.get(day, saved_hours.get(day, DEFAULT_HOURS[day]))
        if _hours_range(value) is None:
            raise ValueError("invalid_hours")
        hours[day] = value

    stop = raw.get("tableStop", current.get("tableStop", []))
    if not isinstance(stop, list) or any(v not in TABLE_IDS for v in stop):
        raise ValueError("invalid_table_stop")
    table_stop = list(dict.fromkeys(stop))

    raw_counts = raw.get("tableCounts", current.get("tableCounts", {}))
    if not isinstance(raw_counts, dict):
        raise ValueError("invalid_table_counts")
    counts = {}
    for table_id, value in raw_counts.items():
        if table_id not in TABLE_IDS or isinstance(value, bool):
            raise ValueError("invalid_table_counts")
        try:
            number = int(value)
        except (TypeError, ValueError):
            raise ValueError("invalid_table_counts") from None
        if str(number) != str(value).strip() or not 1 <= number <= 99:
            raise ValueError("invalid_table_counts")
        counts[table_id] = number

    incoming_delivery = raw.get("delivery", current.get("delivery"))
    if incoming_delivery is None:
        delivery = delivery_cfg({})
    else:
        if not isinstance(incoming_delivery, dict):
            raise ValueError("invalid_delivery_zones")
        raw_zones = incoming_delivery.get("zones")
        if (not isinstance(raw_zones, list)
                or not 1 <= len(raw_zones) <= MAX_DELIVERY_ZONES):
            raise ValueError("invalid_delivery_zones")
        zones = []
        for zone in raw_zones:
            if not isinstance(zone, dict) or isinstance(zone.get("km"), bool) or isinstance(zone.get("fee"), bool):
                raise ValueError("invalid_delivery_zones")
            try:
                km = float(zone.get("km"))
                fee = int(zone.get("fee"))
            except (TypeError, ValueError):
                raise ValueError("invalid_delivery_zones") from None
            if not 0 < km <= 100 or not 0 <= fee <= 100_000:
                raise ValueError("invalid_delivery_zones")
            zones.append({"km": km, "fee": fee})
        if any(zones[index - 1]["km"] >= zones[index]["km"]
               for index in range(1, len(zones))):
            raise ValueError("invalid_delivery_zones")
        delivery = {"zones": zones}

    return {
        "isOpen": is_open,
        "hours": hours,
        "delivery": delivery,
        "tableStop": table_stop,
        "tableCounts": counts,
    }


def booking_occupied_span(b):
    """Interval [start, end+buffer) in minutes the table is unusable, or None."""
    start = _hhmm_to_min(b.get("time"))
    if start is None:
        return None
    end = _hhmm_to_min(b.get("endTime"))
    if end is None or end <= start:
        end = min(start + BOOKING_DEFAULT_STAY_MIN, 24 * 60 - 1)
    return (start, min(end + BOOKING_BUFFER_MIN, 24 * 60))


def room_slot(bookings, count, t):
    """Availability of one table size at minute t given its other active
    bookings that date. Returns (available, sit_until_minutes_or_None):
    - not available: every physical table is taken at t, or the window
      before the tables run out is shorter than a minimal real visit;
    - sit_until: the client must free the table by then (a later booking
      needs it, minus the cleaning buffer); None = no constraint."""
    count = max(1, int(count or 1))
    spans = [s for s in (booking_occupied_span(b) for b in bookings) if s]
    if sum(1 for s, e in spans if s <= t < e) >= count:
        return False, None
    # First future arrival at which all tables would be simultaneously
    # occupied — that's when this client's table is needed back.
    sit_until = None
    for arrive in sorted({s for s, e in spans if s > t}):
        if sum(1 for s, e in spans if s <= arrive < e) >= count:
            sit_until = arrive - BOOKING_BUFFER_MIN
            break
    if sit_until is not None:
        if sit_until - t < BOOKING_MIN_VISIT_MIN:
            return False, None
        if sit_until - t >= BOOKING_DEFAULT_STAY_MIN:
            sit_until = None  # beyond a normal stay — no practical limit
    return True, sit_until


def bookings_for(conn, date, room_id=None):
    """Active bookings on a date (optionally one table size), as booking dicts."""
    rows = conn.execute(
        "SELECT data FROM orders "
        "WHERE status NOT IN ('cancelled','payment_failed','expired','done')"
    ).fetchall()
    out = []
    for r in rows:
        o = r["data"]
        if o.get("type") != "booking":
            continue
        b = o.get("booking") or {}
        if b.get("date") == date and b.get("roomId") and (room_id is None or b["roomId"] == room_id):
            out.append(b)
    return out


ORDER_TYPES = {"table", "pickup", "delivery"}
ORDER_ID_RE = re.compile(
    r"^o(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-"
    r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|[A-Za-z0-9]{20,80})$"
)
MAX_ORDER_LINES = 100
MAX_ORDER_QUANTITY = 100
MAX_MENU_PRICE = 100_000_000


def _bounded_int(value, error, minimum, maximum):
    if isinstance(value, bool):
        raise ValueError(error)
    if isinstance(value, float) and not value.is_integer():
        raise ValueError(error)
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError(error) from None
    if isinstance(value, str) and str(number) != value.strip():
        raise ValueError(error)
    if not minimum <= number <= maximum:
        raise ValueError(error)
    return number


def _clean_text(value, error, maximum, required=False):
    if value is None:
        text = ""
    elif isinstance(value, str):
        text = value.strip()
    else:
        raise ValueError(error)
    if len(text) > maximum or (required and not text):
        raise ValueError(error)
    return text


def _clean_localized(value, error, maximum):
    if isinstance(value, str):
        return _clean_text(value, error, maximum, required=True)
    if not isinstance(value, dict):
        raise ValueError(error)
    cleaned = {}
    for lang in ("en", "ru", "kz"):
        if lang in value:
            cleaned[lang] = _clean_text(value[lang], error, maximum)
    if not any(cleaned.values()):
        raise ValueError(error)
    return cleaned


def _line_name(menu_item, size_label=None):
    name = _clean_localized(menu_item.get("name"), "invalid_menu_name", 200)
    if not size_label:
        return name
    if isinstance(name, str):
        return f"{name} ({size_label})"
    return {
        lang: f"{text} ({size_label})"
        for lang, text in name.items()
    }


def _approved_size_price(size):
    if not isinstance(size, dict):
        return None
    try:
        return _bounded_int(
            size.get("price"), "invalid_menu_price", 1, MAX_MENU_PRICE
        )
    except ValueError:
        return None


def authoritative_order_items(conn, raw_items, allow_empty=False):
    """Resolve public order lines against the server-owned menu.

    Customer-supplied names and prices are display hints only. The stored
    order always uses the current menu name, availability and price.
    """
    if not isinstance(raw_items, list) or len(raw_items) > MAX_ORDER_LINES:
        raise ValueError("invalid_order_items")
    if not raw_items:
        if allow_empty:
            return []
        raise ValueError("empty_order")

    menu_rows = conn.execute("SELECT id, data FROM menu").fetchall()
    if not menu_rows:
        raise ValueError("menu_unavailable")
    menu_by_id = {str(row["id"]): row["data"] for row in menu_rows}

    normalized = []
    total_quantity = 0
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise ValueError("invalid_order_item")
        item_id = _clean_text(raw.get("id"), "invalid_order_item", 120, required=True)
        menu_item = menu_by_id.get(item_id)
        if not isinstance(menu_item, dict) or menu_item.get("available") is False:
            raise ValueError("menu_item_unavailable")

        quantity = _bounded_int(
            raw.get("qty"), "invalid_order_quantity", 1, MAX_ORDER_QUANTITY
        )
        total_quantity += quantity
        if total_quantity > MAX_ORDER_QUANTITY:
            raise ValueError("order_too_large")

        sizes = menu_item.get("sizes")
        size_label = None
        if isinstance(sizes, list) and sizes:
            requested_label = raw.get("sizeLabel")
            chosen = None
            if isinstance(requested_label, str) and requested_label.strip():
                requested_label = requested_label.strip()
                chosen = next(
                    (
                        size for size in sizes
                        if isinstance(size, dict)
                        and str(size.get("label", "")).strip() == requested_label
                    ),
                    None,
                )
            else:
                # Compatibility for a customer with an older cached frontend:
                # a claimed price may select one of the server-approved sizes,
                # but can never introduce a new or cheaper price.
                try:
                    claimed_price = _bounded_int(
                        raw.get("price"), "invalid_order_size", 1, MAX_MENU_PRICE
                    )
                except ValueError:
                    claimed_price = None
                matches = [
                    size for size in sizes
                    if _approved_size_price(size) == claimed_price
                ]
                if len(matches) == 1:
                    chosen = matches[0]
            if not chosen:
                raise ValueError("invalid_order_size")
            size_label = _clean_text(
                chosen.get("label"), "invalid_order_size", 80, required=True
            )
            price = _bounded_int(
                chosen.get("price"), "invalid_menu_price", 1, MAX_MENU_PRICE
            )
        else:
            if raw.get("sizeLabel") not in (None, ""):
                raise ValueError("invalid_order_size")
            price = _bounded_int(
                menu_item.get("price"), "invalid_menu_price", 1, MAX_MENU_PRICE
            )

        line = {
            "id": item_id,
            "name": _line_name(menu_item, size_label),
            "price": price,
            "qty": quantity,
        }
        if size_label:
            line["sizeLabel"] = size_label
        normalized.append(line)
    return normalized


def normalize_order_request(body):
    """Keep only bounded fields used by the website and discard the captcha."""
    if not isinstance(body, dict):
        raise ValueError("invalid_order")
    order_type = body.get("type")
    if order_type not in ORDER_TYPES:
        raise ValueError("invalid_order_type")

    order_id = _clean_text(body.get("id"), "invalid_order_id", 81, required=True)
    if not ORDER_ID_RE.fullmatch(order_id):
        raise ValueError("invalid_order_id")
    order = {
        "id": order_id,
        "num": _bounded_int(
            body.get("num"), "invalid_order_number", 1, 1_000_000_000
        ),
        "ts": int(time.time() * 1000),
        "type": order_type,
        "comment": _clean_text(body.get("comment"), "invalid_comment", 1000),
    }

    if order_type == "booking":
        raw_booking = body.get("booking")
        if not isinstance(raw_booking, dict):
            raise ValueError("booking_invalid")
        room_id = raw_booking.get("roomId")
        if room_id not in TABLE_IDS:
            raise ValueError("booking_invalid")
        date_text = _clean_text(
            raw_booking.get("date"), "booking_invalid", 10, required=True
        )
        try:
            booking_date = dt.date.fromisoformat(date_text)
        except ValueError:
            raise ValueError("booking_invalid") from None
        today = dt.datetime.now(CAFE_TZ).date()
        if not today <= booking_date <= today + dt.timedelta(days=366):
            raise ValueError("booking_invalid")
        time_text = _clean_text(
            raw_booking.get("time"), "booking_invalid", 5, required=True
        )
        if _hhmm_to_min(time_text) is None:
            raise ValueError("booking_invalid")
        capacity = int(room_id[1:])
        guests_raw = raw_booking.get("guests")
        guests = None if guests_raw in (None, "") else _bounded_int(
            guests_raw, "booking_invalid", 1, capacity
        )
        phone = _clean_text(
            raw_booking.get("phone") or body.get("phone"),
            "invalid_phone", 50, required=True,
        )
        order["phone"] = phone
        order["booking"] = {
            "roomId": room_id,
            "roomName": _clean_localized(
                raw_booking.get("roomName"), "booking_invalid", 120
            ),
            "capacity": capacity,
            "date": date_text,
            "time": time_text,
            "guests": guests,
            "phone": phone,
        }
    else:
        order["name"] = _clean_text(
            body.get("name"), "invalid_name", 120,
            required=order_type in {"pickup", "delivery"},
        )
        order["phone"] = _clean_text(
            body.get("phone"), "invalid_phone", 50,
            required=order_type in {"table", "pickup", "delivery"},
        )
        order["table"] = _clean_text(
            body.get("table"), "invalid_table", 30,
            required=order_type == "table",
        )
        order["address"] = _clean_text(
            body.get("address"), "invalid_address", 500
        )

        scheduled = body.get("scheduledFor")
        if scheduled not in (None, "") and order_type in {"pickup", "delivery"}:
            scheduled = _bounded_int(
                scheduled, "invalid_schedule", 1, 9_999_999_999_999
            )
            now_ms = int(time.time() * 1000)
            if not now_ms < scheduled <= now_ms + 31 * 24 * 60 * 60 * 1000:
                raise ValueError("invalid_schedule")
            order["scheduledFor"] = scheduled
        else:
            order["scheduledFor"] = None

    if order_type == "delivery":
        try:
            lat = float(body.get("lat"))
            lng = float(body.get("lng"))
        except (TypeError, ValueError):
            raise ValueError("location_required") from None
        if (not math.isfinite(lat) or not math.isfinite(lng)
                or not -90 <= lat <= 90 or not -180 <= lng <= 180):
            raise ValueError("location_required")
        order["lat"] = lat
        order["lng"] = lng
        order["mapLink"] = f"https://2gis.kz/geo/{lng},{lat}"
        order["mapLinkGoogle"] = f"https://maps.google.com/?q={lat},{lng}"

    order["paymentMethod"] = (
        "kaspi"
        if order_type != "booking"
        and body.get("paymentMethod") == "kaspi"
        and kaspi_pay_url()
        else "at_table"
    )
    return order


def compute_service_total(items, order_type=None):
    """Return (subtotal, service_fee, grand_total) from order line items.
    Single source of truth for the 10% charge so placing and editing an
    order can never disagree. The fee applies only to waiter-served types."""
    subtotal = 0
    for it in (items or []):
        try:
            subtotal += int(it.get("price", 0)) * max(0, int(it.get("qty", 0)))
        except (TypeError, ValueError):
            continue
    service_fee = round(subtotal * SERVICE_FEE_RATE) if order_type in SERVICE_FEE_TYPES else 0
    return subtotal, service_fee, subtotal + service_fee


def restricted_takeaway_items(conn, order):
    """Return menu item ids blocked for pickup and delivery orders."""
    if order.get("type") not in ("pickup", "delivery"):
        return []
    menu_rows = conn.execute("SELECT id, data FROM menu").fetchall()
    menu_by_id = {str(row["id"]): row["data"] for row in menu_rows}
    blocked = []
    for line in order.get("items") or []:
        item_id = str(line.get("id") or "")
        menu_item = menu_by_id.get(item_id)
        if menu_item and menu_item.get("deliveryAvailable") is False and item_id not in blocked:
            blocked.append(item_id)
    return blocked


def platform_commission(amount):
    try:
        return round(max(0, int(amount)) * PLATFORM_COMMISSION_RATE)
    except (TypeError, ValueError):
        return 0


def ledger_row(conn):
    conn.execute("""
        INSERT INTO ledger (id, accrued, paid, balance, history)
        VALUES (1, 0, 0, 0, '[]'::jsonb)
        ON CONFLICT (id) DO NOTHING
    """)
    return conn.execute("SELECT accrued, paid, balance, history FROM ledger WHERE id = 1").fetchone()


def add_ledger_accrual(conn, amount, note):
    amount = int(amount or 0)
    if amount <= 0:
        return
    row = ledger_row(conn)
    history = row["history"] if isinstance(row["history"], list) else []
    history.append({"type": "accrual", "amount": amount, "note": note, "ts": int(time.time() * 1000)})
    conn.execute("""
        UPDATE ledger
        SET accrued = accrued + %s, balance = balance + %s, history = %s
        WHERE id = 1
    """, (amount, amount, json.dumps(history)))


def accrue_order_commission(conn, order):
    if order.get("feeAccrued"):
        return False
    fee = platform_commission(order.get("total", 0))
    order["fee"] = fee
    order["feeAccrued"] = True
    add_ledger_accrual(conn, fee, f"Order №{order.get('num')}")
    return True


# 2. Your Protected Flask API Endpoint
@app.route("/api/orders", methods=["POST"])
@limiter.limit("5 per minute")  # Locks down the order submission endpoint
def place_order():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="invalid_order"), 400

    # Run the invisible captcha check immediately before any logic or database calls
    if not turnstile_ok(body.get("captcha"), request.remote_addr):
        return jsonify(error="failed bot check"), 403

    conn = get_db()
    settings_row = conn.execute("SELECT data FROM settings WHERE key='cafe_status'").fetchone()
    if not cafe_is_open(settings_row["data"] if settings_row else None):
        conn.close()
        return jsonify({"error": "closed"}), 403

    try:
        order = normalize_order_request(body)
        if conn.execute(
            "SELECT 1 FROM orders WHERE id = %s", (order["id"],)
        ).fetchone():
            conn.close()
            return jsonify({"error": "duplicate_order"}), 409
        order["items"] = authoritative_order_items(
            conn,
            body.get("items"),
            allow_empty=order["type"] == "booking",
        )
    except ValueError as exc:
        conn.close()
        return jsonify({"error": str(exc)}), 400
    # The server decides the initial status — never the client. Kaspi orders
    # wait for staff to confirm the money arrived; everything else starts as
    # a normal kitchen order. (Also blocks forged 'ready'/'done' submissions.)
    order["status"] = ("awaiting_confirmation"
                       if order.get("paymentMethod") == "kaspi" and kaspi_pay_url()
                       else "new")

    blocked_items = restricted_takeaway_items(conn, order)
    if blocked_items:
        conn.close()
        return jsonify({"error": "takeaway_item_unavailable", "items": blocked_items}), 400

    # 10% service fee for waiter-served orders (table/booking), computed
    # server-side so the client can never skip it or send a lower total.
    # Subtotal is summed from the order lines; total = subtotal + fee.
    subtotal, service_fee, grand_total = compute_service_total(order.get("items", []), order.get("type"))

    # Bookings are validated against the span-aware availability at save
    # time (last write wins between two racing clients), and the departure
    # cap — when a later booking needs the table — is stamped server-side
    # so a tampered client can't claim the table for the whole evening.
    if order.get("type") == "booking":
        b = order.get("booking") or {}
        t = _hhmm_to_min(b.get("time"))
        rid = b.get("roomId")
        if t is None or not b.get("date") or not rid:
            conn.close()
            return jsonify({"error": "booking_invalid"}), 400
        others = bookings_for(conn, b["date"], rid)
        counts = table_counts(settings_row["data"] if settings_row else None)
        ok, sit = room_slot(others, counts.get(rid, 1), t)
        if not ok:
            conn.close()
            return jsonify({"error": "slot_taken"}), 409
        if sit is not None:
            b["endTime"] = _min_to_hhmm(sit)
        else:
            b.pop("endTime", None)  # staff set the real departure later
        order["booking"] = b

    # Delivery fee from the zone rings — recomputed here from the pin
    # coordinates. Orders without a pin or outside the last ring are refused.
    delivery_fee = 0
    if order.get("type") == "delivery":
        cfg = delivery_cfg(settings_row["data"] if settings_row else None)
        lat, lng = order["lat"], order["lng"]
        fee = delivery_fee_for(cfg, lat, lng)
        if fee is None:
            conn.close()
            return jsonify({"error": "out_of_zone"}), 400
        delivery_fee = fee

    order["subtotal"] = subtotal
    order["serviceFee"] = service_fee
    order["deliveryFee"] = delivery_fee
    base_total = grand_total + delivery_fee

    try:
        loyalty_mode = str(body.get("loyaltyMode") or "none").strip().lower()
        if loyalty_mode not in {"existing", "enroll", "none"}:
            raise LoyaltyError("invalid_loyalty_mode")

        account = None
        issued_code = None
        if loyalty_code():
            account = loyalty_account_from_request(conn, for_update=True)
        elif loyalty_token():
            # Existing customers keep their balance after deployment. The
            # first request with an old device token replaces it with the new
            # eight-digit code and permanently revokes the old token.
            account = account_by_token(conn, loyalty_token())
            if account:
                issued_code = rotate_account_code(conn, account["id"])
        elif loyalty_mode == "enroll":
            account, issued_code = create_loyalty_account(
                conn, order["phone"], order["ts"]
            )
        elif loyalty_mode == "existing":
            raise LoyaltyError("invalid_loyalty_id")

        if loyalty_mode == "existing" and not account:
            raise LoyaltyError("invalid_loyalty_id")

        requested_bonus = body.get("bonusToUse", 0)
        try:
            requested_bonus_number = int(requested_bonus or 0)
        except (TypeError, ValueError):
            raise LoyaltyError("invalid_bonus_amount") from None
        if requested_bonus_number > 0 and not account:
            raise LoyaltyError("invalid_loyalty_id")

        if account:
            # Phone remains useful contact metadata for staff, but never
            # selects or authenticates the account. Multiple accounts may use
            # the same number.
            current_phone = normalize_loyalty_phone(order["phone"])
            conn.execute(
                "UPDATE loyalty_accounts SET phone = %s, updated_at = %s WHERE id = %s",
                (current_phone, order["ts"], account["id"]),
            )
            bonus_used = apply_redemption(
                conn,
                account["id"],
                order["id"],
                requested_bonus_number,
                subtotal,
                order["ts"],
            )
        else:
            bonus_used = 0
    except LoyaltyError as exc:
        if exc.code == "invalid_loyalty_id" and loyalty_code():
            # loyalty_account_from_request recorded the failed code attempt.
            conn.commit()
        else:
            conn.rollback()
        conn.close()
        if exc.code in {"invalid_loyalty_id", "loyalty_rate_limited"}:
            return loyalty_error_response(exc)
        return jsonify({"error": exc.code}), 400

    order["bonusUsed"] = bonus_used
    if account:
        order["loyaltyAccountId"] = account["id"]
        order["bonusPending"] = earn_amount(subtotal, bonus_used)
    else:
        order["bonusPending"] = 0
    order["total"] = max(0, base_total - bonus_used)
    order["fee"] = platform_commission(order["total"])
    order["feeAccrued"] = False

    if order["status"] != "awaiting_confirmation":
        accrue_order_commission(conn, order)

    conn.execute(
        "INSERT INTO orders (id, num, ts, status, payment_id, data) VALUES (%s, %s, %s, %s, %s, %s)",
        (order["id"], order["num"], order["ts"], order["status"],
         order.get("payment_id"), json.dumps(order))
    )
    loyalty_result = (
        loyalty_snapshot(conn, account["id"], issued_code=issued_code, at_ms=order["ts"])
        if account else None
    )
    conn.commit()

    conn.close()
    return jsonify({
        "ok": True,
        "order": {
            "id": order["id"],
            "num": order["num"],
            "total": order["total"],
            "bonusUsed": order["bonusUsed"],
            "bonusPending": order["bonusPending"],
        },
        "loyalty": loyalty_result,
    })


# Customer-facing message created when the status changes (website notifications)
def order_notification_message(status, prep_minutes=None):
    if status == "new":
        # Only reachable via PUT (staff confirming a Kaspi payment) — fresh
        # orders are INSERTed as new and never pass through here.
        return "Payment confirmed. Your order has been sent to the kitchen."
    if status == "cooking":
        if prep_minutes:
            return f"Your order is being prepared. Estimated time: {prep_minutes} minutes."
        return "Your order is being prepared."
    if status == "ready":
        return "Your order is ready."
    if status == "done":
        return "Order completed. Thank you."
    if status == "cancelled":
        return "Your order has been cancelled."
    return None


@app.route("/api/orders/<order_id>", methods=["PUT"])
@require_owner
def update_order(order_id):
    body = request.get_json(silent=True) or {}
    new_status = body.get("status")
    if new_status not in {
        "awaiting_confirmation", "new", "cooking", "ready", "done", "cancelled"
    }:
        return jsonify({"error": "invalid_status"}), 400
    conn = get_db()
    row = conn.execute(
        "SELECT data FROM orders WHERE id = %s", (order_id,)
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "Not found"}), 404
    order = row["data"]
    old_status = order.get("status")
    if old_status in {"done", "cancelled"} and new_status != old_status:
        conn.close()
        return jsonify({"error": "terminal_order"}), 409
    order["status"] = new_status

    # Preparation window + per-step timestamps for the customer timeline
    now_ms = int(time.time() * 1000)
    if new_status == "cooking":
        try:
            prep_minutes = int(body.get("preparation_minutes") or 0)
        except (TypeError, ValueError):
            prep_minutes = 0
        if prep_minutes > 0:
            order["preparation_minutes"] = prep_minutes
            order["preparation_started_at"] = now_ms
            order["estimated_ready_at"] = now_ms + prep_minutes * 60000
    elif new_status == "ready":
        order["ready_at"] = now_ms
    elif new_status == "done":
        order["completed_at"] = now_ms
    elif new_status == "cancelled":
        order["cancelled_at"] = now_ms

    if new_status != old_status and new_status == "done":
        award_order(conn, order, now_ms)
    elif new_status != old_status and new_status == "cancelled":
        restore_order_redemption(conn, order, now_ms)
        order["bonusPending"] = 0

    # Payment-confirm now jumps straight to "cooking" (one press, with the
    # prep-time estimate attached) — but the old →"new" path still counts.
    if old_status == "awaiting_confirmation" and new_status in ("new", "cooking"):
        accrue_order_commission(conn, order)

    conn.execute(
        "UPDATE orders SET status = %s, data = %s WHERE id = %s",
        (new_status, json.dumps(order), order_id)
    )
    if new_status != old_status:
        msg = order_notification_message(new_status, order.get("preparation_minutes"))
        if msg:
            conn.execute(
                "INSERT INTO notifications (order_id, status, message, ts) VALUES (%s, %s, %s, %s)",
                (order_id, new_status, msg, now_ms)
            )
    conn.commit()

    conn.close()
    return jsonify({"ok": True})


@app.route("/api/orders/<order_id>/ack-call", methods=["POST"])
@require_owner
def ack_call(order_id):
    # Staff mark a booking's confirmation call as done (Part 3). Owner-only,
    # merges a flag into the order JSON without touching status, and drops a
    # notification so the customer sees the booking was confirmed.
    conn = get_db()
    row = conn.execute("SELECT data FROM orders WHERE id = %s", (order_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "Not found"}), 404
    order = row["data"]
    already = order.get("callConfirmed")
    order["callConfirmed"] = True
    conn.execute("UPDATE orders SET data = %s WHERE id = %s", (json.dumps(order), order_id))
    if not already:
        conn.execute(
            "INSERT INTO notifications (order_id, status, message, ts) VALUES (%s, %s, %s, %s)",
            (order_id, "call_confirmed", "Your reservation is confirmed. See you soon!",
             int(time.time() * 1000))
        )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/orders/<order_id>/booking-end", methods=["PUT"])
@require_owner
def set_booking_end(order_id):
    # Staff record when the party will leave (learned during the
    # confirmation call). From that moment availability uses the real span
    # instead of the default stay — freeing the table for later clients
    # and correctly capping earlier ones.
    body = request.get_json() or {}
    end = _hhmm_to_min(body.get("endTime"))
    if end is None:
        return jsonify({"error": "bad_time"}), 400
    conn = get_db()
    row = conn.execute("SELECT data FROM orders WHERE id = %s", (order_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "Not found"}), 404
    order = row["data"]
    if order.get("type") != "booking" or not isinstance(order.get("booking"), dict):
        conn.close()
        return jsonify({"error": "not_booking"}), 400
    order["booking"]["endTime"] = _min_to_hhmm(end)
    conn.execute("UPDATE orders SET data = %s WHERE id = %s", (json.dumps(order), order_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/orders/<order_id>/notifications", methods=["GET"])
def order_notifications(order_id):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, order_id, status, message, ts, read_status "
        "FROM notifications WHERE order_id = %s ORDER BY ts ASC", (order_id,)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/orders/<order_id>/notifications/read", methods=["POST"])
def mark_notifications_read(order_id):
    conn = get_db()
    conn.execute(
        "UPDATE notifications SET read_status = TRUE "
        "WHERE order_id = %s AND read_status = FALSE", (order_id,)
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})

@app.route("/api/orders/<order_id>/status", methods=["GET"])
def order_status(order_id):
    conn = get_db()
    row = conn.execute(
        "SELECT status FROM orders WHERE id = %s", (order_id,)
    ).fetchone()
    conn.close()
    return (jsonify({"status": row["status"]}) if row
            else (jsonify({"status": "unknown"}), 404))

# ─────────────────────────────────────────────────

@app.route("/api/ledger", methods=["GET"])
@require_owner
def get_ledger():
    conn = get_db()
    row = ledger_row(conn)
    conn.commit()
    conn.close()
    return jsonify({
        "accrued": row["accrued"],
        "paid": row["paid"],
        "balance": row["balance"],
        "history": row["history"] if isinstance(row["history"], list) else [],
    })


@app.route("/api/ledger/settle", methods=["POST"])
@require_owner
def settle_ledger():
    body = request.get_json() or {}
    note = str(body.get("note") or "Payout")[:120]
    conn = get_db()
    row = ledger_row(conn)
    amount = int(row["balance"] or 0)
    history = row["history"] if isinstance(row["history"], list) else []
    if amount > 0:
        history.append({"type": "payout", "amount": amount, "note": note, "ts": int(time.time() * 1000)})
        conn.execute("""
            UPDATE ledger
            SET paid = paid + %s, balance = 0, history = %s
            WHERE id = 1
        """, (amount, json.dumps(history)))
    conn.commit()
    fresh = ledger_row(conn)
    conn.commit()
    conn.close()
    return jsonify({
        "ok": True,
        "accrued": fresh["accrued"],
        "paid": fresh["paid"],
        "balance": fresh["balance"],
        "history": fresh["history"] if isinstance(fresh["history"], list) else [],
    })


def sync_sales_history(conn):
    """Upsert the latest persisted state of every current order."""
    now_ms = int(time.time() * 1000)
    conn.execute("""
        INSERT INTO sales_history (order_id, ts, status, total, updated_at)
        SELECT
            id,
            ts,
            status,
            CASE
                WHEN jsonb_typeof(data->'total') = 'number'
                THEN ROUND((data->>'total')::numeric)::bigint
                ELSE 0
            END,
            %s
        FROM orders
        ON CONFLICT (order_id) DO UPDATE SET
            ts = EXCLUDED.ts,
            status = EXCLUDED.status,
            total = EXCLUDED.total,
            updated_at = EXCLUDED.updated_at
    """, (now_ms,))


@app.route("/api/admin/sales-history", methods=["GET"])
@require_owner
def get_sales_history():
    conn = get_db()
    try:
        sync_sales_history(conn)
        rows = conn.execute(
            "SELECT ts, status, total FROM sales_history ORDER BY ts DESC"
        ).fetchall()
        conn.commit()
        return jsonify(aggregate_sales_history(rows, CAFE_TZ))
    finally:
        conn.close()


TABLE_COUNT = 30
TABLE_OCCUPANCY_HOURS = 14
TABLE_OCCUPANCY_MS = TABLE_OCCUPANCY_HOURS * 60 * 60 * 1000


def _active_table_occupancy(conn, now_ms=None):
    now_ms = now_ms or int(time.time() * 1000)
    conn.execute(
        "DELETE FROM table_occupancy WHERE occupied_until <= %s", (now_ms,)
    )
    rows = conn.execute(
        "SELECT table_number, occupied_until FROM table_occupancy "
        "ORDER BY table_number"
    ).fetchall()
    return {
        int(row["table_number"]): int(row["occupied_until"])
        for row in rows
    }


@app.route("/api/admin/tables", methods=["GET"])
@require_owner
def get_admin_tables():
    conn = get_db()
    try:
        occupied = _active_table_occupancy(conn)
        conn.commit()
        return jsonify({
            "expiresAfterHours": TABLE_OCCUPANCY_HOURS,
            "tables": [
                {
                    "number": number,
                    "occupied": number in occupied,
                    "occupiedUntil": occupied.get(number),
                }
                for number in range(1, TABLE_COUNT + 1)
            ],
        })
    finally:
        conn.close()


@app.route("/api/admin/tables/<int:table_number>", methods=["PUT"])
@require_owner
def update_admin_table(table_number):
    if not 1 <= table_number <= TABLE_COUNT:
        return jsonify({"error": "invalid_table"}), 400
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("occupied"), bool):
        return jsonify({"error": "invalid_occupied_state"}), 400

    conn = get_db()
    try:
        now_ms = int(time.time() * 1000)
        _active_table_occupancy(conn, now_ms)
        if body["occupied"]:
            occupied_until = now_ms + TABLE_OCCUPANCY_MS
            conn.execute("""
                INSERT INTO table_occupancy (table_number, occupied_until)
                VALUES (%s, %s)
                ON CONFLICT (table_number) DO UPDATE
                SET occupied_until = EXCLUDED.occupied_until
            """, (table_number, occupied_until))
        else:
            occupied_until = None
            conn.execute(
                "DELETE FROM table_occupancy WHERE table_number = %s",
                (table_number,),
            )
        conn.commit()
        return jsonify({
            "ok": True,
            "number": table_number,
            "occupied": body["occupied"],
            "occupiedUntil": occupied_until,
        })
    finally:
        conn.close()


@app.route("/api/bookings/availability", methods=["GET"])
def check_availability():
    # Span-aware availability: for the requested date+time each table size
    # reports whether a table is free at that moment and, when a later
    # booking will need it back, until when the client may sit (already
    # minus the cleaning buffer). Sizes absent from the map are fully free.
    date = request.args.get("date")
    t = _hhmm_to_min(request.args.get("time"))
    if not date or t is None:
        return jsonify({"rooms": {}, "booked_room_ids": []})
    conn = get_db()
    all_bookings = bookings_for(conn, date)
    settings_row = conn.execute("SELECT data FROM settings WHERE key='cafe_status'").fetchone()
    conn.close()
    counts = table_counts(settings_row["data"] if settings_row else None)
    by_room = {}
    for b in all_bookings:
        by_room.setdefault(b["roomId"], []).append(b)
    rooms, booked = {}, []
    for rid, bs in by_room.items():
        ok, sit = room_slot(bs, counts.get(rid, 1), t)
        rooms[rid] = {"available": ok, "sitUntil": _min_to_hhmm(sit) if sit is not None else None}
        if not ok:
            booked.append(rid)
    return jsonify({"rooms": rooms, "booked_room_ids": booked})



# ── SCHEDULE & SETTINGS ────────────────────────────────────────────────
@app.route("/api/settings/cafe", methods=["GET"])
def get_cafe_settings():
    conn = get_db()
    row = conn.execute("SELECT data FROM settings WHERE key='cafe_status'").fetchone()
    conn.close()
    payload = row["data"] if row else {
        "isOpen": True,
        "hours": dict(DEFAULT_HOURS),
    }
    payload = dict(payload)
    # Always overwritten from the validated env var — a value smuggled into
    # the settings table can never redirect customer payments.
    payload["kaspiPayUrl"] = kaspi_pay_url()
    # Real-time open/closed, computed server-side (see place_order) so the
    # frontend never has to re-derive hour/timezone logic from the visitor's
    # own clock.
    payload["effectiveOpen"] = cafe_is_open(payload)
    # Normalized delivery zones so the customer map and the admin editor
    # always see valid rings even before staff first save them.
    payload["delivery"] = delivery_cfg(payload)
    return jsonify(payload)


@app.route("/api/settings/cafe", methods=["PUT"])
@require_owner
def update_cafe_settings():
    conn = get_db()
    row = conn.execute("SELECT data FROM settings WHERE key='cafe_status'").fetchone()
    try:
        body = normalize_cafe_settings(request.get_json(silent=True), row["data"] if row else None)
    except ValueError as exc:
        conn.close()
        return jsonify({"error": str(exc)}), 400
    conn.execute("""
        INSERT INTO settings (key, data) VALUES ('cafe_status', %s)
        ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data
    """, (json.dumps(body),))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ── ADMIN ORDER EDITOR & LEDGER RECALCULATION ─────────────────────────
@app.route("/api/orders/<order_id>/items", methods=["PUT"])
@require_owner
def edit_order_items(order_id):
    body = request.get_json()
    new_items = body.get("items", [])
    conn = get_db()

    row = conn.execute("SELECT data FROM orders WHERE id=%s", (order_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "Not found"}), 404

    old_order = row["data"]
    if int(old_order.get("bonusUsed") or 0) > 0:
        conn.close()
        return jsonify({"error": "bonus_order_locked"}), 409
    # Commission follows the final amount the customer pays. Legacy orders
    # may not have "fee", so derive the old value from total.
    old_total = old_order.get("total", 0)

    # Recompute the 10% service fee and total server-side from the new items.
    # The delivery charge the customer agreed to survives dish edits.
    new_subtotal, new_service_fee, new_total = compute_service_total(new_items, old_order.get("type"))
    try:
        old_delivery_fee = max(0, int(old_order.get("deliveryFee") or 0))
    except (TypeError, ValueError):
        old_delivery_fee = 0
    new_total += old_delivery_fee

    old_commission = old_order.get("fee", platform_commission(old_total))
    new_commission = platform_commission(new_total)
    commission_diff = new_commission - old_commission

    old_order["items"] = new_items
    old_order["subtotal"] = new_subtotal
    old_order["serviceFee"] = new_service_fee
    old_order["deliveryFee"] = old_delivery_fee
    old_order["total"] = new_total
    old_order["fee"] = new_commission

    # Persist the edit first and commit — the order change must never be lost
    # to an optional bookkeeping step.
    conn.execute("UPDATE orders SET data=%s WHERE id=%s", (json.dumps(old_order), order_id))
    conn.commit()

    # Adjust the platform-commission ledger if it changed. This is an internal
    # feature that may not be provisioned (table absent); a failure here must
    # not break order editing, so it runs in its own guarded transaction.
    if commission_diff != 0 and old_order.get("feeAccrued", True):
        try:
            ledger_row(conn)
            conn.execute("""
                UPDATE ledger
                SET accrued = accrued + %s, balance = balance + %s
                WHERE id = 1
            """, (commission_diff, commission_diff))
            conn.commit()
        except Exception as e:
            conn.rollback()
            print("ledger update skipped:", e)

    conn.close()
    return jsonify({"ok": True, "subtotal": new_subtotal, "serviceFee": new_service_fee, "newTotal": new_total})


# Schema setup runs at import so gunicorn triggers it too. A transient DB
# hiccup here must not crash the whole deploy (gunicorn kills workers that
# take too long to boot, and Render then marks the deploy failed): the
# tables already exist after the first successful run, so log and move on.
try:
    init_db()
except Exception as e:
    print("init_db failed at boot (non-fatal, relying on existing schema):", e)


if __name__ == "__main__":
    from payments import payments

    app.register_blueprint(payments)
    app.run(port=5000)
