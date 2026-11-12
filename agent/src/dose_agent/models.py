"""chat_model(tier): one chat model per tier, chosen as 'provider:model'. Same idea as DADA3 bugteam's config.chat().
main = triage and the dose agent; helper = search_history. Providers: ollama (default, the one that runs),
gemini and nvidia (free tiers; keys from GOOGLE_API_KEY / NVIDIA_API_KEY in the environment, never stored here),
claude (written, never called).

DOSE_AGENT_BACKEND = ollama (default) | claude | free (gemini main + nvidia helper).
DOSE_AGENT_MAIN / DOSE_AGENT_HELPER = 'provider:model' override one tier."""
import json
import os
import re

PRESETS = {
    "ollama": {"main": "ollama:qwen3.5:9b", "helper": "ollama:qwen3.5:4b"},
    "claude": {"main": "claude:claude-sonnet-5-5", "helper": "claude:claude-haiku-5-5"},
    "free": {"main": "gemini:gemini-3.6-flash", "helper": "nvidia:nvidia/nemotron-3.5-lightning-30b-a3b"},
}
PROVIDERS = ("ollama", "gemini", "nvidia", "claude")
NVIDIA_URL = "https://integrate.api.nvidia.com/v1"
MAX_TOKENS = 2000


def backend() -> str:
    b = os.environ.get("DOSE_AGENT_BACKEND", "ollama")
    if b not in PRESETS:
        raise ValueError(f"DOSE_AGENT_BACKEND is {b!r}. Use ollama, claude or free.")
    return b


def spec(tier: str) -> tuple[str, str]:
    """(provider, model) for a tier: the tier's env override, else the backend preset."""
    raw = os.environ.get(f"DOSE_AGENT_{tier.upper()}") or PRESETS[backend()][tier]
    provider, _, model = raw.partition(":")
    if provider not in PROVIDERS or not model:
        raise ValueError(f"DOSE_AGENT_{tier.upper()} is {raw!r}. Use provider:model, provider one of {PROVIDERS}.")
    return provider, model


def info() -> dict:
    """The backend and the model id of each tier, for the outbox record."""
    s = {t: spec(t) for t in ("main", "helper")}
    names = {p for p, _ in s.values()}
    return {"backend": names.pop() if len(names) == 1 else "+".join(s[t][0] for t in ("main", "helper")),
            "models": {t: f"{p}:{m}" if p != "ollama" else m for t, (p, m) in s.items()}}


def chat_model(tier: str):
    provider, model = spec(tier)
    if provider == "ollama":
        from langchain_ollama import ChatOllama
        return ChatOllama(model=model, temperature=0, reasoning=False)
    if provider == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI
        # No temperature: Google advises the default for Gemini 3 (low values can loop). Retries for free-tier 429s.
        return ChatGoogleGenerativeAI(model=model, max_retries=8)
    if provider == "nvidia":
        from langchain_nvidia_ai_endpoints import ChatNVIDIA
        return ChatNVIDIA(model=model, base_url=NVIDIA_URL, temperature=0)
    from langchain_anthropic import ChatAnthropic
    # No temperature and no budget_tokens on these models. Helper runs at low effort.
    extra = {"reasoning_effort": "low"} if tier == "helper" else {}
    return ChatAnthropic(model=model, max_tokens=MAX_TOKENS, **extra)


def _json_from(text: str) -> dict:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    m = re.search(r"\{.*\}", text, flags=re.S)
    return json.loads(m.group(0) if m else text)


def structured(model, schema):
    """Structured output through JSON-schema mode, never a forced tool call: Sonnet 5.5 answers a forced
    tool_choice with a 400. Hosted Nemotron has no documented schema mode, so it is asked for JSON in the
    prompt and the reply is parsed and validated by the pydantic schema."""
    if type(model).__name__ == "ChatNVIDIA":
        from langchain.messages import HumanMessage
        from langchain_core.runnables import RunnableLambda
        hint = HumanMessage(content="Reply with only a JSON object matching this schema, nothing else:\n"
                                    + json.dumps(schema.model_json_schema()))
        return RunnableLambda(lambda msgs: schema.model_validate(_json_from(model.invoke([*msgs, hint]).content)))
    return model.with_structured_output(schema, method="json_schema")


def require_synthetic(is_synthetic: bool) -> None:
    """Every tier that is not local Ollama sends records over the network."""
    if not is_synthetic and any(spec(t)[0] != "ollama" for t in ("main", "helper")):
        raise SystemExit("Refusing: a hosted model only runs on a database marked synthetic.")
