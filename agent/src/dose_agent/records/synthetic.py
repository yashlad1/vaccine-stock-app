"""Builds out/clinic.db (from ../docs/schema.sql) and out/extra.json: SYNTHETIC children only.
The repo is public; nothing here is, or is derived from, a real patient.
The formulary values are illustrative, not clinical guidance."""
import json
import os
import sqlite3
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from ..knowledge import formulary

ROOT = Path(__file__).resolve().parents[3]  # agent/
SCHEMA = ROOT.parent / "docs" / "schema.sql"
OUT = ROOT / "out"
NS = uuid.UUID("00000000-0000-4000-8000-00000000d05e")
IST = 330

# name, dob, sex, weigh-ins [(days ago, kg)], allergies, visits [(days ago, note)], vaccines [(vaccine, days ago)]
CHILDREN = [
    ("Aarav Sharma", "2024-03-10", "M", [(0, 12.4), (90, 11.2)], [], [(90, "Cough and cold, settled in 4 days")],
     [("Pentavac", 600), ("Rotavac", 600)]),
    ("Aarav Mehta", "2023-08-02", "M", [(0, 13.1)], [], [(30, "Fever, viral")], [("MR", 400)]),
    ("Diya Patel", "2022-05-19", "F", [(20, 14.8)], [], [(20, "Earache, amoxicillin course")], [("Varilrix", 300)]),
    ("Kabir Singh", "2021-11-23", "M", [(0, 16.0)],
     [("ibuprofen", "Rash and wheeze after ibuprofen, parent reported")], [(200, "Wheeze after ibuprofen")], [("Havrix", 100)]),
    ("Meera Nair", "2025-06-30", "F", [(0, 7.9)], [], [], [("Pentavac", 120)]),
    # added for v4: a CLASS allergy, a BRAND allergy, a note-only class allergy, a child too young for ibuprofen (dob: days old)
    ("Rohan Das", "2022-02-14", "M", [(0, 15.2)], [("penicillin", "Rash after a penicillin injection, parent reported")], [], []),
    ("Ishaan Gupta", "2023-01-09", "M", [(0, 11.6)], [("Ibunorm", "Hives after Ibunorm syrup, parent reported")], [], []),
    ("Zoya Khan", "2022-09-03", "F", [(0, 14.0)], [], [(60, "Penicillin allergy noted by the parent")], []),
    ("Tara Rao", 90, "F", [(0, 5.4)], [], [], []),
]
VACCINES = [("Pentavac", "VIAL", 1), ("Rotavac", "DOSE", 1), ("MR", "VIAL", 10), ("Varilrix", "DOSE", 1), ("Havrix", "DOSE", 1)]


def out_dir() -> Path:
    """DOSE_AGENT_OUT when set, else agent/out."""
    return Path(os.environ["DOSE_AGENT_OUT"]) if os.environ.get("DOSE_AGENT_OUT") else OUT


def _id(*parts: str) -> str:
    return str(uuid.uuid5(NS, "/".join(parts)))


def _ms(d: date, hour: int = 10) -> int:
    return int(datetime(d.year, d.month, d.day, hour, tzinfo=timezone.utc).timestamp() * 1000)


def build(out: Path | None = None, today: date | None = None) -> tuple[Path, Path]:
    out = out or out_dir()
    today = today or date.today()
    out.mkdir(parents=True, exist_ok=True)
    db_path, extra_path = out / "clinic.db", out / "extra.json"
    db_path.unlink(missing_ok=True)
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA.read_text())
    now = _ms(today)
    dev = "synthetic-device"
    db.execute("INSERT INTO settings(key,value,updated_at) VALUES ('synthetic','1',?),('device_id',?,?)", (now, dev, now))
    vid = {}
    for name, mode, per in VACCINES:
        vid[name] = _id("vaccine", name)
        db.execute(
            "INSERT INTO vaccines(id,name,unit_mode,doses_per_vial,created_at,updated_at,device_id) VALUES (?,?,?,?,?,?,?)",
            (vid[name], name, mode, per, now, now, dev))

    def movement(key, vaccine, mtype, delta, d, patient=None, label=None):
        db.execute(
            """INSERT INTO stock_movements(id,idempotency_key,vaccine_id,delta_doses,movement_type,patient_id,patient_label,
               occurred_at,local_date,local_time,tz_offset_minutes,recorded_at,created_at,updated_at,device_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (_id("mv", key), _id("idem", key), vid[vaccine], delta, mtype, patient, label,
             _ms(d), d.isoformat(), "10:00", IST, _ms(d), _ms(d), _ms(d), dev))

    for v, _, _ in VACCINES:  # stock in first so nothing is negative
        movement(f"receipt-{v}", v, "RECEIPT", 100, today - timedelta(days=700))
    extra = {"today": today.isoformat(), "formulary": formulary.legacy_view(formulary.illustrative()),
             "formulary_note": "ILLUSTRATIVE values and invented brand names, not clinical guidance",
             "weights": [], "allergies": [], "visits": []}
    for n, (name, dob, sex, weights, allergies, visits, vaccs) in enumerate(CHILDREN, 1):  # n: fake phone digit
        pid = _id("patient", name)
        db.execute("INSERT INTO patients(id,name,dob,sex,guardian_phone,created_at,updated_at,device_id) VALUES (?,?,?,?,?,?,?,?)",
                   (pid, name, dob if isinstance(dob, str) else (today - timedelta(days=dob)).isoformat(), sex, f"+91 90000 0000{n}", now, now, dev))
        for i, (vaccine, ago) in enumerate(vaccs):
            movement(f"{name}-{vaccine}-{i}", vaccine, "ADMINISTRATION", -1, today - timedelta(days=ago), pid, name)
        for ago, kg in weights:
            extra["weights"].append({"id": _id("w", name, str(ago)), "patient_id": pid, "date": (today - timedelta(days=ago)).isoformat(), "kg": kg})
        for drug, note in allergies:
            extra["allergies"].append({"id": _id("a", name, drug), "patient_id": pid, "drug": drug, "note": note})
        for ago, note in visits:
            extra["visits"].append({"id": _id("vis", name, str(ago)), "patient_id": pid, "date": (today - timedelta(days=ago)).isoformat(), "note": note})
    db.commit()
    db.close()
    extra_path.write_text(json.dumps(extra, indent=2))
    return db_path, extra_path


def main() -> None:
    db, extra = build()
    print(f"wrote {db} and {extra}")
