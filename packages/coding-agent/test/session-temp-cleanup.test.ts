/**
 * Age-based sweeper for tool-output storage: what it reaps, what it refuses to
 * reap, how the marker/lock keep concurrent sessions from racing, and why a
 * symlink is never followed out of the target.
 */
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../../../test/helpers/runtime.ts";
import { redirectOversizedToolResult } from "../src/core/tools/oversized-tool-result.ts";
import {
	CLEANUP_CONTROL_SUBDIR,
	CLEANUP_LOCK_FILE,
	CLEANUP_MARKER_FILE,
	getCleanupControlDir,
	resetSessionTempCleanupScheduleForTesting,
	runSessionTempCleanup,
	SESSION_TEMP_CLEANUP_DELAY_MS,
	SESSION_TEMP_CLEANUP_INTERVAL_MS,
	SESSION_TEMP_CLEANUP_LOCK_STALE_MS,
	SESSION_TEMP_RETENTION_DAYS,
	SESSION_TEMP_RETENTION_MS,
	scheduleSessionTempCleanup,
	sweepSessionDirToolResults,
	sweepSessionTempRoot,
	sweepToolResultsRoot,
} from "../src/core/tools/session-temp-cleanup.ts";
import { acquireProtectedPaths, SESSION_TEMP_FILE_MODE } from "../src/core/tools/session-temp-dir.ts";
import { DEFAULT_MAX_RESULT_SIZE_CHARS, TOOL_RESULTS_SUBDIR } from "../src/core/tools/tool-limits.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Anchored to the real clock: the marker's freshness is read from its mtime, so a
// simulated "now" in the past would make every freshly written marker look future-dated.
const NOW = Date.now();

/** Symlink creation needs elevation or developer mode on Windows. */
const skipSymlinks = process.platform === "win32";

let sandbox: string;
/** Control root for session-storage sweeps, kept inside the per-test sandbox. */
let controlRoot: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "atomic-session-temp-cleanup-"));
	controlRoot = join(sandbox, "control");
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

/** Create a directory holding one file, both stamped `ageDays` old. */
function makeAgedDir(parent: string, name: string, ageDays: number): string {
	const dir = join(parent, name);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "output.log");
	writeFileSync(file, "output");
	const seconds = (NOW - ageDays * MS_PER_DAY) / 1000;
	utimesSync(file, seconds, seconds);
	utimesSync(dir, seconds, seconds);
	return dir;
}

function stampAge(path: string, ageDays: number): void {
	const seconds = (NOW - ageDays * MS_PER_DAY) / 1000;
	utimesSync(path, seconds, seconds);
}

describe("session temp cleanup constants", () => {
	it("uses a 30-day retention, a 24-hour throttle, and a deferred sweep", () => {
		assert.equal(SESSION_TEMP_RETENTION_DAYS, 30);
		assert.equal(SESSION_TEMP_RETENTION_MS, 30 * MS_PER_DAY);
		assert.equal(SESSION_TEMP_CLEANUP_INTERVAL_MS, MS_PER_DAY);
		assert.equal(SESSION_TEMP_CLEANUP_LOCK_STALE_MS, 60 * 60 * 1000);
		assert.ok(SESSION_TEMP_CLEANUP_DELAY_MS > 0);
	});

	it("uses the required marker and lock names for every root", () => {
		assert.equal(CLEANUP_MARKER_FILE, ".last-cleanup");
		assert.equal(CLEANUP_LOCK_FILE, ".cleanup.lock");
	});
});

