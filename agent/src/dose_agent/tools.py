"""The @tool functions the dose agent calls, bound to one database per run by make_tools().
calculate_dose takes ids, never a number: code reads today's weigh-in itself (rule 1 and 2)."""
import json
from dataclasses import dataclass

from langchain.tools import tool
from langchain.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from . import models, records
from .age import format_age
from .dose import DoseResult, DoseRule, compute_dose, mg_per_ml

PICK_SYSTEM = ("You help a paediatric clinic assistant. You are given one child's records, each with an id, and one "
               "medicine. Pick the ids of the records that matter for giving THIS medicine to THIS child (allergies, "
               "past reactions, earlier use, recent illness, recent weights). Use only the ids shown. Also list short "
               "cautions, each drawn only from the records.")


class Pick(BaseModel):
    relevant_ids: list[str] = Field(description="ids of the records that matter, only ids that were shown")
    cautions: list[str] = Field(description="short cautions drawn only from the records")


@dataclass
class DoseOutcome:
    ok: bool
    why: str = ""
    result: DoseResult | None = None


def dose_for(db, extra: dict, patient_id: str, medicine: str) -> DoseOutcome:
    """The one place a dose is decided. Allergy stop first, then today's weight, then the arithmetic."""
    medicine = medicine.strip().lower()
    for r in records.child_records(db, extra, patient_id):
        t = r["text"].lower()
        if "allerg" in t and medicine in t:
            return DoseOutcome(False, f"ask the doctor: note says '{r['text']}'" + (f" ({r['date']})" if r["date"] else ""))
    f = extra["formulary"].get(medicine)
    if f is None:
        return DoseOutcome(False, "ask the doctor: not in the formulary")
    d = compute_dose(DoseRule(
        weight_kg=records.todays_weight(extra, patient_id), mg_per_kg_day=f["mg_per_kg_day"],
        doses_per_day=f["doses_per_day"], mg_per_ml=mg_per_ml(f["strength"]),
        max_single_mg=f.get("max_single_mg"), max_daily_mg=f.get("max_daily_mg")))
    return DoseOutcome(d.ok, "" if d.ok else (d.why or ""), d)


def _model_pick(medicine: str, recs: list) -> dict:
    lines = "\n".join(f"{r['id']} | {r['kind']} | {r['date']} | {r['text']}" for r in recs)
    out = models.structured(models.chat_model("helper"), Pick).invoke(
        [SystemMessage(content=PICK_SYSTEM), HumanMessage(content=f"Medicine: {medicine}\nRecords:\n{lines}")])
    return out.model_dump()


def make_tools(db, extra: dict, pick=None):
    """pick(medicine, records) -> {relevant_ids, cautions}; the helper model unless a test passes a fake."""
    pick = pick or _model_pick
    today = extra["today"]

    @tool
    def find_child(name: str) -> str:
        """Find a child by name. Returns candidates with id, name, age and sex. If there are 0 or 2 or more, stop and
        say so: you must not pick one."""
        found = records.find_children(db, name)
        return json.dumps([{"id": c["id"], "name": c["name"], "age": format_age(c["dob"], today), "sex": c["sex"]}
                           for c in found]) if found else f"No child matches '{name}'."

    @tool
    def get_dose_rule(medicine: str) -> str:
        """Get the formulary entry (strength, mg/kg/day, doses a day) for a medicine. Values are illustrative."""
        f = extra["formulary"].get(medicine.strip().lower())
        return json.dumps(f) if f else f"'{medicine}' is not in the formulary: {', '.join(extra['formulary'])}."

    @tool
    def search_history(patient_id: str, medicine: str) -> str:
        """Search the child's records for what matters when giving this medicine. Returns record ids, dates and text,
        and cautions."""
        recs = records.child_records(db, extra, patient_id)
        out = pick(medicine, recs)
        offered = {r["id"] for r in recs}
        ids = [i for i in out.get("relevant_ids", []) if i in offered]
        dropped = len(out.get("relevant_ids", [])) - len(ids)
        by_id = {r["id"]: r for r in recs}
        lines = [f"{i} | {by_id[i]['date']} | {by_id[i]['kind']} | {by_id[i]['text']}" for i in ids]
        return (f"{len(ids)} records ({dropped} dropped: ids not in this child's records)\n" + "\n".join(lines)
                + "\nCautions: " + ("; ".join(out.get("cautions", [])) or "none"))

    @tool
    def calculate_dose(patient_id: str, medicine: str) -> str:
        """Calculate the dose for this child and medicine. Takes no weight or numbers: the weight is today's weigh-in,
        read by the program. Returns mg, ml and the working, or a refusal with its reason."""
        o = dose_for(db, extra, patient_id, medicine)
        working = f"\nWorking: {o.result.steps}" if o.result and o.result.steps else ""
        if not o.ok:
            return f"REFUSED: {o.why}{working}"
        return f"OK: {o.result.mg:g} mg = {o.result.ml:g} ml per dose.{working}"

    @tool
    def submit_draft(patient_id: str, medicine: str, message: str) -> str:
        """Hand in the draft message to the parent. Write the exact text {DOSE} where the amount goes: code replaces it
        with the amount with its unit (e.g. "3.75 ml"), so write no unit after it. The message may contain only a
        greeting, the medicine, {DOSE}, how often (from the formulary) and cautions from search_history; no other
        medical advice. Call this once the dose is calculated."""
        return "Draft received."

    return [find_child, get_dose_rule, search_history, calculate_dose, submit_draft]
