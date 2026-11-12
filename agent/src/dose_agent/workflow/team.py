"""The team graph, shaped like DADA3 bugteam: triage -> one dose_pair per medicine -> report.

  START -> triage --dose_request: Send per medicine--> dose_pair ... -> report -> END
             (not_a_dose_request, needs_doctor: triage -> report)

dose_pair is a code workflow (dose_pair.py), not a model loop: child, dose, history, draft, check, template.
A request that states its own amount is a dose change and goes to the doctor before any model runs.
Nothing is sent."""
import operator
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from ..dosing.message import check_draft
from ..knowledge import formulary
from ..llm import triage as triage_mod
from . import dose_pair


class Team(TypedDict):
    request: str
    label: str
    reasoning: str
    child_name: str
    medicines: list
    results: Annotated[list, operator.add]  # one record per medicine, from the Sends
    report: dict


def build_graph(db, extra: dict, main_model, triage_fn=None, check=check_draft, pick=None):
    fm = formulary.get()
    triage_fn = triage_fn or (lambda req: triage_mod.triage(req, fm.names_for_prompt(), main_model))

    def triage_node(state: Team) -> dict:
        amount = triage_mod.stated_amount(state["request"])
        if amount:  # a request that states its own amount is a dose change: the doctor's decision
            return {"label": "needs_doctor", "child_name": "", "medicines": [],
                    "reasoning": f"the request names an amount ('{amount}'); changing a dose is the doctor's decision"}
        phrase = triage_mod.override_phrase(state["request"])
        if phrase:  # trying to skip a safety rule, or claiming someone approved skipping it: the doctor's decision
            return {"label": "needs_doctor", "child_name": "", "medicines": [],
                    "reasoning": f"the request tries to override a safety rule ('{phrase}'); that is the doctor's decision"}
        t = triage_fn(state["request"])
        meds = list(dict.fromkeys(m.strip().lower() for m in t.medicines if m.strip()))
        label = t.label if t.label != "dose_request" or (meds and t.child_name.strip()) else "needs_doctor"
        return {"label": label, "reasoning": t.reasoning, "child_name": t.child_name.strip(), "medicines": meds}

    def fan_out(state: Team):
        if state["label"] != "dose_request":
            return "report"
        return [Send("dose_pair", {"child_name": state["child_name"], "medicine": m}) for m in state["medicines"]]

    def pair_node(job: dict) -> dict:
        """One medicine. Its input is the Send's payload, not the team's state."""
        return {"results": [dose_pair.run(db, extra, job, main_model, pick, check)]}

    def report(state: Team) -> dict:
        order = {m: i for i, m in enumerate(state["medicines"])}  # Send results arrive in any order
        return {"report": {"label": state["label"], "reasoning": state["reasoning"], "child_name": state["child_name"],
                           "results": sorted(state["results"], key=lambda r: order[r["medicine"]])}}

    tg = StateGraph(Team)
    tg.add_node("triage", triage_node)
    tg.add_node("dose_pair", pair_node)
    tg.add_node("report", report)
    tg.add_edge(START, "triage")
    tg.add_conditional_edges("triage", fan_out, ["dose_pair", "report"])
    tg.add_edge("dose_pair", "report")
    tg.add_edge("report", END)
    graph = tg.compile()

    def run(request: str) -> dict:
        return graph.invoke({"request": request, "results": [], "medicines": []})["report"]

    return run
