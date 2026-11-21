"""Start Atomic for the description scripts and stop everything they start.

The scripts start `atomic` as their own child processes. Each child stays in
the shell job the scripts run in, so Ctrl+Z, fg, bg and Ctrl+C reach it
exactly as they reach the scripts. Each child is set up to start no processes
of its own: no extensions, MCP servers or command-running tools, and no second
Node process for a larger heap.

Only the thread that started a child signals, waits for and reaps it, so a
signal never reaches a process ID that the system has given to another
process. Cancelling only sets a flag. Every wait checks it at least every
POLL_SECONDS, and the waiting thread then stops its own child: SIGTERM, a
second SIGTERM if it is still running, then SIGKILL.

On Windows a child runs in a job object, which ends it and anything it starts
when the evaluation stops it or when the scripts' own process ends, and in a
console of its own without a window, so Ctrl+C, Ctrl+Break and closing the
scripts' console reach only the scripts, which then end the job.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path
from queue import Empty, SimpleQueue

POLL_SECONDS = 0.1
_POLL_NS = 100_000_000
# The first wait for a terminated job's processes to end.
_FIRST_JOB_POLL_NS = 1_000_000
# A child asked to stop has this many polls to exit before it is asked again, and as many again
# before it is killed. They are counted rather than timed: time the job spends stopped by Ctrl+Z
# does not use them up.
STOP_POLLS = 50
# Node's default heap is enough for one short run; Atomic then runs in a single process instead of
# starting a second one with a larger heap.
CHILD_ENVIRONMENT = {"ATOMIC_HEAP_MB": "0"}
# Nothing that starts processes: extensions, MCP servers, prompt templates. Tools are chosen per use.
ISOLATED_RUN = ["--no-session", "--no-extensions", "--no-mcp", "--no-prompt-templates"]
# Exit status of a Windows console program that Ctrl+C, Ctrl+Break or closing the console ended
# (STATUS_CONTROL_C_EXIT, 0xC000013A, as a signed 32-bit exit code).
WINDOWS_INTERRUPTED_STATUS = -1073741510
# Characters cmd.exe interprets in a batch file's arguments.
_BATCH_UNSAFE = frozenset('"%!^&|<>()\r\n')


class Cancelled(Exception):
    """The evaluation was cancelled by cancel() or by a stop signal."""


class AtomicNotFound(FileNotFoundError):
    """No `atomic` command to run."""


_generation = 0
# Evaluations, queries and improvement calls in progress, each counted before it creates a temporary
# folder or a process. While it is zero a stop signal has nothing to clean up and ends the script at once.
_owners = 0


def cancel() -> None:
    """Cancel every evaluation that started before this call.

    Running queries stop their Atomic processes, and the evaluation raises
    Cancelled. Safe to call from any thread and from a signal handler.
    """
    global _generation
    _generation += 1


class Cancellation:
    """One evaluation's cancellation: by cancel(), by a stop signal, or by its own cancel()."""

    def __init__(self) -> None:
        self._generation = _generation
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    @property
    def cancelled(self) -> bool:
        return self._cancelled or self._generation != _generation or _stop_signal is not None

    def check(self) -> None:
        if self.cancelled:
            raise Cancelled("The evaluation was cancelled")


class Owner:
    """Counts what is in progress, from before it creates anything until it has cleaned up."""

    def __enter__(self) -> Owner:
        global _owners
        _owners += 1
        return self

    def __exit__(self, *_exception: object) -> None:
        global _owners
        _owners -= 1


