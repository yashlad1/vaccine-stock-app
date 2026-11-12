import sqlite3
import pytest
from datetime import date
from dose_agent import records, synthetic

TODAY = date(2026, 11, 11)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    out = tmp_path_factory.mktemp("out")
    db, extra = synthetic.build(out, TODAY)
    return db, records.open_ro(db), records.load_extra(extra)


def test_counts(built):
    db_path, db, extra = built
    n = lambda t: db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
    assert n("patients") == 5 and n("vaccines") == 5
    assert n("stock_movements") == 5 + 6  # 5 receipts + 6 doses
    assert db.execute("SELECT COUNT(*) FROM v_movement_effective WHERE movement_type='ADMINISTRATION'").fetchone()[0] == 6
    assert len(extra["weights"]) == 6 and len(extra["allergies"]) == 1
    assert records.is_synthetic(db)
    assert db.execute("PRAGMA user_version").fetchone()[0] == 6


def test_find_children(built):
    _, db, _ = built
    assert len(records.find_children(db, "aarav")) == 2
    assert [c["name"] for c in records.find_children(db, "Aarav Sharma")] == ["Aarav Sharma"]
    assert records.find_children(db, "nobody") == []


def test_weight_only_today(built):
    _, db, extra = built
    kid = lambda n: records.find_children(db, n)[0]["id"]
    assert records.todays_weight(extra, kid("Aarav Sharma")) == 12.4
    assert records.todays_weight(extra, kid("Diya")) is None  # weighed 20 days ago


def test_child_records(built):
    _, db, extra = built
    kabir = records.find_children(db, "Kabir")[0]["id"]
    kinds = sorted(r["kind"] for r in records.child_records(db, extra, kabir))
    assert kinds == ["allergy", "vaccine", "visit", "weight"]


def test_update_refused_by_trigger(built):
    db_path, _, _ = built
    rw = sqlite3.connect(db_path)
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        rw.execute("UPDATE stock_movements SET delta_doses = -5")
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        rw.execute("DELETE FROM stock_movements")
    rw.close()


def test_read_only_connection_cannot_write(built):
    _, db, _ = built
    with pytest.raises(sqlite3.OperationalError):
        db.execute("INSERT INTO settings(key,value,updated_at) VALUES ('x','y',0)")
