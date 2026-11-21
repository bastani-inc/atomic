#!/usr/bin/env python3
"""Generate and serve a review page for eval results.

Reads the workspace directory, discovers runs (directories with outputs/),
embeds all output data into a self-contained HTML page, and serves it via
a tiny HTTP server. Feedback auto-saves to feedback.json in the workspace.

Usage:
    python generate_review.py <workspace-path> [--port PORT] [--skill-name NAME]
    python generate_review.py <workspace-path> --previous-feedback /path/to/old/feedback.json

No dependencies beyond the Python stdlib are required.
"""

import argparse
import base64
import codecs
import contextlib
import errno
import glob
import hashlib
import io
import json
import mimetypes
import os
import re
import secrets
import socket
import stat
import sys
import time
import webbrowser
from functools import partial
from typing import NamedTuple
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Files to exclude from output listings
METADATA_FILES = {"transcript.md", "user_notes.md", "metrics.json"}

# Extensions we render as inline text
TEXT_EXTENSIONS = {
    ".txt", ".md", ".json", ".csv", ".py", ".js", ".ts", ".tsx", ".jsx",
    ".yaml", ".yml", ".xml", ".html", ".css", ".sh", ".rb", ".go", ".rs",
    ".java", ".c", ".cpp", ".h", ".hpp", ".sql", ".r", ".toml",
}

# Extensions we render as inline images
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}

# MIME type overrides for common types
MIME_OVERRIDES = {
    ".svg": "image/svg+xml",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}