def atomic_command() -> list[str]:
    """The command that starts Atomic.

    That is the installation this skill ships in when it can be run directly,
    and otherwise `atomic` on PATH.
    """
    scripts = Path(__file__).resolve().parent
    # <root>/builtin/subagents/skills/skill-creator/scripts, where <root> is an npm or Bun
    # package's dist/ folder or the folder holding the standalone executable.
    builtin = scripts.parents[3]
    if builtin.name == "builtin":
        root = builtin.parent
        for name in ("atomic.exe", "atomic") if os.name == "nt" else ("atomic",):
            executable = root / name
            if executable.is_file() and os.access(executable, os.X_OK):
                return [str(executable)]
        node = shutil.which("node")
        if root.name == "dist" and (root / "cli.js").is_file() and node:
            return [node, str(root / "cli.js")]
    found = shutil.which("atomic")
    if found is None:
        raise AtomicNotFound("Atomic was not found: install it, or add the `atomic` command to PATH")
    if os.name == "nt" and Path(found).suffix.lower() in (".cmd", ".bat"):
        # npm's shim runs <prefix>/node_modules/@bastani/atomic/dist/cli.js with node. Running that
        # directly keeps cmd.exe from reading the arguments.
        cli = Path(found).parent / "node_modules" / "@bastani" / "atomic" / "dist" / "cli.js"
        bundled_node = Path(found).parent / "node.exe"
        node = str(bundled_node) if bundled_node.is_file() else shutil.which("node")
        if cli.is_file() and node:
            return [node, str(cli)]
    return [found]


def _check_batch_arguments(command: Sequence[str], arguments: Sequence[str]) -> None:
    if os.name != "nt" or Path(command[0]).suffix.lower() not in (".cmd", ".bat"):
        return
    for argument in arguments:
        if _BATCH_UNSAFE.intersection(argument):
            raise ValueError(
                f"{command[0]} is a batch file, which cannot be given {argument!r} safely; "
                "add Atomic's own executable to PATH instead"
            )


def remove_file(path: Path) -> None:
    """Remove a temporary file the scripts created, or a link in its place, never raising.

    A query then reports its own outcome rather than this cleanup's. On Windows a process that has not
    quite exited, or any other process, can hold the file open; removal is retried for a bounded time,
    then the file is left to the system's temporary folder.
    """
    for attempt in range(STOP_POLLS):
        try:
            path.unlink(missing_ok=True)
            return
        except OSError:
            if os.name != "nt" or attempt == STOP_POLLS - 1:
                return
            time.sleep(POLL_SECONDS)


def remove_folder(path: Path) -> None:
    """Remove a temporary folder the scripts created and everything in it, never raising.

    As shutil.rmtree(ignore_errors=True): an entry that cannot be removed does not keep the others,
    and a link or anything else in the folder's place is left alone. On Windows, removal is retried
    while part of the folder is held open, as remove_file retries.
    """
    for attempt in range(STOP_POLLS):
        shutil.rmtree(path, ignore_errors=True)
        # os.path's checks answer False, rather than raise, for a path they cannot examine.
        if os.name != "nt" or attempt == STOP_POLLS - 1 or not os.path.isdir(path) or os.path.islink(path):
            return
        time.sleep(POLL_SECONDS)


# ---------------------------------------------------------------------------
# One Atomic process
# ---------------------------------------------------------------------------

# Started on Windows in the job's place: it starts Atomic only after reading one byte, which the
# scripts write once the job holds it, so Atomic and everything it starts begin inside the job. If the
# scripts end first, the byte never comes and nothing is started.
_WINDOWS_GATE = "import os,subprocess,sys\nif os.read(0,1)!=b'1':sys.exit(1)\nsys.exit(subprocess.call(sys.argv[1:]))"


