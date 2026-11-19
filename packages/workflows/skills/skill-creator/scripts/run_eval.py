#!/usr/bin/env python3
"""Run trigger evaluation for a skill description.

Tests whether a skill's description causes Claude to trigger (read the skill)
for a set of queries. Outputs results as JSON.
"""

import argparse
import atexit
import io
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from scripts.utils import parse_skill_md


# ---------------------------------------------------------------------------
# Commands and cancellation
#
# Every command these scripts run starts in a process group of its own (a
# kill-on-close job on Windows) through one thread that starts and ends all of
# them in request order, so a request to stop a command is always handled after
# the request that started it. Stopping a command ends its whole group, which is
# everything it started. A group is only ended before its leader is reaped, so
# its id cannot belong to a process these scripts did not start.
#
# Only that thread changes the set of running commands, and it takes no lock
# another thread could hold: an interrupt can leave a `with lock:` block
# without releasing the lock, which must not stop commands from being ended.
# ---------------------------------------------------------------------------

_STOP_SIGNALS = tuple(
    getattr(signal, name) for name in ("SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK") if hasattr(signal, name)
)
# 0xC000013A, the status Windows reports for a process ended by a console interrupt.
_STATUS_CONTROL_C_EXIT = -1073741510


class Cancelled(BaseException):
    """Raised by a call that cancel() or a stop signal ended.

    Like KeyboardInterrupt it is not an Exception, so code that counts failed
    queries does not count a cancelled one as a failure.
    """


_commands = set()  # commands started and not yet reaped; changed only by the actor
_scratch = set()  # temporary files not yet removed
_cancelled = False
_stop_signal = None  # the signal that cancelled this process, if one did
_local = threading.local()
_actor = None
_actor_start = threading.Lock()  # held only while the actor starts; the actor never takes it


class _Request:
    def __init__(self, function, args):
        self.function = function
        self.args = args
        # Held until the request has run. A plain lock is implemented in C, so an interrupt
        # cannot leave it half-waited the way it can a threading.Event.
        self.done = threading.Lock()
        self.done.acquire()
        self.value = None
        self.error = None


class _Actor:
    """The thread that starts and ends every command, one request at a time.

    A signal handler that raises can interrupt the thread that asked for a
    command at any point, but never this one, so a command it starts is always
    recorded and later ended.
    """

    def __init__(self):
        self.pid = os.getpid()
        self.requests = queue.SimpleQueue()
        self.suspending = False
        self.resume = None
        self.thread = threading.Thread(target=self._serve, name="skill-eval-commands", daemon=True)

    def _serve(self):
        while True:
            request = self.requests.get()
            try:
                request.value = request.function(*request.args)
            except BaseException as error:
                request.error = error
            finally:
                request.done.release()


def _command_actor():
    global _actor
    actor = _actor
    if actor is None:
        with _actor_start:
            if _actor is None:
                started = _Actor()
                started.thread.start()
                _actor = started
            actor = _actor
    return actor


def _in_actor(function, *args, wait=True):
    actor = _command_actor()
    request = _Request(function, args)
    actor.requests.put(request)
    if wait:
        request.done.acquire()
        if request.error is not None:
            raise request.error
        return request.value
    return request


class _Batch:
    """The commands one run_eval() call starts, so that an exception ending the call ends them too."""

    def __init__(self):
        self.stopped = False
        self.commands = set()

    def __enter__(self):
        return self

    def __exit__(self, kind, error, traceback):
        if kind is not None:
            self.stop()
        return False

    def run(self, function, *args, **kwargs):
        _local.batch = self
        try:
            return function(*args, **kwargs)
        finally:
            _local.batch = None

    def stop(self):
        self.stopped = True
        _end_all_soon(self.commands)


def _stopped(batch):
    return _cancelled or (batch is not None and batch.stopped)


def _check_stopped():
    if _stopped(getattr(_local, "batch", None)):
        raise Cancelled()


def _end_all(commands):
    for command in list(commands):
        command._end()


def _end_all_soon(commands):
    # Nothing has been started if the actor never has.
    if _actor is not None:
        return _in_actor(_end_all, commands, wait=False)
    return None


