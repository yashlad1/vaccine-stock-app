"""Port of Vialbook src/domain/time.ts formatAge / ageInMonths."""
import re
from datetime import date

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _parts(dob: str | None, on: str) -> tuple[int, int] | None:
    if not dob or not _ISO.match(dob) or not _ISO.match(on):
        return None
    try:
        d1, d2 = date.fromisoformat(dob), date.fromisoformat(on)
    except ValueError:
        return None
    days = (d2 - d1).days
    if days < 0:
        return None  # born after the date: a typo, not an age
    months = (d2.year - d1.year) * 12 + (d2.month - d1.month) - (1 if d2.day < d1.day else 0)
    return days, months


def age_in_months(dob: str | None, on: str) -> int | None:
    p = _parts(dob, on)
    return p[1] if p else None


def format_age(dob: str | None, on: str) -> str | None:
    p = _parts(dob, on)
    if not p:
        return None
    days, months = p
    if months < 6:
        return f"{days // 7} w"
    if months < 24:
        return f"{months} m"
    years = months // 12
    return f"{years} y {months % 12} m" if months % 12 else f"{years} y"
