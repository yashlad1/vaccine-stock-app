"""v4 oracle, written from SPEC rules 8-10 only (plus rule 1 via the existing oracle.py)."""
import json
import re
from fractions import Fraction
from pathlib import Path

from oracle import round_ml_oracle  # existing code-blind oracle (rule 1 rounding)


def _get(d, *names, default=None):
    for n in names:
        if d.get(n) not in (None, ""):
            return d[n]
    return default


def _product(generic, e):
    brands = _get(e, "brands", "brand_names", default=[]) or []
    if isinstance(brands, str):
        brands = [brands]
    return {
        "generic": generic,
        "cls": _get(e, "class", "drug_class", "cls"),
        "brands": list(brands),
        "strength": _get(e, "strength", "product_strength"),
        "mg_per_kg_day": _get(e, "mg_per_kg_day"),
        "doses_per_day": _get(e, "doses_per_day"),
        "max_single_mg": _get(e, "max_single_mg"),
        "max_daily_mg": _get(e, "max_daily_mg"),
        "max_mg_per_kg_dose": _get(e, "max_mg_per_kg_dose", "max_mg_per_kg_per_dose"),
        "min_age_months": _get(e, "min_age_months", "min_age"),
        "safety_net": _get(e, "safety_net", "safety_net_sentence"),
        "components": _get(e, "generics", default=[generic]),
        "source": _get(e, "source"),
        "version": _get(e, "version"),
    }


def load_products(extra, out_dir):
    """Flatten the generated formulary into one dict per PRODUCT (generic + strength).
    Accepts: dict keyed by generic or list of entries; an entry may hold `products: [...]`;
    `formulary` may be a path to a JSON file. Missing keys come back None (tests then fail by name)."""
    f = extra.get("formulary")
    ptr = extra.get("formulary_file") or (f if isinstance(f, str) else None)
    if ptr:
        p = Path(ptr)
        f = json.loads((p if p.is_absolute() else Path(out_dir) / p).read_text())
    if isinstance(f, dict) and len(f) == 1 and isinstance(next(iter(f.values())), (list, dict)) \
            and next(iter(f)) in ("medicines", "entries", "formulary"):
        f = next(iter(f.values()))
    items = list(f.items()) if isinstance(f, dict) else [(_get(e, "generic", "name"), e) for e in f]
    prods = []
    ill = Path(__file__).resolve().parent.parent / "src/dose_agent/knowledge/illustrative.json"
    comps = {}
    if ill.exists():
        for p in json.loads(ill.read_text())["products"]:
            if p.get("generics"):
                comps[p["generic"]] = p["generics"]
    for generic, e in items:
        if generic in comps and not e.get("generics"):
            e = {**e, "generics": comps[generic]}
        generic = _get(e, "generic", "name", default=generic)
        subs = e.get("products")
        if subs:
            base = {k: v for k, v in e.items() if k != "products"}
            prods += [_product(generic, {**base, **s}) for s in subs]
        else:
            prods.append(_product(generic, e))
    return prods


def per_ml(strength):
    m = re.match(r"\s*([\d.]+)\s*mg\s*/\s*([\d.]+)\s*ml", strength)
    if not m:
        return None   # e.g. a combination tablet: no ml oracle
    return Fraction(m.group(1)) / Fraction(m.group(2))


def age_months(dob, today):
    """Whole months between ISO dates."""
    by, bm, bd = map(int, dob[:10].split("-"))
    ty, tm, td = map(int, today[:10].split("-"))
    return (ty - by) * 12 + (tm - bm) - (1 if td < bd else 0)


def dose_v4(kg, prod, age_m=None):
    """('ok', mg, ml) or ('refuse', reason). Rule 1 + rule 10."""
    kg = Fraction(str(kg))
    daily = kg * prod["mg_per_kg_day"]
    mg = daily / prod["doses_per_day"]
    if prod["min_age_months"] is not None and age_m is not None and age_m < prod["min_age_months"]:
        return ("refuse", "age")
    if prod["max_mg_per_kg_dose"] is not None and mg / kg > Fraction(str(prod["max_mg_per_kg_dose"])):
        return ("refuse", "mg_per_kg")
    if prod["max_single_mg"] and mg > prod["max_single_mg"]:
        return ("refuse", "max_single")
    if prod["max_daily_mg"] and daily > prod["max_daily_mg"]:
        return ("refuse", "max_daily")
    if per_ml(prod["strength"]) is None:
        return ("refuse", "no_ml_strength")
    exact = mg / per_ml(prod["strength"])
    if exact < Fraction(1, 2):
        return ("refuse", "too_small")
    ml = round_ml_oracle(exact)
    if ml > 20:
        return ("refuse", "too_big")
    return ("ok", mg, ml)


def has_any_max(prod):
    return any(prod[k] for k in ("max_single_mg", "max_daily_mg", "max_mg_per_kg_dose"))


# ---------- self-checks ----------
def _p(**kw):
    base = dict(generic="g", cls=None, brands=[], strength="250 mg / 5 ml", mg_per_kg_day=60,
                doses_per_day=4, max_single_mg=500, max_daily_mg=2000, max_mg_per_kg_dose=None,
                min_age_months=None)
    return {**base, **kw}


def test_oracle_v4_strength_changes_ml():
    assert dose_v4(12.4, _p()) == ("ok", Fraction(186), Fraction("3.75"))
    # 120 mg / 5 ml: 186 mg -> 7.75 ml exact -> 1.55 spoon -> 1.5 -> 1.5 -> 7.5 ml
    assert dose_v4(12.4, _p(strength="120 mg / 5 ml")) == ("ok", Fraction(186), Fraction("7.5"))


def test_oracle_v4_limits():
    assert dose_v4(12.4, _p(min_age_months=24), 12) == ("refuse", "age")
    assert dose_v4(12.4, _p(min_age_months=24), 24)[0] == "ok"
    assert dose_v4(12.4, _p(max_mg_per_kg_dose=10)) == ("refuse", "mg_per_kg")   # 15 mg/kg/dose
    assert dose_v4(12.4, _p(max_mg_per_kg_dose=15))[0] == "ok"                    # equal is not over
    assert dose_v4(40, _p()) == ("refuse", "max_single")
    assert dose_v4(12.4, _p(max_single_mg=None, max_daily_mg=None))[0] == "ok"
    assert dose_v4(1, _p()) == ("refuse", "too_small")


def test_age_months():
    assert age_months("2025-11-11", "2026-11-11") == 12
    assert age_months("2025-11-12", "2026-11-11") == 11
