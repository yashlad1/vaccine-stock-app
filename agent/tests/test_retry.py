import json
from datetime import date
import pytest
from langchain_core.exceptions import OutputParserException
from langchain_core.runnables import RunnableLambda
from pydantic import BaseModel
from dose_agent import models, records, synthetic, triage
from dose_agent.tools import make_tools


class Out(BaseModel):
    x: str


class Flaky:
    """A chat model whose structured output fails `fails` times, then returns Out(x='ok')."""
    def __init__(self, fails):
        self.fails, self.calls = fails, 0

    def with_structured_output(self, schema, **kw):
        def go(_):
            self.calls += 1
            if self.calls <= self.fails:
                raise OutputParserException("invalid json")
            return schema(x="ok") if schema is Out else schema.model_validate(self.good)
        return RunnableLambda(go)


def test_fails_twice_then_succeeds():
    m = Flaky(2)
    assert models.invoke_structured(m, Out, []) == Out(x="ok") and m.calls == 3


def test_always_fails_raises_after_three_attempts():
    m = Flaky(99)
    with pytest.raises(models.StructuredOutputError):
        models.invoke_structured(m, Out, [])
    assert m.calls == 3


def test_validation_error_is_retried_too():
    n = []
    class V:
        def with_structured_output(self, schema, **kw):
            def go(_):
                n.append(1)
                return Out.model_validate({"x": 1}) if len(n) < 2 else Out(x="ok")  # int is not a str
            return RunnableLambda(go)
    assert models.invoke_structured(V(), Out, []).x == "ok" and len(n) == 2


def test_triage_retries_then_fails_closed():
    good = {"reasoning": "r", "label": "dose_request", "child_name": "A", "medicines": ["paracetamol"]}
    m = Flaky(2); m.good = good
    assert triage.triage("req", ["paracetamol"], m).label == "dose_request"
    with pytest.raises(RuntimeError, match="could not read the request; try again"):
        triage.triage("req", ["paracetamol"], Flaky(99))


def test_search_history_fails_closed_but_allergy_stop_still_applies(tmp_path):
    db, extra = synthetic.build(tmp_path, date(2026, 11, 11))
    d, e = records.open_ro(db), records.load_extra(extra)
    def pick(medicine, recs):
        raise models.StructuredOutputError("x")
    t = {x.name: x for x in make_tools(d, e, pick)}
    kabir = records.find_children(d, "Kabir")[0]["id"]
    assert t["search_history"].invoke({"patient_id": kabir, "medicine": "ibuprofen"}) == "history search failed; no records selected"
    assert t["calculate_dose"].invoke({"patient_id": kabir, "medicine": "ibuprofen"}).startswith("REFUSED: ask the doctor")
