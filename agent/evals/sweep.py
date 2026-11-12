"""Seeded random sweep: dosing.compute_dose vs the tests' independent oracle (SPEC rules 1 and 10).
Compares the verdict, the refusal reason, mg, ml, and the working text. A quarter of the cases put a limit
exactly AT the dose ("equal is not over"). Plus a few edge inputs (no weight, no strength...).
uv run python evals/sweep.py [--n 10000] [--seed 1]. Any mismatch prints the input and exits 1."""
import argparse
import random
import re
import sys
from datetime import date, timedelta
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests"))
from oracle import round_ml_oracle  # noqa: E402
from oracle_v4 import age_months, dose_v4, per_ml  # noqa: E402

from dose_agent.dosing.dose import DoseRule, compute_dose, mg_per_ml  # noqa: E402
from dose_agent.records.age import age_in_months  # noqa: E402

STRENGTHS = ["250 mg / 5 ml", "100 mg / 5 ml", "200 mg / 5 ml", "125 mg / 5 ml", "120 mg / 5 ml", "50 mg / 1 ml",
             "400 mg / 5 ml", "156.25 mg / 5 ml"]
WHY = {"mg_per_kg": "over the per-kg dose maximum", "max_single": "over the single dose maximum",
       "max_daily": "over the daily maximum", "too_small": "too small to measure on this syringe",
       "too_big": "volume implausible"}


def _pick(rng, values, p_none=0.4):
    return None if rng.random() < p_none else rng.choice(values)


def _exact(x: Fraction):
    """x as a float only when that float is exactly x (so 'equal' means equal to both sides)."""
    return float(x) if Fraction(float(x)) == x else None


def case(rng):
    c = {"kg": Fraction(rng.randint(5, 700), 10), "strength": rng.choice(STRENGTHS),
         "mg_per_kg_day": rng.choice([10, 15, 20, 25, 30, 40, 45, 50, 60, 75, 90]),
         "doses_per_day": rng.randint(1, 6), "max_single_mg": _pick(rng, [100, 200, 250, 400, 500, 1000]),
         "max_daily_mg": _pick(rng, [500, 1000, 1200, 2000, 3000]),
         "max_mg_per_kg_dose": _pick(rng, [5, 8, 10, 12.5, 15, 20]),
         "min_age_months": _pick(rng, [3, 6, 12, 24], 0.5), "age": rng.randint(0, 200)}
    if rng.random() < 0.25:  # a limit exactly at the dose
        daily = c["kg"] * c["mg_per_kg_day"]
        mg = daily / c["doses_per_day"]
        key, val = rng.choice([("max_single_mg", mg), ("max_daily_mg", daily), ("max_mg_per_kg_dose", mg / c["kg"])])
        if _exact(val) is not None:
            c[key] = _exact(val)
    return c


def _g(x: Fraction, places: int) -> set[str]:
    """x rounded to `places`, written as the working writes it ('20', '158.8'). An exact tie is a float coin
    flip in the code (round(4.245, 2)), so both neighbours are accepted there."""
    scaled = x * 10 ** places
    lo = scaled.numerator // scaled.denominator
    near = {lo, lo + 1} if scaled - lo == Fraction(1, 2) else {round(scaled)}
    return {f"{float(Fraction(k, 10 ** places)):g}" for k in near}


def _working(c, want, got):
    """Problems with the working text, checked against the oracle's numbers."""
    daily = c["kg"] * c["mg_per_kg_day"]
    mg = daily / c["doses_per_day"]
    exact = mg / per_ml(c["strength"])
    m = re.match(r"^(\S+) kg x (\S+) mg/kg/day = (\S+) mg/day / (\d+) (dose|doses) = (\S+) mg per dose -> (.*)$",
                 got.steps or "", re.S)
    if not m:
        return f"working missing or malformed: {got.steps!r}"
    kg, mpk, d, n, noun, m_mg, tail = m.groups()
    if (float(kg), float(mpk), int(n)) != (float(c["kg"]), c["mg_per_kg_day"], c["doses_per_day"]) \
            or d not in _g(daily, 1) or m_mg not in _g(mg, 1) or noun != ("dose" if c["doses_per_day"] == 1 else "doses"):
        return f"working numbers wrong: {got.steps!r}"
    shown = round_ml_oracle(exact)
    if shown > 0:
        t = re.match(r"^(\S+) ml exact; by the spoon rule \(down to a tenth of a spoon, then up to the next quarter\) "
                     r"(\S+) ml; (.*)$", tail, re.S)
        if not t or t.group(1) not in _g(exact, 2) or t.group(2) not in _g(shown, 2):
            return f"working ml wrong: {tail!r}"
        rest = t.group(3)
    else:
        t = re.match(r"^(\S+) ml, too small to measure; (.*)$", tail, re.S)
        if not t or t.group(1) not in _g(exact, 2):
            return f"working small-ml wrong: {tail!r}"
        rest = t.group(2)
    limits = [f"max single {c['max_single_mg']:g} mg"] if c["max_single_mg"] is not None else []
    limits += [f"max daily {c['max_daily_mg']:g} mg"] if c["max_daily_mg"] is not None else []
    limits += [f"max {c['max_mg_per_kg_dose']:g} mg/kg per dose"] if c["max_mg_per_kg_dose"] is not None else []
    if rest != (f"limits on file: {', '.join(limits)}" if limits else "no maximum on file"):
        return f"working limits wrong: {rest!r}"


