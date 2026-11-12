"""audit.jsonl: one line per run, appended beside the outbox, never rewritten. It records what happened (request, triage,
per medicine the status, reason, working, who wrote the draft, rounds, model calls, whether it was approved), including
runs that ended in an error. It lives under the data folder (agent/out/, never committed)."""
import json
from datetime import datetime, timezone


def record(request: str, info: dict, rep: dict | None = None, approvals: dict | None = None, error: str | None = None) -> dict:
    """approvals: medicine -> True/False for each message that was offered; a medicine not offered is null."""
    approvals = approvals or {}
    rec = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "request": request,
           "label": rep["label"] if rep else "", "reason": rep["reasoning"] if rep else "", **info,
           "medicines": [{"medicine": r["medicine"], "child": r["child_name"], "patient_id": r["patient_id"],
                          "status": r["status"], "why": r["why"], "steps": r.get("steps", ""),
                          "draft_source": r.get("draft_source", ""), "rounds": r["rounds"],
                          "model_calls": r.get("model_calls", 0), "approved": approvals.get(r["medicine"])}
                         for r in (rep["results"] if rep else [])]}
    if error is not None:
        rec["error"] = error
    return rec


def append(path, rec: dict) -> None:
    with open(path, "a") as f:
        f.write(json.dumps(rec) + "\n")
