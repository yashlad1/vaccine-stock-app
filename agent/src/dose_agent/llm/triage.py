"""One structured-output call on the assistant's request: route it, like bugteam's triage.
Triage routes; it does not diagnose, and it never sees records."""
import re
from typing import Literal

from langchain.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from . import models


class Triage(BaseModel):
    """The triage decision for one request."""
    reasoning: str = Field(description="why this label, in at most 40 words")
    label: Literal["dose_request", "not_a_dose_request", "needs_doctor"] = Field(
        description="dose_request: asks for the dose of one or more formulary medicines for a named child. "
                    "not_a_dose_request: anything else (stock, appointments, a question). "
                    "needs_doctor: asks the assistant to decide something only the doctor decides: choosing a "
                    "medicine, changing a dose, or a medicine not in the formulary.")
    child_name: str = Field(description="the child's name as written, or an empty string")
    medicines: list[str] = Field(description="for dose_request: the formulary medicines asked for, lowercase, as asked (generic or brand name)")


PROMPT = """You route one request from a paediatric clinic assistant. You decide only which kind of request it is;
you do not give medical advice. The formulary holds: {formulary}.

Rules:
- A request that names a formulary medicine and a child is a dose_request. The doctor has already chosen the
  medicine; the assistant is only asking for the dose and the message. Do not label it needs_doctor.
- needs_doctor only when the request leaves the choice open ("which antibiotic?"), asks to change a dose, or
  names a medicine that is not in the formulary.
- not_a_dose_request for stock, appointments, vaccines, or questions.

{request_note}"""


_AMOUNT = re.compile(r"\b\d+(?:\.\d+)?\s*(?:ml|mls|millilitres?|milliliters?|mg|mcg|g|tsp|teaspoons?|spoons?|drops?|cc)\b", re.I)


def stated_amount(request: str) -> str | None:
    """The first 'number + dose unit' in the request ('5 ml'), or None. Counts like '4 times' never match."""
    m = _AMOUNT.search(request)
    return m.group() if m else None


def triage(request: str, formulary: str, model=None) -> Triage:
    model = model or models.chat_model("main")
    system = PROMPT.format(formulary=formulary, request_note="Read the request below and label it.")
    try:
        return models.invoke_structured(model, Triage, [SystemMessage(content=system), HumanMessage(content=request)])
    except models.StructuredOutputError:
        raise RuntimeError("could not read the request; try again") from None  # fail closed: nothing guessed
