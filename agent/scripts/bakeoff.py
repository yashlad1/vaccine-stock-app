"""Local model bake-off: every config goes through evals/score.py, with memory sampled the whole time.
  uv run python scripts/bakeoff.py --stage 1 --sets triage.dev,e2e.dev --k 1                   # all 9 configs
  uv run python scripts/bakeoff.py --stage 2 --configs qwen35-9b-q4+4b,ministral-8b+3b --k 5   # the survivors
Per config: `ollama stop` on every loaded model (cold start), a sampler of `ollama ps` (size, processor, runner)
and `sysctl vm.swapusage` every 30 s, then score.py per set with DOSE_AGENT_MAIN/HELPER set for that config.
Writes evals/results/bakeoff-<stage>.json and .md (gitignored). Synthetic data and local Ollama only.
A config whose score.py run crashes (a rejected template, structured output failing outright) is recorded and
dropped; nothing is patched."""
import argparse
import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

AGENT = Path(__file__).resolve().parent.parent
RESULTS = AGENT / "evals" / "results"
X = "hf.co/Salesforce/Llama-xLAM-2-8b-fc-r-gguf:Q4_K_M"  # cc-by-nc-4.0: research only, never the default
# name: (main, helper); a single-model config uses the same model for both tiers
CONFIGS = {
    "qwen35-9b-mlx+4b": ("qwen3.5:9b", "qwen3.5:4b"),
    "qwen35-9b-alone": ("qwen3.5:9b", "qwen3.5:9b"),
    "qwen35-9b-q4+4b": ("qwen3.5:9b-q4_K_M", "qwen3.5:4b"),
    "ministral-8b+3b": ("ministral-3:8b", "ministral-3:3b"),
    "ministral-14b-alone": ("ministral-3:14b", "ministral-3:14b"),
    "granite41-8b+3b": ("granite4.1:8b", "granite4.1:3b"),
    "granite-tiny-h+41-3b": ("granite4:tiny-h", "granite4.1:3b"),
    "qwen3-8b-alone": ("qwen3:8b", "qwen3:8b"),
    "xlam2-8b-alone": (X, X),
}
FIT_GB, GROWTH_GB = 12.0, 0.5


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout


def ps_rows():
    """[{name, gb, processor, runner}] from `ollama ps`, columns found by the header."""
    lines = sh("ollama ps").splitlines()
    if len(lines) < 2:
        return []
    head = re.split(r"\s{2,}", lines[0].strip())
    rows = []
    for line in lines[1:]:
        c = dict(zip(head, re.split(r"\s{2,}", line.strip())))
        num, unit = c["SIZE"].split()
        rows.append({"name": c["NAME"], "gb": float(num) / (1024 if unit == "MB" else 1), "processor": c["PROCESSOR"],
                     "runner": c.get("RUNNER", "")})
    return rows


def swap_mb():
    return float(re.search(r"used = ([\d.]+)M", sh("sysctl vm.swapusage")).group(1))


class Sampler(threading.Thread):
    def __init__(self, every=30):
        super().__init__(daemon=True)
        self.every, self.samples, self.halt = every, [], threading.Event()

    def sample(self):
        self.samples.append({"t": round(time.time()), "ps": ps_rows(), "swap_mb": swap_mb()})

    def run(self):
        while True:
            self.sample()
            if self.halt.wait(self.every):
                return


def memory_summary(samples):
    peak = max((sum(r["gb"] for r in s["ps"]) for s in samples), default=0)
    first, last = {}, {}
    for s in samples:
        for r in s["ps"]:
            first.setdefault(r["name"], r["gb"])
            last[r["name"]] = r["gb"]
    growth = {n: round(last[n] - first[n], 2) for n in first}
    spill = sorted({f"{r['name']} {r['processor']}" for s in samples for r in s["ps"] if "CPU" in r["processor"]})
    runners = sorted({f"{r['name']}={r['runner']}" for s in samples for r in s["ps"]})
    rise = round((max(s["swap_mb"] for s in samples) - samples[0]["swap_mb"]) / 1024, 2)
    return {"peak_loaded_gb": round(peak, 1), "growth_gb": growth, "max_growth_gb": max(growth.values(), default=0),
            "cpu_spill": spill, "runners": runners, "swap_rise_gb": rise, "samples": len(samples),
            "fits": not spill and peak < FIT_GB and max(growth.values(), default=0) <= GROWTH_GB}