def get_mime_type(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in MIME_OVERRIDES:
        return MIME_OVERRIDES[ext]
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def find_runs(workspace: Path) -> list[dict]:
    """Recursively find directories that contain an outputs/ subdirectory."""
    runs: list[dict] = []
    _find_runs_recursive(workspace, workspace, runs)
    runs.sort(key=lambda r: (r.get("eval_id", float("inf")), r["id"]))
    return runs


def _find_runs_recursive(root: Path, current: Path, runs: list[dict]) -> None:
    if not current.is_dir():
        return

    outputs_dir = current / "outputs"
    if outputs_dir.is_dir():
        run = build_run(root, current)
        if run:
            runs.append(run)
        return

    skip = {"node_modules", ".git", "__pycache__", "skill", "inputs"}
    for child in sorted(current.iterdir()):
        if child.is_dir() and child.name not in skip:
            _find_runs_recursive(root, child, runs)


def read_text(path: Path) -> str | None:
    """A text file of the workspace, or None when it cannot be read.

    As a browser reads a page: UTF-8, with or without a byte order mark, and a replacement mark for
    anything that is not UTF-8, so a file saved in another encoding still shows rather than failing.
    Line endings read as "\n", whichever a file uses, as Python's text files read them.
    """
    try:
        text = path.read_bytes().decode("utf-8-sig", errors="replace")
    except OSError:
        return None
    return text.replace("\r\n", "\n").replace("\r", "\n")


def read_json(path: Path):
    """A JSON file of the workspace, or None when it cannot be read or is not JSON (or nested too deeply)."""
    text = read_text(path)
    if text is None:
        return None
    try:
        return json.loads(text)
    except (ValueError, RecursionError):
        return None


def build_run(root: Path, run_dir: Path) -> dict | None:
    """Build a run dict with prompt, outputs, and grading data."""
    prompt = ""
    eval_id = None

    # Try eval_metadata.json
    for candidate in [run_dir / "eval_metadata.json", run_dir.parent / "eval_metadata.json"]:
        if candidate.exists():
            metadata = read_json(candidate)
            if isinstance(metadata, dict):
                prompt = metadata.get("prompt", "")
                prompt = prompt if isinstance(prompt, str) else ""
                eval_id = metadata.get("eval_id")
            if prompt:
                break

    # Fall back to transcript.md
    if not prompt:
        for candidate in [run_dir / "transcript.md", run_dir / "outputs" / "transcript.md"]:
            if candidate.exists():
                text = read_text(candidate)
                match = re.search(r"## Eval Prompt\n\n([\s\S]*?)(?=\n##|$)", text or "")
                if match:
                    prompt = match.group(1).strip()
                if prompt:
                    break

    if not prompt:
        prompt = "(No prompt found)"

    run_id = str(run_dir.relative_to(root)).replace("/", "-").replace("\\", "-")

    # Collect output files
    outputs_dir = run_dir / "outputs"
    output_files: list[dict] = []
    if outputs_dir.is_dir():
        for f in sorted(outputs_dir.iterdir()):
            if f.is_file() and f.name not in METADATA_FILES:
                output_files.append(embed_file(f))

    # Load grading if present
    grading = None
    for candidate in [run_dir / "grading.json", run_dir.parent / "grading.json"]:
        if candidate.exists():
            grading = read_json(candidate)
            if not isinstance(grading, dict):
                grading = None
            if grading:
                break

    return {
        "id": run_id,
        "prompt": prompt,
        "eval_id": eval_id,
        "outputs": output_files,
        "grading": grading,
    }


def embed_file(path: Path) -> dict:
    """Read a file and return an embedded representation."""
    ext = path.suffix.lower()
    mime = get_mime_type(path)

    if ext in TEXT_EXTENSIONS:
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            content = "(Error reading file)"
        return {
            "name": path.name,
            "type": "text",
            "content": content,
        }
    elif ext in IMAGE_EXTENSIONS:
        try:
            raw = path.read_bytes()
            b64 = base64.b64encode(raw).decode("ascii")
        except OSError:
            return {"name": path.name, "type": "error", "content": "(Error reading file)"}
        return {
            "name": path.name,
            "type": "image",
            "mime": mime,
            "data_uri": f"data:{mime};base64,{b64}",
        }
    elif ext == ".pdf":
        try:
            raw = path.read_bytes()
            b64 = base64.b64encode(raw).decode("ascii")
        except OSError:
            return {"name": path.name, "type": "error", "content": "(Error reading file)"}
        return {
            "name": path.name,
            "type": "pdf",
            "data_uri": f"data:{mime};base64,{b64}",
        }
    elif ext == ".xlsx":
        try:
            raw = path.read_bytes()
            b64 = base64.b64encode(raw).decode("ascii")
        except OSError:
            return {"name": path.name, "type": "error", "content": "(Error reading file)"}
        return {
            "name": path.name,
            "type": "xlsx",
            "data_b64": b64,
        }
    else:
        # Binary / unknown — base64 download link
        try:
            raw = path.read_bytes()
            b64 = base64.b64encode(raw).decode("ascii")
        except OSError:
            return {"name": path.name, "type": "error", "content": "(Error reading file)"}
        return {
            "name": path.name,
            "type": "binary",
            "mime": mime,
            "data_uri": f"data:{mime};base64,{b64}",
        }


def load_previous_iteration(workspace: Path, notices: list[str] | None = None) -> dict[str, dict]:
    """Load previous iteration's feedback and outputs.

    Returns a map of run_id -> {"feedback": str, "outputs": list[dict]}. When its feedback.json, or part of it,
    cannot be read, what can is shown, and a notice saying so is added to notices; the file is never written.
    """
    result: dict[str, dict] = {}

    # Load feedback
    feedback = read_feedback(workspace / "feedback.json")
    feedback_map = {run_id: text for run_id, text in feedback.reviews.items() if text.strip()}
    if feedback.problem is not None and notices is not None:
        if feedback.reviews:
            notices.append(f"Not all of the previous iteration's feedback could be read ({feedback.problem}), so only what could is shown.")
        else:
            notices.append(f"The previous iteration's feedback could not be read ({feedback.problem}), so it is not shown.")

    # Load runs (to get outputs)
    prev_runs = find_runs(workspace)
    for run in prev_runs:
        result[run["id"]] = {
            "feedback": feedback_map.get(run["id"], ""),
            "outputs": run.get("outputs", []),
        }

    # Also add feedback for run_ids that had feedback but no matching run
    for run_id, fb in feedback_map.items():
        if run_id not in result:
            result[run_id] = {"feedback": fb, "outputs": []}

    return result


def creation_mode(path: Path) -> int:
    """The permissions to create a file standing in for path with: path's own when it exists (the umask can only
    narrow them), so its contents are never readable by more than path's were; a new file's otherwise."""
    try:
        return stat.S_IMODE(os.stat(path).st_mode)
    except OSError:
        return 0o666


class Feedback(NamedTuple):
    """A feedback.json as read: the reviews that could be read, the file's bytes (None when it is missing or cannot be
    read), and why any of it could not be read (None when all of it could)."""

    reviews: dict[str, str]
    raw: bytes | None
    problem: str | None


def read_feedback(path: Path) -> Feedback:
    """A feedback.json: every review with a run ID and feedback text.

    Read as the page's own request read it before: UTF-8, with or without a byte order mark (as Windows
    PowerShell 5 and older Notepad save it), and a replacement mark for what is not UTF-8.
    """
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return Feedback({}, None, None)
    except OSError as error:
        return Feedback({}, None, error.strerror or str(error))
    text = raw.decode("utf-8-sig", errors="replace")
    if not text.strip():
        # Empty: no feedback yet, as the page read it before.
        return Feedback({}, raw, None)
    try:
        data = json.loads(text)
    except (ValueError, RecursionError):
        return Feedback({}, raw, "it is not JSON")
    reviews = data.get("reviews") if isinstance(data, dict) else None
    if isinstance(data, dict) and reviews is None:
        # An object with no reviews, such as {}: no feedback, as the page read it before.
        return Feedback({}, raw, None)
    if not isinstance(reviews, list):
        return Feedback({}, raw, 'it has no "reviews" list')
    readable = {
        review["run_id"]: review["feedback"]
        for review in reviews
        if isinstance(review, dict) and isinstance(review.get("run_id"), str) and isinstance(review.get("feedback"), str)
    }
    problem = None if len(readable) == len(reviews) else "some reviews have no run ID or feedback text"
    return Feedback(readable, raw, problem)


def revision_of(raw: bytes | None) -> str:
    """The revision of feedback.json with these bytes (None: no file), which a save names as the one it was made from."""
    return "absent" if raw is None else "sha256:" + hashlib.sha256(raw).hexdigest()


# A page made from a feedback.json that could not be read sends this as the revision it was made from, which is
# never a file's: nothing is saved over that file.
UNREADABLE = "unreadable"


def keep_copy(path: Path, raw: bytes) -> str:
    """Keep the bytes of a feedback.json that could not be read in a new file next to it, and return its name.

    A copy already kept with the same bytes is reused, so reloading the page keeps one copy. The copy is
    a new file: an existing file or link of that name is never written through.
    """
    for existing in sorted(path.parent.glob(glob.escape(path.name) + ".corrupt-*")):
        with contextlib.suppress(OSError):
            if not existing.is_symlink() and existing.is_file() and existing.read_bytes() == raw:
                return existing.name
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for attempt in range(100):
        name = f"{path.name}.corrupt-{stamp}" + (f"-{attempt}" if attempt else "")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        try:
            handle = os.open(path.with_name(name), flags, creation_mode(path))
        except FileExistsError:
            continue
        with os.fdopen(handle, "wb") as copy:
            copy.write(raw)
        return name
    raise FileExistsError(f"no free name for a copy of {path.name}")


class SavedFeedback(NamedTuple):
    """What a served page starts from: the workspace's saved reviews, the revision of feedback.json they were read
    from, and notices for the page about what could not be read."""

    reviews: dict[str, str]
    revision: str
    notices: list[str]


def load_saved_feedback(feedback_path: Path) -> SavedFeedback:
    """The feedback already saved for the workspace under review, for the page to start from.

    Reopening or reloading the page, or starting the viewer again, shows it, and the next save keeps it.
    When it, or part of it, cannot be read, the page starts from what can, says so once, and keeps the
    file's bytes in a copy first, so the next save, which replaces the file, loses nothing. Viewing a
    page writes nothing otherwise.
    """
    feedback = read_feedback(feedback_path)
    name = feedback_path.name
    if feedback.problem is None:
        return SavedFeedback(feedback.reviews, revision_of(feedback.raw), [])
    if feedback.raw is None:
        return SavedFeedback({}, UNREADABLE, [
            f"{name} could not be read ({feedback.problem}), so this page starts with no feedback and saves nothing over it."
        ])
    try:
        copy = keep_copy(feedback_path, feedback.raw)
    except OSError as error:
        return SavedFeedback(feedback.reviews, UNREADABLE, [
            f"Not all of {name} could be read ({feedback.problem}), and a copy of it could not be kept "
            f"({error.strerror or error}), so this page shows what could be read and saves nothing over it."
        ])
    return SavedFeedback(feedback.reviews, revision_of(feedback.raw), [
        f"Not all of {name} could be read ({feedback.problem}), so this page shows only what could. The file was "
        f"kept as {copy}, and your next save here replaces {name}."
    ])


def file_revision(path: Path) -> str:
    """The revision of the file now there; raises OSError when it cannot be read."""
    try:
        return revision_of(path.read_bytes())
    except FileNotFoundError:
        return revision_of(None)


# How long a save waits for another viewer's save of the same workspace before it fails.
LOCK_WAIT_SECONDS = 10


@contextlib.contextmanager
def feedback_lock(feedback_path: Path):
    """Hold the workspace's save lock: viewers serving the same workspace check and write feedback.json one at a time.

    A save waits at most LOCK_WAIT_SECONDS for another viewer's, then fails with OSError, so a viewer that stopped
    in the middle of a save never stops this one from answering.
    """
    try:
        lock = open(feedback_path.with_name(f".{feedback_path.name}.lock"), "a+b")
    except PermissionError:
        lock = None
    if lock is None:
        # A folder that cannot take the lock file: saved as before, without it.
        yield
        return
    with lock:
        if os.name == "nt":
            import msvcrt

            def acquire() -> None:
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)

            def release() -> None:
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            def acquire() -> None:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

            def release() -> None:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

        deadline = time.monotonic() + LOCK_WAIT_SECONDS
        while True:
            try:
                acquire()
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise OSError(f"another viewer of this workspace has been saving for {LOCK_WAIT_SECONDS} s") from None
                time.sleep(0.05)
        try:
            yield
        finally:
            release()


