"""The @tool functions the dose agent calls, bound to one database per run by make_tools().
calculate_dose takes ids, never a number: code reads today's weigh-in itself (rule 1 and 2)."""
import json
from dataclasses import dataclass

from langchain.tools import tool
from langchain.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from ..knowledge import allergy, formulary
from ..llm import models
from ..records import db as records
from ..records.age import age_in_months, format_age
from ..dosing.dose import DoseResult, DoseRule, compute_dose, mg_per_ml

PICK_SYSTEM = ("You help a paediatric clinic assistant. You are given one child's records, each with an id, and one "
               "medicine. Pick the ids of the records that matter for giving THIS medicine to THIS child (allergies, "
               "past reactions, earlier use, recent illness, recent weights). Use only the ids shown. Also list short "
               "cautions, each drawn only from the records and only about THIS medicine (for example an allergy or reaction "
               "to it); no cautions about vaccines, other medicines, dates, weights or ages.")


class Pick(BaseModel):
    relevant_ids: list[str] = Field(description="ids of the records that matter, only ids that were shown")
    cautions: list[str] = Field(description="short cautions drawn only from the records")


@dataclass
class DoseOutcome:
    ok: bool
    why: str = ""
    result: DoseResult | None = None
    steps: str = ""  # the working shown to the assistant and kept in the outbox: arithmetic, limits, source, weigh-in date
    product: formulary.Product | None = None


def dose_for(db, extra: dict, patient_id: str, medicine: str) -> DoseOutcome:
    """The one place a dose is decided. Allergy stop first (name, brand, class), then which product, then
    today's weight, then the arithmetic."""
    fm = formulary.get()
    term = medicine.strip().lower()
    products = fm.find(term)
    allergies = [(r["text"], r["date"]) for r in records.child_records(db, extra, patient_id)
                 if "allerg" in r["text"].lower()]
    hit = allergy.stops(allergies, products or [fm.stub(term)], fm)
    if hit:
        text, date, why = hit
        return DoseOutcome(False, f"ask the doctor: note says '{text}'" + (f" ({date})" if date else "")
                           + f"; matches: {why}")
    if not products:
        return DoseOutcome(False, "ask the doctor: not in the formulary")
    if len(products) > 1:
        return DoseOutcome(False, f"ask the doctor: {term} has {len(products)} products, and the product is the doctor's "
                           "choice: " + "; ".join(p.label for p in products[:6]) + (" and more" if len(products) > 6 else ""))
    f = products[0]
    if f.unusable:
        return DoseOutcome(False, f"ask the doctor: {f.label}: {f.unusable} ({f.source}, {f.version})", product=f)
    d = compute_dose(DoseRule(
        weight_kg=records.todays_weight(extra, patient_id), mg_per_kg_day=f.mg_per_kg_day,
        doses_per_day=f.doses_per_day, mg_per_ml=mg_per_ml(f.strength),
        max_single_mg=f.max_single_mg, max_daily_mg=f.max_daily_mg, max_mg_per_kg_dose=f.max_mg_per_kg_dose))
    if d.why == "no weight":
        return DoseOutcome(False, "no weight", d, product=f)
    steps = f"{d.steps}; rule from {f.source}, {f.version}; weighed on {extra['today']}" if d.steps else ""
    if f.min_age_months is not None:
        months = age_in_months(records.patient_dob(db, patient_id), extra["today"])
        if months is None or months < f.min_age_months:
            how = "no date of birth on file" if months is None else f"the child is {format_age(records.patient_dob(db, patient_id), extra['today'])} old"
            return DoseOutcome(False, f"ask the doctor: {how}, and the minimum age for {f.label} is {f.min_age_months} months",
                               d, steps, f)
    if not d.ok:
        return DoseOutcome(False, f"ask the doctor: {d.why}", d, steps, f)
    return DoseOutcome(True, "", d, steps, f)


def _model_pick(medicine: str, recs: list) -> dict:
    lines = "\n".join(f"{r['id']} | {r['kind']} | {r['date']} | {r['text']}" for r in recs)
    out = models.invoke_structured(
        models.chat_model("helper"), Pick,
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
        ps = formulary.get().find(medicine)
        return json.dumps([{"brands": p.brands, "strength": p.strength, "mg_per_kg_day": p.mg_per_kg_day,
                            "doses_per_day": p.doses_per_day} for p in ps]) if ps else f"'{medicine}' is not in the formulary."

    @tool
    def search_history(patient_id: str, medicine: str) -> str:
        """Search the child's records for what matters when giving this medicine. Returns record ids, dates and text,
        and cautions."""
        recs = records.child_records(db, extra, patient_id)
        try:
            out = pick(medicine, recs)
        except models.StructuredOutputError:
            return "history search failed; no records selected"
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
        working = f"\nWorking: {o.steps}" if o.steps else ""
        if not o.ok:
            return f"REFUSED: {o.why}{working}"
        return f"OK: {o.result.mg:g} mg = {o.result.ml:g} ml per dose.{working}"

    @tool
    def submit_draft(patient_id: str, medicine: str, message: str) -> str:
        """Hand in the draft message to the parent. Write the exact text {DOSE} where the amount goes: code replaces it
        with the amount with its unit (e.g. "3.75 ml"), so write no unit after it. The message may contain only a
        greeting, the medicine, {DOSE}, how often (from the formulary) and cautions from search_history. A caution
        is only about THIS medicine (e.g. an allergy or reaction to it); never mention vaccines, other medicines, dates,
        weights or ages; no monitoring or other medical advice. Call this once the dose is calculated."""
        return "Draft received."

    return [find_child, get_dose_rule, search_history, calculate_dose, submit_draft]
