"""Does a recorded allergy stop this medicine? It does when the allergy text names the medicine's generic (any
component of a combination), one of its brands, its drug class (any component's), or another medicine of the same
class. Misspelt words are matched too: a missed allergy is the dangerous direction, an extra question is not.
Returns the link that matched, in words."""
import difflib
import re

from . import classes
from .formulary import Formulary, Product


def _term_link(term: str, p: Product, fm: Formulary) -> str | None:
    kind, gen, cls = fm.terms()[term]
    gens, clss = p.all_generics, p.all_classes
    if kind == "class" and cls and cls in clss:
        return f"{cls} class"
    if kind == "generic" and gen and gen in gens:
        return f"same medicine ({gen})"
    if kind == "generic" and cls and cls in clss:
        return f"{term} is in the {cls} class, like {p.generic}"
    if kind == "brand":
        if term in {b.lower() for b in p.brands}:
            return f"brand {term}"
        if gen and gen in gens:
            return f"brand {term}, which is {gen}"
        if cls and cls in clss:
            return f"brand {term} is in the {cls} class, like {p.generic}"
    return None


def _fuzzy_term(word: str, fm: Formulary) -> str | None:
    """The one known name a misspelt word (5+ letters, not itself a known name) clearly means."""
    if len(word) < 5 or word in fm.terms():
        return None
    g = classes._fuzzy(word)
    if g and g in fm.terms():
        return g
    close = difflib.get_close_matches(word, [t for t in fm.terms() if len(t) >= 5], n=1, cutoff=0.85)
    return close[0] if close else None


def link(text: str, p: Product, fm: Formulary) -> str | None:
    """The first way `text` (an allergy record, any case) names product `p`, or None."""
    t = text.lower()
    for m in fm.term_regex().finditer(t):
        lk = _term_link(m.group(1), p, fm)
        if lk:
            return lk
    words = re.findall(r"[a-z]+", t)
    for tok in words + [f"{a} {b}" for a, b in zip(words, words[1:])]:
        term = _fuzzy_term(tok, fm)
        lk = _term_link(term, p, fm) if term else None
        if lk:
            return f"'{tok}' read as {term} ({lk})"
    return None


NONE_RECORDED = re.compile(r"no known (drug )?allerg|\bnkda\b|\bnka\b|no allerg|allergies:\s*none|not allergic", re.I)
STRUCTURED = re.compile(r"^allergy to ([^:]*):", re.I)  # how records.child_records words a structured allergy


def _knows_a_name(text: str, fm: Formulary) -> bool:
    t = text.lower()
    if fm.term_regex().search(t):
        return True
    words = re.findall(r"[a-z]+", t)
    return any(_fuzzy_term(tok, fm) for tok in words + [f"{a} {b}" for a, b in zip(words, words[1:])])


def stops(texts: list[tuple[str, str]], products: list[Product], fm: Formulary) -> tuple[str, str, str] | None:
    """texts: (record text, date) for every allergy record. -> (record text, date, link) of the first that stops any product.
    Fails closed: an allergy we cannot identify (no known generic, class or brand in it, exact or misspelt) stops
    every medicine, unless the record says there are none."""
    for text, date in texts:
        for p in products:
            lk = link(text, p, fm)
            if lk:
                return text, date, lk
        if NONE_RECORDED.search(text):
            continue
        s = STRUCTURED.match(text)
        drug = s.group(1).strip() if s else text  # a structured allergy is judged by its drug, a note by its words
        if not _knows_a_name(drug, fm):
            return text, date, f"unrecognised allergy '{drug}'"
    return None