class _Output:
    """Reads one of a command's output pipes on a thread of its own.

    Waiting on a queue instead of the pipe works on every platform (Windows
    cannot select() a pipe), and a cancelled command's reader can be woken even
    if something outside the command still holds the pipe open.
    """

    def __init__(self, pipe):
        self._chunks = queue.SimpleQueue()
        self._ended = False
        self.thread = threading.Thread(target=self._pump, args=(pipe,), daemon=True)
        self.thread.start()

    def _pump(self, pipe):
        try:
            while True:
                try:
                    chunk = os.read(pipe.fileno(), 8192)
                except (OSError, ValueError):
                    chunk = b""
                self._chunks.put(chunk)
                if not chunk:
                    return
        finally:
            pipe.close()

    def wake(self):
        self._chunks.put(b"")

    def read(self, timeout):
        """The next chunk, b"" once the output has ended, or None if nothing arrived within timeout seconds."""
        if self._ended:
            return b""
        try:
            chunk = self._chunks.get(timeout=timeout)
        except queue.Empty:
            return None
        self._ended = not chunk
        return chunk

    def read_all(self, deadline_ns):
        """Everything until the output ends, or None if it has not ended by deadline_ns (None: no deadline)."""
        data = bytearray()
        while True:
            remaining_ns = None if deadline_ns is None else deadline_ns - time.monotonic_ns()
            if remaining_ns is not None and remaining_ns <= 0:
                return None
            chunk = self.read(1.0 if remaining_ns is None else min(remaining_ns, 1_000_000_000) / 1_000_000_000)
            if chunk == b"":
                return bytes(data)
            if chunk:
                data += chunk


def _write_text(pipe, text):
    # Encodes and closes stdin as subprocess.run(text=True) would.
    try:
        with io.TextIOWrapper(pipe, write_through=True) as writer:
            writer.write(text)
    except (OSError, ValueError):
        pass  # The command exited or was stopped without reading all of its input.


class _Command:
    """A command in a process group of its own (a job on Windows) that is always ended and reaped by close()."""

    def __init__(self):
        self.process = None
        self.stdout = None
        self.stderr = None
        self._owner = os.getpid()
        self._job = None
        self._batch = None
        self._requested = False
        self._ended = False  # never signalled again once set
        self._threads = []

    def start(self, args, input=None, **options):
        """Start args with subprocess.Popen options; PIPE outputs are read through self.stdout and self.stderr."""
        _check_stopped()
        self._batch = getattr(_local, "batch", None)
        self._requested = True
        return _in_actor(self._launch, args, input, options)

    def _launch(self, args, input, options):
        # Runs on the actor, so no stop request can be handled before this one finishes.
        if _stopped(self._batch):
            raise Cancelled()
        if os.name == "nt":
            process = self._launch_in_job(args, options)
        else:
            process = subprocess.Popen(args, start_new_session=True, **options)
        self.process = process
        _commands.add(self)
        if self._batch is not None:
            self._batch.commands.add(self)
        if process.stdout is not None:
            self.stdout = _Output(process.stdout)
            self._threads.append(self.stdout.thread)
        if process.stderr is not None:
            self.stderr = _Output(process.stderr)
            self._threads.append(self.stderr.thread)
        if process.stdin is not None:
            writer = threading.Thread(target=_write_text, args=(process.stdin, input or ""), daemon=True)
            writer.start()
            self._threads.append(writer)
        return process

    def _launch_in_job(self, args, options):
        # Until assignment the job cannot protect the suspended process itself. Windows ends a debuggee if
        # its debugger thread dies: keep that protection from creation until the job takes over, then detach
        # before running any of the command's code. No second process or inherited debug session is needed.
        windows = _windows()
        flags = options.pop("creationflags", 0) | subprocess.CREATE_NEW_PROCESS_GROUP
        guard = windows.CREATE_SUSPENDED | windows.DEBUG_ONLY_THIS_PROCESS
        guarded = True
        job = windows.new_job()
        try:
            try:
                process = subprocess.Popen(args, creationflags=flags | guard, **options)
            except OSError as error:
                if error.winerror != 50:  # ERROR_NOT_SUPPORTED: a 32-bit Python cannot debug a 64-bit command.
                    raise
                # Start it running, as a normal launch would; if this script dies before assignment, the
                # command can still finish. Never leave an unguarded, suspended process behind.
                guarded = False
                process = subprocess.Popen(args, creationflags=flags, **options)
        except BaseException:
            windows.close(job)
            raise
        try:
            windows.assign(job, process, may_have_exited=not guarded)
            if guarded:
                windows.detach(process)
                windows.resume(process)
        except BaseException:
            try:
                process.kill()  # Keep any launch guard until termination is requested.
                if guarded:
                    windows.detach(process, required=False)
                process.wait()
            finally:
                windows.close(job)
            raise
        self._job = job
        return process

    def _end(self):
        # Runs on the actor. The leader is not reaped yet, so the group is still this command's.
        if self.process is None or self._ended or self._owner != os.getpid():
            return
        self._ended = True
        if self.process.returncode is not None:
            return  # Already reaped by _exited(): its group id may belong to someone else now.
        if os.name == "nt":
            _windows().terminate(self._job)
        else:
            self._signal_group(signal.SIGKILL)
        for output in (self.stdout, self.stderr):
            if output is not None:
                output.wake()

    def _signal_group(self, signum):
        # Only the actor signals groups, and only before reaping the leader.
        try:
            os.killpg(self.process.pid, signum)
        except (ProcessLookupError, PermissionError):
            pass

    def _stop(self):
        # Runs on the actor: end the group, then reap the leader.
        if self.process is None or self._owner != os.getpid():
            return None
        self._end()
        returncode = self.process.wait()
        if self._job is not None:
            _windows().close(self._job)
            self._job = None
        _commands.discard(self)
        if self._batch is not None:
            self._batch.commands.discard(self)
        return returncode

    def wait_for_exit(self, deadline_ns):
        """Wait until the command exits by itself, without reaping it. False if it is still running at deadline_ns."""
        process = self.process
        while True:
            if os.name == "nt":
                try:
                    process.wait(timeout=0.05)
                    return True
                except subprocess.TimeoutExpired:
                    pass
            elif hasattr(os, "waitid"):
                if os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                    return True
                time.sleep(0.01)
            else:
                # Without waitid, reading the exit status reaps the command. The actor does that, so it never
                # ends a group after its leader is reaped; what the command left running then stays.
                if _in_actor(self._exited):
                    return True
                time.sleep(0.01)
            _check_stopped()
            if deadline_ns is not None and time.monotonic_ns() >= deadline_ns:
                return False

    def _exited(self):
        return self.process.poll() is not None

    def close(self):
        """End the command and everything it started, reap it, and return its exit status (None if it never started)."""
        if not self._requested:
            return None
        self._requested = False
        returncode = _in_actor(self._stop)
        for thread in self._threads:
            thread.join(timeout=2.0)
        return returncode


