"""Drug classes and a generic-name normaliser. Public knowledge only (no patient data, no clinic data).
Allergy matching uses the class table: an allergy to one penicillin stops every penicillin.
Cross-class reactions (penicillin to cephalosporin) are deliberately out of scope."""
import difflib
import re

CLASSES = {
    "penicillin": ["amoxicillin", "ampicillin", "penicillin", "cloxacillin", "flucloxacillin", "piperacillin",
                   "dicloxacillin", "oxacillin", "cloxacillin"],
    "cephalosporin": ["cefixime", "cefpodoxime", "cefuroxime", "ceftriaxone", "cephalexin", "cefadroxil",
                      "cefdinir", "cefotaxime", "ceftazidime", "cefaclor", "cefprozil"],
    "macrolide": ["azithromycin", "clarithromycin", "erythromycin", "roxithromycin"],
    "sulfonamide": ["cotrimoxazole", "sulfamethoxazole", "sulfadiazine", "trimethoprim"],
    "nsaid": ["ibuprofen", "diclofenac", "naproxen", "aspirin", "mefenamic acid", "nimesulide", "ketorolac",
              "piroxicam", "ketoprofen", "indomethacin"],
    "quinolone": ["ciprofloxacin", "ofloxacin", "levofloxacin", "norfloxacin"],
    "antihistamine": ["cetirizine", "levocetirizine", "loratadine", "fexofenadine", "chlorpheniramine",
                      "cyproheptadine", "hydroxyzine", "diphenhydramine"],
    "antiepileptic": ["phenytoin", "carbamazepine", "valproate", "phenobarbitone"],
}
OTHER = ["paracetamol", "clavulanate", "salbutamol", "ondansetron", "domperidone", "metronidazole", "albendazole",
         "prednisolone", "montelukast", "zinc", "ors", "cholecalciferol", "levosalbutamol", "dicyclomine",
         "chloramphenicol", "lignocaine", "racecadotril", "bacitracin", "dextromethorphan", "terbutaline",
         "mupirocin", "mometasone", "budesonide", "simethicone", "ranitidine", "calamine", "ambroxol",
         "bromhexine", "lactulose", "deflazacort", "amlodipine", "ferrous", "theophylline", "acrivastine"]  # known generics with no class here
ALIASES = {"pcm": "paracetamol", "acetaminophen": "paracetamol", "paracetamol": "paracetamol",
           "amox": "amoxicillin", "amoxycillin": "amoxicillin", "amoxicilline": "amoxicillin",
           "clav": "clavulanate", "clavulanic": "clavulanate", "clavulanate": "clavulanate", "ibu": "ibuprofen",
           "azithro": "azithromycin", "cefix": "cefixime", "cipro": "ciprofloxacin", "co": None, "cpm": "chlorpheniramine", "levo": None,
           "cotrimoxazole": "cotrimoxazole", "septran": "cotrimoxazole", "mefenamic": "mefenamic acid"}
NOISE = {"mg", "ml", "syrup", "syp", "susp", "suspension", "tablet", "tab", "tabs", "drops", "drop", "dry", "forte",
         "dt", "injection", "inj", "oral", "acid", "and", "with", "plus", "sodium", "potassium", "kid", "kids",
         "ds", "xl", "sr", "cap", "capsule", "powder", "for", "oint", "gel", "cream"}

_KNOWN = {g: c for c, gs in CLASSES.items() for g in gs}
for _g in OTHER:
    _KNOWN.setdefault(_g, None)
CLASS_NAMES = set(CLASSES)


def class_of(generic: str | None) -> str | None:
    return _KNOWN.get(generic) if generic else None


def _fuzzy(tok: str) -> str | None:
    """A misspelt or shortened word ('cetrizine', 'oflox') -> the one known generic it clearly means."""
    if len(tok) < 5:
        return None
    pre = [g for g in _KNOWN if g.startswith(tok) and " " not in g]
    if len(pre) == 1:
        return pre[0]
    close = difflib.get_close_matches(tok, [g for g in _KNOWN if " " not in g], n=1, cutoff=0.85)
    return close[0] if close else None


def normalise(text: str | None) -> list[str]:
    """Free-text generic name -> canonical generic names ('amox- clav' -> amoxicillin, clavulanate).
    [] when nothing in it is recognised ('1', '', an unknown brand)."""
    if not text:
        return []
    t = re.sub(r"[^a-z]+", " ", text.lower()).strip()
    if "mefenamic acid" in t:
        t = t.replace("mefenamic acid", "mefenamic")
    found: list[str] = []
    for tok in t.split():
        if tok in NOISE:
            continue
        g = ALIASES.get(tok, tok if tok in _KNOWN else None) or (_fuzzy(tok) if tok not in ALIASES else None)
        if g and g not in found:
            found.append(g)
    return found


def primary(text: str | None) -> tuple[str | None, str | None]:
    """(generic, class) of a free-text generic name. A combination takes its first classed component's class
    and its first component's name; unresolved -> (None, None)."""
    gs = normalise(text)
    if not gs:
        return None, None
    return gs[0], next((class_of(g) for g in gs if class_of(g)), None)
