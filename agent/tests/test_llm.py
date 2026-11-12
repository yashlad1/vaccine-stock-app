from dose_agent import llm

SCHEMA = {"type": "object", "properties": {"x": {"type": "string"}}, "required": ["x"]}


def test_ollama_shape():
    r = llm.build_ollama_request("helper", "sys", "usr", SCHEMA)
    assert r["model"] == "qwen3.5:4b" and r["stream"] is False and r["think"] is False
    assert r["format"] == SCHEMA and r["options"] == {"temperature": 0}
    assert llm.build_ollama_request("main", "s", "u", SCHEMA)["model"] == "qwen3.5:9b"


def test_anthropic_main_shape():
    r = llm.build_anthropic_request("main", "sys", "usr", SCHEMA)
    assert r["model"] == "claude-sonnet-5-5" and r["max_tokens"] == 2000
    assert r["output_config"] == {"format": {"type": "json_schema", "schema": SCHEMA}}
    assert r["betas"] == ["server-side-fallback-2026-07-01"] and r["fallbacks"] == "default"
    assert not {"output_format", "temperature", "tool_choice", "thinking"} & r.keys()
    assert r["messages"] == [{"role": "user", "content": "usr"}]  # no assistant prefill


def test_anthropic_helper_shape():
    r = llm.build_anthropic_request("helper", "sys", "usr", SCHEMA)
    assert r["model"] == "claude-haiku-5-5"
    assert r["output_config"]["effort"] == "low" and r["output_config"]["format"]["type"] == "json_schema"
    assert "betas" not in r and "fallbacks" not in r


def test_anthropic_path_imports():
    import anthropic
    assert hasattr(anthropic.Anthropic, "__init__") and llm._anthropic
