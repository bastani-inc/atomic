"""Use the skill-creator evaluator as a program that imports it would, and report what it left running.

The fake `claude` (test/fixtures/skill-creator-fake-claude.py) is on PATH. Usage:
  importer.py <project> interrupt-every-line   Ctrl+C at each line the caller's thread runs during a query
  importer.py <project> cancel-from-thread     another thread calls cancel() while queries run
  importer.py <project> cancel-from-handler    the importer's own SIGTERM handler calls cancel()
  importer.py <project> keep-handlers          evaluating leaves the importer's signal handlers in place
The last line printed is a JSON report.
"""

import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

records = Path(os.environ.get("FAKE_CLAUDE_RECORDS", "."))
project = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()


def report(**fields):
    print(json.dumps(fields), flush=True)
    sys.exit(0)


def descendants():
    """Running processes this one started, directly or not: the sweep makes this process the subreaper for its
    descendants, so one that loses its parent becomes its child."""
    pids = []
    for task in Path(f"/proc/{os.getpid()}/task").iterdir():
        try:
            pids += [int(pid) for pid in (task / "children").read_text().split()]
        except OSError:
            pass
    running = []
    for pid in pids:
        try:
            state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
        except OSError:
            continue
        if state == "Z":
            os.waitpid(pid, os.WNOHANG)  # an adopted orphan that has exited
        elif state != "X":
            running.append(pid)
    return running


def leftovers():
    """Fake commands or their children still running, and command files still present."""
    running = set()
    for record in records.glob("*.json"):
        fake = json.loads(record.read_text())
        for pid in (fake["pid"], fake["child"]):
            try:
                state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
            except OSError:
                continue
            if state not in ("Z", "X"):
                running.add(pid)
    running.update(descendants())
    files = sorted(path.name for path in (project / ".claude" / "commands").glob("*.md"))
    return sorted(running), files


def settled_leftovers():
    # The kernel needs a moment to finish processes that were just killed.
    for _ in range(100):
        running, files = leftovers()
        if not running and not files:
            break
        time.sleep(0.02)
    return running, files


def kill_leftovers(pids):
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def started(count):
    for _ in range(2000):
        if len(list(records.glob("*.json"))) >= count:
            return
        time.sleep(0.01)
    raise SystemExit(f"only {len(list(records.glob('*.json')))} of {count} fake commands started")


def eval_args(queries, timeout):
    return dict(
        eval_set=[{"query": query, "should_trigger": True} for query in queries],
        skill_name="probe",
        description="Answers probe questions.",
        num_workers=len(queries),
        timeout=timeout,
        project_root=project,
    )


def main():
    scenario = sys.argv[2]
    if scenario == "keep-handlers":
        def mine(signum, frame):
            pass

        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(signum, mine)
        from scripts import improve_description, run_eval, run_loop  # noqa: F401

        output = run_eval.run_eval(**eval_args(["question"], 30))
        kept = all(signal.getsignal(signum) is mine for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP))
        report(kept=kept, triggers=output["results"][0]["triggers"])

    from scripts import run_eval

    if scenario == "interrupt-every-line":
        import ctypes

        # Orphaned descendants of the children forked below become this process's children.
        pr_set_child_subreaper = 36
        ctypes.CDLL(None).prctl(pr_set_child_subreaper, 1, 0, 0, 0)
        evaluator = str(Path(run_eval.__file__).resolve())
        launcher = str(Path(subprocess.__file__).resolve())

        def interrupted_query(point):
            """In a forked child: deliver SIGINT at the point-th line the evaluator (or its process launcher) runs on
            this thread, as Ctrl+C can, then exit the way an importer does. Exit status 3: the query finished first."""
            seen = 0

            def tracer(frame, event, arg):
                nonlocal seen
                if event == "line" and frame.f_code.co_filename in (evaluator, launcher):
                    seen += 1
                    if seen == point:
                        where = f"{Path(frame.f_code.co_filename).name}:{frame.f_lineno} in {frame.f_code.co_name}"
                        (project.parent / "where").write_text(where)
                        signal.raise_signal(signal.SIGINT)
                return tracer

            status = 3
            sys.settrace(tracer)
            try:
                run_eval.run_single_query("question", "probe", "Answers probe questions.", 30, str(project))
                for _ in range(3):
                    pass  # A signal sent at the query's last line is raised here.
            except BaseException:
                status = 0
            finally:
                sys.settrace(None)
            sys.exit(status if seen < point else 0)

        point = 0
        while True:
            point += 1
            child = os.fork()
            if child == 0:
                interrupted_query(point)
            _, status = os.waitpid(child, 0)
            running, files = [], []
            for _ in range(50):
                running = descendants()
                files = sorted(path.name for path in (project / ".claude" / "commands").glob("*.md"))
                if not running and not files:
                    break
                time.sleep(0.02)
            if running or files:
                where = (project.parent / "where").read_text()
                kill_leftovers(running)
                report(point=point, where=where, running=running, files=files)
            if os.waitstatus_to_exitcode(status) == 3:
                report(points=point - 1, running=[], files=[])

    if scenario in ("cancel-from-thread", "cancel-from-handler"):
        if scenario == "cancel-from-handler":
            signal.signal(signal.SIGTERM, lambda signum, frame: run_eval.cancel())
            print("ready", flush=True)
        else:
            def cancel_once_started():
                started(2)
                run_eval.cancel()

            threading.Thread(target=cancel_once_started, daemon=True).start()
        began = time.monotonic()
        try:
            run_eval.run_eval(**eval_args(["first question", "second question"], 600))
            outcome = "finished"
        except run_eval.Cancelled:
            outcome = "cancelled"
        elapsed = time.monotonic() - began
        running, files = settled_leftovers()
        kill_leftovers(running)
        report(outcome=outcome, seconds=round(elapsed, 2), running=running, files=files)

    raise SystemExit(f"unknown scenario {scenario}")


if __name__ == "__main__":
    main()