def _track_scratch(path):
    _scratch.add(path)


def _remove_scratch(path):
    # Forgotten only once removed, so an interrupted removal is finished at exit.
    path.unlink(missing_ok=True)
    _scratch.discard(path)


def cancel():
    """Stop everything evaluations in this process have started, and refuse to start more.

    For programs that import these scripts. It returns at once and can be called
    from a signal handler or another thread. Calls that were running raise
    Cancelled once their commands have been ended and their temporary files
    removed. Cancellation lasts for the rest of the process.
    """
    _cancel(None)


def _cancel(signum):
    global _cancelled, _stop_signal
    if _cancelled:
        return
    _stop_signal = signum
    _cancelled = True
    _end_all_soon(_commands)


def _on_stop_signal(signum, frame):
    _cancel(signum)


def _suspend_job(actor, signum):
    # Keep starts and reaps on hold until the shell continues the job. The signal handler must not wait
    # for us: it could have interrupted the main thread holding a lock we need to finish a launch.
    groups = [command for command in _commands if not command._ended and command.process.returncode is None]
    for command in groups:
        command._signal_group(signal.SIGSTOP)  # SIGTSTP is ignored by an orphaned process group.
    resumed = threading.Lock()
    resumed.acquire()
    actor.resume = resumed
    signal.pthread_kill(threading.main_thread().ident, signum)
    resumed.acquire()
    for command in groups:
        command._signal_group(signal.SIGCONT)


def _on_suspend(signum, frame):
    actor = _actor
    if actor is not None and actor.resume is None:
        if not _cancelled and not actor.suspending:
            actor.suspending = True
            _in_actor(_suspend_job, actor, signum, wait=False)
        return
    # Either no command can have started, or the actor has paused them all and signalled back.
    signal.signal(signum, signal.SIG_DFL)
    try:
        if not _cancelled:
            signal.raise_signal(signum)  # Preserve the shell's stop status and the default for orphaned jobs.
    finally:
        signal.signal(signum, _on_suspend)
        if actor is not None:
            resumed, actor.resume = actor.resume, None
            actor.suspending = False
            resumed.release()


