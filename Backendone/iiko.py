"""iiko Cloud API client — Option A (iiko drives the menu).

Read-only for now: fetches an access token and the published external menu,
with in-process caching so we never hammer iiko (tokens last 1h; the menu is
cached for a few minutes). Nothing here sends orders — that is a later,
explicitly-gated step.

Credentials come from the environment (never hard-coded / never in git):
  IIKO_APP_ID, IIKO_CLIENT_SECRET, IIKO_API_KEY
The organization and external-menu ids are not secret; they have safe
defaults discovered during setup but can be overridden via env.
"""
import os
import re
import json
import time
import threading
import requests

IIKO_BASE = "https://api-ru.iiko.services"

APP_ID = (os.environ.get("IIKO_APP_ID") or "").strip()
CLIENT_SECRET = (os.environ.get("IIKO_CLIENT_SECRET") or "").strip()
API_KEY = (os.environ.get("IIKO_API_KEY") or "").strip()
ORG_ID = (os.environ.get("IIKO_ORG_ID") or "24b551b3-a559-402a-81a6-9a0df016795d").strip()
EXT_MENU_ID = (os.environ.get("IIKO_EXTERNAL_MENU_ID") or "86462").strip()
TERMINAL_GROUP_ID = (os.environ.get("IIKO_TERMINAL_GROUP_ID") or "1999d35a-73fe-9797-019c-dcb4f10d0066").strip()
# iiko order types discovered via /api/1/deliveries/order_types for this
# organization. Website order.type -> iiko orderTypeId.
ORDER_TYPE_IDS = {
    "delivery": (os.environ.get("IIKO_ORDER_TYPE_DELIVERY") or "76067ea3-356f-eb93-9d14-1fa00d082c4e").strip(),
    "pickup": (os.environ.get("IIKO_ORDER_TYPE_PICKUP") or "5b1508f9-fe5b-d6af-cb8d-043af587d5c2").strip(),
    "table": (os.environ.get("IIKO_ORDER_TYPE_TABLE") or "bbbef4dc-5a02-7ea3-81d3-826f4e8bb3e0").strip(),
}

MENU_TTL = int(os.environ.get("IIKO_MENU_TTL", "300"))  # seconds

_lock = threading.Lock()
_token = {"value": None, "exp": 0.0}
_menu_cache = {"data": None, "ts": 0.0}


class IikoError(Exception):
    pass


def configured():
    return bool(APP_ID and CLIENT_SECRET and API_KEY)


def _post(path, body, token=None, timeout=25):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        r = requests.post(f"{IIKO_BASE}{path}", json=body, headers=headers, timeout=timeout)
    except requests.RequestException as e:
        raise IikoError(f"network error calling {path}: {e}")
    if r.status_code != 200:
        raise IikoError(f"{path} -> HTTP {r.status_code}: {r.text[:300]}")
    return r.json()


def get_token(force=False):
    """Return a valid bearer token, refreshing ~10 min before its 1h expiry."""
    now = time.time()
    with _lock:
        if not force and _token["value"] and now < _token["exp"]:
            return _token["value"]
    if not configured():
        raise IikoError("iiko credentials not configured (IIKO_APP_ID / CLIENT_SECRET / API_KEY)")
    data = _post("/api/v2/access_token",
                 {"apiKey": API_KEY, "appId": APP_ID, "clientSecret": CLIENT_SECRET})
    tok = data.get("token")
    if not tok:
        raise IikoError("no token in access_token response")
    with _lock:
        _token["value"] = tok
        _token["exp"] = now + 50 * 60
    return tok


def _fetch_external_menu():
    body = {"externalMenuId": EXT_MENU_ID, "organizationIds": [ORG_ID], "priceCategoryId": None}
    try:
        return _post("/api/2/menu/by_id", body, token=get_token(), timeout=40)
    except IikoError:
        # token may have been revoked/expired early — retry once with a fresh one.
        return _post("/api/2/menu/by_id", body, token=get_token(force=True), timeout=40)


