"""Exercise the bundled query evaluator with a local producer and no network."""

import json
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

from scripts.run_eval import run_single_query

scenario = sys.argv[1]
spawn = subprocess.Popen
wait_readable = select.select


def start_producer(_command, **kwargs):
    name = next(Path(kwargs["cwd"]).glob("*/commands/*.md")).stem
    message = {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Skill", "input": {"skill": name}},
    ]}}
    record = json.dumps(message) + ("" if scenario == "exited" else "\n")
    child = spawn([sys.executable, "-c", "import sys; sys.stdout.write(sys.argv[1])", record], **kwargs)
    if scenario == "slow-start":
        time.sleep(1.1)  # Starting the producer already used up the query budget.
    if scenario == "exited":
        child.wait()  # stdout is buffered in the pipe, not in the live process.
    return child


def resume_reader(*args):
    result = wait_readable(*args)
    if scenario == "late":
        time.sleep(1.1)  # The reader is not scheduled again until after its one-second deadline.
    return result


with tempfile.TemporaryDirectory() as root, patch("subprocess.Popen", start_producer), patch("select.select", resume_reader):
    timeout = int(sys.argv[2]) if len(sys.argv) > 2 else (1 if scenario == "late" else 30)
    print(run_single_query("query", "sample", "sample skill", timeout, root))
