# dose-agent

A prototype that helps a clinic assistant work out a child's weight-based medicine dose and
drafts the message to the parent, for the assistant to approve. **Synthetic children only, local
Qwen via Ollama, nothing is ever sent.** The formulary values are illustrative, not clinical.

## Run
```
cd agent && uv sync
uv run pytest
uv run dose-agent-synthetic                     # builds out/clinic.db and out/extra.json
uv run dose-agent "paracetamol for Aarav Sharma"
```
Needs Ollama on `localhost:11434` with `qwen3.5:9b` (main) and `qwen3.5:4b` (helper).
`DOSE_AGENT_BACKEND=claude` switches to Sonnet 5.5 / Haiku 5.5 (written, never run; it refuses a
database whose `settings.synthetic` is not `1`).

## How it works
```
triage -> dose_request: one dose_pair per medicine (Send) -> report
dose_pair: agent <-> tools (find_child, get_dose_rule, search_history, calculate_dose, submit_draft)
           -> check (code) -> accepted | back to the agent, 3 rounds, then "needs a person"
```
- The model never writes a dose. `calculate_dose` takes ids, not numbers, reads **today's**
  weigh-in itself, and code fills `{DOSE}` in the accepted draft.
- A note saying the child is allergic to the medicine stops it: no dose, no draft, "ask the doctor".
- `search_history` is the RAG step: the helper model picks records, code drops ids it never offered.
- `check_draft` in `dose.py` is a fail-closed stub until it is written, so a draft is never accepted
  yet: every run that reaches `submit_draft` ends "needs a person".

## Layout
`dose.py` dose math (port of clinic-queue) | `age.py` | `records.py` read-only queries |
`synthetic.py` builds the DB from `../docs/schema.sql` | `models.py` | `tools.py` | `triage.py` |
`team.py` the graphs | `cli.py`. Everything is under `agent/`; the app is untouched.
