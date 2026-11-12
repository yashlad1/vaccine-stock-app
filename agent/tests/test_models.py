import pytest
from pydantic import BaseModel
from dose_agent import models


class Out(BaseModel):
    x: str


def test_ollama_config(monkeypatch):
    for v in ("DOSE_AGENT_BACKEND", "DOSE_AGENT_MAIN", "DOSE_AGENT_HELPER"):
        monkeypatch.delenv(v, raising=False)
    m, h = models.chat_model("main"), models.chat_model("helper")
    assert (m.model, h.model) == ("qwen3.5:9b", "qwen3.5:4b")
    assert m.temperature == 0 and m.reasoning is False


def test_claude_config_no_network(monkeypatch):
    for v in ("DOSE_AGENT_MAIN", "DOSE_AGENT_HELPER"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setenv("DOSE_AGENT_BACKEND", "claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-not-used")
    m, h = models.chat_model("main"), models.chat_model("helper")
    assert (m.model, h.model) == ("claude-sonnet-5-5", "claude-haiku-5-5")
    assert m.max_tokens == 2000 and m.temperature is None
    assert h.reasoning_effort == "low" and m.reasoning_effort is None
    # structured output must be JSON-schema mode, not a forced tool call
    bound = models.structured(m, Out)
    kw = bound.first.kwargs if hasattr(bound, "first") else bound.kwargs
    assert "tool_choice" not in kw
    assert "output_config" in kw and kw["output_config"]["format"]["type"] == "json_schema"
    assert "output_format" not in kw


def test_claude_refuses_non_synthetic_db(monkeypatch):
    monkeypatch.setenv("DOSE_AGENT_BACKEND", "claude")
    with pytest.raises(SystemExit):
        models.require_synthetic(False)
    models.require_synthetic(True)
    monkeypatch.setenv("DOSE_AGENT_BACKEND", "ollama")
    models.require_synthetic(False)


def test_bad_backend(monkeypatch):
    monkeypatch.setenv("DOSE_AGENT_BACKEND", "gpt")
    with pytest.raises(ValueError):
        models.chat_model("main")


def test_free_preset_selection_and_info(monkeypatch):
    for v in ("DOSE_AGENT_MAIN", "DOSE_AGENT_HELPER"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setenv("DOSE_AGENT_BACKEND", "free")
    monkeypatch.setenv("GOOGLE_API_KEY", "test-not-used")
    monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-test-not-used")
    assert models.spec("main") == ("gemini", "gemini-3.6-flash")
    assert models.spec("helper") == ("nvidia", "nvidia/nemotron-3.5-lightning-30b-a3b")
    assert models.info() == {"backend": "gemini+nvidia", "models": {
        "main": "gemini:gemini-3.6-flash", "helper": "nvidia:nvidia/nemotron-3.5-lightning-30b-a3b"}}
    m, h = models.chat_model("main"), models.chat_model("helper")
    assert type(m).__name__ == "ChatGoogleGenerativeAI" and m.model.endswith("gemini-3.6-flash") and m.temperature is None
    assert type(h).__name__ == "ChatNVIDIA" and h.temperature == 0 and h.model == "nvidia/nemotron-3.5-lightning-30b-a3b"


def test_tier_override_and_bad_spec(monkeypatch):
    monkeypatch.delenv("DOSE_AGENT_BACKEND", raising=False)
    monkeypatch.setenv("DOSE_AGENT_MAIN", "gemini:gemini-3.5-flash-lite")
    assert models.spec("main") == ("gemini", "gemini-3.5-flash-lite") and models.spec("helper") == ("ollama", "qwen3.5:4b")
    monkeypatch.setenv("DOSE_AGENT_HELPER", "bogus")
    with pytest.raises(ValueError):
        models.spec("helper")


@pytest.mark.parametrize("main,helper", [("gemini:x", None), (None, "nvidia:y"), ("claude:z", None)])
def test_guard_covers_every_hosted_provider(monkeypatch, main, helper):
    monkeypatch.delenv("DOSE_AGENT_BACKEND", raising=False)
    for k, v in (("DOSE_AGENT_MAIN", main), ("DOSE_AGENT_HELPER", helper)):
        monkeypatch.delenv(k, raising=False)
        if v:
            monkeypatch.setenv(k, v)
    with pytest.raises(SystemExit):
        models.require_synthetic(False)
    models.require_synthetic(True)


def test_nvidia_structured_parses_and_validates_json(monkeypatch):
    from langchain_core.language_models.fake_chat_models import FakeListChatModel
    class ChatNVIDIA(FakeListChatModel):
        pass
    fake = ChatNVIDIA(responses=['<think>hm</think>```json\n{"x": "ok"}\n```'])
    assert models.structured(fake, Out).invoke([]) == Out(x="ok")
