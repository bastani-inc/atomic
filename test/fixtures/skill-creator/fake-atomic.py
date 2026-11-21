"""A stand-in for `atomic -p` used by the skill-creator script tests. No model, no network.

It waits FAKE_ATOMIC_STARTUP seconds when set, records how it was started in
FAKE_ATOMIC_LOG/<pid>.json, then plays the scenario that
FAKE_ATOMIC_PLAN (a JSON object of prompt -> scenario) or FAKE_ATOMIC_SCENARIO names:

  read-skill        the first tool call reads the --skill folder's SKILL.md (absolute path)
  read-skill-relative, read-skill-selector, read-skill-at
                    the same file as a cwd-relative path, with a :1-40 selector, with an @ prefix
  read-other        the first tool call reads another file in the same folder
  bash-first        the first tool call is bash
  answer            an answer without tool calls
  retry-then-read   a failed request, then a read of SKILL.md
  final-only        SKILL.md read only in message_end (no streaming events)
  unterminated      the read of SKILL.md without a final newline, then exit
  slow:<seconds>    the read of SKILL.md after a delay
  hold              a running query that prints nothing more until it is stopped
  hold-ignore-term  the same, ignoring SIGTERM
  hold-child        the same, after starting a process in its own session with a child of its own
                    (like a credential command), which it ends when asked to stop, as Atomic does
  stalled-child     the same, but it does not act on SIGTERM; with FAKE_ATOMIC_CLEAN_GRANDCHILD
                    set, the helper starts its child with an environment of its own, and with
                    FAKE_ATOMIC_HELPER_EXITS set the helper exits at once, leaving its child
  exit:<status>     exit at once with a status and a stderr line
  improve           text mode: an answer with <new_description> tags
"""

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

if os.environ.get("FAKE_ATOMIC_STARTUP"):
    # Slow to start: nothing is printed before this has passed.
    time.sleep(float(os.environ["FAKE_ATOMIC_STARTUP"]))
if hasattr(signal, "pthread_sigmask"):
    # Atomic's runtime starts with every signal unblocked, whatever mask its parent had.
    signal.pthread_sigmask(signal.SIG_SETMASK, set())

args = sys.argv[1:]
prompt = sys.stdin.buffer.read().decode("utf-8")
plan = json.loads(os.environ.get("FAKE_ATOMIC_PLAN", "{}"))
scenario = plan.get(prompt, os.environ.get("FAKE_ATOMIC_SCENARIO", "read-skill"))
skill_dir = Path(args[args.index("--skill") + 1]) if "--skill" in args else None
record = {
    "pid": os.getpid(),
    "ppid": os.getppid(),
    "args": args,
    "cwd": os.getcwd(),
    "prompt": prompt,
    "scenario": scenario,
    "heap": os.environ.get("ATOMIC_HEAP_MB"),
    "skill": (skill_dir / "SKILL.md").read_text(encoding="utf-8") if skill_dir else None,
}
log = Path(os.environ["FAKE_ATOMIC_LOG"])


def save() -> None:
    target = log / f"{os.getpid()}.json"
    target.with_suffix(".tmp").write_text(json.dumps(record), encoding="utf-8")
    os.replace(target.with_suffix(".tmp"), target)


def emit(event: dict, end: str = "\n") -> None:
    sys.stdout.write(json.dumps(event) + end)
    sys.stdout.flush()


def tool_call(name: str, arguments: dict, streamed: bool = True) -> None:
    call = {"type": "toolCall", "id": "call_0", "name": name, "arguments": arguments}
    if streamed:
        emit({"type": "message_update", "assistantMessageEvent": {"type": "toolcall_start", "contentIndex": 0, "toolName": name}})
        emit({"type": "message_update", "assistantMessageEvent": {"type": "toolcall_end", "contentIndex": 0, "toolCall": call}})
    emit({"type": "message_end", "message": {"role": "assistant", "content": [call], "stopReason": "toolUse"}})


def hold() -> None:
    save()
    while True:
        time.sleep(1)


save()
emit({"type": "session", "version": 4})
emit({"type": "agent_start"})
skill_file = str(skill_dir / "SKILL.md") if skill_dir else ""
if scenario == "read-skill":
    tool_call("read", {"path": skill_file})
elif scenario == "read-skill-relative":
    tool_call("read", {"path": os.path.relpath(skill_file, os.getcwd())})
elif scenario == "read-skill-selector":
    tool_call("read", {"path": skill_file + ":1-40"})
elif scenario == "read-skill-at":
    tool_call("read", {"path": "@" + skill_file})
elif scenario == "read-other":
    tool_call("read", {"path": str(skill_dir / "helper.py")})
elif scenario == "bash-first":
    tool_call("bash", {"command": f"cat {skill_file}"})
elif scenario == "answer":
    emit({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "Done."}], "stopReason": "stop"}})
    emit({"type": "agent_settled", "aborted": False})
elif scenario == "retry-then-read":
    emit({"type": "message_end", "message": {"role": "assistant", "content": [], "stopReason": "error"}})
    emit({"type": "auto_retry_start", "attempt": 1})
    tool_call("read", {"path": skill_file})
elif scenario == "final-only":
    tool_call("read", {"path": skill_file}, streamed=False)
elif scenario == "unterminated":
    call = {"type": "toolCall", "id": "call_0", "name": "read", "arguments": {"path": skill_file}}
    emit({"type": "message_end", "message": {"role": "assistant", "content": [call], "stopReason": "toolUse"}}, end="")
elif scenario.startswith("slow:"):
    time.sleep(float(scenario.split(":", 1)[1]))
    tool_call("read", {"path": skill_file})
elif scenario == "hold":
    hold()
elif scenario == "hold-ignore-term":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    hold()
elif scenario in ("hold-child", "stalled-child"):
    # Like Atomic's detached credential command: a process in its own session with a child of its own.
    code = (
        "import os, subprocess, sys, time\n"
        "environment = None\n"
        "if os.environ.get('FAKE_ATOMIC_CLEAN_GRANDCHILD'):\n"
        "    environment = {key: value for key, value in os.environ.items() if key == 'PATH'}\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time\\nwhile True: time.sleep(1)'], env=environment)\n"
        "print(child.pid, flush=True)\n"
        "while not os.environ.get('FAKE_ATOMIC_HELPER_EXITS'): time.sleep(1)"
    )
    helper = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, start_new_session=os.name != "nt")
    record["child"] = helper.pid
    record["grandchild"] = int(helper.stdout.readline())

    def end_with_helper(signum, _frame):
        # Atomic's print mode ends the processes it started when it is asked to stop.
        if os.name == "nt":
            helper.kill()
        else:
            os.killpg(helper.pid, signal.SIGKILL)
        helper.wait()
        os._exit(128 + signum)

    for name in ("SIGTERM", "SIGINT", "SIGHUP"):
        if hasattr(signal, name):
            stalled = scenario == "stalled-child" and name == "SIGTERM"
            # A stalled Atomic does not act on SIGTERM in time.
            signal.signal(getattr(signal, name), signal.SIG_IGN if stalled else end_with_helper)
    hold()
elif scenario.startswith("exit:"):
    sys.stderr.write("fake atomic failed on purpose\n")
    sys.exit(int(scenario.split(":", 1)[1]))
elif scenario == "improve":
    sys.stdout.write("<new_description>Use this skill for fake work. \u2713</new_description>\n")
else:
    sys.exit(f"unknown scenario {scenario}")
