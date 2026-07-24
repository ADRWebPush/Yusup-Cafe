# auth.py
import os, jwt, datetime
from functools import wraps
from flask import request, jsonify, g
from argon2 import PasswordHasher

ph = PasswordHasher()
JWT_SECRET = os.environ["JWT_SECRET"]   # set in Render (Step 17)

# Run once to get your password hash, then store it in an env var:
#   python -c "from argon2 import PasswordHasher; print(PasswordHasher().hash('YOUR_PASSWORD'))"
OWNER_USER = os.environ["OWNER_USER"]
OWNER_HASH = os.environ["OWNER_PASS_HASH"]

def make_token():
    payload = {"role": "owner",
               "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=72)}
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def check_login(username, password):
    if username != OWNER_USER:
        return None
    try:
        ph.verify(OWNER_HASH, password)
        return make_token()
    except Exception:
        return None

def is_owner_request(req):
    # Non-raising variant of require_owner: lets an endpoint serve both
    # public (sanitized) and owner (full) responses from one route.
    token = req.headers.get("Authorization", "").removeprefix("Bearer ")
    if not token:
        return False
    try:
        jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        return True
    except jwt.InvalidTokenError:
        return False

def require_owner(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        token = request.headers.get("Authorization", "").removeprefix("Bearer ")
        if not token:
            return jsonify(error="login required"), 401
        try:
            jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        except jwt.InvalidTokenError:
            return jsonify(error="invalid or expired login"), 401
        return fn(*a, **kw)
    return wrapper