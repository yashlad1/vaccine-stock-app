"""Independent dose oracle, written from SPEC rule 1 only."""
import math
import re
from decimal import Decimal
from fractions import Fraction


def round_ml_oracle(ml: Fraction) -> Fraction:
    spoons = ml / 5
    tenth = Fraction(math.floor(spoons * 10), 10)       # floor to a tenth of a spoon
    quarter = Fraction(math.ceil(tenth * 4), 4)         # up to the next quarter spoon (stays if already one)
    return quarter * 5


def dose(kg, rule):
    """Return (mg, shown_ml) or None when SPEC rule 1 says refuse."""
    kg = Fraction(str(kg))
    daily = kg * rule["mg_per_kg_day"]
    mg = daily / rule["doses_per_day"]
    m = re.match(r"\s*([\d.]+)\s*mg\s*/\s*([\d.]+)\s*ml", rule["strength"])
    per_ml = Fraction(m.group(1)) / Fraction(m.group(2))
    exact = mg / per_ml
    ml = round_ml_oracle(exact)
    if rule.get("max_single_mg") and mg > rule["max_single_mg"]:
        return None
    if rule.get("max_daily_mg") and daily > rule["max_daily_mg"]:
        return None
    if ml > 20 or exact < Fraction(1, 2):
        return None
    return mg, ml


def num_re(v: Fraction) -> str:
    """Regex matching v as a standalone decimal (trailing zeros optional), not part of a longer number."""
    d = Decimal(v.numerator) / Decimal(v.denominator)
    s = format(d.normalize(), "f")
    ip, _, fp = s.partition(".")
    frac = rf"\.{fp}0*" if fp else r"(?:\.0*)?"
    return rf"(?<![\d.]){ip}{frac}(?!\d)"


def terminates(v: Fraction) -> bool:
    n = v.denominator
    while n % 2 == 0:
        n //= 2
    while n % 5 == 0:
        n //= 5
    return n == 1


def test_oracle_worked_examples():
    assert round_ml_oracle(Fraction("3.72")) == Fraction("3.75")
    assert round_ml_oracle(Fraction("3.76")) == Fraction("3.75")
    assert round_ml_oracle(Fraction("3.75")) == Fraction("3.75")
    rule = {"strength": "250 mg / 5 ml", "mg_per_kg_day": 60, "doses_per_day": 4,
            "max_single_mg": 500, "max_daily_mg": 2000}
    assert dose(12.4, rule) == (Fraction(186), Fraction("3.75"))
    assert dose(40, rule) is None      # over max single
    assert dose(1, rule) is None       # 0.3 ml, too small to measure
