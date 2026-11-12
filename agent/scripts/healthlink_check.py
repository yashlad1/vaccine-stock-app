"""Aggregates over the local HealthLink directory. Prints counts only, never a row, a name or a value.
  DOSE_AGENT_HEALTHLINK=<dir> [DOSE_AGENT_HEALTHLINK_REVIEW=<xlsx>] uv run python scripts/healthlink_check.py"""
import os
import sys
from collections import Counter

from dose_agent.knowledge import classes, healthlink
from dose_agent.knowledge.formulary import key_of

if not os.environ.get("DOSE_AGENT_HEALTHLINK"):
    sys.exit("set DOSE_AGENT_HEALTHLINK=<dir holding drugs.json>")
rows = healthlink.entries()
review = healthlink.read_review(os.environ.get("DOSE_AGENT_HEALTHLINK_REVIEW"))
names = Counter(key_of(n) for n, _, _ in review)
matched = sum(min(c, sum(1 for e, _, _ in rows if key_of(str(e.get("drug", ""))) == k)) for k, c in names.items())
fm = healthlink.load()
usable = sum(1 for p in fm.products if not p.unusable)

print(f"entries: {len(rows)}")
print(f"review rows: {len(review)}; matched to an entry: {matched}; marked yes: {sum(1 for _, y, _ in review if y)}; "
      f"with a correction: {sum(1 for _, _, c in review if c)}")
print("review state:", dict(Counter(s for _, _, s in rows)))
print("validation (by itself, ignoring review):")
for why, n in Counter(b or "valid" for _, b, _ in rows).most_common():
    print(f"  {n:4d}  {why}")
print("usable to compute a dose (reviewed AND valid):", usable)
print("not usable, by reason:")
for why, n in Counter(p.unusable for p in fm.products if p.unusable).most_common():
    print(f"  {n:4d}  {why}")
resolved = sum(1 for e, _, _ in rows if classes.normalise(e.get("generic_name")))
with_class = sum(1 for p in fm.products if p.cls)
print(f"generic name resolved: {resolved}/{len(rows)}; entries with a drug class: {with_class}; "
      f"lookup-by-brand only: {len(rows) - resolved}")
print(f"distinct generics resolved: {len({p.generic for p in fm.products if p.generic})}; "
      f"distinct brand keys: {len({key_of(b) for p in fm.products for b in p.brands})}")
