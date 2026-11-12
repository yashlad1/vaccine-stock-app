"""The clinic's own HealthLink medicines directory, LOCAL ONLY. It is the clinic's data and this repo is public:
nothing here writes a row anywhere (no copy, no cache, no log), and the directory is read from its own path each run.

  DOSE_AGENT_HEALTHLINK=<dir>               holds drugs.json
  DOSE_AGENT_HEALTHLINK_REVIEW=<file.xlsx>  the doctor's review ('Medicines' sheet; header row starts with 'Rank';
                                            columns 'Medicine name', 'Correct?', 'Correction')

An entry computes a dose only if the doctor marked it Correct? (yes) AND it validates. A recorded Correction is NOT
applied automatically: such a row is 'ask the doctor'. Every other entry is lookup-only (names, brands, allergies)."""
import json
import os
import re
from datetime import date
from pathlib import Path

from ..dosing.dose import mg_per_ml
from . import classes
from .formulary import Formulary, Product, key_of

YES = {"yes", "y", "ok", "correct", "true", "1"}
SAFETY_NET = "If your child seems worse, or you are worried, please call the clinic."
NOT_REVIEWED = "not yet reviewed"
CORRECTION = "a correction is recorded for this medicine but not yet applied"


def _num(v) -> float | None:
    try:
        return float(str(v).strip())
    except ValueError:
        return None


def strength_text(e: dict) -> str:
    return f"{str(e.get('strength', '')).strip()} {str(e.get('strength_unit', '')).strip()}".strip()


def validate(e: dict) -> str:
    """Why this entry cannot compute a dose by itself, or '' when it can."""
    if str(e.get("dose_calculation", "")).strip() != "1":
        return "its dose is a fixed amount, not by weight"
    kg = _num(e.get("mg_per_kg_day"))
    if kg is None or kg <= 0:
        return "no mg/kg/day recorded"
    if kg == 1:
        return "mg/kg/day is the unfilled default"
    if mg_per_ml(strength_text(e)) is None:
        return "its strength gives no concentration"
    f = _num(e.get("frequency"))
    if f is None or f != int(f) or not 1 <= f <= 6:
        return "doses a day is not 1 to 6"
    return ""


def read_review(path: str | None) -> list[tuple[str, bool, bool]]:
    """(medicine name, marked yes, has a correction) per row of the review sheet, in sheet order. [] without a workbook."""
    if not path:
        return []
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    rows = list(wb["Medicines"].iter_rows(values_only=True))
    head = next(i for i, r in enumerate(rows) if r and r[0] == "Rank")
    col = {str(h).strip(): i for i, h in enumerate(rows[head]) if h}
    out = []
    for r in rows[head + 1:]:
        name = r[col["Medicine name"]]
        if not name:
            continue
        mark = str(r[col["Correct?"]] or "").strip().lower()
        out.append((str(name), mark in YES, bool(str(r[col["Correction"]] or "").strip())))
    return out


def entries() -> list[tuple[dict, str, str]]:
    """Every directory entry, most prescribed first, as (entry, validation reason or '', review state), where the review
    state is 'reviewed', 'correction' (marked yes but a correction is recorded) or 'unreviewed'."""
    d = Path(os.environ["DOSE_AGENT_HEALTHLINK"])
    drugs = sorted(json.loads((d / "drugs.json").read_text()), key=lambda e: -int(e.get("usage_count") or 0))
    seen: dict[str, int] = {}
    rows: dict[tuple[str, int], tuple[bool, bool]] = {}
    for name, yes, corr in read_review(os.environ.get("DOSE_AGENT_HEALTHLINK_REVIEW")):
        k = key_of(name)
        rows[(k, seen.get(k, 0))] = (yes, corr)
        seen[k] = seen.get(k, 0) + 1
    out, used = [], {}
    for e in drugs:
        k = key_of(str(e.get("drug", "")))
        i = used.get(k, 0)
        used[k] = i + 1
        yes, corr = rows.get((k, i), (False, False))
        state = "unreviewed" if not yes else "correction" if corr else "reviewed"
        out.append((e, validate(e), state))
    return out


def load() -> Formulary:
    version = f"drugs.json {date.fromtimestamp((Path(os.environ['DOSE_AGENT_HEALTHLINK']) / 'drugs.json').stat().st_mtime)}"
    ps = []
    for e, bad, state in entries():
        generic, cls = classes.primary(e.get("generic_name"))
        unusable = NOT_REVIEWED if state == "unreviewed" else CORRECTION if state == "correction" else bad
        freq = _num(e.get("frequency"))
        ps.append(Product(
            key=f"healthlink:{e.get('id')}", generic=generic, cls=cls, brands=(str(e.get("drug", "")).strip(),),
            strength=strength_text(e) or None, mg_per_kg_day=_num(e.get("mg_per_kg_day")),
            doses_per_day=int(freq) if freq and freq == int(freq) else None, min_age_months=None,
            max_mg_per_kg_dose=None, max_single_mg=None, max_daily_mg=None,
            source="HealthLink directory (" + {"reviewed": "reviewed by the doctor", "unreviewed": "not reviewed",
                                               "correction": "reviewed, correction not yet applied"}[state] + ")",
            version=version, safety_net=SAFETY_NET, unusable=unusable))
    return Formulary(ps, "healthlink")