def write_replacing(path: Path, content: bytes) -> None:
    """Replace a file with content in one step: written whole under another name next to it, then renamed, so a
    failure leaves the old file as it was and no one reads half a file. It keeps the old file's permissions.

    As writing it in place did before: a link is written through to the file it links to, a file that cannot
    be written is refused, and in a folder that cannot take new files a file that can be written is written in
    place. Errors name path, never the file written next to it.
    """
    # A link is written through to the file it links to.
    target = Path(os.path.realpath(path)) if path.is_symlink() else path
    if target.exists() and not os.access(target, os.W_OK):
        raise PermissionError(errno.EACCES, os.strerror(errno.EACCES), str(path))
    mode = creation_mode(target)
    temporary = target.with_name(f".{target.name}.{secrets.token_hex(4)}.tmp")
    try:
        handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), mode)
    except PermissionError:
        if not target.is_file():
            raise PermissionError(errno.EACCES, os.strerror(errno.EACCES), str(path)) from None
        # A folder that cannot take new files: the file is written in place.
        target.write_bytes(content)
        return
    try:
        with os.fdopen(handle, "wb") as file:
            file.write(content)
        if target.exists():
            # Exactly the old file's permissions, which the umask may have narrowed at creation.
            os.chmod(temporary, mode)
        for attempt in range(20):
            try:
                os.replace(temporary, target)
                break
            except PermissionError:
                # On Windows a program reading the file can hold it for a moment.
                if os.name != "nt" or attempt == 19:
                    raise
                time.sleep(0.05)
    except OSError as error:
        raise OSError(error.errno, error.strerror, str(path)) from None
    finally:
        with contextlib.suppress(OSError):
            temporary.unlink(missing_ok=True)