def install_signal_handlers():
    """Make SIGINT, SIGTERM and SIGHUP cancel this process's evaluations (on Windows: Ctrl+C, Ctrl+Break and console close).

    The command-line entry points call this through run_cancellable(). Importing
    these scripts leaves the importer's handlers alone. A signal that is already
    ignored, as under nohup, stays ignored.
    """
    for signum in _STOP_SIGNALS:
        if signal.getsignal(signum) is not signal.SIG_IGN:
            signal.signal(signum, _on_stop_signal)
    if os.name == "nt":
        _windows().handle_console_events()
    elif signal.getsignal(signal.SIGTSTP) == signal.SIG_DFL:
        signal.signal(signal.SIGTSTP, _on_suspend)


def _wait_until_settled(timeout):
    deadline = time.monotonic() + timeout
    while (_commands or _scratch) and time.monotonic() < deadline:
        time.sleep(0.02)
    for path in list(_scratch):
        try:
            path.unlink()
        except OSError:
            pass


def _exit_by_signal(signum):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except (OSError, ValueError):
            pass
    if os.name == "nt" and signum != signal.SIGTERM:
        os._exit(_STATUS_CONTROL_C_EXIT)
    signal.signal(signum, signal.SIG_DFL)
    signal.raise_signal(signum)
    os._exit(128 + signum)


def run_cancellable(main):
    """Run a command-line entry point. A stop signal ends everything it started, then exits with that signal's status."""
    install_signal_handlers()
    try:
        main()
    except Cancelled:
        if _stop_signal is None:
            raise
    finally:
        if _stop_signal is not None:
            _exit_by_signal(_stop_signal)


def run_command(args, input=None, timeout=None, env=None):
    """subprocess.run(args, input=input, capture_output=True, text=True, timeout=timeout, env=env), except that
    the command runs in a group of its own that cancel() and stop signals end, and that is ended when it returns."""
    deadline_ns = None if timeout is None else time.monotonic_ns() + int(timeout * 1_000_000_000)
    command = _Command()
    try:
        stdin = subprocess.DEVNULL if input is None else subprocess.PIPE
        command.start(args, input=input, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        stdout = command.stdout.read_all(deadline_ns)
        stderr = None if stdout is None else command.stderr.read_all(deadline_ns)
        _check_stopped()
        if stderr is None or not command.wait_for_exit(deadline_ns):
            raise subprocess.TimeoutExpired(args, timeout)
        returncode = command.close()
        _check_stopped()
        text = [io.TextIOWrapper(io.BytesIO(data)).read() for data in (stdout, stderr)]
        return subprocess.CompletedProcess(args, returncode, *text)
    finally:
        command.close()


@atexit.register
def _end_commands_at_exit():
    # For an importer that exits while a call was still unwinding, for example
    # when an interrupt arrived just as the call began its cleanup.
    request = _end_all_soon(_commands) if _commands else None
    if request is not None:
        request.done.acquire(timeout=5)
    for path in list(_scratch):
        try:
            path.unlink()
        except OSError:
            pass


if hasattr(os, "register_at_fork"):

    def _forget_parent_commands():
        # A forked child did not start its parent's commands, so it must never end them.
        global _actor, _actor_start
        _commands.clear()
        _scratch.clear()
        _actor = None
        _actor_start = threading.Lock()

    os.register_at_fork(after_in_child=_forget_parent_commands)


_WINDOWS = None


def _windows():
    global _WINDOWS
    if _WINDOWS is None:
        _WINDOWS = _WindowsJobs()
    return _WINDOWS


class _WindowsJobs:
    """Kill-on-close job objects and console events, through the Windows API."""

    CREATE_SUSPENDED = 0x00000004
    DEBUG_ONLY_THIS_PROCESS = 0x00000002

    def __init__(self):
        import ctypes
        from ctypes import wintypes

        self._ctypes = ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        ntdll = ctypes.WinDLL("ntdll")

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ("read", "write", "other", "read_bytes", "write_bytes", "other_bytes")]

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

        self._ExtendedLimits = ExtendedLimits
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.DebugActiveProcessStop.argtypes = [wintypes.DWORD]
        kernel32.DebugActiveProcessStop.restype = wintypes.BOOL
        kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel32.TerminateJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        self._handler_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)
        kernel32.SetConsoleCtrlHandler.argtypes = [self._handler_type, wintypes.BOOL]
        kernel32.SetConsoleCtrlHandler.restype = wintypes.BOOL
        ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
        ntdll.NtResumeProcess.restype = ctypes.c_long
        self._kernel32 = kernel32
        self._ntdll = ntdll
        self._console_handler = None

    def _fail(self):
        raise self._ctypes.WinError(self._ctypes.get_last_error())

    def new_job(self):
        job = self._kernel32.CreateJobObjectW(None, None)
        if not job:
            self._fail()
        limits = self._ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        extended_limit_information = 9
        size = self._ctypes.sizeof(limits)
        if not self._kernel32.SetInformationJobObject(job, extended_limit_information, self._ctypes.byref(limits), size):
            error = self._ctypes.get_last_error()
            self._kernel32.CloseHandle(job)
            raise self._ctypes.WinError(error)
        return job

    def assign(self, job, process, may_have_exited=False):
        if not self._kernel32.AssignProcessToJobObject(job, int(process._handle)):
            error = self._ctypes.get_last_error()
            if may_have_exited and error == 5 and process.poll() is not None:
                return  # Windows denies assignment to an exited process. Its answer and exit status are still valid.
            raise self._ctypes.WinError(error)

    def detach(self, process, required=True):
        if not self._kernel32.DebugActiveProcessStop(process.pid) and required:
            self._fail()

    def resume(self, process):
        status = self._ntdll.NtResumeProcess(int(process._handle))
        if status < 0:
            raise OSError(f"could not resume {process.args!r}: NTSTATUS {status & 0xFFFFFFFF:#010x}")

    def terminate(self, job):
        self._kernel32.TerminateJobObject(job, 1)

    def close(self, job):
        self._kernel32.CloseHandle(job)

    def handle_console_events(self):
        def on_console_event(event):
            if event == 0:  # CTRL_C_EVENT
                _cancel(signal.SIGINT)
                return True
            if event == 1:  # CTRL_BREAK_EVENT
                _cancel(signal.SIGBREAK)
                return True
            # Closing the console, logging off or shutting down: Windows ends the process
            # as soon as this returns, so finish stopping everything first.
            _cancel(signal.SIGBREAK)
            _wait_until_settled(4.0)
            return False

        self._console_handler = self._handler_type(on_console_event)
        if not self._kernel32.SetConsoleCtrlHandler(self._console_handler, True):
            self._fail()


