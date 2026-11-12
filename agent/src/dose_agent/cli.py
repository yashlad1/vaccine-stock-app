"""Request -> graphs -> show -> approve y/N -> out/outbox.jsonl. Nothing is ever sent."""
import json
import sys
from datetime import date

from . import models, records, synthetic
from .team import build_graph


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
            print(f"Draft:\n{r['draft']}")
        elif r["answer"]:
            print(f"Agent said: {r['answer']}")


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    request = " ".join(argv) or input("Request: ")
    extra_path = synthetic.OUT / "extra.json"
    if not extra_path.exists() or records.load_extra(extra_path)["today"] != date.today().isoformat():
        synthetic.build()  # the simulated clinic day is today
    db, extra = records.open_ro(synthetic.OUT / "clinic.db"), records.load_extra(extra_path)
    models.require_synthetic(records.is_synthetic(db))
    rep = build_graph(db, extra, models.chat_model("main"))(request)
    render(rep)
    for r in rep["results"]:
        if r["status"] == "accepted" and input(f"\nApprove the {r['medicine']} message? (nothing is sent) [y/N] ").strip().lower() == "y":
            with open(synthetic.OUT / "outbox.jsonl", "a") as f:
                f.write(json.dumps({"child": r["child_name"], "medicine": r["medicine"], "message": r["draft"]}) + "\n")
            print("Saved to out/outbox.jsonl (not sent).")
