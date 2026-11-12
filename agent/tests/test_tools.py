import json
from datetime import date
import pytest
from dose_agent import records, synthetic
from dose_agent.tools import dose_for, make_tools

TODAY = date(2026, 11, 11)


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    db, extra = synthetic.build(tmp_path_factory.mktemp("o"), TODAY)
    d, e = records.open_ro(db), records.load_extra(extra)
    kid = lambda n: records.find_children(d, n)[0]["id"]
    return d, e, kid


def tools(env, pick=lambda m, r: {"relevant_ids": [], "cautions": []}):
    d, e, _ = env
    return {t.name: t for t in make_tools(d, e, pick)}


def test_five_tools_with_expected_names(env):
    assert list(tools(env)) == ["find_child", "get_dose_rule", "search_history", "calculate_dose", "submit_draft"]


def test_find_child(env):
    t = tools(env)
    assert len(json.loads(t["find_child"].invoke({"name": "Aarav"}))) == 2  # the agent must stop
    (c,) = json.loads(t["find_child"].invoke({"name": "Aarav Sharma"}))
    assert c["age"] == "2 y 8 m" and c["sex"] == "M"
    assert "No child" in t["find_child"].invoke({"name": "zed"})


def test_get_dose_rule(env):
    t = tools(env)
    assert json.loads(t["get_dose_rule"].invoke({"medicine": "Paracetamol"}))["doses_per_day"] == 4
    assert "not in the formulary" in t["get_dose_rule"].invoke({"medicine": "x"})


def test_search_history_drops_invented_ids(env):
    d, e, kid = env
    recs = records.child_records(d, e, kid("Aarav Sharma"))
    pick = lambda m, r: {"relevant_ids": [recs[0]["id"], "invented-id", "another"], "cautions": ["c1"]}
    out = tools(env, pick)["search_history"].invoke({"patient_id": kid("Aarav Sharma"), "medicine": "paracetamol"})
    assert "1 records (2 dropped" in out and recs[0]["id"] in out and "invented-id" not in out and "c1" in out


def test_calculate_dose_weighed_today(env):
    _, _, kid = env
    out = tools(env)["calculate_dose"].invoke({"patient_id": kid("Aarav Sharma"), "medicine": "paracetamol"})
    assert out.startswith("OK: 186 mg = 3.75 ml") and "3.72 ml" in out


def test_calculate_dose_no_weight_today(env):
    _, _, kid = env
    out = tools(env)["calculate_dose"].invoke({"patient_id": kid("Diya"), "medicine": "paracetamol"})
    assert out.startswith("REFUSED: no weight")


def test_allergy_stops_even_though_weighed_today(env):
    d, e, kid = env
    o = dose_for(d, e, kid("Kabir"), "ibuprofen")
    assert not o.ok and o.why.startswith("ask the doctor") and "ibuprofen" in o.why
    assert dose_for(d, e, kid("Kabir"), "paracetamol").ok  # only the named medicine stops


def test_unknown_medicine_and_no_number_params(env):
    d, e, kid = env
    assert dose_for(d, e, kid("Meera"), "unobtainium").why == "ask the doctor: not in the formulary"
    assert set(tools(env)["calculate_dose"].args) == {"patient_id", "medicine"}
