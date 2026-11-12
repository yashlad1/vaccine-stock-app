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
dose_pair: agent <-> tools (find_child, get_dose_rule, search_history, calculate_dose, submit_draft)
           -> check (code) -> accepted | back to the agent, 3 rounds, then a code template
```
- A request that names its own amount ("give 5 ml") goes to the doctor before any model runs.
- The model never writes a dose. `calculate_dose` takes ids, not numbers, reads **today's**
  weigh-in itself, and code fills `{DOSE}` in the accepted draft.
- A note saying the child is allergic to the medicine stops it: no dose, no draft, "ask the doctor".
- `search_history` is the RAG step: the helper model picks records, code drops ids it never offered.
- `check_draft` allows digits only as counts or intervals ("4 times a day"), `{DOSE}` exactly once
  and no unit after it. A draft is accepted only for the one child the name matches, and the dose
  always comes from that child and the requested medicine, never from the model's arguments.

## Layout
```
src/dose_agent/
  cli.py                       dose-agent
  dosing/   dose.py message.py   pure: the dose math (port of clinic-queue), the number rule for drafts
  records/  db.py age.py synthetic.py   patient data, read-only (synthetic builds the DB from ../docs/schema.sql)
  llm/      models.py triage.py  chat model per tier, triage
  workflow/ team.py tools.py     the graphs and the @tool functions
```
Everything is under `agent/`; the app is untouched.
