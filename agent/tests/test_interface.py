"""Direct black-box calls of the documented public functions (INTERFACE.md docstrings + SPEC.md)."""
import re
from fractions import Fraction

import pytest

from dose_agent.dosing.dose import DoseRule, compute_dose, mg_per_ml, round_ml
from dose_agent.dosing.message import check_draft
from dose_agent.records.db import load_extra, open_ro
from dose_agent.workflow.tools import dose_for, make_tools
from oracle import dose, num_re, round_ml_oracle
from test_blackbox import allergy_child, shared_first_name, stale_child, unique_name_child


def test_mg_per_ml():
    assert mg_per_ml("250 mg / 5 ml") == 50.0
    assert mg_per_ml("100 mg / 5 ml") == 20.0
    for bad in (None, "", "garbage", "100 mcg / 1 ml"):
        assert mg_per_ml(bad) is None


def test_round_ml_examples_and_sweep():
    assert round_ml(3.72) == pytest.approx(3.75)
    assert round_ml(3.76) == pytest.approx(3.75)
    assert round_ml(3.75) == pytest.approx(3.75)
    for i in range(50, 2001):
        ml = Fraction(i, 100)
        assert round_ml(float(ml)) == pytest.approx(float(round_ml_oracle(ml))), ml


RULE = dict(mg_per_kg_day=60, doses_per_day=4, mg_per_ml=50.0, max_single_mg=500, max_daily_mg=2000)


def test_compute_dose_ok_and_refusals():
    r = compute_dose(DoseRule(weight_kg=12.4, **RULE))
    assert r.ok and r.mg == pytest.approx(186) and r.ml == pytest.approx(3.75)
    assert not compute_dose(DoseRule(weight_kg=None, **RULE)).ok
    assert not compute_dose(DoseRule(weight_kg=40, **RULE)).ok          # over max single
    assert not compute_dose(DoseRule(weight_kg=1, **RULE)).ok           # 0.3 ml, unmeasurable
    big = dict(RULE, max_single_mg=None, max_daily_mg=None)
    assert not compute_dose(DoseRule(weight_kg=100, **big)).ok          # 75 mg/ml... 1500 mg = 30 ml > 20
    daily = dict(RULE, max_single_mg=None)
    assert not compute_dose(DoseRule(weight_kg=40, **daily)).ok         # 2400 mg/day > 2000


@pytest.mark.parametrize("draft", [
    "Hello, paracetamol {DOSE}, 4 times a day.",
    "Hello, paracetamol {DOSE}, every 6 hours for 3 days.",
])
def test_check_draft_accepts(draft):
    ok, _ = check_draft(draft)
    assert ok


@pytest.mark.parametrize("draft", [
    "Hello, paracetamol {DOSE}, he weighs 12.4 kg.",
    "Hello, give 186 mg of paracetamol, 4 times a day.",
    "Hello, give 5 ml of paracetamol.",
])
def test_check_draft_rejects_other_numbers(draft):
    ok, reason = check_draft(draft)
    assert not ok and reason


@pytest.fixture
def db_extra(clinic):
    return open_ro(clinic.out / "clinic.db"), load_extra(clinic.out / "extra.json")


def tool(tools, name):
    return next(t for t in tools if t.name == name)


def test_dose_for(clinic, db_extra):
    db, extra = db_extra
    p = unique_name_child(clinic)
    out = dose_for(db, extra, p["id"], "paracetamol")
    exp = dose(clinic.kg_today(p["id"]), clinic.formulary["paracetamol"])
    assert out.ok and out.result.ml == pytest.approx(float(exp[1]))
    assert not dose_for(db, extra, stale_child(clinic)["id"], "paracetamol").ok
    ap, a = allergy_child(clinic)
    r = dose_for(db, extra, ap["id"], a["drug"])
    assert not r.ok and a["note"] in r.why


def test_tools(clinic, db_extra):
    db, extra = db_extra
    tools = make_tools(db, extra, pick=lambda medicine, records: {"relevant_ids": [], "cautions": []})
    find, calc = tool(tools, "find_child"), tool(tools, "calculate_dose")
    p = unique_name_child(clinic)
    assert p["id"] in find.invoke({"name": p["name"]})
    first, full = shared_first_name(clinic)
    shared = find.invoke({"name": first})
    assert all(n in shared for n in full)
    assert not any(x["id"] in find.invoke({"name": "Zzyzx Quillfeather"}) for x in clinic.patients)
    exp = dose(clinic.kg_today(p["id"]), clinic.formulary["paracetamol"])
    assert re.search(rf"{num_re(exp[1])}\s*ml", calc.invoke({"patient_id": p["id"], "medicine": "paracetamol"}))
    stale = calc.invoke({"patient_id": stale_child(clinic)["id"], "medicine": "paracetamol"})
    assert "weight" in stale.lower()