def generate_html(
    runs: list[dict],
    skill_name: str,
    previous: dict[str, dict] | None = None,
    benchmark: dict | None = None,
    saved: SavedFeedback | None = None,
    notices: list[str] | None = None,
) -> str:
    """Generate the complete standalone HTML page with embedded data.

    saved is the reviewed workspace's own feedback, which the served page starts from; a static page has
    none. notices are shown at the top of the page.
    """
    template_path = Path(__file__).parent / "viewer.html"
    template = template_path.read_text(encoding="utf-8")

    # Build previous_feedback and previous_outputs maps for the template
    previous_feedback: dict[str, str] = {}
    previous_outputs: dict[str, list[dict]] = {}
    if previous:
        for run_id, data in previous.items():
            if data.get("feedback"):
                previous_feedback[run_id] = data["feedback"]
            if data.get("outputs"):
                previous_outputs[run_id] = data["outputs"]

    embedded = {
        "skill_name": skill_name,
        "runs": runs,
        "previous_feedback": previous_feedback,
        "previous_outputs": previous_outputs,
        "saved_feedback": saved.reviews if saved else {},
        # The revision every save names as the one it was made from; a static page saves nowhere.
        "saved_revision": saved.revision if saved else None,
        "notices": [*(notices or []), *(saved.notices if saved else [])],
    }
    if benchmark:
        embedded["benchmark"] = benchmark

    # Inside the page's script element, "</script>" or "<!--" in an output or in feedback would end the script
    # or change how it is read: "</" and "<!" are written with JSON escapes, which read back as the same text.
    data_json = json.dumps(embedded).replace("</", "<\\/").replace("<!", "\\u003c!")

    return template.replace("/*__EMBEDDED_DATA__*/", f"const EMBEDDED_DATA = {data_json};")


