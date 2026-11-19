"""Stop the skill-creator scripts the ways Windows stops a console program, and report what they left behind.

  windows.py <scenario> <dir>   set up a project in dir, run the scenario, print a JSON report
Scenarios:
  triggers   a query whose command uses the skill is counted as a trigger
  improve    the description improver returns the command's answer and ends what the command left running
  terminate  the evaluator is terminated outright (TerminateProcess) while its queries run
  terminate-at-launch  the evaluator is terminated after Windows creates a command, before Popen returns
  break      Ctrl+Break to the evaluator's process group while its queries run
  ctrl-c     Ctrl+C in the evaluator's console while its queries run
  close      the evaluator's console is closed while its queries run
Console events need a console of their own, so those scenarios run in a hidden one (the "host" role). The evaluator
runs in the "program" role, which starts `claude` as the fake in test/fixtures/skill-creator-fake-claude.py: a stand-in
`claude.exe` cannot be a script, so that role substitutes it where the scripts start their commands.
"""

import ctypes
import json
import os
import runpy
import signal
import subprocess
import sys
import time
from ctypes import wintypes
from pathlib import Path

HERE = Path(__file__).resolve().parent
FAKE = HERE / "skill-creator-fake-claude.py"
STATUS_CONTROL_C_EXIT = 0xC000013A
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
kernel32.GetConsoleWindow.restype = wintypes.HWND
kernel32.GenerateConsoleCtrlEvent.argtypes = [wintypes.DWORD, wintypes.DWORD]
kernel32.SetConsoleCtrlHandler.argtypes = [ctypes.c_void_p, wintypes.BOOL]


def running(pid):
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def setup(root, queries):
    project = root / "project"
    (project / ".claude").mkdir(parents=True, exist_ok=True)
    skill = root / "skill"
    skill.mkdir(exist_ok=True)
    (skill / "SKILL.md").write_text("---\nname: probe\ndescription: Answers probe questions.\n---\n\n# Probe\n")
    (root / "eval.json").write_text(json.dumps([{"query": query, "should_trigger": True} for query in queries]))
    (root / "records").mkdir(exist_ok=True)
    return project


def environment(root, mode):
    skill_creator = HERE.parent.parent / "packages" / "workflows" / "skills" / "skill-creator"
    return {
        **os.environ,
        "PYTHONPATH": str(skill_creator),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "FAKE_CLAUDE_RECORDS": str(root / "records"),
        "FAKE_CLAUDE_MODE": mode,
    }


def program_command(root, module, *args):
    return [sys.executable, str(Path(__file__).resolve()), "program", str(root), module, *args]


def evaluator(root):
    args = ["--eval-set", str(root / "eval.json"), "--skill-path", str(root / "skill")]
    return program_command(root, "scripts.run_eval", *args, "--runs-per-query", "1", "--timeout", "600", "--num-workers", "2")


def fakes(root):
    return [json.loads(path.read_text()) for path in (root / "records").glob("*.json")]


def wait_for_fakes(root, count):
    deadline = time.monotonic() + 30
    while len(fakes(root)) < count:
        if time.monotonic() > deadline:
            raise SystemExit(f"only {len(fakes(root))} of {count} fake commands started")
        time.sleep(0.05)


def leftovers(root, project):
    pids = [pid for fake in fakes(root) for pid in (fake["pid"], fake["child"])]
    deadline = time.monotonic() + 5
    while any(running(pid) for pid in pids) and time.monotonic() < deadline:
        time.sleep(0.05)
    return {
        "running": [pid for pid in pids if running(pid)],
        "files": sorted(path.name for path in (project / ".claude" / "commands").glob("*.md")),
    }


def finish(program, limit=30):
    try:
        program.wait(timeout=limit)
    except subprocess.TimeoutExpired:
        program.kill()
        return "still running"
    return program.returncode & 0xFFFFFFFF


