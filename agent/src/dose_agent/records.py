"""Read-only queries over a Vialbook clinic.db plus extra.json. Never writes."""
import json
import sqlite3
from pathlib import Path


def open_ro(db_path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, check_same_thread=False)  # read-only; ToolNode and Send use threads
    db.row_factory = sqlite3.Row
    return db


def load_extra(path: Path) -> dict:
    return json.loads(Path(path).read_text())


def is_synthetic(db: sqlite3.Connection) -> bool:
    r = db.execute("SELECT value FROM settings WHERE key='synthetic'").fetchone()
    return bool(r and r["value"] == "1")


def find_children(db: sqlite3.Connection, name: str) -> list[dict]:
    """Case-insensitive: every word typed must start a word of the child's name."""
    words = name.lower().split()
    out = []
    for r in db.execute("SELECT id,name,dob,sex FROM patients WHERE deleted_at IS NULL ORDER BY name"):
        parts = r["name"].lower().split()
        if words and all(any(p.startswith(w) for p in parts) for w in words):
            out.append(dict(r))
    return out


def todays_weight(extra: dict, patient_id: str, today: str | None = None) -> float | None:
    """Only a weigh-in dated today counts (clinic-queue's rule)."""
    today = today or extra["today"]
    ws = [w["kg"] for w in extra["weights"] if w["patient_id"] == patient_id and w["date"] == today]
    return ws[-1] if ws else None


def child_records(db: sqlite3.Connection, extra: dict, patient_id: str) -> list[dict]:
    """Everything on file for the child, each with a stable id the helper may pick."""
    recs = []
    for r in db.execute(
        "SELECT m.id, m.local_date, v.name AS vaccine FROM v_movement_effective m JOIN vaccines v ON v.id=m.vaccine_id "
        "WHERE m.patient_id=? AND m.movement_type='ADMINISTRATION'", (patient_id,)):
        recs.append({"id": r["id"], "kind": "vaccine", "date": r["local_date"], "text": f"{r['vaccine']} given"})
    for k, key, fmt in (("weight", "weights", lambda x: f"{x['kg']} kg"),
                        ("allergy", "allergies", lambda x: f"allergy to {x['drug']}: {x['note']}"),
                        ("visit", "visits", lambda x: x["note"])):
        for x in extra[key]:
            if x["patient_id"] == patient_id:
                recs.append({"id": x["id"], "kind": k, "date": x.get("date", ""), "text": fmt(x)})
    return sorted(recs, key=lambda r: (r["date"], r["id"]))


def guardian_phone(db: sqlite3.Connection, patient_id: str) -> str | None:
    r = db.execute("SELECT guardian_phone FROM patients WHERE id=?", (patient_id,)).fetchone()
    return r["guardian_phone"] if r else None