class AtomicProcess:
    """One `atomic` run: its prompt goes to standard input, its output is read line by line.

    Use it from one thread only, the one that created it, and close it on every path.
    """

    def __init__(
        self,
        arguments: Sequence[str],
        prompt: str,
        cwd: str | os.PathLike[str] | None,
        stderr_path: Path,
        cancellation: Cancellation,
        command: Sequence[str] | None = None,
        deadline_ns: int | None = None,
    ) -> None:
        cancellation.check()
        self._cancellation = cancellation
        command = list(command) if command is not None else atomic_command()
        _check_batch_arguments(command, arguments)
        argv = [*command, *arguments]
        environment = {**os.environ, **CHILD_ENVIRONMENT}
        self._stderr_path = stderr_path
        self._stderr = open(stderr_path, "wb")
        self._job: _WindowsJob | None = None
        self._lines: SimpleQueue[bytes | None] = SimpleQueue()
        data = prompt.encode("utf-8")

        def admit() -> None:
            # Checked again right before the start: a query that waited to start may have been
            # cancelled, or run out of time, in the meantime.
            cancellation.check()
            if deadline_ns is not None and time.monotonic_ns() >= deadline_ns:
                raise TimeoutError("Timed out before Atomic started")

        try:
            if os.name == "nt":
                self._job = _WindowsJob()
                admit()
                self.process = subprocess.Popen(
                    # -I -S: no environment variables, user site or site hooks act before the gate.
                    [sys.executable, "-I", "-S", "-c", _WINDOWS_GATE, *argv],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=self._stderr,
                    cwd=cwd,
                    env=environment,
                    # A hidden console of its own: the console events of the scripts' console reach only
                    # the scripts, which end the job, so no query ends before they know they were stopped.
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW,
                )
                try:
                    self._job.assign(self.process.pid)
                except BaseException:
                    self.process.stdin.close()
                    self.process.wait()
                    raise
                data = b"1" + data
            else:
                self.process = _start_in_job(argv, cwd, environment, self._stderr, admit)
        except BaseException:
            if self._job is not None:
                self._job.close()
            self._stderr.close()
            raise
        self._writer = threading.Thread(target=self._write, args=(data,), daemon=True)
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._writer.start()
        self._reader.start()

    def _write(self, data: bytes) -> None:
        try:
            self.process.stdin.write(data)
            self.process.stdin.close()
        except (OSError, ValueError):
            pass  # The process ended without reading its prompt; its exit status says why.

    def _read(self) -> None:
        try:
            for line in iter(self.process.stdout.readline, b""):
                self._lines.put(line)
        except (OSError, ValueError):
            pass
        finally:
            self._lines.put(None)

    def lines(self, deadline_ns: int | None = None) -> Iterator[bytes]:
        """Output lines until the end of output; the last one may lack its newline.

        Raises Cancelled when the evaluation is cancelled and TimeoutError once
        the monotonic deadline has passed, even for output that is waiting.
        """
        while True:
            self._cancellation.check()
            wait = POLL_SECONDS
            if deadline_ns is not None:
                remaining = deadline_ns - time.monotonic_ns()
                if remaining <= 0:
                    raise TimeoutError("Timed out waiting for Atomic")
                # A large budget need not fit a float or the platform's timer.
                wait = min(remaining, _POLL_NS) / 1_000_000_000
            try:
                line = self._lines.get(timeout=wait)
            except Empty:
                continue
            if line is None:
                return
            self._cancellation.check()
            if deadline_ns is not None and time.monotonic_ns() >= deadline_ns:
                raise TimeoutError("Timed out waiting for Atomic")
            yield line

    def wait_for_exit(self, deadline_ns: int | None = None, polls: int | None = None) -> int | None:
        """The exit status once the process has exited, or None if it still runs at the deadline
        or after `polls` polls. Raises Cancelled when the evaluation is cancelled."""
        while polls is None or polls > 0:
            self._cancellation.check()
            wait = POLL_SECONDS
            if deadline_ns is not None:
                remaining = deadline_ns - time.monotonic_ns()
                if remaining <= 0:
                    break
                wait = min(remaining, _POLL_NS) / 1_000_000_000
            try:
                return self.process.wait(wait)
            except subprocess.TimeoutExpired:
                if polls is not None:
                    polls -= 1
        return self.process.poll()

    def stderr_tail(self, limit: int = 2000) -> str:
        """The end of what the process wrote to standard error."""
        self._stderr.flush()
        with open(self._stderr_path, "rb") as stderr:
            stderr.seek(max(0, stderr.seek(0, os.SEEK_END) - limit))
            return stderr.read(limit).decode("utf-8", errors="replace").strip()

    def close(self) -> None:
        """Stop the process and anything it started, reap it, and release its pipes."""
        try:
            if self._job is not None:
                self._job.terminate()
                self.process.wait()
                # Every process in the job ends asynchronously and keeps its inherited handles,
                # such as the query's error output file, until it has exited.
                self._job.wait_until_empty()
            else:
                _stop(self.process)
                # A process it left behind can hold its output open, even after it exited by itself.
                # While another query's Atomic runs, an orphan may still be working for that one,
                # such as the rest of its credential command, so only a cancelled evaluation or the
                # last Atomic to end clears them.
                _end_orphans(only_when_idle=not self._cancellation.cancelled)
        finally:
            for thread, stream in ((self._writer, self.process.stdin), (self._reader, self.process.stdout)):
                for _ in range(STOP_POLLS):
                    if not thread.is_alive():
                        break
                    thread.join(POLL_SECONDS)
                if thread.is_alive():
                    # Still blocked on a pipe that something else keeps open: closing the stream
                    # would wait for that thread. The thread ends once the pipe does.
                    continue
                try:
                    stream.close()
                except OSError:
                    pass
            self._stderr.close()
            if self._job is not None:
                self._job.close()

    def __enter__(self) -> AtomicProcess:
        return self

    def __exit__(self, *_exception: object) -> None:
        self.close()


