#!/usr/bin/env python3
"""Run trigger evaluation for a skill description.

Tests whether a skill's description causes the model to trigger (read the
skill) for a set of queries. Each query runs `atomic -p` with the candidate
skill loaded from a private temporary folder. Outputs results as JSON.
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from scripts.atomic_cli import ISOLATED_RUN, AtomicProcess, Cancellation, Cancelled, Owner, atomic_command, run_main
from scripts.utils import parse_skill_md

# A trailing read selector such as :raw, :conflicts, :12, :10-20, :5+3 or :1-5,9-12.
_READ_SELECTOR = re.compile(r":(?:raw|conflicts|\d+(?:[-+]\d+)?(?:,\d+(?:[-+]\d+)?)*)$")


def find_project_root() -> Path:
    """The directory the queries run in: the current one.

    Atomic reads a project's settings, skills and context files from the
    directory it starts in, so the queries see what a session started here
    sees.
    """
    return Path.cwd()


def write_candidate_skill(folder: Path, skill_name: str, skill_description: str) -> Path:
    """Write the candidate skill under a unique name and return its SKILL.md.

    The name keeps the skill's own name where it is a valid skill name, and is
    always one folder inside `folder`.
    """
    readable = re.sub(r"[^a-z0-9]+", "-", skill_name.lower()).strip("-")[:48].strip("-") or "skill"
    clean_name = f"{readable}-skill-{uuid.uuid4().hex[:8]}"
    skill_dir = folder / clean_name
    skill_dir.mkdir(parents=True)
    # Use YAML block scalar to avoid breaking on quotes in description
    indented_desc = "\n  ".join(skill_description.split("\n"))
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(
        f"---\n"
        f"name: {clean_name}\n"
        f"description: |\n"
        f"  {indented_desc}\n"
        f"---\n\n"
        f"# {skill_name}\n\n"
        f"This skill handles: {skill_description}\n",
        encoding="utf-8",
    )
    return skill_file


def _same_file(a: str, b: str) -> bool:
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def reads_skill_file(path: object, skill_file: Path, cwd: Path) -> bool:
    """Whether a read tool call's path names the candidate's SKILL.md.

    Accepts what Atomic's read tool accepts for that file: a relative or ~
    path, an @ prefix, and trailing selectors such as :1-40 or :raw.
    """
    if not isinstance(path, str) or not path:
        return False
    spellings = {path, path[1:] if path.startswith("@") else path}
    for spelling in list(spellings):
        while (stripped := _READ_SELECTOR.sub("", spelling)) != spelling:
            spelling = stripped
            spellings.add(spelling)
    for spelling in spellings:
        if spelling and _same_file(str(cwd / os.path.expanduser(spelling)), str(skill_file)):
            return True
    return False


_NO_CALL = object()


class TriggerDecision:
    """Decides, from Atomic's JSON event stream, whether the model triggered the skill.

    The model's first tool call decides: it triggered when that call reads the
    candidate's SKILL.md, and did not when it is another tool or another file.
    An answer without a tool call did not trigger.
    """

    def __init__(self, skill_file: Path, cwd: Path) -> None:
        self.skill_file = skill_file
        self.cwd = cwd
        self.result: bool | None = None
        self._first_call: object = _NO_CALL

    def _decide_call(self, name: object, arguments: object) -> None:
        if self.result is None:
            path = arguments.get("path") if isinstance(arguments, dict) else None
            self.result = name == "read" and reads_skill_file(path, self.skill_file, self.cwd)

    def feed(self, line: bytes) -> bool | None:
        if self.result is not None:
            return self.result
        try:
            event = json.loads(line.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            return None
        if not isinstance(event, dict):
            return None
        kind = event.get("type")
        if kind == "message_update":
            update = event.get("assistantMessageEvent") or {}
            if update.get("type") == "toolcall_start" and self._first_call is _NO_CALL:
                self._first_call = update.get("contentIndex")
                if update.get("toolName") != "read":
                    # Early detection: the first tool call is not a read.
                    self.result = False
            elif update.get("type") == "toolcall_end" and update.get("contentIndex") == self._first_call:
                call = update.get("toolCall") or {}
                self._decide_call(call.get("name"), call.get("arguments"))
        elif kind == "message_end":
            # Fallback: the full assistant message.
            message = event.get("message") or {}
            if message.get("role") == "assistant":
                for item in message.get("content") or []:
                    if isinstance(item, dict) and item.get("type") == "toolCall":
                        self._decide_call(item.get("name"), item.get("arguments"))
                        break
                else:
                    # An answer without tools. A failed request is retried, so it does not decide.
                    if message.get("stopReason") in ("stop", "length"):
                        self.result = False
        elif kind == "tool_execution_start":
            self._decide_call(event.get("toolName"), event.get("args"))
        elif kind == "agent_settled":
            self.result = False
        return self.result


def query_arguments(skill_file: Path, model: str | None) -> list[str]:
    """`atomic` arguments for one query: JSON events, the read tool only, the candidate skill."""
    arguments = ["-p", "--mode", "json", *ISOLATED_RUN, "--tools", "read", "--skill", str(skill_file.parent)]
    if model:
        arguments.extend(["--model", model])
    return arguments


def run_single_query(
    query: str,
    skill_name: str,
    skill_description: str,
    timeout: int,
    project_root: str,
    model: str | None = None,
    skill_file: Path | None = None,
    cancellation: Cancellation | None = None,
    command: list[str] | None = None,
) -> bool:
    """Run a single query and return whether the skill was triggered.

    The candidate skill is loaded from a private temporary folder (skill_file,
    or one written for this query) with `atomic -p --skill`, and the raw query
    is sent on standard input. Triggering is decided from the event stream as
    soon as the model's first tool call shows it, before any tool runs: the
    query's Atomic has the read tool only.
    """
    second_ns = 1_000_000_000
    deadline_ns = time.monotonic_ns() + timeout * second_ns
    cancellation = cancellation or Cancellation()
    try:
        return _run_query(
            query, skill_name, skill_description, project_root, model, skill_file, cancellation, command, deadline_ns
        )
    except TimeoutError:
        raise TimeoutError(f"Timed out after {timeout}s waiting for a skill trigger") from None


def _run_query(
    query: str,
    skill_name: str,
    skill_description: str,
    project_root: str,
    model: str | None,
    skill_file: Path | None,
    cancellation: Cancellation,
    command: list[str] | None,
    deadline_ns: int,
) -> bool:
    def check_deadline():
        if time.monotonic_ns() >= deadline_ns:
            raise TimeoutError("Timed out waiting for a skill trigger")

    with Owner():
        cancellation.check()
        own_folder = None
        if skill_file is None:
            own_folder = Path(tempfile.mkdtemp(prefix="skill-eval-"))
        try:
            if skill_file is None:
                skill_file = write_candidate_skill(own_folder, skill_name, skill_description)
            root = Path(project_root)
            decision = TriggerDecision(skill_file, root)
            stderr_path = skill_file.parent.parent / f"atomic-{uuid.uuid4().hex}.log"
            try:
                with AtomicProcess(
                    query_arguments(skill_file, model), query, root, stderr_path, cancellation, command, deadline_ns
                ) as atomic:
                    for line in atomic.lines(deadline_ns):
                        if decision.feed(line) is not None:
                            # A decision read after the deadline is a timeout.
                            check_deadline()
                            return decision.result
                    # Output ended in time without a decision: not triggered, unless Atomic failed.
                    check_deadline()
                    status = atomic.wait_for_exit(polls=5)
                    if status:
                        raise RuntimeError(f"atomic -p exited {status}: {atomic.stderr_tail()}")
                return False
            finally:
                stderr_path.unlink(missing_ok=True)
        finally:
            if own_folder is not None:
                shutil.rmtree(own_folder, ignore_errors=True)


def _run_queries(
    eval_set: list[dict],
    skill_name: str,
    description: str,
    num_workers: int,
    timeout: int,
    project_root: Path,
    runs_per_query: int,
    model: str | None,
    cancellation: Cancellation,
    command: list[str],
) -> tuple[dict[str, list[bool]], dict[str, dict]]:
    """Run every query in parallel and collect each one's triggers."""
    query_triggers: dict[str, list[bool]] = {}
    query_items: dict[str, dict] = {}
    folder = Path(tempfile.mkdtemp(prefix="skill-eval-"))
    try:
        skill_file = write_candidate_skill(folder, skill_name, description)
        executor = ThreadPoolExecutor(max_workers=num_workers)
        try:
            future_to_info = {}
            for item in eval_set:
                for run_idx in range(runs_per_query):
                    future = executor.submit(
                        run_single_query,
                        item["query"],
                        skill_name,
                        description,
                        timeout,
                        str(project_root),
                        model,
                        skill_file,
                        cancellation,
                        command,
                    )
                    future_to_info[future] = (item, run_idx)

            for future in as_completed(future_to_info):
                item, _ = future_to_info[future]
                query = item["query"]
                query_items[query] = item
                if query not in query_triggers:
                    query_triggers[query] = []
                try:
                    query_triggers[query].append(future.result())
                except Cancelled:
                    raise
                except Exception as e:
                    print(f"Warning: query failed: {e}", file=sys.stderr)
                    query_triggers[query].append(False)
        except BaseException:
            # Interrupted or cancelled: every running query stops its Atomic before this returns.
            cancellation.cancel()
            raise
        finally:
            executor.shutdown(wait=True, cancel_futures=True)
        cancellation.check()
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    return query_triggers, query_items


