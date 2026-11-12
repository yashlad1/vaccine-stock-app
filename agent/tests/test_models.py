import pytest
from pydantic import BaseModel
from dose_agent import models


class Out(BaseModel):
    x: str


def test_ollama_config(monkeypatch):
    monkeypatch.delenv("DOSE_AGENT_BACKEND", raising=False)
    m, h = models.chat_model("main"), models.chat_model("helper")
    assert (m.model, h.model) == ("qwen3.5:9b", "qwen3.5:4b")
    assert m.temperature == 0 and m.reasoning is False


def test_claude_config_no_network(monkeypatch):
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