def _normalize(raw):
    """Flatten iiko's external menu into a compact, frontend-friendly shape.
    Only visible, sellable items are kept; each carries its iiko itemId (the
    id an order must reference) plus price(s) and size options."""
    cats = []
    for c in raw.get("itemCategories", []) or []:
        if c.get("isHidden"):
            continue
        items = []
        for it in c.get("items", []) or []:
            if it.get("isHidden"):
                continue
            sizes = []
            for s in it.get("itemSizes", []) or []:
                if s.get("isHidden"):
                    continue
                prices = s.get("prices") or []
                price = prices[0].get("price") if prices else None
                sizes.append({
                    "sizeId": s.get("sizeId"),
                    "name": s.get("sizeName") or "",
                    "price": price,
                    "sku": s.get("sku"),
                })
            base_price = sizes[0]["price"] if sizes else None
            items.append({
                "iikoId": it.get("itemId"),
                "name": it.get("name") or "",
                "sku": it.get("sku"),
                "description": it.get("description") or "",
                "type": it.get("type"),
                "price": base_price,
                "sizes": sizes,
            })
        if items:
            cats.append({"id": c.get("id"), "name": c.get("name") or "", "items": items})
    return {
        "revision": raw.get("revision"),
        "organizationId": ORG_ID,
        "externalMenuId": EXT_MENU_ID,
        "categories": cats,
    }


def get_menu(force=False):
    """Cached, normalized iiko menu. `force=True` bypasses the cache."""
    now = time.time()
    with _lock:
        if not force and _menu_cache["data"] and now - _menu_cache["ts"] < MENU_TTL:
            return _menu_cache["data"]
    menu = _normalize(_fetch_external_menu())
    with _lock:
        _menu_cache["data"] = menu
        _menu_cache["ts"] = now
    return menu


STOP_LIST_TTL = int(os.environ.get("IIKO_STOP_LIST_TTL", "60"))  # seconds — shorter than the menu, stock changes fast
_stop_list_cache = {"ids": set(), "ts": 0.0}


def get_stop_list_ids(force=False):
    """Product ids currently marked unavailable (out of stock) in iiko for
    our terminal group. Never raises — an iiko hiccup here should not hide
    the whole menu, so a failed fetch just returns the last known set (or
    empty on first run)."""
    now = time.time()
    with _lock:
        if not force and now - _stop_list_cache["ts"] < STOP_LIST_TTL:
            return _stop_list_cache["ids"]
    try:
        data = _post("/api/1/stop_lists",
                     {"organizationIds": [ORG_ID], "terminalGroupsIds": [TERMINAL_GROUP_ID]},
                     token=get_token(), timeout=25)
        ids = set()
        for grp in data.get("terminalGroupStopLists", []) or []:
            for tg in grp.get("items", []) or []:
                for it in tg.get("items", []) or []:
                    pid = it.get("productId")
                    if pid:
                        ids.add(pid)
    except IikoError:
        with _lock:
            return _stop_list_cache["ids"]
    with _lock:
        _stop_list_cache["ids"] = ids
        _stop_list_cache["ts"] = now
    return ids


# ── presentation overlay (Option A) ────────────────────────────────────
# iiko has no images and only Russian names; the overlay (built offline by
# build_overlay.py) layers the website's images + kz/en names onto iiko items
# by itemId. Reloaded automatically when the file changes.
OVERLAY_PATH = os.path.join(os.path.dirname(__file__), "iiko_overlay.json")
_overlay_cache = {"data": None, "mtime": -1.0}


def load_overlay():
    try:
        mtime = os.path.getmtime(OVERLAY_PATH)
    except OSError:
        return {"items": {}, "hiddenCategoryPrefixes": []}
    with _lock:
        if _overlay_cache["data"] is None or mtime != _overlay_cache["mtime"]:
            try:
                with open(OVERLAY_PATH, encoding="utf-8") as f:
                    _overlay_cache["data"] = json.load(f)
                _overlay_cache["mtime"] = mtime
            except (OSError, ValueError):
                return {"items": {}, "hiddenCategoryPrefixes": []}
        return _overlay_cache["data"]


# iiko stores each drink size as its own item ("Американо 0,3", "Американо 0,4").
# We merge items in the same category that differ only by a trailing size token
# into ONE card with size options — but each option keeps its own iiko itemId,
# so an order still targets the exact size the customer picked.
_SIZE_RE = re.compile(r"\s+(\d+(?:[.,]\d+)?\s*(?:л|l|мл|ml|шт)?)\s*$", re.IGNORECASE)


