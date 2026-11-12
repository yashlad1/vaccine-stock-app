"""Black-box harness: builds synthetic data in tmp_path and runs the CLI as a subprocess."""
import json
import os
import re
import sqlite3
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import pytest

AGENT_DIR = Path(__file__).resolve().parent.parent
FORBIDDEN_ENV = ("DOSE_AGENT_BACKEND", "DOSE_AGENT_MAIN", "DOSE_AGENT_HELPER")


@dataclass
class Result:
    code: int
    out: str
    outbox: list = field(default_factory=list)

    @property
    def drafts(self):
        """[(medicine, draft_text)] per result section ('== <medicine> for ...'), in order."""
        found = []
        for sec in re.split(r"(?m)^== ", self.out)[1:]:
            m = re.search(r"Draft:\n(.*?)(?:\n\s*\n|\Z)", sec, re.S)
            if m:
                found.append((sec.split()[0], m.group(1).strip()))
        return found

    @property
    def workings(self):
        return re.findall(r"^Working: (.*)$", self.out, re.M)

    @property
    def dose_lines(self):
        return re.findall(r"^Dose: (.*)$", self.out, re.M)


class Clinic:
    def __init__(self, out: Path):
        self.out = out
        env = self._env()
        subprocess.run(["uv", "run", "dose-agent-synthetic"], cwd=AGENT_DIR, env=env,
                       check=True, capture_output=True, text=True, timeout=300)
        self.extra = json.loads((out / "extra.json").read_text())
        con = sqlite3.connect(f"file:{out / 'clinic.db'}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        self.patients = [dict(r) for r in con.execute(
            "SELECT id, name, guardian_phone FROM patients WHERE deleted_at IS NULL")]
        con.close()
        self.today = self.extra["today"]
        self.formulary = self.extra["formulary"]

    def _env(self, extra=None):
        env = {k: v for k, v in os.environ.items() if k not in FORBIDDEN_ENV}
        env["DOSE_AGENT_OUT"] = str(self.out)
        env.update(extra or {})
        return env

    def kg_today(self, pid):
        for w in self.extra["weights"]:
            if w["patient_id"] == pid and w["date"] == self.today:
                return w["kg"]
        return None

    def weighed_dates(self, pid):
        return [w["date"] for w in self.extra["weights"] if w["patient_id"] == pid]

    def run(self, request, stdin="", env=None) -> Result:
        p = subprocess.run(["uv", "run", "dose-agent", request], cwd=AGENT_DIR,
                           env=self._env(env), input=stdin, capture_output=True,
                           text=True, timeout=300)
        out = p.stdout + p.stderr
        assert "Traceback" not in out, out
        return Result(p.returncode, out, self.outbox())

    def outbox(self):
        f = self.out / "outbox.jsonl"
        if not f.exists():
            return []
        return [json.loads(line) for line in f.read_text().splitlines() if line.strip()]


@pytest.fixture
def clinic(tmp_path):
    return Clinic(tmp_path)