# ---------------------------------------------------------------------------
# HTTP server (stdlib only, zero dependencies)
# ---------------------------------------------------------------------------

class ReviewServer(HTTPServer):
    """An HTTP server that never takes over a port another program listens on.

    On Windows, SO_REUSEADDR would let it bind a port that is already in use,
    so it asks for the port exclusively there instead.
    """

    allow_reuse_address = os.name != "nt"

    def server_bind(self) -> None:
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def start_server(port: int, handler) -> HTTPServer:
    """Serve on the given port, or on a free one when another program uses it."""
    try:
        return ReviewServer(("127.0.0.1", port), handler)
    except OSError:
        return ReviewServer(("127.0.0.1", 0), handler)


class ReviewHandler(BaseHTTPRequestHandler):
    """Serves the review HTML and handles feedback saves.

    Regenerates the HTML on each page load so that refreshing the browser
    picks up new eval outputs without restarting the server.
    """

    def __init__(
        self,
        workspace: Path,
        skill_name: str,
        feedback_path: Path,
        previous: dict[str, dict],
        benchmark_path: Path | None,
        notices: list[str],
        *args,
        **kwargs,
    ):
        self.workspace = workspace
        self.skill_name = skill_name
        self.feedback_path = feedback_path
        self.previous = previous
        self.benchmark_path = benchmark_path
        self.notices = notices
        super().__init__(*args, **kwargs)

    def do_GET(self) -> None:
        if self.path == "/" or self.path == "/index.html":
            # Regenerate HTML on each request (re-scans workspace for new outputs)
            runs = find_runs(self.workspace)
            benchmark = read_benchmark(self.benchmark_path)
            html = generate_html(
                runs, self.skill_name, self.previous, benchmark, load_saved_feedback(self.feedback_path), self.notices
            )
            content = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            # Never kept in the browser's cache: a tab it restores, or a page revisited through its history, is made
            # again here with the feedback saved since, rather than shown with what it embedded at first.
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        elif self.path == "/api/feedback":
            data = b"{}"
            if self.feedback_path.exists():
                data = self.feedback_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_error(404)

    def do_POST(self) -> None:
        if self.path != "/api/feedback":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
            if not isinstance(data, dict) or "reviews" not in data:
                raise ValueError("Expected JSON object with 'reviews' key")
        except (ValueError, RecursionError) as e:
            self.answer(500, {"error": str(e)})
            return
        # The page names the revision of feedback.json it made this save from; a save made from another one than
        # the file now there (another tab's or program's save came between) is refused, so it never overwrites
        # feedback it did not show. A request naming none is saved as before.
        expected = self.headers.get("If-Match")
        content = (json.dumps(data, indent=2) + "\n").encode("utf-8")
        try:
            with feedback_lock(self.feedback_path):
                current = file_revision(self.feedback_path)
                if expected is not None and expected != f'"{current}"':
                    self.answer(412, {"error": "feedback.json changed since this page was loaded", "revision": current})
                    return
                write_replacing(self.feedback_path, content)
        except OSError as e:
            self.answer(500, {"error": str(e)})
            return
        revision = revision_of(content)
        self.answer(200, {"ok": True, "revision": revision}, {"ETag": f'"{revision}"'})

    def answer(self, status: int, body: dict, headers: dict[str, str] | None = None) -> None:
        content = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format: str, *args: object) -> None:
        # Suppress request logging to keep terminal clean
        pass


