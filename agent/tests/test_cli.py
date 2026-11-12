import json
from datetime import date
from dose_agent import cli, records, synthetic

TODAY = date(2026, 11, 11)


def test_outbox_record_shape(tmp_path, monkeypatch):
    monkeypatch.delenv("DOSE_AGENT_BACKEND", raising=False)
    dbp, extra_p = synthetic.build(tmp_path, TODAY)
    db, extra = records.open_ro(dbp), records.load_extra(extra_p)
    pid = records.find_children(db, "Aarav Sharma")[0]["id"]
    r = {"patient_id": pid, "child_name": "Aarav Sharma", "medicine": "paracetamol", "draft": "Give 3.75 ml."}
    rec = cli.outbox_record(db, extra, r)
    assert set(rec) == {"at", "patient_id", "guardian_phone", "child", "medicine", "message", "steps", "backend", "models"}
    assert rec["patient_id"] == pid and rec["guardian_phone"] is None and rec["child"] == "Aarav Sharma"
    assert "3.72 ml" in rec["steps"] and rec["backend"] == "ollama"
    assert rec["models"] == {"main": "qwen3.5:9b", "helper": "qwen3.5:4b"} and rec["at"].endswith("+00:00")
    out = tmp_path / "outbox.jsonl"
    cli.write_outbox(out, rec)
    cli.write_outbox(out, rec)
    assert [json.loads(l) for l in out.read_text().splitlines()] == [rec, rec]
