from flask import Flask, jsonify, request
import requests as http_requests
from flask_cors import CORS
import sqlite3
import json
import os
import time
import threading
import datetime as dt
import re
from zoneinfo import ZoneInfo

app = Flask(__name__)
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
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            data JSONB NOT NULL
        )
    """)
    # Staff edits (photo / kz+en names / hide) attached to iiko items by their
    # itemId, layered on top of the auto-generated overlay at display time.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS iiko_overlay (
            item_id TEXT PRIMARY KEY,
            data JSONB NOT NULL
        )
    """)
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
    conn.commit()
    conn.close()

# ── MENU ──────────────────────────────────────────
from auth import check_login, require_owner, is_owner_request

@app.route("/api/login", methods=["POST"])
@limiter.limit("5 per minute; 30 per hour")  # slow brute-force attempts to a crawl
def login():
    body = request.get_json()
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


# Read-only iiko menu (Option A: iiko is the source of truth). Separate from
# /api/menu for now so the live site is untouched until we deliberately switch.
# Default: display menu (iiko items + website images/translations overlay).
# ?raw=1 returns the plain iiko menu; ?force=1 bypasses the cache.
def _load_iiko_overlay(conn):
    """All staff overlay edits as {iikoId: {name:{kz,en}, image, hidden}}."""
    try:
        rows = conn.execute("SELECT item_id, data FROM iiko_overlay").fetchall()
        return {r["item_id"]: r["data"] for r in rows}
    except Exception:
        return {}  # table may not exist yet on a fresh DB


def _load_iiko_cat_order(conn):
    row = conn.execute("SELECT data FROM settings WHERE key='iiko_category_order'").fetchone()
    order = (row["data"] or {}).get("order") if row else None
    return order if isinstance(order, list) else None


@app.route("/api/iiko/menu", methods=["GET"])
def get_iiko_menu():
    import iiko
    try:
        force = request.args.get("force") == "1"
        if request.args.get("raw") == "1":
            return jsonify(iiko.get_menu(force=force))
        conn = get_db()
        db_overlay = _load_iiko_overlay(conn)
        cat_order = _load_iiko_cat_order(conn)
        conn.close()
        return jsonify(iiko.get_display_menu(force=force, db_overlay=db_overlay, cat_order=cat_order))
    except iiko.IikoError as e:
        return jsonify({"error": str(e)}), 502


@app.route("/api/iiko/category-order", methods=["PUT"])
@require_owner
def save_iiko_category_order():
    body = request.get_json() or {}
    order = body.get("order")
    if not isinstance(order, list) or not all(isinstance(x, str) for x in order):
        return jsonify({"error": "bad_body"}), 400
    conn = get_db()
    conn.execute("""
        INSERT INTO settings (key, data) VALUES ('iiko_category_order', %s)
        ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data
    """, (json.dumps({"order": order}),))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# Staff overlay editor: read/save photo + kz/en names + hide flag per iiko item.
IMG_RE = re.compile(r"^data:image/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$")


@app.route("/api/iiko/overlay", methods=["GET"])
@require_owner
def get_iiko_overlay():
    conn = get_db()
    ov = _load_iiko_overlay(conn)
    conn.close()
    return jsonify({"items": ov})