def _split_size(name):
    m = _SIZE_RE.search(name or "")
    if m:
        return (name[:m.start()].strip(), m.group(1).strip())
    return ((name or "").strip(), None)


def _size_order(tok):
    m = re.match(r"(\d+(?:[.,]\d+)?)", tok or "")
    try:
        return float(m.group(1).replace(",", ".")) if m else 0.0
    except ValueError:
        return 0.0


def _group_sized(items):
    groups, order = {}, []
    for it in items:
        base, tok = _split_size(it["name"]["ru"])
        key = base.lower()
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append((it, tok, base))
    out = []
    for key in order:
        members = groups[key]
        if len(members) > 1 and all(tok for _it, tok, _b in members):
            members.sort(key=lambda x: _size_order(x[1]))
            first, _tok, base = members[0]
            sizes = [{"name": tok, "price": it["price"], "iikoId": it["iikoId"], "sku": it.get("sku"),
                      "soldOut": it.get("soldOut", False)}
                     for it, tok, _b in members]
            strip = lambda v: _split_size(v)[0] or v
            out.append({
                "iikoId": sizes[0]["iikoId"],
                "sku": first.get("sku"),
                "name": {"ru": base, "kz": strip(first["name"]["kz"]), "en": strip(first["name"]["en"])},
                "desc": first.get("desc") or {},
                "image": first.get("image"),
                "emoji": first.get("emoji") or "",
                "tags": first.get("tags") or [],
                "price": min((s["price"] for s in sizes if s["price"] is not None), default=None),
                "sizes": sizes,
                # Sizes are always toggled together (see toggleDelivery), but
                # fall back to "non-deliverable wins" if they ever disagree.
                "deliveryAvailable": all(m[0].get("deliveryAvailable", True) for m in members),
                # Only mark the whole card sold out once every size is —
                # a single out-of-stock size still leaves the dish orderable.
                "soldOut": all(m[0].get("soldOut", False) for m in members),
            })
        else:
            out.extend(m[0] for m in members)
    return out


def get_display_menu(force=False, db_overlay=None, cat_order=None):
    """iiko menu merged with the presentation overlay — the shape the website
    consumes: each item has trilingual name/description, image/emoji, tags,
    price, sizes, and its iiko itemId. Add-on categories are dropped;
    prices/ids stay iiko's. Same-dish size variants are merged into one card
    (each size keeps its id).

    Overlay layering per item (later wins): iiko → generated file overlay →
    db_overlay (staff edits from the admin editor). db_overlay is keyed by
    iiko itemId: {name:{kz,en}, desc:{ru,kz,en}, image, hidden, sortOrder,
    deliveryAvailable}. A hidden item is dropped. Items within a category sort by sortOrder (staff
    reorder), falling back to iiko's own order. cat_order is an explicit list
    of category ids (staff reorder); categories not listed keep iiko's order,
    appended after the listed ones in their original relative order."""
    menu = get_menu(force=force)
    stopped_ids = get_stop_list_ids()
    ov = load_overlay()
    items_ov = ov.get("items", {}) or {}
    db = db_overlay or {}
    hidden = tuple(ov.get("hiddenCategoryPrefixes", []) or [])
    out = []
    for c in menu["categories"]:
        if hidden and c["name"].startswith(hidden):
            continue
        items = []
        for idx, it in enumerate(c["items"]):
            o = items_ov.get(it["iikoId"]) or {}
            d = db.get(it["iikoId"]) or {}
            if d.get("hidden"):
                continue  # staff hid this item
            nm_f = o.get("name") or {}
            nm_d = d.get("name") or {}
            ru = it["name"]  # iiko name is authoritative for Russian
            kz = nm_d.get("kz") or nm_f.get("kz") or ru
            en = nm_d.get("en") or nm_f.get("en") or ru
            image = d.get("image") if ("image" in d) else o.get("image")
            desc_f = o.get("desc") or {}
            desc_d = d.get("desc") or {}
            desc = {
                "ru": desc_d.get("ru") or desc_f.get("ru") or "",
                "kz": desc_d.get("kz") or desc_f.get("kz") or "",
                "en": desc_d.get("en") or desc_f.get("en") or "",
            }
            so = d.get("sortOrder")
            items.append({
                "iikoId": it["iikoId"],
                "sku": it["sku"],
                "name": {"ru": ru, "kz": kz, "en": en},
                "desc": desc,
                "image": image,
                "emoji": o.get("emoji") or "",
                "tags": o.get("tags") or [],
                "price": it["price"],
                "sizes": it["sizes"],
                # Staff can mark a dish dine-in/pickup-in-person only (e.g. a
                # soup that doesn't travel well); defaults to deliverable.
                "deliveryAvailable": d.get("deliveryAvailable") is not False,
                # Kitchen marked this out of stock in iikoFront just now —
                # mirrors iiko's own stop-list, not staff-editable here.
                "soldOut": it["iikoId"] in stopped_ids,
                "_sort": (so, idx) if isinstance(so, (int, float)) else (idx, idx),
            })
        items.sort(key=lambda x: x["_sort"])
        for it in items:
            it.pop("_sort", None)
        items = _group_sized(items)
        if items:
            out.append({"id": c["id"], "name": c["name"], "items": items})
    if cat_order:
        pos = {cid: i for i, cid in enumerate(cat_order)}
        indexed = list(enumerate(out))
        indexed.sort(key=lambda pair: (pos.get(pair[1]["id"], len(pos)), pair[0]))
        out = [c for _, c in indexed]
    return {"revision": menu.get("revision"), "categories": out}


