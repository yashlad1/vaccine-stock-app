"""Request -> graphs -> show -> approve y/N -> out/outbox.jsonl. Nothing is ever sent.
Every run, even a failed one, appends one line to out/audit.jsonl."""
import os
import sys
from datetime import date, datetime, timezone

import httpx

from . import audit
from .llm import models
from .records import db as records, synthetic
from .workflow.team import build_graph


def render(rep: dict) -> None:
    print(f"Triage: {rep['label']} ({rep['reasoning']})")
    if rep["label"] == "not_a_dose_request":
        print("This is not a dose request, so nothing was drafted.")
    elif rep["label"] == "needs_doctor":
        print("Ask the doctor: this needs a decision only the doctor makes. Nothing was drafted.")
    for r in rep["results"]:
        print(f"\n== {r['medicine']} for {r['child_name']}: {r['status'].upper().replace('_', ' ')}"
              + (f" ({r['why']})" if r["why"] else ""))
        for d in r["doses"]:
            print(f"Dose: {d}")
        if r["draft"]:
            label = ("Draft (template: the model's drafts failed the number check)"
                     if r.get("draft_source") == "template" else "Draft")
            print(f"{label}:\n{r['draft']}")
        elif r["answer"]:
            print(f"Agent said: {r['answer']}")


def outbox_record(db, r: dict) -> dict:
    return {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "patient_id": r["patient_id"],
            "guardian_phone": records.guardian_phone(db, r["patient_id"]), "child": r["child_name"],
            "medicine": r["medicine"], "message": r["draft"], "steps": r["steps"], **models.info()}  # steps: the working shown


def write_outbox(path, record: dict) -> None:
    audit.append(path, record)  # same append-only JSON line


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    try:
        request = " ".join(argv) or input("Request: ")
    except EOFError:
        request = ""
    out = synthetic.out_dir()
    out.mkdir(parents=True, exist_ok=True)

    def fail(msg: str):
        try:
            info = models.info()
        except ValueError:
            info = {"backend": "", "models": {}}
        audit.append(out / "audit.jsonl", audit.record(request, info, error=msg))
        sys.exit(msg)

    if not request.strip():
        fail("error: empty request")
    extra_path = out / "extra.json"
    if not extra_path.exists() or records.load_extra(extra_path)["today"] != date.today().isoformat():
        synthetic.build()  # the simulated clinic day is today
    db, extra = records.open_ro(out / "clinic.db"), records.load_extra(extra_path)
    try:
        models.require_synthetic(records.is_synthetic(db))
        models.require_local_for_healthlink()
    except SystemExit as e:
        fail(str(e.code))
    try:
        rep = build_graph(db, extra, models.chat_model("main"))(request)
    except RuntimeError as e:  # triage could not read the request
        fail(str(e))
    except (httpx.ConnectError, ConnectionError):
        host = os.environ.get("OLLAMA_HOST", "localhost:11434")
        fail(f"error: cannot reach the local model at {host}; is Ollama running? (ollama serve)")
    except Exception as e:  # anything else from the model call: one line, no traceback
        fail(f"error: {type(e).__name__}: {str(e).splitlines()[0] if str(e) else 'model call failed'}"[:300])
    render(rep)
    approvals: dict = {}
    try:
        for r in rep["results"]:
            if r["status"] != "accepted":
                continue
            try:
                answer = input(f"\nApprove the {r['medicine']} message? (nothing is sent) [y/N] ")
            except EOFError:
                answer = ""
            approvals[r["medicine"]] = answer.strip().lower() == "y"
            if approvals[r["medicine"]]:
                write_outbox(out / "outbox.jsonl", outbox_record(db, r))
                print(f"Saved to {'out' if out == synthetic.OUT else out}/outbox.jsonl (not sent).")
    finally:
        audit.append(out / "audit.jsonl", audit.record(request, models.info(), rep, approvals))
