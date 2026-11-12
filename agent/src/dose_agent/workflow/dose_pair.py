"""One medicine for one child, as a fixed workflow of code steps (no model decides what happens next):

  child -> dose -> history pick -> draft <-> check -> template
  (code)   (code)   (helper model)  (main model, up to 3 rounds)  (code, if every round failed)

Any refusal before the history step (no child, several children, no weight today, allergy, age, a maximum, an
unknown or ambiguous product, an unreviewed HealthLink entry) ends here with ZERO model calls. The model only
reads records (helper) and words a message around the placeholder {DOSE}; code reads the child, the weight and the
dose, fills {DOSE}, checks every number, and appends the formulary's safety-net sentence."""
from langchain.messages import AIMessage, HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from ..dosing.message import check_draft
from ..llm import models
from ..records import db as records
from .tools import dose_for, format_dose, search_history_for

MAX_ROUNDS = 3

DRAFT_SYSTEM = """You write a short, plain, kind message from a paediatric clinic to a child's parent about ONE medicine.
Write the exact text {DOSE} where the amount goes: code replaces it with the amount WITH its unit (for example
"3.75 ml"), so never write a unit after it, and write {DOSE} exactly once.
The message may contain only: a greeting, the child's first name, the medicine, {DOSE}, how often (given below),
and the cautions given below. A caution is only about THIS medicine. Never mention vaccines, other medicines, dates,
weights or ages, and give no monitoring or other medical advice. Never write a dose, a weight or an amount yourself.
Do not add a closing line of advice: the clinic adds its own."""


class DraftMessage(BaseModel):
    message: str = Field(description="the message to the parent, with {DOSE} exactly once where the amount goes")


def _result(job: dict, status: str, why: str = "", *, patient_id: str = "", draft: str = "", rounds: int = 0,
            source: str = "", doses=(), steps: str = "", calls: int = 0) -> dict:
    return {"medicine": job["medicine"], "child_name": job["child_name"], "status": status, "why": why,
            "patient_id": patient_id, "draft": draft, "rounds": rounds, "draft_source": source,
            "doses": list(doses), "steps": steps, "model_calls": calls, "answer": ""}


def run(db, extra: dict, job: dict, main_model, pick=None, check=check_draft) -> dict:
    """job = {child_name, medicine}. -> one result record (status accepted | needs_person)."""
    with models.count_calls() as calls:
        medicine = job["medicine"]
        found = records.find_children(db, job["child_name"])
        if len(found) != 1:  # never picks one: the matches are listed and a person decides
            why = (f"no child matches '{job['child_name']}'" if not found else
                   f"{len(found)} children match '{job['child_name']}': {', '.join(c['name'] for c in found)}; "
                   "a person must confirm which")
            return _result(job, "needs_person", why)
        child = found[0]
        outcome = dose_for(db, extra, child["id"], medicine)
        shown = [format_dose(outcome)]
        if not outcome.ok:
            return _result(job, "needs_person", outcome.why, patient_id=child["id"], doses=shown, steps=outcome.steps)

        history = search_history_for(db, extra, child["id"], medicine, pick)  # helper model: 1 call
        facts = (f"Child's first name: {child['name'].split()[0]}\nMedicine: {medicine}\n"
                 f"How often: {outcome.product.doses_per_day} times a day\n"
                 f"Cautions: {'; '.join(history['cautions']) or 'none'}")
        msgs = [SystemMessage(content=DRAFT_SYSTEM), HumanMessage(content=facts)]
        ml = f"{outcome.result.ml:g} ml"
        safety = outcome.product.safety_net
        why = ""
        for rounds in range(1, MAX_ROUNDS + 1):
            try:
                text = models.invoke_structured(main_model, DraftMessage, msgs).message
            except models.StructuredOutputError:
                why = "the model returned no usable message"
                continue
            ok, why = check(text)
            if ok:
                return _finish(job, child["id"], text, ml, safety, rounds, "model", shown, outcome.steps, calls[0])
            msgs += [AIMessage(content=text), HumanMessage(content=f"The check sent your draft back. Reason: {why}")]
        template = (f"Hello, this is the clinic. {child['name'].split()[0]}'s {medicine} dose is {{DOSE}}, "
                    f"{outcome.product.doses_per_day} times a day.")
        if check(template)[0]:  # every round failed: code writes the message
            return _finish(job, child["id"], template, ml, safety, MAX_ROUNDS, "template", shown, outcome.steps, calls[0])
        return _result(job, "needs_person", why, patient_id=child["id"], rounds=MAX_ROUNDS, doses=shown,
                       steps=outcome.steps, calls=calls[0])


def _finish(job, patient_id, text, ml, safety, rounds, source, shown, steps, calls) -> dict:
    body = text.replace(safety, "").replace("{DOSE}", ml).rstrip()  # the safety net is the clinic's sentence, once
    return _result(job, "accepted", patient_id=patient_id, draft=f"{body} {safety}", rounds=rounds, source=source,
                   doses=shown, steps=steps, calls=calls)