# ── send orders to iiko (Stage 4, Option A: iiko/kitchen stays the source of
# truth for cooking status; this direction only pushes the order itself so it
# shows up on the kitchen's existing iikoFront screen — nothing here ever
# reads status back or overwrites what the kitchen decides). Best-effort by
# design: called only after the order is already saved in our own database,
# and a failure here must never be treated as the order having failed. ────
def _order_items_payload(items):
    out = []
    for it in items or []:
        product_id = it.get("iikoId") or it.get("id")
        if not product_id:
            continue
        try:
            amount = float(it.get("qty") or 1)
        except (TypeError, ValueError):
            amount = 1
        out.append({"type": "Product", "productId": product_id, "amount": amount})
    return out


def _delivery_point(order):
    """Build iiko's deliveryPoint from our map-pin order. Courier delivery
    is refused by iiko without an address, so we send the pin coordinates
    (the real navigation target) plus the reverse-geocoded address as a
    free-form ('legacy') street line. house is required by iiko's legacy
    address, but our pin has no house number, so a placeholder stands in —
    the courier navigates by coordinates / the map link in the comment."""
    line = (order.get("address") or "").strip() or "По карте (см. координаты)"
    point = {"address": {"street": {"name": line}, "house": "1", "type": "legacy"}}
    try:
        point["coordinates"] = {"latitude": float(order["lat"]), "longitude": float(order["lng"])}
    except (TypeError, ValueError, KeyError):
        pass
    if order.get("mapLink"):
        point["comment"] = str(order["mapLink"])
    return point


def _await_creation(order_id, is_delivery, tries=8, delay=1.2):
    """iiko creates orders asynchronously: the create call returns an id
    while creationStatus is still 'InProgress', and the order can *still*
    fail afterwards. Poll by_id until it resolves so we never report a
    failed order as sent. Returns (creation_status, error_info, order)."""
    # deliveries/by_id takes organizationId (singular); order/by_id takes
    # organizationIds (a list) — iiko is not consistent between the two.
    path = "/api/1/deliveries/by_id" if is_delivery else "/api/1/order/by_id"
    body = {"orderIds": [order_id]}
    body["organizationId" if is_delivery else "organizationIds"] = ORG_ID if is_delivery else [ORG_ID]
    for _ in range(tries):
        time.sleep(delay)
        try:
            data = _post(path, body, token=get_token())
        except IikoError:
            continue
        row = (data.get("orders") or [{}])[0]
        status = row.get("creationStatus")
        if status in ("Success", "Error"):
            return status, row.get("errorInfo"), row.get("order")
    return "InProgress", None, None