@app.route("/api/iiko/overlay", methods=["PUT"])
@require_owner
def save_iiko_overlay():
    # Body: {items: {iikoId: {name:{kz,en}?, desc:{ru,kz,en}?, image?, hidden?,
    # sortOrder?}}}. Only the fields present are changed — each item's existing
    # overlay is MERGED, so saving a photo never wipes a previously-set name.
    # image:null means "remove photo".
    body = request.get_json() or {}
    items = body.get("items") or {}
    if not isinstance(items, dict):
        return jsonify({"error": "bad_body"}), 400
    conn = get_db()
    rejected = {}
    for iiko_id, raw in items.items():
        raw = raw if isinstance(raw, dict) else {}
        row = conn.execute("SELECT data FROM iiko_overlay WHERE item_id = %s", (str(iiko_id),)).fetchone()
        data = dict(row["data"]) if row and isinstance(row["data"], dict) else {}
        nm = raw.get("name")
        if isinstance(nm, dict):
            data["name"] = {"kz": str(nm.get("kz") or "").strip()[:120],
                            "en": str(nm.get("en") or "").strip()[:120]}
        ds = raw.get("desc")
        if isinstance(ds, dict):
            data["desc"] = {"ru": str(ds.get("ru") or "").strip()[:400],
                            "kz": str(ds.get("kz") or "").strip()[:400],
                            "en": str(ds.get("en") or "").strip()[:400]}
        if "image" in raw:
            img = raw.get("image")
            if img is None:
                data["image"] = None  # explicit removal (hides file-overlay image too)
            elif isinstance(img, str) and len(img) <= 1_600_000 and IMG_RE.match(img):
                data["image"] = img
            else:
                # Previously silently dropped, leaving the request looking
                # successful while the photo just vanished. Now reported so
                # the admin editor can tell staff it actually failed.
                rejected[str(iiko_id)] = "image_too_large" if isinstance(img, str) and len(img) > 1_600_000 else "invalid_image"
        if "hidden" in raw:
            if raw.get("hidden"):
                data["hidden"] = True
            else:
                data.pop("hidden", None)
        if "deliveryAvailable" in raw:
            if raw.get("deliveryAvailable") is False:
                data["deliveryAvailable"] = False
            else:
                data.pop("deliveryAvailable", None)  # default: deliverable
        if "sortOrder" in raw:
            try:
                data["sortOrder"] = int(raw["sortOrder"])
            except (TypeError, ValueError):
                pass
        conn.execute(
            "INSERT INTO iiko_overlay (item_id, data) VALUES (%s, %s) "
            "ON CONFLICT (item_id) DO UPDATE SET data = EXCLUDED.data",
            (str(iiko_id), json.dumps(data))
        )
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "rejected": rejected})

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
    r = http_requests.post(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        data={"secret": os.environ["TURNSTILE_SECRET"],
              "response": token, "remoteip": ip})
    return r.json().get("success", False)


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


# Service charge for waiter-served orders only: dine-in and table bookings.
# To-go and delivery have no waiter, so no fee.
SERVICE_FEE_RATE = 0.10
SERVICE_FEE_TYPES = {"table", "booking"}
PLATFORM_COMMISSION_RATE = 0.01

# Delivery pricing: three concentric zones around the restaurant. The fee is
# decided by which ring the client's map pin falls in; outside the last ring
# the order is refused. Radii are staff-editable via cafe settings; fees stay
# fixed unless changed in the settings JSON. Computed here — never trusted
# from the client — so a tampered request can't dodge the charge or order
# from another city.
import math

DELIVERY_DEFAULTS = {
    # Subhi Food — Юсуф Сареми 5/17, Сайрам (the physical restaurant). The
    # ring centre is code-controlled only (no admin UI sets it), so it always
    # comes from here and can never drift from a stale stored value.
    "lat": 42.2976, "lng": 69.7592,
    "zones": [{"km": 2, "fee": 0}, {"km": 4, "fee": 300}, {"km": 6, "fee": 500}],
}