describe("sweepSessionTempRoot", () => {
	it("removes trees past the retention cutoff and keeps fresh ones", () => {
		const stale = makeAgedDir(sandbox, "stale-session", 45);
		const fresh = makeAgedDir(sandbox, "fresh-session", 2);
		const justInside = makeAgedDir(sandbox, "just-inside-session", 29);

		assert.equal(sweepSessionTempRoot(sandbox, { now: NOW, protectedPaths: [] }), "swept");

		assert.equal(existsSync(stale), false);
		assert.equal(existsSync(fresh), true);
		assert.equal(existsSync(justInside), true);
	});

	it("reaps only stale session directories and preserves every loose root file", () => {
		const transcript = join(sandbox, "session.jsonl");
		const loose = join(sandbox, "loose-output.log");
		const transcriptContent = '{"type":"session"}\n';
		const looseContent = "not a session tree";
		writeFileSync(transcript, transcriptContent);
		writeFileSync(loose, looseContent);
		stampAge(transcript, 60);
		stampAge(loose, 60);
		const staleSession = makeAgedDir(sandbox, "stale-real-session", 60);

		assert.equal(sweepSessionTempRoot(sandbox, { now: NOW, protectedPaths: [] }), "swept");
		assert.equal(readFileSync(transcript, "utf8"), transcriptContent);
		assert.equal(readFileSync(loose, "utf8"), looseContent);
		assert.equal(existsSync(staleSession), false);
	});

	it.skipIf(skipSymlinks)("keeps a linked directory entry and its outside contents", () => {
		const outside = mkdtempSync(join(tmpdir(), "atomic-session-temp-outside-"));
		try {
			const outsideFile = join(outside, "keep.txt");
			writeFileSync(outsideFile, "outside");
			stampAge(outsideFile, 60);
			stampAge(outside, 60);
			const link = join(sandbox, "linked-session-entry");
			symlinkSync(outside, link, "dir");

			assert.equal(sweepSessionTempRoot(sandbox, { now: NOW, protectedPaths: [] }), "swept");
			assert.equal(lstatSync(link).isSymbolicLink(), true);
			assert.equal(readFileSync(outsideFile, "utf8"), "outside");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("keeps an old tree that still holds one fresh file", () => {
		const dir = makeAgedDir(sandbox, "mixed-session", 60);
		const fresh = join(dir, "recent.log");
		writeFileSync(fresh, "recent");
		stampAge(fresh, 1);
		stampAge(dir, 60);

		sweepSessionTempRoot(sandbox, { now: NOW, protectedPaths: [] });

		assert.equal(existsSync(dir), true);
		assert.equal(existsSync(fresh), true);
	});

	it("never reaps a session this process registered as live", () => {
		const live = makeAgedDir(sandbox, "live-session", 90);

		assert.equal(sweepSessionTempRoot(sandbox, { now: NOW, protectedPaths: [live] }), "swept");

		assert.equal(existsSync(live), true);
	});

	it("leaves its own control directory alone", () => {
		const control = join(sandbox, CLEANUP_CONTROL_SUBDIR);
		mkdirSync(control, { recursive: true });
		const staleMarker = join(control, "aaaa");
		mkdirSync(staleMarker);
		stampAge(staleMarker, 90);
		stampAge(control, 90);

		sweepSessionTempRoot(sandbox, { now: NOW, protectedPaths: [] });

		assert.equal(existsSync(staleMarker), true, "the control root holds live throttle state");
	});

	it("writes the marker into the root and throttles the next sweep for 24 hours", () => {
		makeAgedDir(sandbox, "stale-a", 45);
		assert.equal(sweepSessionTempRoot(sandbox, { now: NOW, protectedPaths: [] }), "swept");
		assert.equal(existsSync(join(sandbox, CLEANUP_MARKER_FILE)), true);

		const laterStale = makeAgedDir(sandbox, "stale-b", 45);
		const throttledAt = NOW + SESSION_TEMP_CLEANUP_INTERVAL_MS - 1;
		assert.equal(sweepSessionTempRoot(sandbox, { now: throttledAt, protectedPaths: [] }), "throttled");
		assert.equal(existsSync(laterStale), true);
	});

	it.skipIf(skipSymlinks)("replaces a marker symlink without touching its transcript target", () => {
		const transcript = join(sandbox, "2026-01-01-session.jsonl");
		const transcriptContent = '{"type":"session"}\n';
		writeFileSync(transcript, transcriptContent);
		chmodSync(transcript, 0o644);
		stampAge(transcript, 60);
		const transcriptMode = statSync(transcript).mode & 0o777;
		const marker = join(sandbox, CLEANUP_MARKER_FILE);
		symlinkSync(transcript, marker);
		const staleSession = makeAgedDir(sandbox, "stale-with-hostile-marker", 60);

		assert.equal(sweepSessionTempRoot(sandbox, { now: NOW, protectedPaths: [] }), "swept");
		assert.equal(readFileSync(transcript, "utf8"), transcriptContent);
		assert.equal(statSync(transcript).mode & 0o777, transcriptMode);
		assert.equal(existsSync(staleSession), false);
		const markerStat = lstatSync(marker);
		assert.equal(markerStat.isSymbolicLink(), false);
		assert.equal(markerStat.isFile(), true);
		assert.equal(markerStat.mode & 0o777, SESSION_TEMP_FILE_MODE);
	});

	it.skipIf(skipSymlinks)("does not let a fresh marker symlink target throttle cleanup", () => {
		const transcript = join(sandbox, "fresh-session-target.jsonl");
		const transcriptContent = '{"type":"session"}\n';
		writeFileSync(transcript, transcriptContent);
		const marker = join(sandbox, CLEANUP_MARKER_FILE);
		symlinkSync(transcript, marker);
		const staleSession = makeAgedDir(sandbox, "stale-beside-fresh-marker-target", 60);

		assert.equal(sweepSessionTempRoot(sandbox, { now: NOW, protectedPaths: [] }), "swept");
		assert.equal(readFileSync(transcript, "utf8"), transcriptContent);
		assert.equal(existsSync(staleSession), false);
		assert.equal(lstatSync(marker).isFile(), true);
		assert.equal(lstatSync(marker).isSymbolicLink(), false);
	});
	it("sweeps again once the marker is older than the throttle window", () => {
		makeAgedDir(sandbox, "stale-a", 45);
		sweepSessionTempRoot(sandbox, { now: NOW, protectedPaths: [] });

		// Push the marker just past the throttle window instead of moving the clock,
		// so the boundary is exact rather than racing the real mtime.
		const markerSeconds = (NOW - SESSION_TEMP_CLEANUP_INTERVAL_MS - 1000) / 1000;
		utimesSync(join(sandbox, CLEANUP_MARKER_FILE), markerSeconds, markerSeconds);
		const laterStale = makeAgedDir(sandbox, "stale-b", 45);

		assert.equal(sweepSessionTempRoot(sandbox, { now: NOW, protectedPaths: [] }), "swept");
		assert.equal(existsSync(laterStale), false);
	});

	it("stands down when another session holds the lock", () => {
		const stale = makeAgedDir(sandbox, "stale-session", 45);
		writeFileSync(join(sandbox, CLEANUP_LOCK_FILE), "other-process-token");

		assert.equal(sweepSessionTempRoot(sandbox, { now: NOW, protectedPaths: [] }), "locked");

		assert.equal(existsSync(stale), true);
		assert.equal(existsSync(join(sandbox, CLEANUP_MARKER_FILE)), false);
	});

	it("breaks a lock left behind by a dead process and releases its own", () => {
		const stale = makeAgedDir(sandbox, "stale-session", 45);
		const lockPath = join(sandbox, CLEANUP_LOCK_FILE);
		writeFileSync(lockPath, "crashed-process-token");
		const staleLockSeconds = (NOW - 2 * SESSION_TEMP_CLEANUP_LOCK_STALE_MS) / 1000;
		utimesSync(lockPath, staleLockSeconds, staleLockSeconds);

		assert.equal(sweepSessionTempRoot(sandbox, { now: NOW, protectedPaths: [] }), "swept");

		assert.equal(existsSync(stale), false);
		assert.equal(existsSync(lockPath), false, "the sweeper must release the lock it took");
	});

	it("reports a missing root instead of creating one", () => {
		const missing = join(sandbox, "absent");
		assert.equal(sweepSessionTempRoot(missing, { now: NOW, protectedPaths: [] }), "missing");
		assert.equal(existsSync(missing), false);
	});

	it.skipIf(skipSymlinks)("refuses a symlinked cleanup root and never reads through it", () => {
		const outside = join(sandbox, "outside");
		mkdirSync(outside, { recursive: true });
		const outsideStale = makeAgedDir(outside, "not-ours", 90);
		const link = join(sandbox, "linked-root");
		symlinkSync(outside, link, "dir");

		assert.equal(sweepSessionTempRoot(link, { now: NOW, protectedPaths: [] }), "missing");

		assert.equal(existsSync(outsideStale), true, "an outside tree must survive a symlinked root");
		assert.equal(existsSync(link), true, "the link itself is left in place");
		assert.equal(existsSync(join(outside, CLEANUP_MARKER_FILE)), false);
	});
});

it.skipIf(process.platform === "win32")("repairs cleanup lock and marker modes under umask 0o777", () => {
	const packageRoot = dirname(moduleDir(import.meta.url));
	const scriptPath = join(sandbox, "cleanup-lock-umask.ts");
	writeFileSync(
		scriptPath,
		`
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const cleanup = await import(${JSON.stringify(join(dirname(moduleDir(import.meta.url)), "src/core/tools/session-temp-cleanup.ts"))});

const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-cleanup-lock-"));
const heldRoot = path.join(sandbox, "held");
const sweepRoot = path.join(sandbox, "sweep");
fs.mkdirSync(heldRoot, { mode: 0o700 });
const stale = path.join(sweepRoot, "stale-session");
fs.mkdirSync(stale, { recursive: true, mode: 0o700 });
const staleFile = path.join(stale, "output.log");
fs.writeFileSync(staleFile, "stale", { mode: 0o600 });
const now = Date.now();
const oldSeconds = (now - 45 * 24 * 60 * 60 * 1000) / 1000;
fs.utimesSync(staleFile, oldSeconds, oldSeconds);
fs.utimesSync(stale, oldSeconds, oldSeconds);
fs.chmodSync(sweepRoot, 0o700);

const previousUmask = process.umask(0o777);
let lockMode = null;
let tokenReadable = false;
let released = false;
let result;
try {
	const hooks = cleanup.sessionTempCleanupTestHooks;
	if (hooks) {
		const lockPath = path.join(heldRoot, cleanup.CLEANUP_LOCK_FILE);
		const lock = hooks.acquireCleanupLock(lockPath, now, cleanup.SESSION_TEMP_CLEANUP_LOCK_STALE_MS);
		if (!lock) throw new Error("lock acquisition failed");
		lockMode = fs.statSync(lockPath).mode & 0o777;
		tokenReadable = fs.readFileSync(lockPath, "utf8") === lock.token;
		hooks.releaseCleanupLock(lockPath, lock);
		released = !fs.existsSync(lockPath);
	}
	const outcome = cleanup.sweepSessionTempRoot(sweepRoot, { now, protectedPaths: [] });
	const markerPath = path.join(sweepRoot, cleanup.CLEANUP_MARKER_FILE);
	result = {
		lockMode,
		tokenReadable,
		released,
		outcome,
		staleExists: fs.existsSync(stale),
		markerExists: fs.existsSync(markerPath),
		markerMode: fs.existsSync(markerPath) ? fs.statSync(markerPath).mode & 0o777 : null,
		lockExists: fs.existsSync(path.join(sweepRoot, cleanup.CLEANUP_LOCK_FILE)),
	};
} finally {
	process.umask(previousUmask);
	fs.rmSync(sandbox, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(result));
`,
	);

	const child = spawnSyncCollect([bunExecutable(), scriptPath], { cwd: packageRoot });
	assert.equal(child.exitCode, 0, child.stderr.toString());
	assert.deepEqual(JSON.parse(child.stdout.toString()), {
		lockMode: SESSION_TEMP_FILE_MODE,
		tokenReadable: true,
		released: true,
		outcome: "swept",
		staleExists: false,
		markerExists: true,
		markerMode: SESSION_TEMP_FILE_MODE,
		lockExists: false,
	});
});

describe("sweepToolResultsRoot", () => {
	/** `<sessionsRoot>/<project>/` holding a transcript and a tool-results directory. */
	function makeProject(root: string, name: string, ageDays: number): { project: string; transcript: string } {
		const project = join(root, name);
		mkdirSync(join(project, TOOL_RESULTS_SUBDIR), { recursive: true });
		const transcript = join(project, "2026-01-01-session.jsonl");
		writeFileSync(transcript, "{}\n");
		const result = join(project, TOOL_RESULTS_SUBDIR, "call-1.txt");
		writeFileSync(result, "persisted");
		stampAge(transcript, ageDays);
		stampAge(result, ageDays);
		stampAge(join(project, TOOL_RESULTS_SUBDIR), ageDays);
		stampAge(project, ageDays);
		return { project, transcript };
	}

	it("removes a stale tool-results directory and never touches the transcript", () => {
		const { project, transcript } = makeProject(sandbox, "--project-a--", 60);

		assert.equal(sweepToolResultsRoot(sandbox, { now: NOW, controlRoot }), "swept");

		assert.equal(existsSync(join(project, TOOL_RESULTS_SUBDIR)), false);
		assert.equal(existsSync(transcript), true, "transcripts are out of scope");
		assert.equal(existsSync(project), true);
	});

	it("keeps a fresh tool-results directory", () => {
		const { project } = makeProject(sandbox, "--project-b--", 1);

		sweepToolResultsRoot(sandbox, { now: NOW, controlRoot });

		assert.equal(existsSync(join(project, TOOL_RESULTS_SUBDIR, "call-1.txt")), true);
	});

	it("keeps a tool-results tree intact when any entry is newer than the cutoff", () => {
		const { project } = makeProject(sandbox, "--project-c--", 60);
		const toolResults = join(project, TOOL_RESULTS_SUBDIR);
		const fresh = join(toolResults, "call-2.txt");
		writeFileSync(fresh, "recent");
		stampAge(fresh, 1);

		sweepToolResultsRoot(sandbox, { now: NOW, controlRoot });

		assert.equal(existsSync(fresh), true);
		// The directory's newest entry decides its fate, so a stale sibling survives
		// alongside it — a path a tool result recorded weeks ago stays readable.
		assert.equal(existsSync(join(toolResults, "call-1.txt")), true);
	});

	it("keeps its marker and lock in the control root, outside the scanned sessions root", () => {
		makeProject(sandbox, "--project-d--", 60);
		// The subagents sweep owns `.last-cleanup` inside the sessions root; ours
		// must neither read it nor be throttled by it.
		writeFileSync(join(sandbox, CLEANUP_MARKER_FILE), String(NOW));

		assert.equal(sweepToolResultsRoot(sandbox, { now: NOW, controlRoot }), "swept");

		const controlDir = getCleanupControlDir(sandbox, controlRoot);
		assert.equal(existsSync(join(controlDir, CLEANUP_MARKER_FILE)), true);
		assert.equal(existsSync(join(sandbox, CLEANUP_LOCK_FILE)), false, "no lock inside the sessions root");
		assert.equal(sweepToolResultsRoot(sandbox, { now: NOW, controlRoot }), "throttled");
	});

	it("keys throttle state per sessions root", () => {
		const otherRoot = join(sandbox, "other-sessions");
		mkdirSync(otherRoot, { recursive: true });
		makeProject(sandbox, "--project-e--", 60);
		const other = makeProject(otherRoot, "--project-f--", 60);

		sweepToolResultsRoot(sandbox, { now: NOW, controlRoot });

		assert.equal(sweepToolResultsRoot(otherRoot, { now: NOW, controlRoot }), "swept");
		assert.equal(existsSync(join(other.project, TOOL_RESULTS_SUBDIR)), false);
	});

	it("stands down when another session holds the control lock", () => {
		const { project } = makeProject(sandbox, "--project-g--", 60);
		const controlDir = getCleanupControlDir(sandbox, controlRoot);
		mkdirSync(controlDir, { recursive: true });
		writeFileSync(join(controlDir, CLEANUP_LOCK_FILE), "other-token");

		assert.equal(sweepToolResultsRoot(sandbox, { now: NOW, controlRoot }), "locked");
		assert.equal(existsSync(join(project, TOOL_RESULTS_SUBDIR)), true);
	});

	it.skipIf(skipSymlinks)("never follows a symlinked tool-results directory", () => {
		const outside = join(sandbox, "outside");
		mkdirSync(outside, { recursive: true });
		const outsideStale = join(outside, "old.txt");
		const outsideFresh = join(outside, "new.txt");
		writeFileSync(outsideStale, "old");
		writeFileSync(outsideFresh, "new");
		stampAge(outsideStale, 90);
		stampAge(outsideFresh, 1);

		const project = join(sandbox, "--project-linked--");
		mkdirSync(project, { recursive: true });
		const transcript = join(project, "2026-01-01-session.jsonl");
		writeFileSync(transcript, "{}\n");
		const link = join(project, TOOL_RESULTS_SUBDIR);
		symlinkSync(outside, link, "dir");
		stampAge(project, 90);

		assert.equal(sweepToolResultsRoot(sandbox, { now: NOW, controlRoot }), "swept");

		assert.equal(existsSync(outsideStale), true, "an outside file must not be reaped through a link");
		assert.equal(existsSync(outsideFresh), true);
		assert.equal(existsSync(link), true, "the link itself is skipped, not deleted");
		assert.equal(existsSync(transcript), true);
	});
});

describe("sweepSessionDirToolResults", () => {
	/** A custom `--session-dir`: transcripts and `tool-results` sit side by side. */
	function makeCustomSessionDir(name: string, ageDays: number): { dir: string; transcript: string } {
		const dir = join(sandbox, name);
		mkdirSync(join(dir, TOOL_RESULTS_SUBDIR), { recursive: true });
		const transcript = join(dir, "2026-01-01-session.jsonl");
		writeFileSync(transcript, "{}\n");
		const result = join(dir, TOOL_RESULTS_SUBDIR, "call-1.txt");
		writeFileSync(result, "persisted");
		stampAge(transcript, ageDays);
		stampAge(result, ageDays);
		stampAge(join(dir, TOOL_RESULTS_SUBDIR), ageDays);
		return { dir, transcript };
	}

	it("removes a stale result under a directly chosen session directory", () => {
		const { dir, transcript } = makeCustomSessionDir("custom-sessions", 60);

		assert.equal(sweepSessionDirToolResults(dir, { now: NOW, controlRoot }), "swept");

		assert.equal(existsSync(join(dir, TOOL_RESULTS_SUBDIR)), false);
		assert.equal(existsSync(transcript), true, "sibling transcripts are never touched");
	});

	it("keeps fresh results under a directly chosen session directory", () => {
		const { dir } = makeCustomSessionDir("custom-fresh", 1);

		sweepSessionDirToolResults(dir, { now: NOW, controlRoot });

		assert.equal(existsSync(join(dir, TOOL_RESULTS_SUBDIR, "call-1.txt")), true);
	});

	it("keeps a tree when the depth bound leaves a fresh descendant unscanned", () => {
		const { dir } = makeCustomSessionDir("custom-deep-fresh", 60);
		const toolResults = join(dir, TOOL_RESULTS_SUBDIR);
		const ancestors = [toolResults];
		let deepest = toolResults;
		for (let depth = 0; depth < 40; depth++) {
			deepest = join(deepest, `level-${depth}`);
			mkdirSync(deepest);
			ancestors.push(deepest);
		}
		const fresh = join(deepest, "fresh.txt");
		writeFileSync(fresh, "recent");
		for (const ancestor of ancestors) stampAge(ancestor, 60);

		assert.equal(sweepSessionDirToolResults(dir, { now: NOW, controlRoot }), "swept");
		assert.equal(existsSync(toolResults), true, "an incomplete scan cannot authorize deletion");
		assert.equal(existsSync(fresh), true);
	});

	it.skipIf(process.platform === "win32")("keeps a stale tree whose scan encounters a nested symlink", () => {
		const { dir } = makeCustomSessionDir("custom-nested-symlink", 60);
		const toolResults = join(dir, TOOL_RESULTS_SUBDIR);
		const outside = join(sandbox, "nested-symlink-target.txt");
		writeFileSync(outside, "outside");
		stampAge(outside, 60);
		const link = join(toolResults, "outside-link.txt");
		symlinkSync(outside, link);
		const oldSeconds = (NOW - 60 * MS_PER_DAY) / 1000;
		lutimesSync(link, oldSeconds, oldSeconds);
		stampAge(toolResults, 60);

		assert.equal(sweepSessionDirToolResults(dir, { now: NOW, controlRoot }), "swept");
		assert.equal(existsSync(toolResults), true);
		assert.equal(lstatSync(link).isSymbolicLink(), true);
		assert.equal(readFileSync(outside, "utf8"), "outside");
	});

	it("throttles on its own control marker", () => {
		const { dir } = makeCustomSessionDir("custom-throttled", 60);

		assert.equal(sweepSessionDirToolResults(dir, { now: NOW, controlRoot }), "swept");
		assert.equal(existsSync(join(getCleanupControlDir(dir, controlRoot), CLEANUP_MARKER_FILE)), true);
		assert.equal(sweepSessionDirToolResults(dir, { now: NOW, controlRoot }), "throttled");
	});
});

describe("runSessionTempCleanup", () => {
	it("sweeps the temp root, the sessions roots, and custom session directories in one pass", () => {
		const tempRoot = join(sandbox, "temp-root");
		const sessionsRoot = join(sandbox, "sessions");
		const customDir = join(sandbox, "custom");
		mkdirSync(tempRoot, { recursive: true });
		mkdirSync(sessionsRoot, { recursive: true });
		const staleTemp = makeAgedDir(tempRoot, "stale-session", 60);

		const project = join(sessionsRoot, "--project--");
		mkdirSync(join(project, TOOL_RESULTS_SUBDIR), { recursive: true });
		const staleResult = join(project, TOOL_RESULTS_SUBDIR, "call-1.txt");
		writeFileSync(staleResult, "persisted");
		stampAge(staleResult, 60);
		stampAge(join(project, TOOL_RESULTS_SUBDIR), 60);
		stampAge(project, 60);

		mkdirSync(join(customDir, TOOL_RESULTS_SUBDIR), { recursive: true });
		const customResult = join(customDir, TOOL_RESULTS_SUBDIR, "call-2.txt");
		const customTranscript = join(customDir, "2026-01-01-session.jsonl");
		writeFileSync(customResult, "persisted");
		writeFileSync(customTranscript, "{}\n");
		stampAge(customResult, 60);
		stampAge(join(customDir, TOOL_RESULTS_SUBDIR), 60);
		stampAge(customTranscript, 60);

		runSessionTempCleanup({
			now: NOW,
			tempRoot,
			sessionsRoots: [sessionsRoot],
			sessionDirs: [customDir],
			controlRoot,
			protectedPaths: [],
		});

		assert.equal(existsSync(staleTemp), false);
		assert.equal(existsSync(join(project, TOOL_RESULTS_SUBDIR)), false);
		assert.equal(existsSync(join(customDir, TOOL_RESULTS_SUBDIR)), false);
		assert.equal(existsSync(customTranscript), true, "a stale transcript is still never deleted");
	});

	it("keeps a live session's disk-backed results, including a replayed old file", async () => {
		// A replayed result reuses the file written on an earlier turn and does not
		// refresh its mtime, so the model can be handed a month-old path this turn.
		// Age cannot protect that; the session's registered directory has to.
		const sessionsRoot = join(sandbox, "live-sessions");
		const project = join(sessionsRoot, "--live-project--");
		const toolResults = join(project, TOOL_RESULTS_SUBDIR);
		mkdirSync(toolResults, { recursive: true });
		const transcript = join(project, "2026-01-01-session.jsonl");
		const replayed = join(toolResults, "call-live.txt");
		writeFileSync(transcript, "{}\n");
		writeFileSync(replayed, "persisted on an earlier turn");
		for (const path of [transcript, replayed, toolResults, project]) stampAge(path, 60);

		const lease = acquireProtectedPaths([toolResults]);
		try {
			// The documented EEXIST replay path: same call id, existing file reused.
			const replacement = await redirectOversizedToolResult({
				toolName: "bash",
				toolCallId: "call-live",
				result: { content: [{ type: "text", text: "q".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1) }], details: {} },
				isError: false,
				sessionId: "live-session",
				sessionDir: project,
			});
			const advertised = replacement?.content[0]?.text.match(/Full output saved to: (.+)\n/)?.[1];
			assert.equal(advertised, replayed, "the replayed file is what the model was handed");

			runSessionTempCleanup({
				now: NOW,
				tempRoot: join(sandbox, "absent"),
				sessionsRoots: [sessionsRoot],
				controlRoot,
			});

			assert.equal(existsSync(replayed), true, "an advertised path must survive the same process's sweep");
			assert.equal(existsSync(transcript), true);
		} finally {
			lease.release();
		}
	});

	it("reaps the same storage once the session's lease is released", () => {
		const customDir = join(sandbox, "released-custom");
		const toolResults = join(customDir, TOOL_RESULTS_SUBDIR);
		mkdirSync(toolResults, { recursive: true });
		const stale = join(toolResults, "call-1.txt");
		writeFileSync(stale, "persisted");
		for (const path of [stale, toolResults]) stampAge(path, 60);

		const lease = acquireProtectedPaths([toolResults]);
		runSessionTempCleanup({ now: NOW, tempRoot: join(sandbox, "absent"), sessionDirs: [customDir], controlRoot });
		assert.equal(existsSync(toolResults), true, "protected while the session holds its lease");

		lease.release();
		// A fresh control root rather than a future clock: the marker's freshness is
		// read from its real mtime, so an arithmetic "past the window" is only true
		// while the test is fast, and this suite must not depend on machine load.
		runSessionTempCleanup({
			now: NOW,
			tempRoot: join(sandbox, "absent"),
			sessionDirs: [customDir],
			controlRoot: join(controlRoot, "after-release"),
		});

		assert.equal(existsSync(toolResults), false, "released storage becomes reapable");
	});
});

describe("oversized result replay safety", () => {
	it.skipIf(process.platform === "win32")("rejects a replay symlink without mutating its outside target", async () => {
		const sessionDir = join(sandbox, "replay-symlink-session");
		const toolResults = join(sessionDir, TOOL_RESULTS_SUBDIR);
		mkdirSync(toolResults, { recursive: true });
		const outside = join(sandbox, "outside-result.txt");
		const outsideContent = "outside content must remain untouched";
		writeFileSync(outside, outsideContent);
		chmodSync(outside, 0o644);
		const replayPath = join(toolResults, "call-symlink.txt");
		symlinkSync(outside, replayPath);
		const outsideMode = statSync(outside).mode & 0o777;

		const replacement = await redirectOversizedToolResult({
			toolName: "bash",
			toolCallId: "call-symlink",
			result: {
				content: [{ type: "text", text: "r".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1) }],
				details: {},
			},
			isError: false,
			sessionId: "replay-symlink",
			sessionDir,
		});

		assert.equal(replacement, undefined);
		assert.equal(lstatSync(replayPath).isSymbolicLink(), true);
		assert.equal(readFileSync(outside, "utf8"), outsideContent);
		assert.equal(statSync(outside).mode & 0o777, outsideMode);
	});
});

describe("scheduleSessionTempCleanup", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetSessionTempCleanupScheduleForTesting();
	});

	afterEach(() => {
		resetSessionTempCleanupScheduleForTesting();
		vi.useRealTimers();
	});

	function makeStaleCustomSession(name: string): { dir: string; toolResults: string } {
		const dir = join(sandbox, name);
		const toolResults = join(dir, TOOL_RESULTS_SUBDIR);
		mkdirSync(toolResults, { recursive: true });
		const result = join(toolResults, "call-1.txt");
		writeFileSync(result, "persisted");
		stampAge(result, 60);
		stampAge(toolResults, 60);
		return { dir, toolResults };
	}

	function scheduleCustomDirs(...dirs: string[]): void {
		scheduleSessionTempCleanup({
			now: NOW,
			tempRoot: join(sandbox, "temp-root"),
			sessionsRoots: [],
			sessionDirs: dirs,
			controlRoot,
		});
	}

	it("rearms cleanup for a custom root discovered after the first sweep", async () => {
		const first = makeStaleCustomSession("first-late-root");
		scheduleCustomDirs(first.dir);
		assert.equal(vi.getTimerCount(), 1);

		await vi.advanceTimersByTimeAsync(SESSION_TEMP_CLEANUP_DELAY_MS);
		assert.equal(existsSync(first.toolResults), false);

		const second = makeStaleCustomSession("second-late-root");
		scheduleCustomDirs(second.dir);
		assert.equal(vi.getTimerCount(), 1, "a later root gets a new deferred sweep");

		await vi.advanceTimersByTimeAsync(SESSION_TEMP_CLEANUP_DELAY_MS);
		assert.equal(existsSync(second.toolResults), false);
	});

	it("batches every root discovered before the callback onto one timer", async () => {
		const first = makeStaleCustomSession("first-batched-root");
		const second = makeStaleCustomSession("second-batched-root");

		scheduleCustomDirs(first.dir);
		scheduleCustomDirs(second.dir);
		assert.equal(vi.getTimerCount(), 1);

		await vi.advanceTimersByTimeAsync(SESSION_TEMP_CLEANUP_DELAY_MS);
		assert.equal(existsSync(first.toolResults), false);
		assert.equal(existsSync(second.toolResults), false);
	});

	it("cancels its outstanding timer when test state is reset", async () => {
		const pending = makeStaleCustomSession("cancelled-root");
		scheduleCustomDirs(pending.dir);
		assert.equal(vi.getTimerCount(), 1);

		resetSessionTempCleanupScheduleForTesting();
		assert.equal(vi.getTimerCount(), 0);
		await vi.advanceTimersByTimeAsync(SESSION_TEMP_CLEANUP_DELAY_MS);
		assert.equal(existsSync(pending.toolResults), true);
	});
});
