# payments.py
import os, time, json, uuid, hmac, hashlib
from flask import Blueprint, request, jsonify
from db import get_db   # your existing SQLite helper

payments = Blueprint("payments", __name__)
PENDING_TTL_MS = 15 * 60 * 1000
PLATFORM_FEE_RATE = 0.01

# --- price authority: recompute the total from OUR menu, never trust client ---
def compute_total(conn, items):
    total = 0
    for it in items:
        row = conn.execute("SELECT data FROM menu WHERE id=?", (it["id"],)).fetchone()
        if not row:
            raise ValueError(f"unknown item {it['id']}")
        dish = json.loads(row["data"])
        if not dish.get("available", True):
            raise ValueError(f"unavailable item {it['id']}")
        total += int(dish["price"]) * max(1, int(it["qty"]))
    return total

# ===== PSP INTEGRATION POINT (swap body for Freedom Pay / Halyk / Stripe) =====
def psp_create_payment(order_id, amount, partner_amount, fee_amount):
    """Ask the gateway for a hosted payment; return (payment_id, checkout_url)."""
    payment_id = "pay_" + uuid.uuid4().hex
    # Example marketplace payload you'd POST to the PSP:
    # {
    #   "amount": amount, "currency": "KZT", "order_id": order_id,
    #   "splits": [
    #       {"payee_id": os.environ["PARTNER_PAYEE_ID"],  "amount": partner_amount},
    #       {"payee_id": os.environ["PLATFORM_PAYEE_ID"], "amount": fee_amount},
    #   ],
    #   "webhook_url": os.environ["PUBLIC_URL"] + "/api/payments/webhook",
    #   "return_url":  os.environ["PUBLIC_URL"] + "/pay/return?order=" + order_id,
    # }
    checkout_url = f"{os.environ['PSP_CHECKOUT_BASE']}/{payment_id}"
    return payment_id, checkout_url

def verify_webhook(req):
    secret = os.environ["PSP_WEBHOOK_SECRET"].encode()
    expected = hmac.new(secret, req.get_data(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, req.headers.get("X-Signature", ""))
# =============================================================================

@payments.route("/api/payments/init", methods=["POST"])
def init_payment():
    body = request.get_json()
    conn = get_db()
    try:
        amount = compute_total(conn, body.get("items", []))   # authoritative
    except ValueError as e:
        conn.close(); return jsonify({"error": str(e)}), 400
    if amount <= 0:
        conn.close(); return jsonify({"error": "empty order"}), 400

    fee = round(amount * PLATFORM_FEE_RATE)
    order_id = "o" + uuid.uuid4().hex
    now = int(time.time() * 1000)
    num = conn.execute("SELECT COALESCE(MAX(num),100) FROM orders").fetchone()[0] + 1

    payment_id, checkout_url = psp_create_payment(order_id, amount, amount - fee, fee)

    order = {**body, "id": order_id, "num": num, "ts": now,
             "status": "pending_payment", "amount": amount, "fee": fee,
             "payment_id": payment_id, "expires_at": now + PENDING_TTL_MS}
    conn.execute(
        "INSERT INTO orders (id, num, ts, status, payment_id, data) VALUES (?,?,?,?,?,?)",
        (order_id, num, now, "pending_payment", payment_id, json.dumps(order)))
    conn.commit(); conn.close()
    return jsonify({"order_id": order_id, "checkout_url": checkout_url})

@payments.route("/api/payments/webhook", methods=["POST"])
def webhook():
    if not verify_webhook(request):
        return "bad signature", 400
    evt = request.get_json()
    payment_id, status = evt.get("payment_id"), evt.get("status")
    paid_amount = int(evt.get("amount", 0))

    conn = get_db()
    row = conn.execute("SELECT data, status FROM orders WHERE payment_id=?", (payment_id,)).fetchone()
    if not row:
        conn.close(); return "unknown", 404

    # idempotency: if it's already moved past pending, do nothing (webhooks repeat)
    if row["status"] != "pending_payment":
        conn.close(); return "ok", 200

    order = json.loads(row["data"])
    if status == "success" and paid_amount != int(order["amount"]):
        conn.close(); return "amount mismatch", 400   # never trust a wrong amount

    new_status = "paid" if status == "success" else "payment_failed"
    order["status"] = new_status
    conn.execute("UPDATE orders SET status=?, data=? WHERE payment_id=?",
                 (new_status, json.dumps(order), payment_id))
    conn.commit(); conn.close()
    return "ok", 200   # respond 200 fast; do heavy work async if needed
