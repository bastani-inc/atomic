"""Stands in for `claude -p` in the skill-creator script tests, with no network and no model.

It starts a child that only sleeps, as a tool the real command runs would, and records both
process ids in FAKE_CLAUDE_RECORDS once the child exists. FAKE_CLAUDE_MODE then decides what a query does,
and FAKE_CLAUDE_IMPROVE_MODE what a description improvement (`--output-format text`) does:
  wait     wait to be stopped
  trigger  report that the skill under evaluation was used, then wait to be stopped
  held-trigger  report the trigger only once the driver creates the allow-trigger file
  answer   answer the prompt on stdin with a description and exit, leaving the child running
  slow     wait FAKE_CLAUDE_SECONDS (no child, no record), report that the skill was not used, and exit
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

improving = "text" in sys.argv
mode = os.environ.get("FAKE_CLAUDE_IMPROVE_MODE", "answer") if improving else os.environ.get("FAKE_CLAUDE_MODE", "wait")
if mode == "slow":
    time.sleep(float(os.environ.get("FAKE_CLAUDE_SECONDS", "1")))
    print(json.dumps({"type": "result"}), flush=True)
    sys.exit(0)

records = Path(os.environ["FAKE_CLAUDE_RECORDS"])
child = subprocess.Popen(
    [sys.executable, "-c", "import time; time.sleep(600)"],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
record = records / f"{os.getpid()}.json"
partial = records / f"{os.getpid()}.partial"
partial.write_text(json.dumps({"pid": os.getpid(), "child": child.pid, "argv": sys.argv[1:]}))
os.replace(partial, record)

if mode in ("trigger", "held-trigger"):
    if mode == "held-trigger":
        while not (records / "allow-trigger").exists():
            time.sleep(0.01)
    name = next(Path.cwd().glob(".claude/commands/*.md")).stem
    use = {"type": "tool_use", "name": "Skill", "input": {"skill": name}}
    print(json.dumps({"type": "assistant", "message": {"content": [use]}}), flush=True)
elif mode == "answer":
    sys.stdin.read()
    print("<new_description>A clearer description.</new_description>", flush=True)
    sys.exit(0)
time.sleep(600)
