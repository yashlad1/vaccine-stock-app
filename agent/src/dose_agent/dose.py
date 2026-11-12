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
            f" -> {_round(exact, 2):g} ml, rounded up to the next quarter spoon, {_round(ml, 2):g} ml"
            if ml > 0
            else f" -> {_round(exact, 2):g} ml, too small to measure"
        )
    )
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


_ALLOWED_COUNT = re.compile(r"\b\d+\s*(?:times|x|hours|hrs|hourly|days|weeks)\b", re.I)
MAX_DRAFT_CHARS = 600
_UNIT_AFTER_DOSE = re.compile(r"\{DOSE\}\s*(ml|mls|millilitres?|milliliters?|mg|tsp|teaspoons?|spoons?|drops?|cc)\b", re.I)


def check_draft(draft: str) -> tuple[bool, str]:
    """(ok, reason). Numbers are an allowlist: the only digits a draft may hold are a count of times or a
    time interval ('4 times a day', 'every 6 hours', 'for 5 days'). The amount is only ever {DOSE}."""
    if draft.count("{DOSE}") != 1:
        return False, f"write {{DOSE}} exactly once, where the amount goes (found {draft.count('{DOSE}')})"
    u = _UNIT_AFTER_DOSE.search(draft)
    if u:
        return False, f"{{DOSE}} already includes the unit; remove '{u.group(1)}' after it"
    rest = draft.replace("{DOSE}", "")
    if "{" in rest or "}" in rest:
        return False, "remove every other { or }: {DOSE} is the only placeholder, and nothing fills any other"
    rest = _ALLOWED_COUNT.sub("", rest)
    m = re.search(r"\d[\d.,]*\s*[A-Za-z]*", rest)
    if m:
        return False, (f"write the amount only as {{DOSE}}; remove '{m.group().strip()}'. Digits are allowed only "
                       "as a count of times or hours, such as '4 times a day' or 'every 6 hours'")
    if len(draft) > MAX_DRAFT_CHARS:
        return False, f"shorten the message to at most {MAX_DRAFT_CHARS} characters (it is {len(draft)})"
    return True, ""