def run_eval(
    eval_set: list[dict],
    skill_name: str,
    description: str,
    num_workers: int,
    timeout: int,
    project_root: Path,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
    cancellation: Cancellation | None = None,
) -> dict:
    """Run the full eval set and return results.

    Raises Cancelled, once every query's Atomic has stopped, when the
    evaluation is cancelled by atomic_cli.cancel(), the cancellation's own
    cancel() or a stop signal.
    """
    cancellation = cancellation or Cancellation()
    with Owner():
        cancellation.check()
        command = atomic_command()
        query_triggers, query_items = _run_queries(
            eval_set, skill_name, description, num_workers, timeout, project_root,
            runs_per_query, model, cancellation, command,
        )

    results = []
    for query, triggers in query_triggers.items():
        item = query_items[query]
        trigger_rate = sum(triggers) / len(triggers)
        should_trigger = item["should_trigger"]
        if should_trigger:
            did_pass = trigger_rate >= trigger_threshold
        else:
            did_pass = trigger_rate < trigger_threshold
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "pass": did_pass,
        })

    passed = sum(1 for r in results if r["pass"])
    total = len(results)

    return {
        "skill_name": skill_name,
        "description": description,
        "results": results,
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Run trigger evaluation for a skill description")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--description", default=None, help="Override description to test")
    parser.add_argument("--num-workers", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout per query in seconds")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--model", default=None, help="Atomic model pattern, e.g. provider/id (default: your default model)")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text(encoding="utf-8"))
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description, content = parse_skill_md(skill_path)
    description = args.description or original_description
    project_root = find_project_root()

    if args.verbose:
        print(f"Evaluating: {description}", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_name=name,
        description=description,
        num_workers=args.num_workers,
        timeout=args.timeout,
        project_root=project_root,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        model=args.model,
    )

    if args.verbose:
        summary = output["summary"]
        print(f"Results: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
        for r in output["results"]:
            status = "PASS" if r["pass"] else "FAIL"
            rate_str = f"{r['triggers']}/{r['runs']}"
            print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    run_main(main)
