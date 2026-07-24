"""Generate iiko_overlay.json — the presentation layer for Option A.

iiko is the source of truth (items, prices, ids, sizes). iiko has no images
and only Russian names. This build step matches the website's curated menu to
iiko items and freezes an overlay keyed by iiko itemId that carries:
  image / emoji / tags / description / kz+en names.

Run this whenever the website's curated menu (images/translations) changes.
It is NOT part of request handling — it produces a reviewable static file that
the backend merges onto the live iiko menu at runtime.

Usage:  python build_overlay.py   (writes Backendone/iiko_overlay.json)
"""
import os, sys, io, json, re, datetime
from pathlib import Path
from difflib import SequenceMatcher
import requests
from dotenv import load_dotenv

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
load_dotenv()
import iiko

SITE_API = os.environ.get("SITE_MENU_URL", "https://aspan-cafe-backend.onrender.com/api/menu")
OUT = Path(__file__).with_name("iiko_overlay.json")

# Categories that are add-ons/toppings, not standalone dishes — hidden by
# default from the customer grid (owner can unhide by editing this list).
HIDDEN_CATEGORY_PREFIXES = ("Добавки", "Категория без имени")

STOP = {"пицца", "соус", "каша", "лимонад", "доп", "суши"}
MATCH_THRESHOLD = 0.80  # overlay only affects presentation, not order correctness


def norm(s):
    if not s:
        return ""
    s = str(s).lower().replace("ё", "е").replace(",", ".")
    s = re.sub(r"[^\w\s.]", " ", s, flags=re.UNICODE)
    s = re.sub(r"\bл\b", "l", s)
    return re.sub(r"\s+", " ", s).strip()


def toks(s):
    return [w for w in norm(s).split() if w and w not in STOP]


def score(a, b):
    na, nb = " ".join(toks(a)), " ".join(toks(b))
    if not na or not nb:
        return 0.0
    plain = SequenceMatcher(None, na, nb).ratio()
    ssort = SequenceMatcher(None, " ".join(sorted(toks(a))), " ".join(sorted(toks(b)))).ratio()
    return max(plain, ssort)


def trailing_size(name):
    """Extract a trailing size/volume token from an iiko name, e.g. '0,4', '0,8'."""
    m = re.search(r"(\d+(?:[.,]\d+)?\s*(?:л|мл|шт)?)\s*$", name.strip(), flags=re.IGNORECASE)
    return m.group(1).strip() if m else ""


def main():
    site = requests.get(SITE_API, timeout=30).json()
    menu = iiko.get_menu(force=True)

    site_items = []
    for it in site:
        nm = it.get("name") or {}
        site_items.append({
            "ru": nm.get("ru") or nm.get("en") or "",
            "kz": nm.get("kz") or "", "en": nm.get("en") or "",
            "desc": it.get("desc") or {},
            "image": it.get("image"), "emoji": it.get("emoji") or "",
            "tags": it.get("tags") or [], "has_sizes": bool(it.get("sizes")),
        })

    overlay, matched, hidden_ct = {}, 0, 0
    for c in menu["categories"]:
        cat_hidden = any(c["name"].startswith(p) for p in HIDDEN_CATEGORY_PREFIXES)
        for it in c["items"]:
            if cat_hidden:
                hidden_ct += 1
            iid, iname = it["iikoId"], it["name"]
            best, bm = 0.0, None
            for s in site_items:
                sc = score(iname, s["ru"])
                if s["has_sizes"]:  # also try base+size variants score already covers word tokens
                    sc = max(sc, score(iname, f"{s['ru']} {trailing_size(iname)}"))
                if sc > best:
                    best, bm = sc, s
            entry = {}
            if bm and best >= MATCH_THRESHOLD:
                matched += 1
                suffix = trailing_size(iname) if bm["has_sizes"] else ""
                sfx = f" {suffix}" if suffix else ""
                entry = {
                    "image": bm["image"] or None,
                    "emoji": bm["emoji"],
                    "tags": bm["tags"],
                    "desc": bm["desc"],
                    "name": {
                        "ru": iname,  # iiko name is authoritative
                        "kz": (bm["kz"] + sfx).strip() if bm["kz"] else iname,
                        "en": (bm["en"] + sfx).strip() if bm["en"] else iname,
                    },
                    "matchScore": round(best, 2),
                }
            overlay[iid] = entry  # empty {} for unmatched → frontend falls back to iiko ru name

    out = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "hiddenCategoryPrefixes": list(HIDDEN_CATEGORY_PREFIXES),
        "items": overlay,
        "stats": {
            "iikoItems": len(overlay),
            "matched": matched,
            "unmatched": len(overlay) - matched,
            "hiddenItems": hidden_ct,
        },
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {OUT}")
    print(f"  iiko items: {out['stats']['iikoItems']}")
    print(f"  matched (image/translation applied): {matched}")
    print(f"  unmatched (fall back to iiko Russian name): {out['stats']['unmatched']}")
    print(f"  hidden (add-on categories): {hidden_ct}")


if __name__ == "__main__":
    main()