def check(c):
    """None when code and oracle agree, else a description.
    Age is dose_for's job, so a too-young case is compared with the age rule switched off."""
    want = dose_v4(c["kg"], c, c["age"])
    if want == ("refuse", "age"):
        want = dose_v4(c["kg"], {**c, "min_age_months": None}, c["age"])
    got = compute_dose(DoseRule(
        weight_kg=float(c["kg"]), mg_per_kg_day=c["mg_per_kg_day"], doses_per_day=c["doses_per_day"],
        mg_per_ml=mg_per_ml(c["strength"]), max_single_mg=c["max_single_mg"], max_daily_mg=c["max_daily_mg"],
        max_mg_per_kg_dose=c["max_mg_per_kg_dose"]))
    if got.ok not in (True, False):
        return f"ok is {got.ok!r}, not a bool"
    if want[0] == "refuse":
        if got.ok:
            return f"oracle refuses ({want[1]}), code accepts {got.mg} mg {got.ml} ml"
        if got.why != WHY[want[1]]:
            return f"oracle refuses ({want[1]}), code says {got.why!r}"
        return _working(c, want, got)
    if not got.ok:
        return f"oracle accepts {float(want[1]):g} mg {float(want[2]):g} ml, code refuses ({got.why})"
    if got.ml != float(want[2]) or f"{got.mg:g}" not in _g(want[1], 1):  # mg is shown to 1 dp
        return f"oracle {float(want[1]):g} mg {float(want[2]):g} ml, code {got.mg} mg {got.ml} ml"
    return _working(c, want, got)


def check_edges():
    base = dict(weight_kg=12.4, mg_per_kg_day=60, doses_per_day=4, mg_per_ml=50.0)
    out = []
    for name, over, why in [("no strength", {"mg_per_ml": None}, "no strength"), ("zero strength", {"mg_per_ml": 0}, "no strength"),
                            ("no weight", {"weight_kg": None}, "no weight"), ("zero weight", {"weight_kg": 0}, "no weight"),
                            ("no rule", {"mg_per_kg_day": 0}, "no rule"), ("no frequency", {"doses_per_day": None}, "no frequency"),
                            ("zero frequency", {"doses_per_day": 0}, "no frequency")]:
        got = compute_dose(DoseRule(**{**base, **over}))
        if got.ok is not False or got.why != why:
            out.append(f"edge {name}: got ok={got.ok!r} why={got.why!r}, want False/{why!r}")
    edge20 = compute_dose(DoseRule(**{**base, "weight_kg": 20, "mg_per_kg_day": 50, "doses_per_day": 1}))  # exactly 20 ml
    if edge20.ok is not True or edge20.ml != 20:
        out.append(f"edge exactly 20 ml must be accepted: {edge20}")
    tiny = compute_dose(DoseRule(**{**base, "weight_kg": 0.1}))  # 0.6 mg = 0.012 ml: rounds to 0 ml
    if tiny.ok is not False or "too small to measure" not in (tiny.steps or ""):
        out.append(f"edge tiny dose: {tiny}")
    return out


def check_age(rng):
    today = date(2026, 1, 1) + timedelta(days=rng.randint(0, 3000))
    dob = today - timedelta(days=rng.randint(0, 6000))
    want, got = age_months(dob.isoformat(), today.isoformat()), age_in_months(dob.isoformat(), today.isoformat())
    return None if want == got else f"age {dob} on {today}: oracle {want}, code {got}"


def run(n=10000, seed=1) -> list[str]:
    """Every mismatch between code and oracle; none is tolerated."""
    rng = random.Random(seed)
    bad = check_edges()
    for _ in range(n):
        c = case(rng)
        msg = check(c) or check_age(rng)
        if msg:
            bad.append(f"{msg}\n  input: { {k: str(v) for k, v in c.items()} }")
    return bad


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10000)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    bad = run(a.n, a.seed)
    print(f"{a.n} cases, seed {a.seed}: {len(bad)} mismatches")
    print("\n".join(bad[:20]))
    sys.exit(1 if bad else 0)
