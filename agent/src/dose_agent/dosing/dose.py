"""Dose arithmetic: a port of clinic-queue's computeDose (BY_FORMULA path only),
healthlinkRoundMl and mgPerMlOf. The model never writes a dose number; this does.
Formulary values used with it are illustrative, not clinical."""
import math
import re
from dataclasses import dataclass

SPOON_ML = 5.0
MAX_PLAUSIBLE_ML = 20.0
STEP_ML = 0.5


def _round(n: float, dp: int) -> float:
    return round(n, dp)


def mg_per_ml(strength: str | None) -> float | None:
    """'250 mg / 5 ml' -> 50.0. None for anything unreadable, mcg, or a combination."""
    if not strength:
        return None
    # (?<![a-z]) stops 'g' matching inside 'mcg' (a 1000x error).
    masses = re.findall(r"[\d.]+\s*(?<![a-z])(?:mg|g)\b", strength, re.I)
    ratio = re.search(r"[\d.]\s*/\s*[\d.]+\s*(?<![a-z])(?:mg|g)\b", strength, re.I)
    if len(masses) > 1 or ratio:
        return None
    m = re.search(r"([\d.]+)\s*(?<![a-z])(mg|g)\s*/\s*([\d.]+)?\s*ml\b", strength, re.I)
    if not m:
        return None
    try:
        mg = float(m.group(1)) * (1000 if m.group(2).lower() == "g" else 1)
        ml = 1.0 if m.group(3) is None else float(m.group(3))
    except ValueError:
        return None
    return mg / ml if mg > 0 and ml > 0 else None


def round_ml(ml: float, unit_ml: float = SPOON_ML) -> float:
    """HealthLink's rounding: floor to a tenth of a spoon, then up to the next quarter."""
    q = math.floor((ml / unit_ml) * 10) / 10
    out = math.trunc(q)
    frac = q - out
    if frac == 0.5:
        out += 0.5
    elif 0 < frac <= 0.25:
        out += 0.25
    elif 0.25 < frac <= 0.5:
        out += 0.5
    elif 0.5 < frac <= 0.75:
        out += 0.75
    elif 0.75 < frac <= 0.99:
        out += 1
    return out * unit_ml


@dataclass(frozen=True)
class DoseRule:
    weight_kg: float | None
    mg_per_kg_day: float
    doses_per_day: int | None
    mg_per_ml: float | None
    max_single_mg: float | None = None
    max_daily_mg: float | None = None
    max_mg_per_kg_dose: float | None = None
    step_ml: float = STEP_ML
    unit_ml: float = SPOON_ML


@dataclass(frozen=True)
class DoseResult:
    ok: bool
    why: str | None = None  # refusal reason when not ok
    mg: float | None = None
    ml: float | None = None
    steps: str | None = None  # the working, also kept for refusals
    capped: bool = False


def compute_dose(r: DoseRule) -> DoseResult:
    if not (r.mg_per_ml is not None and r.mg_per_ml > 0):
        return DoseResult(False, "no strength")
    if not (r.weight_kg is not None and r.weight_kg > 0):
        return DoseResult(False, "no weight")
    if not r.mg_per_kg_day > 0:
        return DoseResult(False, "no rule")
    if r.doses_per_day is None or not r.doses_per_day > 0:
        return DoseResult(False, "no frequency")

    daily = r.weight_kg * r.mg_per_kg_day
    mg = daily / r.doses_per_day
    exact = mg / r.mg_per_ml
    ml = round_ml(exact, r.unit_ml)
    n = r.doses_per_day
    steps = (
        f"{r.weight_kg:g} kg x {r.mg_per_kg_day:g} mg/kg/day = {_round(daily, 1):g} mg/day"
        f" / {n} {'dose' if n == 1 else 'doses'} = {_round(mg, 1):g} mg per dose"
        + (
            f" -> {_round(exact, 2):g} ml exact; by the spoon rule (down to a tenth of a spoon, then up to the next"
            f" quarter) {_round(ml, 2):g} ml"
            if ml > 0
            else f" -> {_round(exact, 2):g} ml, too small to measure"
        )
    )
    limits = [f"{label} {v:g} mg" for label, v in (("max single", r.max_single_mg), ("max daily", r.max_daily_mg))
              if v is not None]
    if r.max_mg_per_kg_dose is not None:
        limits.append(f"max {r.max_mg_per_kg_dose:g} mg/kg per dose")
    steps += f"; limits on file: {', '.join(limits)}" if limits else "; no maximum on file"
    if r.max_mg_per_kg_dose is not None and mg / r.weight_kg > r.max_mg_per_kg_dose:
        return DoseResult(False, "over the per-kg dose maximum", steps=steps)
    if r.max_single_mg is not None and mg > r.max_single_mg:
        return DoseResult(False, "over the single dose maximum", steps=steps)
    if r.max_daily_mg is not None and daily > r.max_daily_mg:
        return DoseResult(False, "over the daily maximum", steps=steps)
    if exact > MAX_PLAUSIBLE_ML:
        return DoseResult(False, "volume implausible", steps=steps)
    if ml < r.step_ml:
        return DoseResult(False, "too small to measure on this syringe", steps=steps)
    capped = r.max_single_mg is not None and r.max_daily_mg is not None
    return DoseResult(True, mg=_round(mg, 1), ml=_round(ml, 2), steps=steps, capped=capped)
