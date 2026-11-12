import itertools
from datetime import date
import pytest
from langchain.messages import AIMessage
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from dose_agent import records, synthetic
from dose_agent.team import build_graph
from dose_agent.triage import Triage

TODAY = date(2026, 11, 11)


class FakeModel(GenericFakeChatModel):
    def bind_tools(self, tools, **kw):
        return self


def script(*steps):
    """Each step is a list of (tool, args) calls, or a string for a final answer."""
    n = itertools.count()
    msgs = []
    for s in steps:
        if isinstance(s, str):
            msgs.append(AIMessage(content=s))
        else:
            msgs.append(AIMessage(content="", tool_calls=[{"name": t, "args": a, "id": f"c{next(n)}"} for t, a in s]))
    return FakeModel(messages=iter(msgs))


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    db, extra = synthetic.build(tmp_path_factory.mktemp("o"), TODAY)
    d, e = records.open_ro(db), records.load_extra(extra)
    return d, e, lambda n: records.find_children(d, n)[0]["id"]


def tri(label="dose_request", child="Aarav Sharma", meds=("paracetamol",)):
    return lambda req: Triage(reasoning="r", label=label, child_name=child, medicines=list(meds))


OK = lambda draft: (True, "")
NOPICK = lambda m, r: {"relevant_ids": [], "cautions": []}


def draft(pid, medicine="paracetamol", msg="Give {DOSE} four times a day."):
    return [("submit_draft", {"patient_id": pid, "medicine": medicine, "message": msg})]


def run(env, model, triage_fn=None, check=OK, **kw):
    d, e, _ = env
    return build_graph(d, e, model, triage_fn or tri(), check, NOPICK, **kw)("req")


def test_full_loop_to_accepted_draft(env):
    pid = env[2]("Aarav Sharma")
    m = script([("find_child", {"name": "Aarav Sharma"})], [("get_dose_rule", {"medicine": "paracetamol"})],
               [("search_history", {"patient_id": pid, "medicine": "paracetamol"})],
               [("calculate_dose", {"patient_id": pid, "medicine": "paracetamol"})], draft(pid), "Done.")
    rep = run(env, m)
    (r,) = rep["results"]
    assert r["status"] == "accepted" and r["draft"] == "Give 3.75 ml four times a day." and r["rounds"] == 1
    assert r["doses"][0].startswith("OK: 186 mg = 3.75 ml")


def test_check_fails_then_reason_reaches_the_agent_and_second_draft_passes(env):
    pid = env[2]("Aarav Sharma")
    seen = []
    verdicts = iter([(False, "too long"), (True, "")])
    def chk(d):
        v = next(verdicts); seen.append(d); return v
    m = script(draft(pid, msg="First {DOSE}."), draft(pid, msg="Second {DOSE}."), "Done.")
    (r,) = run(env, m, check=chk)["results"]
    assert r["status"] == "accepted" and r["draft"] == "Second 3.75 ml." and r["rounds"] == 2
    assert seen == ["First {DOSE}.", "Second {DOSE}."]


def test_reason_is_fed_back_as_a_message(env):
    pid = env[2]("Aarav Sharma")
    d, e, _ = env
    model = script(draft(pid), draft(pid), draft(pid))
    inputs = []
    orig = model._generate
    model._generate = lambda msgs, *a, **k: (inputs.append(msgs), orig(msgs, *a, **k))[1]
    run(env, model, check=lambda x: (False, "bad tone"))
    assert any("bad tone" in str(m.content) for m in inputs[1])


def test_three_failures_needs_a_person_and_never_fills_dose(env):
    pid = env[2]("Aarav Sharma")
    (r,) = run(env, script(draft(pid), draft(pid), draft(pid)), check=lambda x: (False, "no"))["results"]
    assert r["status"] == "needs_person" and r["rounds"] == 3 and r["draft"] == "" and r["why"] == "no"


def test_stub_check_draft_fails_closed(env):
    from dose_agent.dose import check_draft
    pid = env[2]("Aarav Sharma")
    (r,) = run(env, script(draft(pid), draft(pid), draft(pid)), check=check_draft)["results"]
    assert r["status"] == "needs_person" and r["why"] == "check_draft not implemented"


