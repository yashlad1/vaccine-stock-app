"""The graphs, shaped like DADA3 bugteam.

team:       START -> triage --dose_request: Send per medicine--> dose_pair ... -> report -> END
                       (not_a_dose_request, needs_doctor: triage -> report)
dose_pair:  START -> agent <-> tools (ToolNode)   the ReAct loop, ended by submit_draft
                       |
                       +-- after submit_draft runs --> check (code)
                              ok -> END (accepted) | fails, rounds < 3 -> agent, with the reason | rounds = 3 -> END
A step cap (GraphRecursionError) also ends in "needs a person". Nothing is sent.
The accepted draft is taken by code from the submit_draft call that passed the check, and code fills {DOSE}.
"""
import operator
from typing import Annotated, TypedDict

from langchain.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.errors import GraphRecursionError
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition
from langgraph.types import Send

from ..knowledge import formulary
from ..llm import triage as triage_mod
from ..records import db as records
from ..dosing.message import check_draft
from .tools import dose_for, make_tools

MAX_ROUNDS = 3
STEP_CAP = 30

AGENT_PROMPT = """You help a paediatric clinic assistant prepare a message to a child's parent about ONE medicine.
Work in this order, calling the tools:
1. find_child with the child's name. If it returns no child or more than one, STOP: do not guess, say which names matched.
2. get_dose_rule for the medicine, then search_history for this child and medicine.
3. calculate_dose with the child's id and the medicine. If it REFUSES, STOP: do not draft, say why in your answer.
4. submit_draft with a short, plain, kind message to the parent. Write the exact text {DOSE} where the amount goes:
   code replaces it with the amount WITH its unit (for example "3.75 ml"), so never write a unit after it.
   The message may contain only: a greeting, the medicine, {DOSE}, how often (from the formulary), and cautions taken
   from search_history. A caution is only about THIS medicine (for example an allergy or a reaction to it). Never
   mention vaccines, other medicines, dates, weights or ages, and give no monitoring or other medical advice.
   Never write a dose, a weight or an amount yourself.
If submit_draft is sent back, read the reason and submit a corrected draft."""


class Team(TypedDict):
    request: str
    label: str
    reasoning: str
    child_name: str
    medicines: list
    results: Annotated[list, operator.add]  # one record per medicine, from the Sends
    report: dict


class PairState(MessagesState):
    medicine: str
    child_name: str
    patient_id: str  # set only once code has verified it is the one named child
    fatal: bool      # a failure redrafting cannot fix
    rounds: int
    accepted: str  # the draft that passed the check, with the dose filled in by code
    why: str       # the last check failure
    source: str    # "model" or "template": who wrote the accepted draft


def _tail_tool_names(messages) -> list[str]:
    out = []
    for m in reversed(messages):
        if not isinstance(m, ToolMessage):
            break
        out.append(m.name)
    return out


