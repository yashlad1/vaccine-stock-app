"""chat_model(tier): one chat model per tier, chosen as 'provider:model'. Same idea as DADA3 bugteam's config.chat().
main = triage and the dose agent; helper = search_history. Providers: ollama (default, the one that runs),
gemini and nvidia (free tiers; keys from GOOGLE_API_KEY / NVIDIA_API_KEY in the environment, never stored here),
claude (written, never called).

DOSE_AGENT_BACKEND = ollama (default) | claude | free (gemini main + nvidia helper).
DOSE_AGENT_MAIN / DOSE_AGENT_HELPER = 'provider:model' override one tier."""
import json
import os
import re
from contextlib import contextmanager
from contextvars import ContextVar

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.exceptions import OutputParserException
from pydantic import ValidationError

PRESETS = {
    "ollama": {"main": "ollama:qwen3.5:9b", "helper": "ollama:qwen3.5:4b"},
    "claude": {"main": "claude:claude-sonnet-5-5", "helper": "claude:claude-haiku-5-5"},
    "free": {"main": "gemini:gemini-3.6-flash", "helper": "nvidia:nvidia/nemotron-3.5-lightning-30b-a3b"},
}
PROVIDERS = ("ollama", "gemini", "nvidia", "claude")
NVIDIA_URL = "https://integrate.api.nvidia.com/v1"
MAX_TOKENS = 2000
# The biggest prompt the agent sends is ~300 tokens (measured over e2e.test: triage, history pick, draft, redraft),
# so 8192 is more than 25x headroom. Ollama's default of 65536 made qwen3.5:9b take 10 GB and the 4b ~5.5 GB, more than
# the GPU budget of a 16 GB Mac: they evicted each other and the Mac swapped. DOSE_AGENT_NUM_CTX overrides it.
NUM_CTX = int(os.environ.get("DOSE_AGENT_NUM_CTX", 8192))
NUM_PREDICT = 2048  # a runaway qwen3.5:9b call once wrote ~23,000 tokens in 13 minutes; normal is 120-280
ATTEMPTS = 3


_CALLS: ContextVar[list | None] = ContextVar("dose_agent_model_calls", default=None)


class _CallCounter(BaseCallbackHandler):
    """Counts every chat-model request made while a count_calls() block is open (retries on bad JSON included)."""

    def on_chat_model_start(self, serialized, messages, **kwargs):
        n = _CALLS.get()
        if n is not None:
            n[0] += 1


_COUNTER = _CallCounter()


@contextmanager
def count_calls():
    """with count_calls() as n: ... n[0] is the number of model requests made inside the block (in this context)."""
    n = [0]
    token = _CALLS.set(n)
    try:
        yield n
    finally:
        _CALLS.reset(token)


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
        return ChatOllama(model=model, temperature=0, reasoning=False, num_predict=NUM_PREDICT, num_ctx=NUM_CTX, callbacks=[_COUNTER])
    if provider == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI
        # No temperature: Google advises the default for Gemini 3 (low values can loop). Retries for free-tier 429s.
        return ChatGoogleGenerativeAI(model=model, max_retries=8, callbacks=[_COUNTER])
    if provider == "nvidia":
        from langchain_nvidia_ai_endpoints import ChatNVIDIA
        return ChatNVIDIA(model=model, base_url=NVIDIA_URL, temperature=0, callbacks=[_COUNTER])
    from langchain_anthropic import ChatAnthropic
    # No temperature and no budget_tokens on these models. Helper runs at low effort.
    extra = {"reasoning_effort": "low"} if tier == "helper" else {}
    return ChatAnthropic(model=model, max_tokens=MAX_TOKENS, callbacks=[_COUNTER], **extra)


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


class StructuredOutputError(RuntimeError):
    """The model never returned output the schema accepts."""


def invoke_structured(model, schema, messages, attempts: int = ATTEMPTS):
    """structured(...).invoke with a retry on invalid JSON (json_schema output is intermittently invalid on
    local models). After `attempts` failures it raises StructuredOutputError: callers fail closed."""
    chain = structured(model, schema)
    for i in range(attempts):
        try:
            return chain.invoke(messages)
        except (OutputParserException, ValidationError, json.JSONDecodeError):
            if i == attempts - 1:
                raise StructuredOutputError(f"no valid {schema.__name__} after {attempts} attempts") from None


def require_local_for_healthlink() -> None:
    """The HealthLink directory is the clinic's data: only local Ollama models may run beside it."""
    if os.environ.get("DOSE_AGENT_HEALTHLINK") and any(spec(t)[0] != "ollama" for t in ("main", "helper")):
        raise SystemExit("Refusing: with the HealthLink directory loaded only the ollama backend runs.")


def require_synthetic(is_synthetic: bool) -> None:
    """Every tier that is not local Ollama sends records over the network."""
    if not is_synthetic and any(spec(t)[0] != "ollama" for t in ("main", "helper")):
        raise SystemExit("Refusing: a hosted model only runs on a database marked synthetic.")