def test_step_cap_is_needs_a_person(env):
    loop = [("get_dose_rule", {"medicine": "paracetamol"})]
    (r,) = run(env, script(*[loop] * 40), step_cap=6)["results"]
    assert r["status"] == "needs_person" and r["why"] == "ran out of steps"


def test_draft_without_dose_placeholder_is_sent_back(env):
    pid = env[2]("Aarav Sharma")
    (r,) = run(env, script(draft(pid, msg="Give 5 ml."), draft(pid), "Done."))["results"]
    assert r["status"] == "accepted" and r["rounds"] == 2


def test_refused_dose_cannot_be_submitted(env):
    pid = env[2]("Diya")  # weighed 20 days ago
    m = script([("calculate_dose", {"patient_id": pid, "medicine": "paracetamol"})], "No weight today, ask the doctor.")
    (r,) = run(env, m, tri(child="Diya"))["results"]
    assert r["status"] == "needs_person" and r["draft"] == "" and "REFUSED: no weight" in r["doses"][0]
    pid = env[2]("Kabir")  # allergy: even a submitted draft is rejected by code
    (r,) = run(env, script(draft(pid, "ibuprofen"), draft(pid, "ibuprofen"), draft(pid, "ibuprofen")),
               tri(child="Kabir", meds=["ibuprofen"]))["results"]
    assert r["status"] == "needs_person" and "ask the doctor" in r["why"]


def test_shared_first_name_agent_stops(env):
    m = script([("find_child", {"name": "Aarav"})], "Two children match: Aarav Sharma, Aarav Mehta. Which one?")
    (r,) = run(env, m, tri(child="Aarav"))["results"]
    assert r["status"] == "needs_person" and r["draft"] == "" and "Which one" in r["answer"]


@pytest.mark.parametrize("label", ["not_a_dose_request", "needs_doctor"])
def test_other_labels_route_to_report_without_the_agent(env, label):
    boom = script()  # no messages: any agent call would fail
    rep = run(env, boom, tri(label=label, child="", meds=[]))
    assert rep["label"] == label and rep["results"] == []


def test_dose_request_without_child_or_medicine_becomes_needs_doctor(env):
    assert run(env, script(), tri(child="", meds=["paracetamol"]))["label"] == "needs_doctor"
    assert run(env, script(), tri(meds=[]))["label"] == "needs_doctor"


def test_two_medicines_fan_out_in_request_order(env):
    pid = env[2]("Aarav Sharma")
    # shared fake model across parallel Sends: give every call the same reply via a cycle
    reply = AIMessage(content="", tool_calls=[{"name": "calculate_dose", "args": {"patient_id": pid, "medicine": "x"}, "id": "c"}])
    rep = run(env, FakeModel(messages=itertools.cycle([reply])), tri(meds=["ibuprofen", "paracetamol"]), step_cap=4)
    assert [r["medicine"] for r in rep["results"]] == ["ibuprofen", "paracetamol"]


def test_shared_first_name_submit_anyway_is_never_accepted(env):
    pid = env[2]("Aarav Sharma")  # one of the two Aaravs; nobody confirmed which
    (r,) = run(env, script(draft(pid), draft(pid), draft(pid)), tri(child="Aarav"))["results"]
    assert r["status"] == "needs_person" and r["draft"] == "" and r["patient_id"] == ""
    assert r["rounds"] == 1 and "2 children" in r["why"]  # not fixable by redrafting: no more rounds


def test_unique_child_but_other_childs_id_is_not_accepted(env):
    other = env[2]("Meera")
    (r,) = run(env, script(draft(other), draft(other), draft(other)), tri(child="Aarav Sharma"))["results"]
    assert r["status"] == "needs_person" and r["draft"] == "" and r["rounds"] == 1 and "different child" in r["why"]


def test_accepted_result_carries_verified_patient_id(env):
    pid = env[2]("Aarav Sharma")
    (r,) = run(env, script(draft(pid), "Done."))["results"]
    assert r["status"] == "accepted" and r["patient_id"] == pid
