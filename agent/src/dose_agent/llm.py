"""ask(tier, system, user, schema) -> dict. Two backends: Ollama (stdlib urllib, the one that runs)
and the Anthropic SDK (written, never called in this project). Request builders are pure so tests
can assert their shape without a network."""
import json
import os
import urllib.request

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODELS = {"main": "qwen3.5:9b", "helper": "qwen3.5:4b"}
CLAUDE_MODELS = {"main": "claude-sonnet-5-5", "helper": "claude-haiku-5-5"}
MAX_TOKENS = 2000
FALLBACK_BETA = "server-side-fallback-2026-07-01"


def build_ollama_request(tier: str, system: str, user: str, schema: dict) -> dict:
    return {
        "model": OLLAMA_MODELS[tier],
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "stream": False,
        "format": schema,
        "think": False,
        "options": {"temperature": 0},
    }


def build_anthropic_request(tier: str, system: str, user: str, schema: dict) -> dict:
    fmt = {"format": {"type": "json_schema", "schema": schema}}
    req = {
        "model": CLAUDE_MODELS[tier],
        "max_tokens": MAX_TOKENS,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    if tier == "main":
        req.update(output_config=fmt, betas=[FALLBACK_BETA], fallbacks="default")
    else:
        req["output_config"] = {**fmt, "effort": "low"}
    return req


def _ollama(tier: str, system: str, user: str, schema: dict) -> dict:
    body = json.dumps(build_ollama_request(tier, system, user, schema)).encode()
    req = urllib.request.Request(f"{OLLAMA_URL}/api/chat", body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(json.load(r)["message"]["content"])


def _anthropic(tier: str, system: str, user: str, schema: dict) -> dict:
    import anthropic  # imported here so the Ollama path never needs a key

    client = anthropic.Anthropic()
    kwargs = build_anthropic_request(tier, system, user, schema)
    create = client.beta.messages.create if "betas" in kwargs else client.messages.create
    msg = create(**kwargs)
    if msg.stop_reason == "refusal":
        raise RuntimeError(f"model refused: {getattr(msg, 'stop_details', None)}")
    text = next(b.text for b in msg.content if b.type == "text")
    return json.loads(text)


def ask(tier: str, system: str, user: str, schema: dict, backend: str | None = None) -> dict:
    backend = backend or os.environ.get("DOSE_AGENT_BACKEND", "ollama")
    return {"ollama": _ollama, "claude": _anthropic}[backend](tier, system, user, schema)
