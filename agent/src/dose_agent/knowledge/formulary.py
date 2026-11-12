"""One Formulary over either source: the public illustrative.json (default, what the tests use) or a local
HealthLink directory (see healthlink.py). Lookup by brand or generic, strength, rule, class, review status.
Nothing here writes anything."""
import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from . import classes

NOISE_WORDS = {"syrup", "syp", "susp", "suspension", "tablet", "tab", "drops", "oral"}


@dataclass(frozen=True)
class Product:
    key: str                       # unique within a formulary
    generic: str | None            # canonical generic; None when the source's generic name can't be read
    cls: str | None
    brands: tuple[str, ...]
    strength: str | None
    mg_per_kg_day: float | None
    doses_per_day: int | None
    min_age_months: int | None
    max_mg_per_kg_dose: float | None
    max_single_mg: float | None
    max_daily_mg: float | None
    source: str
    version: str
    safety_net: str
    unusable: str = ""             # why this product cannot compute a dose; "" when it can
    generics: tuple[str, ...] = ()  # every component of a combination; generic/cls above are the first, for display
    classes: tuple[str, ...] = ()

    @property
    def all_generics(self) -> set[str]:
        return set(self.generics) | ({self.generic} if self.generic else set())

    @property
    def all_classes(self) -> set[str]:
        return set(self.classes) | ({self.cls} if self.cls else set())

    @property
    def label(self) -> str:
        return f"{self.brands[0] if self.brands else self.generic} {self.strength or 'strength unknown'}"


def key_of(text: str) -> str:
    words = [w for w in re.sub(r"[^a-z0-9]+", " ", text.lower()).split() if w not in NOISE_WORDS]
    return " ".join(words)


class Formulary:
    def __init__(self, products: list[Product], name: str):
        self.products = products
        self.name = name  # "illustrative" | "healthlink"
        self._by_brand: dict[str, list[Product]] = {}
        self._by_generic: dict[str, list[Product]] = {}
        for p in products:
            for b in p.brands:
                self._by_brand.setdefault(key_of(b), []).append(p)
            if p.generic:
                self._by_generic.setdefault(p.generic, []).append(p)

    def find(self, term: str) -> list[Product]:
        """Products a request names: a brand (exact, noise words dropped) or a generic (all its products)."""
        k = key_of(term)
        if k in self._by_brand:
            return self._by_brand[k]
        longer = [p for b, ps in self._by_brand.items() if k and b.startswith(k + " ") for p in ps]
        if longer:  # 'crocin' names 'crocin 125'
            return list(dict.fromkeys(longer))
        gs = classes.normalise(term)
        return self._by_generic.get(gs[0], []) if len(gs) == 1 else []

    def stub(self, term: str) -> Product:
        """A product-less stand-in for a medicine that is not in the formulary, so allergy checks still run."""
        gs, cs = classes.components(term)
        g, c = (gs[0] if gs else None), (cs[0] if cs else None)
        return Product(key="stub:" + key_of(term), generic=g or key_of(term), cls=c, brands=(), strength=None,
                       generics=gs, classes=cs,
                       mg_per_kg_day=None, doses_per_day=None, min_age_months=None, max_mg_per_kg_dose=None,
                       max_single_mg=None, max_daily_mg=None, source="", version="", safety_net="",
                       unusable="not in the formulary")

    def names_for_prompt(self, limit: int = 40) -> str:
        """Generic names (and brands) for the triage prompt. A big directory is cut to its first `limit`."""
        gen = list(dict.fromkeys(p.generic for p in self.products if p.generic))[:limit]
        brands = [b for p in self.products for b in p.brands][:limit]
        return f"{', '.join(gen)}; brands: {', '.join(brands)}" if brands else ", ".join(gen)

    @lru_cache(maxsize=1)
    def terms(self) -> dict:
        """Every name an allergy note may use -> (kind, generic, class): class names, class members, generics, brands."""
        t: dict[str, tuple] = {}
        for c, gs in classes.CLASSES.items():
            for g in gs:
                t[g] = ("generic", g, c)
            t[c] = ("class", None, c)
        for g, c in classes._KNOWN.items():
            t.setdefault(g, ("generic", g, c))
        for p in self.products:
            for g in p.all_generics:
                t.setdefault(g, ("generic", g, classes.class_of(g) or (p.cls if g == p.generic else None)))
            for b in p.brands:
                k = key_of(b)
                if len(k) >= 3:
                    t[k] = ("brand", p.generic, p.cls)
        return t

    @lru_cache(maxsize=1)
    def term_regex(self):
        names = sorted(self.terms(), key=len, reverse=True)
        return re.compile(r"(?<![a-z0-9])(" + "|".join(re.escape(n) for n in names) + r")(?![a-z0-9])")


def illustrative() -> Formulary:
    raw = json.loads((Path(__file__).with_name("illustrative.json")).read_text())
    ps = []
    for i, e in enumerate(raw["products"]):
        ps.append(Product(
            key=f"illustrative:{i}", generic=e["generic"], cls=e["class"], brands=tuple(e["brands"]),
            generics=tuple(e.get("generics") or [e["generic"]]),
            classes=tuple(dict.fromkeys(c for c in map(classes.class_of, e.get("generics") or [e["generic"]]) if c)),
            strength=e["strength"], mg_per_kg_day=e["mg_per_kg_day"], doses_per_day=e["doses_per_day"],
            min_age_months=e["min_age_months"], max_mg_per_kg_dose=e["max_mg_per_kg_dose"],
            max_single_mg=e["max_single_mg"], max_daily_mg=e["max_daily_mg"],
            source=e["source"], version=e["version"], safety_net=e["safety_net"]))
    return Formulary(ps, "illustrative")


@lru_cache(maxsize=1)
def get() -> Formulary:
    """HealthLink when DOSE_AGENT_HEALTHLINK is set (local only), else the illustrative test formulary."""
    import os
    if os.environ.get("DOSE_AGENT_HEALTHLINK"):
        from . import healthlink
        return healthlink.load()
    return illustrative()


def legacy_view(fm: Formulary) -> dict:
    """The shape written to extra.json for readers: generic -> its entry, or {'products': [...]} when it has several."""
    out: dict = {}
    for g in dict.fromkeys(p.generic for p in fm.products):
        ps = fm._by_generic[g]
        rows = [{"brands": list(p.brands), "class": p.cls, "strength": p.strength, "mg_per_kg_day": p.mg_per_kg_day,
                 "doses_per_day": p.doses_per_day, "min_age_months": p.min_age_months,
                 "max_mg_per_kg_dose": p.max_mg_per_kg_dose, "max_single_mg": p.max_single_mg,
                 "max_daily_mg": p.max_daily_mg, "source": p.source, "version": p.version,
                 "safety_net": p.safety_net} for p in ps]
        out[g] = rows[0] if len(rows) == 1 else {"products": rows}
    return out
