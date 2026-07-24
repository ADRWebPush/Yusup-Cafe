# init_db.py  — run:  python init_db.py
from db import get_db

conn = get_db()
conn.execute("""
CREATE TABLE IF NOT EXISTS menu (
    id TEXT PRIMARY KEY, data JSONB NOT NULL
);""")
conn.execute("""
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    num SERIAL,
    ts BIGINT NOT NULL,
    status TEXT NOT NULL,
    guest_token TEXT,
    client_ip TEXT,
    payment_id TEXT,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);""")
conn.execute("""
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, data JSONB NOT NULL
);""")
conn.execute("""
CREATE TABLE IF NOT EXISTS print_jobs (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    order_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);""")
conn.execute("""
CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY DEFAULT 1,
    accrued BIGINT NOT NULL DEFAULT 0,
    paid BIGINT NOT NULL DEFAULT 0,
    balance BIGINT NOT NULL DEFAULT 0,
    history JSONB NOT NULL DEFAULT '[]'::jsonb
);""")
conn.execute("""
INSERT INTO ledger (id, accrued, paid, balance, history)
VALUES (1, 0, 0, 0, '[]'::jsonb)
ON CONFLICT (id) DO NOTHING;
""")
conn.commit(); conn.close()
print("tables ready")