def get_order_statuses(order_ids, is_delivery=True):
    """Batch-read the current iiko status of orders we previously pushed
    (Setup A mirror: iikoFront is where staff actually manage cooking, we
    only read it back). Returns {iikoOrderId: status} for successfully
    created orders; never raises — a failed poll just means no update."""
    if not order_ids or not configured():
        return {}
    path = "/api/1/deliveries/by_id" if is_delivery else "/api/1/order/by_id"
    body = {"orderIds": list(order_ids)}
    body["organizationId" if is_delivery else "organizationIds"] = ORG_ID if is_delivery else [ORG_ID]
    try:
        data = _post(path, body, token=get_token())
    except IikoError:
        try:
            data = _post(path, body, token=get_token(force=True))
        except IikoError:
            return {}
    out = {}
    for row in data.get("orders") or []:
        if row.get("creationStatus") != "Success":
            continue
        status = (row.get("order") or {}).get("status")
        if row.get("id") and status:
            out[row["id"]] = status
    return out


def send_order(order):
    """Create the matching order in iiko and confirm it really landed.
    Returns {"ok": True, "iikoOrderId", "iikoNumber"} or {"ok": False,
    "error"} — never raises, since a website order must stand on its own
    even if iiko is unreachable or rejects it. Meant to run off the request
    thread (see app._send_order_to_iiko), so the customer never waits on it."""
    if not configured():
        return {"ok": False, "error": "iiko not configured"}
    order_type = order.get("type")
    order_type_id = ORDER_TYPE_IDS.get(order_type)
    if not order_type_id:
        return {"ok": False, "error": f"no iiko order type mapping for {order_type!r}"}
    items = _order_items_payload(order.get("items"))
    if not items:
        return {"ok": False, "error": "no order items carry an iiko product id"}

    # Lead the ticket with a bold fulfillment-type label plus the delivery
    # address and map link, all in the comment. iikoFront shows the comment
    # prominently, whereas the structured deliveryPoint address is unreliable
    # for us (iiko forces the city to Moscow and blanks the street when our
    # free-form map-pin address doesn't match its classifier), so the comment
    # is where staff can actually read the type and where to go.
    TYPE_LABEL = {"delivery": "🚚 ДОСТАВКА", "pickup": "🥡 САМОВЫВОЗ", "table": "🍽 В ЗАЛЕ"}
    comment_parts = []
    label = TYPE_LABEL.get(order_type, "")
    if order_type == "table" and order.get("table"):
        label = f"{label} (стол {order['table']})".strip()
    if label:
        comment_parts.append(label)
    if order_type == "delivery" and order.get("address"):
        comment_parts.append(f"Адрес: {order['address']}")
    if order.get("mapLink"):
        comment_parts.append(str(order["mapLink"]))
    if order.get("comment"):
        comment_parts.append(f"Комментарий: {order['comment']}")

    payload_order = {
        "phone": (order.get("phone") or "").strip() or "+70000000000",
        "orderTypeId": order_type_id,
        "customer": {"name": (order.get("name") or "").strip() or "Сайт"},
        "items": items,
        "sourceKey": order.get("id"),  # our own order id -> lets iiko dedupe retries
    }
    if comment_parts:
        payload_order["comment"] = " | ".join(comment_parts)
    if order_type == "delivery":
        payload_order["deliveryPoint"] = _delivery_point(order)

    is_delivery = order_type != "table"
    path = "/api/1/deliveries/create" if is_delivery else "/api/1/order/create"
    body = {"organizationId": ORG_ID, "terminalGroupId": TERMINAL_GROUP_ID, "order": payload_order}
    try:
        data = _post(path, body, token=get_token(), timeout=25)
    except IikoError:
        try:
            data = _post(path, body, token=get_token(force=True), timeout=25)
        except IikoError as e2:
            return {"ok": False, "error": str(e2)}

    info = data.get("orderInfo") or {}
    order_id = info.get("id")
    status = info.get("creationStatus")
    err = info.get("errorInfo")
    created = info.get("order")
    # The order may only be confirmed asynchronously — wait for the real verdict.
    if status == "InProgress" and order_id:
        status, err, created = _await_creation(order_id, is_delivery)
    if status == "Error" or (err and status != "Success"):
        msg = (err or {}).get("message") or (err or {}).get("code") or "iiko rejected the order"
        return {"ok": False, "error": msg, "iikoOrderId": order_id}
    if status != "Success":
        # Never resolved in time — don't claim success; staff verify in iikoFront.
        return {"ok": False, "error": "iiko did not confirm the order in time", "iikoOrderId": order_id}
    return {"ok": True, "iikoOrderId": order_id, "iikoNumber": (created or {}).get("number")}