def read_benchmark(path: Path | None) -> dict | None:
    """benchmark.json for the Benchmark tab, or None when there is none or it cannot be read."""
    benchmark = read_json(path) if path else None
    return benchmark if isinstance(benchmark, dict) else None


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate and serve eval review")
    parser.add_argument("workspace", type=Path, help="Path to workspace directory")
    parser.add_argument("--port", "-p", type=int, default=3117, help="Server port (default: 3117; a free port when it is in use)")
    parser.add_argument("--skill-name", "-n", type=str, default=None, help="Skill name for header")
    parser.add_argument(
        "--previous-workspace", type=Path, default=None,
        help="Path to previous iteration's workspace (shows old outputs and feedback as context)",
    )
    parser.add_argument(
        "--benchmark", type=Path, default=None,
        help="Path to benchmark.json to show in the Benchmark tab",
    )
    parser.add_argument(
        "--static", "-s", type=Path, default=None,
        help="Write standalone HTML to this path instead of starting a server",
    )
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    if not workspace.is_dir():
        print(f"Error: {workspace} is not a directory", file=sys.stderr)
        sys.exit(1)

    runs = find_runs(workspace)
    if not runs:
        print(f"No runs found in {workspace}", file=sys.stderr)
        sys.exit(1)

    skill_name = args.skill_name or workspace.name.replace("-workspace", "")
    feedback_path = workspace / "feedback.json"

    previous: dict[str, dict] = {}
    notices: list[str] = []
    if args.previous_workspace:
        previous = load_previous_iteration(args.previous_workspace.resolve(), notices)

    benchmark_path = args.benchmark.resolve() if args.benchmark else None
    benchmark = read_benchmark(benchmark_path)

    if args.static:
        html = generate_html(runs, skill_name, previous, benchmark, notices=notices)
        args.static.parent.mkdir(parents=True, exist_ok=True)
        args.static.write_text(html, encoding="utf-8")
        print(f"\n  Static viewer written to: {args.static}\n")
        sys.exit(0)

    handler = partial(ReviewHandler, workspace, skill_name, feedback_path, previous, benchmark_path, notices)
    server = start_server(args.port, handler)
    port = server.server_address[1]

    url = f"http://localhost:{port}"
    print(f"\n  Eval Viewer")
    print(f"  ─────────────────────────────────")
    print(f"  URL:       {url}")
    print(f"  Workspace: {workspace}")
    print(f"  Feedback:  {feedback_path}")
    if previous:
        print(f"  Previous:  {args.previous_workspace} ({len(previous)} runs)")
    if benchmark_path:
        print(f"  Benchmark: {benchmark_path}")
    print(f"\n  Press Ctrl+C to stop.\n")

    webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()


if __name__ == "__main__":
    # The output usually goes to a pipe or a file that an agent reads, in the ANSI code page on Windows:
    # write UTF-8, one line at a time, so the URL can be read as soon as the server is up. There is no
    # output to set up under pythonw, with standard output closed, or when a stream replaced it.
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace", line_buffering=True)
    # Errors in UTF-8 too, unless they already are or go to a stream that replaced the standard one.
    if isinstance(sys.stderr, io.TextIOWrapper) and codecs.lookup(sys.stderr.encoding).name != "utf-8":
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    main()