# Process IDs of the Atomic children this process started and has not reaped yet. Changed only with
# the lock held, around the start of a child, so a child is never seen unregistered.
_children_lock = threading.Lock()
_owned_pids: set[int] = set()
# A script run as a command on Linux adopts orphans from its first Atomic on: orphans of a killed
# Atomic become its children instead of init's, so they can be found and ended. It starts nothing
# else from then on, so every child it adopts descends from one of its Atomic processes.
_run_as_command = False
_adopts_orphans = False


def _start_in_job(
    argv: list[str], cwd, environment: dict[str, str], stderr, admit: Callable[[], None]
) -> subprocess.Popen[bytes]:
    """Start a child in this process's own process group, so the shell's job control reaches it.

    SIGTSTP stays blocked in this thread while the child is created. CPython may create it with
    vfork, which holds this thread until the child starts its program; a Ctrl+Z that stopped the
    child before then would keep this whole process from stopping, and the shell would never see
    the job stop. The child starts with SIGTSTP blocked; Atomic's runtime clears the mask when it
    starts, and a pending stop then takes effect unless the job was continued in the meantime.
    """
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTSTP})
    try:
        with _children_lock:
            admit()
            if _run_as_command and not _adopts_orphans:
                _adopt_orphans()
            process = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=stderr,
                cwd=cwd,
                env=environment,
            )
            _owned_pids.add(process.pid)
            return process
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def _stop(process: subprocess.Popen[bytes]) -> None:
    """Ask the child to stop (Atomic ends its own work on SIGTERM), ask again, then kill it.

    SIGCONT comes first each time, as with the shell's `kill`, so a child stopped on its own while
    this script runs can act on the request. The child is not reaped until it has exited, so its
    process ID still names it here.
    """
    try:
        for _ in range(2):
            if process.poll() is not None:
                return
            process.send_signal(signal.SIGCONT)
            process.send_signal(signal.SIGTERM)
            for _ in range(STOP_POLLS):
                try:
                    process.wait(POLL_SECONDS)
                    return
                except subprocess.TimeoutExpired:
                    continue
        # Atomic ends the processes it started when it handles SIGTERM. One that did not handle
        # either request is killed; on Linux, as a command, close() ends what it left behind.
        process.send_signal(signal.SIGCONT)
        process.kill()
        process.wait()
    finally:
        with _children_lock:
            _owned_pids.discard(process.pid)


def _child_pids() -> set[int]:
    """This process's children: Linux lists each thread's in /proc/self/task/<id>/children, or,
    without that file, each process's parent in /proc/<pid>/stat."""
    pids: set[int] = set()
    tasks = list(Path("/proc/self/task").iterdir())
    if all((task / "children").exists() for task in tasks):
        for task in tasks:
            try:
                pids.update(int(pid) for pid in (task / "children").read_bytes().split())
            except OSError:
                continue
        return pids
    me = os.getpid()
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            # The parent follows the parenthesized command name, which may itself contain ") ".
            fields = (entry / "stat").read_bytes().rsplit(b")", 1)[1].split()
        except (OSError, IndexError):
            continue
        if int(fields[1]) == me:
            pids.add(int(entry.name))
    return pids


