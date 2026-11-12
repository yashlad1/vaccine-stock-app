"""The number rule for the parent message: code checks every draft (SPEC rule 2)."""
import re

_ALLOWED_COUNT = re.compile(r"\b\d+\s*(?:times|x|hours|hrs|hourly|days|weeks)\b", re.I)
MAX_DRAFT_CHARS = 600
_UNIT_AFTER_DOSE = re.compile(r"\{DOSE\}\s*(ml|mls|millilitres?|milliliters?|mg|tsp|teaspoons?|spoons?|drops?|cc)\b", re.I)


def check_draft(draft: str) -> tuple[bool, str]:
    """(ok, reason). Numbers are an allowlist: the only digits a draft may hold are a count of times or a
    time interval ('4 times a day', 'every 6 hours', 'for 5 days'). The amount is only ever {DOSE}."""
    if draft.count("{DOSE}") != 1:
        return False, f"write {{DOSE}} exactly once, where the amount goes (found {draft.count('{DOSE}')})"
    u = _UNIT_AFTER_DOSE.search(draft)
    if u:
        return False, f"{{DOSE}} already includes the unit; remove '{u.group(1)}' after it"
    rest = draft.replace("{DOSE}", "")
    if "{" in rest or "}" in rest:
        return False, "remove every other { or }: {DOSE} is the only placeholder, and nothing fills any other"
    rest = _ALLOWED_COUNT.sub("", rest)
    m = re.search(r"\d[\d.,]*\s*[A-Za-z]*", rest)
    if m:
        return False, (f"write the amount only as {{DOSE}}; remove '{m.group().strip()}'. Digits are allowed only "
                       "as a count of times or hours, such as '4 times a day' or 'every 6 hours'")
    if len(draft) > MAX_DRAFT_CHARS:
        return False, f"shorten the message to at most {MAX_DRAFT_CHARS} characters (it is {len(draft)})"
    return True, ""
