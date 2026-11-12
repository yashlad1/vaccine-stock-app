"""Does a recorded allergy stop this medicine? It does when the allergy text names the medicine's generic, one of
its brands, its drug class, or another medicine of the same class. Returns the link that matched, in words."""
from .formulary import Formulary, Product


def link(text: str, p: Product, fm: Formulary) -> str | None:
    """The first way `text` (an allergy record, any case) names product `p`, or None."""
    for m in fm.term_regex().finditer(text.lower()):
        term = m.group(1)
        kind, gen, cls = fm.terms()[term]
        if kind == "class" and cls and cls == p.cls:
            return f"{cls} class"
        if kind == "generic" and gen and gen == p.generic:
            return f"same medicine ({gen})"
        if kind == "generic" and cls and cls == p.cls:
            return f"{term} is in the {cls} class, like {p.generic}"
        if kind == "brand":
            if term in {b.lower() for b in p.brands}:
                return f"brand {term}"
            if gen and gen == p.generic:
                return f"brand {term}, which is {gen}"
            if cls and cls == p.cls:
                return f"brand {term} is in the {cls} class, like {p.generic}"
    return None


def stops(texts: list[tuple[str, str]], products: list[Product], fm: Formulary) -> tuple[str, str, str] | None:
    """texts: (record text, date) for every allergy record. -> (record text, date, link) of the first that stops any product."""
    for text, date in texts:
        for p in products:
            lk = link(text, p, fm)
            if lk:
                return text, date, lk
    return None