def build_graph(db, extra: dict, main_model, triage_fn=None, check=check_draft, pick=None, step_cap=STEP_CAP):
    tools = make_tools(db, extra, pick)
    fm = formulary.get()
    triage_fn = triage_fn or (lambda req: triage_mod.triage(req, fm.names_for_prompt(), main_model))
    model_with_tools = main_model.bind_tools(tools)

    # dose_pair --------------------------------------------------------------------------
    def agent(state: PairState) -> dict:
        return {"messages": [model_with_tools.invoke([SystemMessage(content=AGENT_PROMPT)] + state["messages"])]}

    def after_tools(state: PairState) -> str:
        return "check" if "submit_draft" in _tail_tool_names(state["messages"]) else "agent"

    def check_node(state: PairState) -> dict:
        call = next(c for m in reversed(state["messages"]) if isinstance(m, AIMessage)
                    for c in m.tool_calls if c["name"] == "submit_draft")
        a, rounds = call["args"], state["rounds"] + 1
        found = records.find_children(db, state["child_name"])
        if len(found) != 1 or a.get("patient_id") != found[0]["id"]:
            who = "no child" if not found else f"{len(found)} children" if len(found) > 1 else "a different child"
            return {"rounds": rounds, "fatal": True,
                    "why": f"{who} matches '{state['child_name']}' or the draft is for another child; a person must confirm which"}
        dose = dose_for(db, extra, found[0]["id"], state["medicine"])  # never the agent's arguments
        message = a.get("message", "")
        if not dose.ok:
            ok, why = False, f"there is no dose for this child and medicine ({dose.why}); do not draft"
        elif a.get("medicine", "").strip().lower() != state["medicine"]:
            ok, why = False, f"the draft is for {a.get('medicine')!r}, not {state['medicine']!r}"
        elif "{DOSE}" not in message:
            ok, why = False, "the message must contain the exact text {DOSE} where the amount goes"
        else:
            ok, why = check(message)
        if ok:
            return {"rounds": rounds, "patient_id": found[0]["id"], "accepted": message.replace("{DOSE}", f"{dose.result.ml:g} ml"),
                    "source": "model", "why": ""}
        if rounds >= MAX_ROUNDS and dose.ok:  # the model's drafts keep failing: code writes the message
            n = fm.find(state["medicine"])[0].doses_per_day
            template = f"Hello, this is the clinic. {found[0]['name'].split()[0]}'s {state['medicine']} dose is {{DOSE}}, {n} times a day."
            if check(template)[0]:
                return {"rounds": rounds, "patient_id": found[0]["id"], "accepted": template.replace("{DOSE}", f"{dose.result.ml:g} ml"),
                        "source": "template", "why": ""}
        note = HumanMessage(content=f"The check sent your draft back. Reason: {why}")
        return {"rounds": rounds, "why": why, "messages": [note] if rounds < MAX_ROUNDS else []}

    def after_check(state: PairState) -> str:
        return END if state["accepted"] or state["fatal"] or state["rounds"] >= MAX_ROUNDS else "agent"

    pg = StateGraph(PairState)
    pg.add_node("agent", agent)
    pg.add_node("tools", ToolNode(tools))
    pg.add_node("check", check_node)
    pg.add_edge(START, "agent")
    pg.add_conditional_edges("agent", tools_condition)
    pg.add_conditional_edges("tools", after_tools, ["agent", "check"])
    pg.add_conditional_edges("check", after_check, ["agent", END])
    pair = pg.compile()

    def dose_pair(job: dict) -> dict:
        """One medicine. Its input is the Send's payload, not the team's state."""
        base = {"medicine": job["medicine"], "child_name": job["child_name"]}
        request = f"Child: {job['child_name']}\nMedicine: {job['medicine']}"
        try:
            out = pair.invoke({"messages": [HumanMessage(content=request)], "rounds": 0, "accepted": "", "why": "",
                               "medicine": job["medicine"], "child_name": job["child_name"], "patient_id": "", "fatal": False}, {"recursion_limit": step_cap})
        except GraphRecursionError:
            return {"results": [{**base, "status": "needs_person", "draft": "", "why": "ran out of steps",
                                 "doses": [], "answer": "", "rounds": 0, "patient_id": ""}]}
        msgs = out["messages"]
        last = msgs[-1]
        return {"results": [{**base, "status": "accepted" if out["accepted"] else "needs_person",
                             "patient_id": out["patient_id"], "draft": out["accepted"], "rounds": out["rounds"],
                             "draft_source": out.get("source", "") if out["accepted"] else "",
                             "why": "" if out["accepted"] else (out["why"] or "no draft was submitted"),
                             "doses": [m.content for m in msgs if isinstance(m, ToolMessage) and m.name == "calculate_dose"],
                             "answer": last.content if isinstance(last, AIMessage) else ""}]}

    # team ---------------------------------------------------------------------------------
    def triage_node(state: Team) -> dict:
        amount = triage_mod.stated_amount(state["request"])
        if amount:  # a request that states its own amount is a dose change: the doctor's decision
            return {"label": "needs_doctor", "child_name": "", "medicines": [],
                    "reasoning": f"the request names an amount ('{amount}'); changing a dose is the doctor's decision"}
        t = triage_fn(state["request"])
        meds = list(dict.fromkeys(m.strip().lower() for m in t.medicines if m.strip()))
        label = t.label if t.label != "dose_request" or (meds and t.child_name.strip()) else "needs_doctor"
        return {"label": label, "reasoning": t.reasoning, "child_name": t.child_name.strip(), "medicines": meds}

    def fan_out(state: Team):
        if state["label"] != "dose_request":
            return "report"
        return [Send("dose_pair", {"child_name": state["child_name"], "medicine": m}) for m in state["medicines"]]

    def report(state: Team) -> dict:
        order = {m: i for i, m in enumerate(state["medicines"])}  # Send results arrive in any order
        return {"report": {"label": state["label"], "reasoning": state["reasoning"], "child_name": state["child_name"],
                           "results": sorted(state["results"], key=lambda r: order[r["medicine"]])}}

    tg = StateGraph(Team)
    tg.add_node("triage", triage_node)
    tg.add_node("dose_pair", dose_pair)
    tg.add_node("report", report)
    tg.add_edge(START, "triage")
    tg.add_conditional_edges("triage", fan_out, ["dose_pair", "report"])
    tg.add_edge("dose_pair", "report")
    tg.add_edge("report", END)
    graph = tg.compile()

    def run(request: str) -> dict:
        return graph.invoke({"request": request, "results": [], "medicines": []})["report"]

    return run
