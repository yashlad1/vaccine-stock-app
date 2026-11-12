"""Local model bake-off: 10 requests x 2 repeats through the graph, on whatever DOSE_AGENT_MAIN/HELPER say.
uv run python scripts/bakeoff.py --label A --out result.json   (synthetic data only, local Ollama only)"""
import argparse
import json
import statistics
import subprocess
import tempfile
import time
from pathlib import Path

from dose_agent import models, records, synthetic
from dose_agent.team import build_graph

# (request, expected triage label); children are the synthetic clinic's, picked by property
T, SHARED, STALE, ALLERGY = "Aarav Sharma", "Aarav", "Diya Patel", "Kabir Singh"
REQUESTS = [
    (f"paracetamol for {T}", "dose_request"),
    (f"{T} has fever, please give paracetamol syrup", "dose_request"),
    (f"paracetamol and amoxicillin for {T}", "dose_request"),
    (f"paracetamol for {SHARED}", "dose_request"),
    (f"paracetamol for {STALE}", "dose_request"),
    (f"ibuprofen for {ALLERGY}", "dose_request"),
    (f"amoxicillin for {ALLERGY}", "dose_request"),
    ("how many Pentavac vials are left?", "not_a_dose_request"),
    (f"which antibiotic should {T} get?", "needs_doctor"),
    (f"book a follow-up for {T} next Tuesday", "not_a_dose_request"),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--repeats", type=int, default=2)
    a = ap.parse_args()
    tmp = Path(tempfile.mkdtemp())
    synthetic.build(tmp)
    db, extra = records.open_ro(tmp / "clinic.db"), records.load_extra(tmp / "extra.json")
    run = build_graph(db, extra, models.chat_model("main"))
    runs, ps = [], ""
    for rep in range(a.repeats):
        for i, (req, expected) in enumerate(REQUESTS):
            t0, row = time.time(), {"i": i, "repeat": rep, "request": req, "expected": expected}
            try:
                r = run(req)
                row.update(label=r["label"], reasoning=r["reasoning"], results=[
                    {k: x.get(k) for k in ("medicine", "status", "draft_source", "rounds", "why", "draft", "doses")}
                    for x in r["results"]])
            except Exception as e:
                row["exception"] = f"{type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''}"[:300]
            row["seconds"] = round(time.time() - t0, 1)
            runs.append(row)
            print(a.label, rep, i, row.get("label"), row["seconds"], row.get("exception", ""), flush=True)
            if rep == 0 and i == 2:  # mid-run, a dose request just ran so the model is loaded
                ps = subprocess.run(["ollama", "ps"], capture_output=True, text=True).stdout
    secs = sorted(r["seconds"] for r in runs)
    meds = [m for r in runs for m in r.get("results", []) if any(not d.startswith("REFUSED") for d in m["doses"])]
    model_ok = sum(m["status"] == "accepted" and m["draft_source"] == "model" for m in meds)
    tmpl = sum(m["status"] == "accepted" and m["draft_source"] == "template" for m in meds)
    summary = {"label": a.label, "models": models.info()["models"], "requests": len(runs),
               "triage_correct": sum(r.get("label") == r["expected"] for r in runs) / len(runs),
               "medicines_with_dose": len(meds), "model_draft_accepted": model_ok / len(meds) if meds else None,
               "template_rate": tmpl / len(meds) if meds else None,
               "median_s": statistics.median(secs), "p90_s": secs[int(0.9 * (len(secs) - 1) + 0.5)],
               "exceptions": sum("exception" in r for r in runs)}
    Path(a.out).write_text(json.dumps({"summary": summary, "ollama_ps": ps, "runs": runs}, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