def delivery_cfg(settings):
    d = (settings or {}).get("delivery") or {}
    defaults = DELIVERY_DEFAULTS["zones"]
    zones = []
    raw = d.get("zones")
    if isinstance(raw, list) and len(raw) == 3:
        for i, z in enumerate(raw):
            z = z if isinstance(z, dict) else {}
            try:
                km = float(z.get("km"))
            except (TypeError, ValueError):
                km = defaults[i]["km"]
            if not (km > 0):
                km = defaults[i]["km"]
            try:
                fee = max(0, int(z.get("fee")))
            except (TypeError, ValueError):
                fee = defaults[i]["fee"]
            zones.append({"km": km, "fee": fee})
    else:
        zones = [dict(z) for z in defaults]
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
BOOKING_ACTIVE_FILTER = "status NOT IN ('cancelled','payment_failed','expired','done')"


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
        if not isinstance(raw_zones, list) or len(raw_zones) != 3:
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
        if not zones[0]["km"] < zones[1]["km"] < zones[2]["km"]:
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
        "SELECT data FROM orders WHERE " + BOOKING_ACTIVE_FILTER
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
    body = request.get_json()

    # Run the invisible captcha check immediately before any logic or database calls
    if not turnstile_ok(body.get("captcha"), request.remote_addr):
        return jsonify(error="failed bot check"), 403

    conn = get_db()
    settings_row = conn.execute("SELECT data FROM settings WHERE key='cafe_status'").fetchone()
    if not cafe_is_open(settings_row["data"] if settings_row else None):
        conn.close()
        return jsonify({"error": "closed"}), 403

    order = request.get_json()
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
        try:
            lat, lng = float(order.get("lat")), float(order.get("lng"))
        except (TypeError, ValueError):
            conn.close()
            return jsonify({"error": "location_required"}), 400
        fee = delivery_fee_for(cfg, lat, lng)
        if fee is None:
            conn.close()
            return jsonify({"error": "out_of_zone"}), 400
        delivery_fee = fee

    order["subtotal"] = subtotal
    order["serviceFee"] = service_fee
    order["deliveryFee"] = delivery_fee
    order["total"] = grand_total + delivery_fee
    order["fee"] = platform_commission(order["total"])
    order["feeAccrued"] = False

    if order["status"] != "awaiting_confirmation":
        accrue_order_commission(conn, order)

    conn.execute(
        "INSERT INTO orders (id, num, ts, status, payment_id, data) VALUES (%s, %s, %s, %s, %s, %s)",
        (order["id"], order["num"], order["ts"], order["status"],
         order.get("payment_id"), json.dumps(order))
    )
    conn.commit()

    # Push the order into iiko so kitchen/courier staff see it on their own
    # iikoFront screen — best-effort, never lets an iiko problem touch the
    # customer's response. Kaspi orders wait for staff to confirm payment
    # (see update_order) before the kitchen is told about them.
    if order["status"] != "awaiting_confirmation":
        _send_order_to_iiko(order)

    conn.close()
    return jsonify({"ok": True})


def _send_order_to_iiko(order):
    # Kill-switch: order-sending is fully wired but deliberately off until we
    # run a live test together (a real ticket hits the kitchen once this is
    # on). Stop-list/menu sync is unaffected — those stay read-only and on.
    if os.environ.get("IIKO_SEND_ORDERS", "").strip().lower() not in ("1", "true", "yes"):
        return

    # Runs off the request thread: iiko confirms orders asynchronously (a few
    # seconds), and a slow or down iiko must never delay or fail the
    # customer's checkout. The result is merged back onto the stored order so
    # the admin panel can show whether the kitchen actually got it.
    order_id = order["id"]
    order_snapshot = dict(order)

    def worker():
        import iiko
        try:
            result = iiko.send_order(order_snapshot)
        except Exception as e:
            result = {"ok": False, "error": str(e)}
        conn = get_db()
        try:
            row = conn.execute("SELECT data FROM orders WHERE id = %s", (order_id,)).fetchone()
            if not row:
                return
            data = row["data"]
            data["iikoSent"] = bool(result.get("ok"))
            if result.get("ok"):
                data["iikoOrderId"] = result.get("iikoOrderId")
                data["iikoNumber"] = result.get("iikoNumber")
                data.pop("iikoError", None)
            else:
                data["iikoError"] = result.get("error")
                if result.get("iikoOrderId"):
                    data["iikoOrderId"] = result.get("iikoOrderId")
            conn.execute("UPDATE orders SET data = %s WHERE id = %s", (json.dumps(data), order_id))
            conn.commit()
        finally:
            conn.close()

    threading.Thread(target=worker, daemon=True).start()

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
    body = request.get_json()
    new_status = body["status"]
    conn = get_db()
    row = conn.execute(
        "SELECT data FROM orders WHERE id = %s", (order_id,)
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "Not found"}), 404
    order = row["data"]
    old_status = order.get("status")
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

    # Payment just got confirmed — only now does the kitchen learn about
    # it, same as any other order. (Confirm goes straight to "cooking" in
    # the current admin panel; "new" kept for compatibility.)
    if old_status == "awaiting_confirmation" and new_status in ("new", "cooking"):
        _send_order_to_iiko(order)

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
    # always see three valid rings even before staff first save them.
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


# ── iiko status mirror (Setup A, strictly read-only) ─────────────────────
# iikoFront is where staff actually manage cooking; every ~45s this poller
# reads each active order's status back from iiko and mirrors it onto our
# copy, so the customer's tracking screen and notifications follow the
# kitchen automatically ("ready" pressed in iikoFront → customer notified).
# One-way by design: nothing here ever writes to iiko.
_IIKO_DELIVERY_STATUS = {
    "CookingStarted": "cooking",
    "CookingCompleted": "ready",
    "Waiting": "ready",
    "OnWay": "ready",
    "Delivered": "done",
    "Closed": "done",
    "Cancelled": "cancelled",
}
# Dine-in ("Обычный заказ") orders only expose coarse states via the API —
# no cooking/ready. Fine: the customer is sitting at the table anyway.
_IIKO_TABLE_STATUS = {"Closed": "done", "Deleted": "cancelled"}
_STATUS_FORWARD = {"new": 0, "cooking": 1, "ready": 2, "done": 3}