def host(scenario, root):
    project = root / "project"
    env = environment(root, "wait")
    if scenario == "break":
        program = subprocess.Popen(evaluator(root), cwd=project, env=env, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        wait_for_fakes(root, 2)
        os.kill(program.pid, signal.CTRL_BREAK_EVENT)
    elif scenario == "ctrl-c":
        # Whatever started this host may have disabled Ctrl+C for its descendants, which a terminal does not:
        # enable it for the evaluator, and ignore it here, since Ctrl+C reaches everything on this console.
        kernel32.SetConsoleCtrlHandler(None, False)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        program = subprocess.Popen(evaluator(root), cwd=project, env=env)
        wait_for_fakes(root, 2)
        kernel32.GenerateConsoleCtrlEvent(0, 0)  # CTRL_C_EVENT
    elif scenario == "close":
        program = subprocess.Popen(evaluator(root), cwd=project, env=env)
        wait_for_fakes(root, 2)
        window = kernel32.GetConsoleWindow()
        kernel32.FreeConsole()  # Survive the close to report on it.
        ctypes.WinDLL("user32").PostMessageW(window, 0x0010, 0, 0)  # WM_CLOSE
    else:
        raise SystemExit(f"unknown console scenario {scenario}")
    status = finish(program)
    (root / "report.json").write_text(json.dumps({"status": status, **leftovers(root, project)}))


def scenario(name, root):
    root.mkdir(parents=True, exist_ok=True)
    project = setup(root, ["question"] if name in ("triggers", "improve", "terminate-at-launch") else ["first question", "second question"])
    if name == "triggers":
        program = subprocess.run(evaluator(root), cwd=project, env=environment(root, "trigger"), capture_output=True, text=True, timeout=120)
        output = json.loads(program.stdout) if program.returncode == 0 else None
        triggers = output["results"][0]["triggers"] if output else None
        return {"status": program.returncode, "triggers": triggers, "stderr": program.stderr[-2000:], **leftovers(root, project)}
    if name == "improve":
        results = root / "results.json"
        failed = {"query": "question", "should_trigger": True, "trigger_rate": 0, "triggers": 0, "runs": 1, "pass": False}
        summary = {"total": 1, "passed": 0, "failed": 1}
        results.write_text(json.dumps({"description": "Answers probe questions.", "results": [failed], "summary": summary}))
        args = ["--eval-results", str(results), "--skill-path", str(root / "skill"), "--model", "any"]
        env = environment(root, "wait")
        env["FAKE_CLAUDE_IMPROVE_MODE"] = "answer"
        program = subprocess.run(program_command(root, "scripts.improve_description", *args), cwd=project, env=env, capture_output=True, text=True, timeout=120)
        output = json.loads(program.stdout) if program.returncode == 0 else None
        return {"status": program.returncode, "description": output and output["description"], "stderr": program.stderr[-2000:], **leftovers(root, project)}
    if name == "terminate-at-launch":
        # Stop one real launch at the creation boundary instead of waiting for the command to run any code.
        created = root / "created"
        env = {**environment(root, "wait"), "FAKE_CLAUDE_PAUSE_AT_CREATE": str(created)}
        program = subprocess.Popen(evaluator(root), cwd=project, env=env)
        handle = None
        try:
            deadline = time.monotonic() + 30
            while not created.exists():
                if program.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("no query command was created")
                time.sleep(0.01)
            pid = int(created.read_text())
            handle = kernel32.OpenProcess(0x00100001, False, pid)  # SYNCHRONIZE | PROCESS_TERMINATE
            if not handle:
                raise ctypes.WinError(ctypes.get_last_error())
            program.kill()
            program.wait(timeout=10)
            return {"exited": kernel32.WaitForSingleObject(handle, 5000) == 0}
        finally:
            if program.poll() is None:
                program.kill()
                program.wait(timeout=10)
            if handle:
                if kernel32.WaitForSingleObject(handle, 0) == 258:  # WAIT_TIMEOUT: clean up even on the old code.
                    kernel32.TerminateProcess(handle, 1)
                    kernel32.WaitForSingleObject(handle, 5000)
                kernel32.CloseHandle(handle)
    if name == "terminate":
        program = subprocess.Popen(evaluator(root), cwd=project, env=environment(root, "wait"))
        wait_for_fakes(root, 2)
        program.kill()  # TerminateProcess: no handler runs.
        program.wait()
        return {"status": program.returncode, "running": leftovers(root, project)["running"]}
    # A hidden console of its own, so console events reach only the evaluator.
    startup = subprocess.STARTUPINFO(dwFlags=subprocess.STARTF_USESHOWWINDOW, wShowWindow=0)
    hosted = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "host", name, str(root)],
        creationflags=subprocess.CREATE_NEW_CONSOLE,
        startupinfo=startup,
        timeout=120,
    )
    report = root / "report.json"
    if not report.exists():
        return {"status": f"host exited {hosted.returncode} without a report"}
    return json.loads(report.read_text())


def program(root, module, args):
    real = subprocess.Popen

    class FakeClaude(real):
        def __init__(self, command, *rest, **options):
            is_claude = isinstance(command, list) and command[:1] == ["claude"]
            pause = os.environ.get("FAKE_CLAUDE_PAUSE_AT_CREATE") if is_claude else None
            if pause:
                command = [sys.executable, "-c", "import time; time.sleep(1)"]
            elif is_claude:
                command = [sys.executable, str(FAKE), *command[1:]]
            super().__init__(command, *rest, **options)
            if pause:
                partial = Path(pause).with_suffix(".tmp")
                partial.write_text(str(self.pid))
                partial.replace(pause)
                time.sleep(30)  # An unscheduled launcher, not a simulated process or termination.

    subprocess.Popen = FakeClaude
    sys.argv = [module, *args]
    runpy.run_module(module, run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    role = sys.argv[1]
    if role == "program":
        program(Path(sys.argv[2]), sys.argv[3], sys.argv[4:])
    elif role == "host":
        host(sys.argv[2], Path(sys.argv[3]))
    else:
        print(json.dumps(scenario(role, Path(sys.argv[2]))))
