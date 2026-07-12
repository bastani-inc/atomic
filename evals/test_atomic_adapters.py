import json
import logging
from pathlib import Path

from harbor.models.agent.context import AgentContext as HarborAgentContext
from pier.models.agent.context import AgentContext as PierAgentContext

from atomic_harbor import Atomic as HarborAtomic
from atomic_pier import Atomic as PierAtomic


def _assistant(timestamp: int, *, input_tokens: int = 10) -> dict[str, object]:
    return {
        "role": "assistant",
        "timestamp": timestamp,
        "provider": "test",
        "model": "test-model",
        "stopReason": "stop",
        "content": [{"type": "text", "text": f"response-{timestamp}"}],
        "usage": {
            "input": input_tokens,
            "output": 2,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": input_tokens + 2,
            "cost": {"total": 0.01},
        },
    }


def _write_jsonl(path: Path, entries: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(f"{json.dumps(entry)}\n" for entry in entries))


def _write_atomic_logs(logs_dir: Path) -> None:
    main_message = _assistant(1_000)
    workflow_message = _assistant(2_000, input_tokens=20)
    _write_jsonl(
        logs_dir / "atomic.txt",
        [{"type": "message_end", "message": main_message}],
    )
    _write_jsonl(
        logs_dir / "atomic-sessions" / "main.jsonl",
        [
            {"type": "session", "id": "main"},
            {"type": "message", "id": "main-turn", "message": main_message},
        ],
    )
    _write_jsonl(
        logs_dir / "atomic-sessions" / "workflow" / "stage.jsonl",
        [
            {"type": "session", "id": "stage", "internal": True},
            # Forked workflow transcripts contain copied parent context. It must
            # be de-duplicated rather than reported as another agent turn.
            {"type": "message", "id": "main-turn", "message": main_message},
            {"type": "message", "id": "workflow-turn", "message": workflow_message},
        ],
    )


def test_pier_counts_unique_main_and_workflow_agent_steps(tmp_path: Path) -> None:
    _write_atomic_logs(tmp_path)
    agent = PierAtomic.__new__(PierAtomic)
    agent.logs_dir = tmp_path
    agent._version = "test"
    agent.model_name = "test/test-model"
    agent.logger = logging.getLogger("test-atomic-pier")
    context = PierAgentContext()

    agent.populate_context_post_run(context)

    assert context.n_agent_steps == 2
    trajectory = json.loads((tmp_path / "trajectory.json").read_text())
    assert len(trajectory["subagent_trajectories"]) == 1
    assert trajectory["final_metrics"]["total_prompt_tokens"] == 30


def test_harbor_reports_unique_main_and_workflow_agent_steps(tmp_path: Path) -> None:
    _write_atomic_logs(tmp_path)
    agent = HarborAtomic.__new__(HarborAtomic)
    agent.logs_dir = tmp_path
    context = HarborAgentContext()

    agent.populate_context_post_run(context)

    assert context.metadata == {"n_agent_steps": 2}
    assert context.n_input_tokens == 30