def _mirror_status(conn, order, new_status):
    old = order.get("status")
    if new_status == old:
        return False
    # Never move a status backwards (e.g. iiko still says CookingStarted
    # after staff already pressed Завершить here).
    if new_status != "cancelled" and \
            _STATUS_FORWARD.get(new_status, -1) <= _STATUS_FORWARD.get(old, 99):
        return False
    now_ms = int(time.time() * 1000)
    order["status"] = new_status
    if new_status == "ready":
        order["ready_at"] = now_ms
    elif new_status == "done":
        order["completed_at"] = now_ms
    elif new_status == "cancelled":
        order["cancelled_at"] = now_ms
    conn.execute("UPDATE orders SET status = %s, data = %s WHERE id = %s",
                 (new_status, json.dumps(order), order["id"]))
    msg = order_notification_message(new_status, order.get("preparation_minutes"))
    if msg:
        conn.execute(
            "INSERT INTO notifications (order_id, status, message, ts) VALUES (%s, %s, %s, %s)",
            (order["id"], new_status, msg, now_ms))
    return True


def _iiko_mirror_tick():
    import iiko
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT data FROM orders WHERE status IN ('new','cooking','ready')"
        ).fetchall()
        # Bookings never reach iiko (no iikoOrderId) and drop out here.
        active = [r["data"] for r in rows
                  if isinstance(r["data"], dict) and r["data"].get("iikoOrderId")]
        if not active:
            return
        buckets = {"delivery": [], "table": []}
        for o in active:
            buckets["table" if o.get("type") == "table" else "delivery"].append(o)
        for kind, group in buckets.items():
            if not group:
                continue
            statuses = iiko.get_order_statuses(
                [o["iikoOrderId"] for o in group], is_delivery=(kind == "delivery"))
            mapping = _IIKO_DELIVERY_STATUS if kind == "delivery" else _IIKO_TABLE_STATUS
            for o in group:
                mapped = mapping.get(statuses.get(o["iikoOrderId"]))
                if mapped:
                    _mirror_status(conn, o, mapped)
        conn.commit()
    finally:
        conn.close()


def _iiko_mirror_loop():
    while True:
        time.sleep(45)
        if os.environ.get("IIKO_SEND_ORDERS", "").strip().lower() not in ("1", "true", "yes"):
            continue  # same kill-switch as order-sending
        try:
            _iiko_mirror_tick()
        except Exception as e:
            print("iiko status mirror tick failed:", e)


threading.Thread(target=_iiko_mirror_loop, daemon=True).start()

if __name__ == "__main__":
    from payments import payments

    app.register_blueprint(payments)
    app.run(port=5000)
    PRINTER_TOKEN = os.environ["PRINTER_TOKEN"]  # one long random secret


    def check_printer(req):
        return req.headers.get("Authorization", "").removeprefix("Bearer ") == PRINTER_TOKEN


    @app.route("/api/print-jobs/claim", methods=["POST"])
    def claim_jobs():
        if not check_printer(request): return jsonify(error="no"), 401
        conn = get_db()
        rows = conn.execute("""
            UPDATE print_jobs SET status='claimed', attempts=attempts+1
            WHERE id IN (SELECT id FROM print_jobs WHERE status='queued'
                         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 5)
            RETURNING id, payload
        """).fetchall()
        conn.commit();
        conn.close()
        return jsonify(jobs=[dict(r) for r in rows])


    @app.route("/api/print-jobs/<job_id>/done", methods=["POST"])
    def job_done(job_id):
        if not check_printer(request): return jsonify(error="no"), 401
        ok = request.get_json().get("printed", False)
        conn = get_db()
        conn.execute("UPDATE print_jobs SET status=%s WHERE id=%s",
                     ("printed" if ok else "failed", job_id))
        conn.commit();
        conn.close()
        return jsonify(ok=True)