def find_project_root() -> Path:
    """Find the project root by walking up from cwd looking for .claude/.

    Mimics how Claude Code discovers its project root, so the command file
    we create ends up where claude -p will look for it.
    """
    current = Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / ".claude").is_dir():
            return parent
    return current


def run_single_query(
    query: str,
    skill_name: str,
    skill_description: str,
    timeout: int,
    project_root: str,
    model: str | None = None,
) -> bool:
    """Run a single query and return whether the skill was triggered.

    Creates a command file in .claude/commands/ so it appears in Claude's
    available_skills list, then runs `claude -p` with the raw query.
    Uses --include-partial-messages to detect triggering early from
    stream events (content_block_start) rather than waiting for the
    full assistant message, which only arrives after tool execution.
    """
    second_ns = 1_000_000_000
    deadline_ns = time.monotonic_ns() + timeout * second_ns

    def check_deadline():
        if time.monotonic_ns() >= deadline_ns:
            raise TimeoutError(f"Timed out after {timeout}s waiting for a skill trigger")

    unique_id = uuid.uuid4().hex[:8]
    clean_name = f"{skill_name}-skill-{unique_id}"
    project_commands_dir = Path(project_root) / ".claude" / "commands"
    command_file = project_commands_dir / f"{clean_name}.md"
    command = _Command()

    try:
        _check_stopped()
        project_commands_dir.mkdir(parents=True, exist_ok=True)
        # Use YAML block scalar to avoid breaking on quotes in description
        indented_desc = "\n  ".join(skill_description.split("\n"))
        command_content = (
            f"---\n"
            f"description: |\n"
            f"  {indented_desc}\n"
            f"---\n\n"
            f"# {skill_name}\n\n"
            f"This skill handles: {skill_description}\n"
        )
        _track_scratch(command_file)
        command_file.write_text(command_content)

        cmd = [
            "claude",
            "-p", query,
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
        ]
        if model:
            cmd.extend(["--model", model])

        # Remove CLAUDECODE env var to allow nesting claude -p inside a
        # Claude Code session. The guard is for interactive terminal conflicts;
        # programmatic subprocess usage is safe.
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

        check_deadline()
        command.start(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=project_root,
            env=env,
        )
        output = command.stdout

        def read_trigger():
            triggered = False
            buffer = b""
            pending_tool_name = None
            accumulated_json = ""
            while (remaining_ns := deadline_ns - time.monotonic_ns()) > 0:
                # A large user budget need not fit the operating system's timer.
                chunk = output.read(min(remaining_ns, second_ns) / second_ns)
                if chunk is None or time.monotonic_ns() >= deadline_ns:
                    continue

                if not chunk and not buffer:
                    break
                # EOF completes the last line even if the producer omitted its newline.
                buffer += chunk or b"\n"

                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    line = line.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue

                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    # Early detection via stream events
                    if event.get("type") == "stream_event":
                        se = event.get("event", {})
                        se_type = se.get("type", "")

                        if se_type == "content_block_start":
                            cb = se.get("content_block", {})
                            if cb.get("type") == "tool_use":
                                tool_name = cb.get("name", "")
                                if tool_name in ("Skill", "Read"):
                                    pending_tool_name = tool_name
                                    accumulated_json = ""
                                else:
                                    return False

                        elif se_type == "content_block_delta" and pending_tool_name:
                            delta = se.get("delta", {})
                            if delta.get("type") == "input_json_delta":
                                accumulated_json += delta.get("partial_json", "")
                                if clean_name in accumulated_json:
                                    return True

                        elif se_type in ("content_block_stop", "message_stop"):
                            if pending_tool_name:
                                return clean_name in accumulated_json
                            if se_type == "message_stop":
                                return False

                    # Fallback: full assistant message
                    elif event.get("type") == "assistant":
                        message = event.get("message", {})
                        for content_item in message.get("content", []):
                            if content_item.get("type") != "tool_use":
                                continue
                            tool_name = content_item.get("name", "")
                            tool_input = content_item.get("input", {})
                            if tool_name == "Skill" and clean_name in tool_input.get("skill", ""):
                                triggered = True
                            elif tool_name == "Read" and clean_name in tool_input.get("file_path", ""):
                                triggered = True
                            return triggered

                    elif event.get("type") == "result":
                        return triggered
            return False

        triggered = read_trigger()
        _check_stopped()
        check_deadline()
        return triggered
    finally:
        # On any exit path (return, exception, timeout, cancellation), end the
        # command and everything it started, then remove the command file.
        try:
            command.close()
        finally:
            _remove_scratch(command_file)


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
) -> dict:
    """Run the full eval set and return results."""
    results = []

    # Each query waits on its own `claude -p`, so threads run them as concurrently as processes would.
    # Leaving the block early (an interrupt or cancellation) ends the queries' commands instead of waiting for them.
    with ThreadPoolExecutor(max_workers=num_workers) as executor, _Batch() as batch:
        future_to_info = {}
        completed = queue.SimpleQueue()
        if eval_set and runs_per_query > 0 and os.name == "posix" and signal.getsignal(signal.SIGTSTP) is _on_suspend:
            _command_actor()  # Publish the actor before a worker can race the CLI's first suspend signal.
        for item in eval_set:
            for run_idx in range(runs_per_query):
                future = executor.submit(
                    batch.run,
                    run_single_query,
                    item["query"],
                    skill_name,
                    description,
                    timeout,
                    str(project_root),
                    model,
                )
                future_to_info[future] = (item, run_idx)
                future.add_done_callback(completed.put)

        query_triggers: dict[str, list[bool]] = {}
        query_items: dict[str, dict] = {}
        while future_to_info:
            # After SIGCONT a worker may receive a pending signal. Only the main thread can run its
            # Python handler, so don't sleep until the next query finishes. Results still wake us immediately.
            try:
                future = completed.get(timeout=0.25)
            except queue.Empty:
                continue
            item, _ = future_to_info.pop(future)
            query = item["query"]
            query_items[query] = item
            if query not in query_triggers:
                query_triggers[query] = []
            try:
                query_triggers[query].append(future.result())
            except Exception as e:
                print(f"Warning: query failed: {e}", file=sys.stderr)
                query_triggers[query].append(False)

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
    parser.add_argument("--model", default=None, help="Model to use for claude -p (default: user's configured model)")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
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
    run_cancellable(main)