def _end_orphans(only_when_idle: bool = False) -> None:
    """Kill and reap the orphans this process adopted from its Atomic processes, then theirs.

    Runs only when this process adopts orphans and, with `only_when_idle`, only when none of its
    Atomic processes runs. Each orphan is an unreaped child of this process while the lock is held,
    so its process ID still names it when it is signalled.
    """
    if not _adopts_orphans:
        return
    with _children_lock:
        if only_when_idle and _owned_pids:
            return
        while orphans := _child_pids() - _owned_pids:
            for pid in orphans:
                os.kill(pid, signal.SIGCONT)
                os.kill(pid, signal.SIGKILL)
            for pid in orphans:
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass


def _adopt_orphans() -> None:
    """Make this process the reaper of its descendants' orphans (Linux, scripts run as commands).

    Called with the lock held, before the first Atomic starts.
    """
    global _adopts_orphans
    if not sys.platform.startswith("linux") or not Path("/proc/self/task").is_dir():
        return
    import ctypes

    libc = ctypes.CDLL(None, use_errno=True)
    pr_set_child_subreaper = 36
    if libc.prctl(pr_set_child_subreaper, 1, 0, 0, 0) == 0:
        _adopts_orphans = True


class _WindowsJob:
    """A job object that ends every process in it when it is terminated or its last handle closes."""

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        class IoCounters(ctypes.Structure):
            _fields_ = [
                (name, ctypes.c_ulonglong)
                for name in (
                    "ReadOperationCount",
                    "WriteOperationCount",
                    "OtherOperationCount",
                    "ReadTransferCount",
                    "WriteTransferCount",
                    "OtherTransferCount",
                )
            ]

        class BasicLimits(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BasicLimits),
                ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        class Accounting(ctypes.Structure):
            _fields_ = [
                ("TotalUserTime", ctypes.c_int64),
                ("TotalKernelTime", ctypes.c_int64),
                ("ThisPeriodTotalUserTime", ctypes.c_int64),
                ("ThisPeriodTotalKernelTime", ctypes.c_int64),
                ("TotalPageFaultCount", wintypes.DWORD),
                ("TotalProcesses", wintypes.DWORD),
                ("ActiveProcesses", wintypes.DWORD),
                ("TotalTerminatedProcesses", wintypes.DWORD),
            ]

        self._accounting = Accounting
        kernel32.QueryInformationJobObject.restype = wintypes.BOOL
        kernel32.QueryInformationJobObject.argtypes = (
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.c_void_p,
        )
        kernel32.TerminateJobObject.restype = wintypes.BOOL
        kernel32.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        self._ctypes = ctypes
        self._kernel32 = kernel32
        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        self._handle = handle
        limits = ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        extended_limit_information = 9
        if not kernel32.SetInformationJobObject(
            handle, extended_limit_information, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def assign(self, pid: int) -> None:
        # The caller's Popen holds the process's handle, so this process ID cannot name another one.
        process_set_quota_and_terminate = 0x0100 | 0x0001
        process = self._kernel32.OpenProcess(process_set_quota_and_terminate, False, pid)
        if not process:
            raise self._ctypes.WinError(self._ctypes.get_last_error())
        try:
            if not self._kernel32.AssignProcessToJobObject(self._handle, process):
                raise self._ctypes.WinError(self._ctypes.get_last_error())
        finally:
            self._kernel32.CloseHandle(process)

    def terminate(self) -> None:
        if self._handle is not None:
            self._kernel32.TerminateJobObject(self._handle, 1)

    def wait_until_empty(self) -> None:
        """Wait, for a bounded time, until no process of the job is left.

        Terminated processes end within moments, so the first checks follow each other closely; the
        time between checks then doubles up to POLL_SECONDS. The waits add up to at most STOP_POLLS
        times POLL_SECONDS.
        """
        basic_accounting_information = 1
        accounting = self._accounting()
        budget_ns = STOP_POLLS * _POLL_NS
        wait_ns = _FIRST_JOB_POLL_NS
        while True:
            if self._handle is None or not self._kernel32.QueryInformationJobObject(
                self._handle,
                basic_accounting_information,
                self._ctypes.byref(accounting),
                self._ctypes.sizeof(accounting),
                None,
            ):
                return
            if accounting.ActiveProcesses == 0 or budget_ns == 0:
                return
            wait_ns = min(wait_ns, budget_ns)
            time.sleep(wait_ns / 1_000_000_000)
            budget_ns -= wait_ns
            wait_ns = min(2 * wait_ns, _POLL_NS)

    def close(self) -> None:
        if self._handle is not None:
            self._kernel32.CloseHandle(self._handle)
            self._handle = None


# ---------------------------------------------------------------------------
# Running a script as a command
# ---------------------------------------------------------------------------

_stop_signal: int | None = None
_finished = threading.Event()
_console_handler = None


def _on_stop_signal(signum: int, _frame: object) -> None:
    global _stop_signal
    if _stop_signal is None:
        _stop_signal = signum
    cancel()
    if _owners == 0:
        # Nothing started yet or left to clean up: end now, as the signal's default action would,
        # even while the main thread waits for input.
        _exit_by_signal(signum, flush=False)


def _install_stop_handlers() -> None:
    for name in ("SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"):
        signum = getattr(signal, name, None)
        # A signal the shell left ignored (nohup, or a background job's SIGINT) stays ignored.
        if signum is None or signal.getsignal(signum) == signal.SIG_IGN:
            continue
        signal.signal(signum, _on_stop_signal)
    if hasattr(signal, "SIGCHLD"):
        # A child stays unreaped, so its process ID keeps naming it, until this process waits for
        # it, even when SIGCHLD came in ignored.
        signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    if os.name == "nt":
        _install_console_close_handler()


def _install_console_close_handler() -> None:
    """Closing the console, logging off or shutting down: clean up during the time Windows allows."""
    import ctypes
    from ctypes import wintypes

    global _console_handler
    close_events = {2, 5, 6}  # CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)
    def handler(event: int) -> bool:
        if event not in close_events:
            return False  # Ctrl+C and Ctrl+Break reach the SIGINT and SIGBREAK handlers.
        # With nothing to clean up, this exits at once with the console-interrupt status.
        _on_stop_signal(signal.SIGINT, None)
        # Windows ends the process about five seconds after a close event: exit with the
        # console-interrupt status once the cleanup is done, before Windows ends it with another.
        _finished.wait(4)
        os._exit(WINDOWS_INTERRUPTED_STATUS)

    _console_handler = handler
    ctypes.WinDLL("kernel32").SetConsoleCtrlHandler(handler, True)


def open_in_browser(url: str) -> None:
    """Open a page in the user's browser, as webbrowser.open does, from a separate process.

    The browser is the user's: it is left open when the script ends or is stopped. Opening it
    from a process that has exited before the first Atomic starts keeps the browser outside
    the processes the script adopts and ends.
    """
    subprocess.run([sys.executable, "-I", "-c", "import sys, webbrowser; webbrowser.open(sys.argv[1])", url])


def _exit_by_signal(signum: int, flush: bool = True) -> None:
    if flush:
        sys.stdout.flush()
        sys.stderr.flush()
    if os.name == "nt":
        os._exit(WINDOWS_INTERRUPTED_STATUS)
    signal.signal(signum, signal.SIG_DFL)
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signum})
    os.kill(os.getpid(), signum)
    os._exit(128 + signum)


def run_main(main: Callable[[], None]) -> None:
    """Run a script's main() as a command.

    SIGINT, SIGTERM and SIGHUP (on Windows Ctrl+C, Ctrl+Break and closing the
    console) cancel the run. Its Atomic processes are stopped and its
    temporary files removed, then the script exits with that signal's status.
    Importing a script never installs these handlers.
    """
    global _run_as_command
    _install_stop_handlers()
    _run_as_command = True
    try:
        main()
    except Cancelled:
        if _stop_signal is None:
            raise
    except AtomicNotFound as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
    finally:
        _end_orphans()
        _finished.set()
    if _stop_signal is not None:
        _exit_by_signal(_stop_signal)
