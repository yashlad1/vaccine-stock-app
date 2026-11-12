# dose-agent

A prototype that helps a clinic assistant work out a child's weight-based medicine dose and
drafts the message to the parent, for the assistant to approve. **Synthetic children only, local
Qwen via Ollama, nothing is ever sent.** The formulary values are illustrative, not clinical.

## Run
```
cd agent && uv sync
uv run dose-agent-synthetic                     # builds out/clinic.db and out/extra.json
uv run dose-agent "paracetamol for Aarav Sharma"
```
Needs Ollama on `localhost:11434` with `qwen3.5:9b` (main) and `qwen3.5:4b` (helper).
`DOSE_AGENT_OUT=<dir>` moves the data and the outbox out of `out/`. Other backends are written but
never run: `DOSE_AGENT_BACKEND=free` (Gemini main + NVIDIA Nemotron helper, keys from
`GOOGLE_API_KEY` / `NVIDIA_API_KEY`) and `claude` (Sonnet 5.5 / Haiku 5.5). Every hosted backend
refuses a database whose `settings.synthetic` is not `1`.

## Tests are black-box
`uv run pytest` (about 12 min: it drives the real CLI on local Qwen, each test in its own
`DOSE_AGENT_OUT`) and `uv run pytest tests/test_interface.py` (under a second: the documented
functions). Expected values come from the spec and an independent dose oracle (`tests/oracle.py`),
and only what code guarantees is asserted, never the model's wording.

## How it works
```
triage -> dose_request: one dose_pair per medicine (Send) -> report
dose_pair (a fixed code workflow, `workflow/dose_pair.py`):
           child -> dose -> history pick -> draft <-> check (up to 3 rounds) -> code template
           (code)   (code)  (helper model)   (main model)   (code)
```
- A request that names its own amount ("give 5 ml") goes to the doctor before any model runs.
- A medicine refused before drafting (no or several children, no weight today, allergy, age, a maximum, an
  unknown or ambiguous product) costs zero model calls beyond reading the request: 1 helper call plus 1 to 3
  draft calls otherwise.
- The model never writes a dose. Code reads **today's** weigh-in, computes the dose, and fills `{DOSE}` in
  the accepted draft. The five `@tool` functions in `workflow/tools.py` stay as the documented interface;
  the workflow calls the same code directly instead of letting a model choose the order.
- Every accepted message (model-written or template) ends with that medicine's safety-net sentence from the
  formulary, appended by code once and after the dose sentence. The sentence holds no digits.
- Every run appends one line to `out/audit.jsonl` (beside `outbox.jsonl`, append-only): at, request, label,
  reason, backend, models and, per medicine in `medicines`: medicine, child, patient_id, status, why, steps,
  draft_source, rounds, model_calls, approved (true/false, null when nothing was offered). A run that ends in
  an error still appends a line, with an `error` field.
- A recorded allergy (a structured one, or a note saying "allerg...") stops a medicine when it names the
  medicine's generic, any of its brands, its drug class, or another medicine of that class (a penicillin
  allergy stops amoxicillin; one brand stops every product of that generic). No dose, no draft, "ask the
  doctor", the allergy quoted and the link named. Cross-class reactions are out of scope.
- Each formulary entry can carry a minimum age (months), a maximum mg/kg per dose, a maximum single mg and a
  maximum daily mg. A child under the minimum age, or a dose over any maximum, is refused ("ask the doctor")
  with the working shown; an entry with no maximum says "no maximum on file". The working also names the
  rule's source and version and the date of the weigh-in used.
- **HealthLink (local only).** `DOSE_AGENT_HEALTHLINK=<dir holding drugs.json>` and
  `DOSE_AGENT_HEALTHLINK_REVIEW=<review .xlsx>` load the clinic's own directory instead of the illustrative
  file. It is the clinic's data: read from its path each run, never copied, committed or logged by the
  code, and only the ollama backend runs with it. Names, brands and generics of every entry serve lookup and
  allergy matching, but an entry computes a dose only if the doctor marked it `Correct?` yes in the workbook
  AND it validates (by formula, `mg/kg/day` present and not the placeholder 1, a strength that reads as a
  concentration, 1 to 6 doses a day). A reviewed row with a recorded `Correction` is "ask the doctor: a
  correction is recorded, not yet applied"; anything else is "ask the doctor: not yet reviewed".
  `DOSE_AGENT_HEALTHLINK=... uv run python scripts/healthlink_check.py` prints counts only, never a row.
- Medicines are named by generic or brand. A generic with several products (two syrup strengths) is listed
  and left to the doctor.
- `search_history` is the RAG step: the helper model picks records, code drops ids it never offered.
- `check_draft` allows digits only as counts or intervals ("4 times a day"), `{DOSE}` exactly once
  and no unit after it. A draft is accepted only for the one child the name matches, and the dose
  always comes from that child and the requested medicine, never from the model's arguments.

## Layout
```
src/dose_agent/
  cli.py audit.py              dose-agent; the append-only audit log
  knowledge/ illustrative.json classes.py formulary.py allergy.py healthlink.py   drug knowledge, no patient data
  dosing/   dose.py message.py   pure: the dose math (port of clinic-queue), the number rule for drafts
  records/  db.py age.py synthetic.py   patient data, read-only (synthetic builds the DB from ../docs/schema.sql)
  llm/      models.py triage.py  chat model per tier, triage
  workflow/ team.py tools.py     the graphs and the @tool functions
```
Everything is under `agent/`; the app is untouched.
