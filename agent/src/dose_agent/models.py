"""chat_model(tier): ChatOllama (the one that runs) or ChatAnthropic (written, never called).
Same switch as DADA3 bugteam's config.chat(). main = triage and the dose agent; helper = search_history."""
import os

OLLAMA_MODELS = {"main": "qwen3.5:9b", "helper": "qwen3.5:4b"}
CLAUDE_MODELS = {"main": "claude-sonnet-5-5", "helper": "claude-haiku-5-5"}
MAX_TOKENS = 2000


def backend() -> str:
    b = os.environ.get("DOSE_AGENT_BACKEND", "ollama")
    if b not in ("ollama", "claude"):
        raise ValueError(f"DOSE_AGENT_BACKEND is {b!r}. Use ollama or claude.")
    return b


def info() -> dict:
    """The backend and model ids in use, for the outbox record."""
    return {"backend": backend(), "models": dict((OLLAMA_MODELS if backend() == "ollama" else CLAUDE_MODELS))}


def chat_model(tier: str):
    if backend() == "ollama":
        from langchain_ollama import ChatOllama
        return ChatOllama(model=OLLAMA_MODELS[tier], temperature=0, reasoning=False)
    from langchain_anthropic import ChatAnthropic
    # No temperature and no budget_tokens on these models. Helper runs at low effort.
    extra = {"reasoning_effort": "low"} if tier == "helper" else {}
    return ChatAnthropic(model=CLAUDE_MODELS[tier], max_tokens=MAX_TOKENS, **extra)


def structured(model, schema):
    """Structured output through the provider's JSON-schema mode, never a forced tool call:
    Sonnet 5.5 answers a forced tool_choice with a 400."""
    return model.with_structured_output(schema, method="json_schema")


def require_synthetic(is_synthetic: bool) -> None:
    if backend() == "claude" and not is_synthetic:
        raise SystemExit("Refusing: the Claude backend only runs on a database marked synthetic.")
