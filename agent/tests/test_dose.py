from dose_agent.dose import DoseRule, compute_dose, mg_per_ml, round_ml


def rule(**kw):
    base = dict(weight_kg=12.4, mg_per_kg_day=60, doses_per_day=4, mg_per_ml=50.0)
    return DoseRule(**{**base, **kw})


def test_worked_example():
    # 12.4 x 60 = 744 mg/day / 4 = 186 mg; 186 / 50 = 3.72 ml -> 3.75 ml
    r = compute_dose(rule())
    assert r.ok and r.mg == 186.0 and r.ml == 3.75
    assert "3.72 ml" in r.steps and "3.75 ml" in r.steps


def test_round_ml_steps():
    assert round_ml(3.72) == 3.75
    assert round_ml(5.0) == 5.0
    assert round_ml(0.4) == 0.0  # floors to zero under a tenth of a spoon


def test_strength_parser():
    assert mg_per_ml("250 mg / 5 ml") == 50
    assert mg_per_ml("125 mg/5 ml") == 25
    assert mg_per_ml("1 g / 10 ml") == 100
    assert mg_per_ml("50 mcg / ml") is None  # never read as mg
    assert mg_per_ml("Co-amoxiclav 125/31.25 mg / 5 ml") is None
    assert mg_per_ml("125 mg + 31.25 mg / 5 ml") is None
    assert mg_per_ml(None) is None and mg_per_ml("") is None and mg_per_ml("syrup") is None


def test_refusals():
    assert compute_dose(rule(mg_per_ml=None)).why == "no strength"
    assert compute_dose(rule(weight_kg=None)).why == "no weight"
    assert compute_dose(rule(weight_kg=0)).why == "no weight"
    assert compute_dose(rule(mg_per_kg_day=0)).why == "no rule"
    assert compute_dose(rule(doses_per_day=None)).why == "no frequency"
    r = compute_dose(rule(max_single_mg=150))
    assert not r.ok and r.why == "over the single dose maximum" and r.steps
    assert compute_dose(rule(max_daily_mg=700)).why == "over the daily maximum"
    assert compute_dose(rule(weight_kg=40, doses_per_day=1)).why == "volume implausible"  # 48 ml
    assert compute_dose(rule(weight_kg=3, mg_per_kg_day=10, mg_per_ml=100.0)).why == "too small to measure on this syringe"


def test_capped_flag():
    assert compute_dose(rule(max_single_mg=500, max_daily_mg=2000)).capped
    assert not compute_dose(rule()).capped