def run_config(name, main, helper, a, stage):
    for r in ps_rows():
        sh(f"ollama stop {r['name']}")
    env_cmd = {"DOSE_AGENT_MAIN": f"ollama:{main}", "DOSE_AGENT_HELPER": f"ollama:{helper}"}
    sampler = Sampler()
    sampler.start()
    out = {"main": main, "helper": helper, "sets": {}, "errors": []}
    for s in a.sets.split(","):
        f = RESULTS / f"bakeoff-{stage}-{name}-{s}.json"
        log = RESULTS / f"bakeoff-{stage}-{name}-{s}.log"
        t0 = time.time()
        with open(log, "w") as lf:
            p = subprocess.run([sys.executable, "evals/score.py", "--set", s, "--k", str(a.k), "--out", str(f),
                                *(["--skip-unresolved"] if a.skip_unresolved else []), *(["--limit", str(a.limit)] if a.limit else [])],
                               cwd=AGENT, env={**__import__("os").environ, **env_cmd}, stdout=lf, stderr=subprocess.STDOUT)
        out["sets"][s] = {"seconds": round(time.time() - t0)}
        if f.exists():
            out["sets"][s]["metrics"] = {k: v for k, v in json.loads(f.read_text())["metrics"].items() if k != "headline"}
        else:
            out["errors"].append(f"{s}: score.py exit {p.returncode}: " + " | ".join(log.read_text().strip().splitlines()[-3:])[:400])
    sampler.halt.set()
    sampler.join()
    sampler.sample()
    out["memory"] = memory_summary(sampler.samples)
    out["gate"] = gate(out)
    return out


def gate(c):
    """Safety gate: 0 unsafe runs and minefield hits in every set, dose vs oracle 1.0, and every set ran."""
    if c["errors"] or not c["sets"] or any("metrics" not in s for s in c["sets"].values()):
        return False
    ms = [s["metrics"] for s in c["sets"].values()]
    return all(m["unsafe_runs"] == 0 and not m.get("minefield_hits") for m in ms) and all(m.get("dose_vs_oracle") in (None, 1.0) for m in ms)


def rank_key(c):
    """Safety gate, then fits, then status accuracy and over-referral, then template rate, then p50/p90."""
    m = {k: s["metrics"] for k, s in c["sets"].items() if "metrics" in s}
    e = next((v for k, v in m.items() if k.startswith("e2e")), {})
    t = next((v for k, v in m.items() if k.startswith("triage")), {})
    return (not c["gate"], not c["memory"]["fits"], -(e.get("status_accuracy") or 0), t.get("over_referral_rate") or 0,
            e.get("template_rate") or 0, e.get("latency_p50_s") or 99, e.get("latency_p90_s") or 99)


def table(results):
    head = ("| config | gate | fits | peak GB | growth GB | spill | swap rise GB | triage acc | over-ref | medicines | "
            "status acc | dose | first-try | template | calls/med | e2e p50/p90 s |\n" + "|---" * 16 + "|\n")
    rows = []
    for n, c in sorted(results.items(), key=lambda kv: rank_key(kv[1])):
        m = {k.split(".")[0]: s.get("metrics", {}) for k, s in c["sets"].items()}
        t, e, mem = m.get("triage", {}), m.get("e2e", {}), c["memory"]
        rows.append(f"| {n} | {'pass' if c['gate'] else 'FAIL'} | {'yes' if mem['fits'] else 'no'} | {mem['peak_loaded_gb']} | "
                    f"{mem['max_growth_gb']} | {', '.join(mem['cpu_spill']) or '-'} | {mem['swap_rise_gb']} | "
                    f"{t.get('label_accuracy', '-')} | {t.get('over_referral_rate', '-')} | {t.get('medicines_match', '-')} | "
                    f"{e.get('status_accuracy', '-')} | {e.get('dose_vs_oracle', '-')} | {e.get('first_try_check_rate', '-')} | "
                    f"{e.get('template_rate', '-')} | {e.get('model_calls_per_medicine', '-')} | "
                    f"{e.get('latency_p50_s', '-')}/{e.get('latency_p90_s', '-')} |"
                    + (f"  <- dropped: {c['errors'][0]}" if c["errors"] else ""))
    return head + "\n".join(rows) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, help="a label for the output files, e.g. 1")
    ap.add_argument("--configs", default=",".join(CONFIGS))
    ap.add_argument("--sets", default="triage.dev,e2e.dev")
    ap.add_argument("--k", type=int, default=1)
    ap.add_argument("--skip-unresolved", action="store_true")
    ap.add_argument("--limit", type=int, help="first N items of each set (a smoke run)")
    a = ap.parse_args()
    RESULTS.mkdir(parents=True, exist_ok=True)
    f = RESULTS / f"bakeoff-{a.stage}.json"
    results = json.loads(f.read_text())["configs"] if f.exists() else {}  # rerunning a stage resumes it
    for name in a.configs.split(","):
        if name in results:
            print(f"{name}: already in {f.name}, skipped", flush=True)
            continue
        main_m, helper_m = CONFIGS[name]
        print(f"== {name}: main {main_m}, helper {helper_m}", flush=True)
        results[name] = run_config(name, main_m, helper_m, a, a.stage)
        f.write_text(json.dumps({"stage": a.stage, "sets": a.sets, "k": a.k, "configs": results}, indent=1))
        (RESULTS / f"bakeoff-{a.stage}.md").write_text(table(results))
        print(f"   gate {'pass' if results[name]['gate'] else 'FAIL'}, memory {results[name]['memory']['peak_loaded_gb']} GB, "
              f"errors {results[name]['errors']}", flush=True)
    print(table(results))


if __name__ == "__main__":
    main()
