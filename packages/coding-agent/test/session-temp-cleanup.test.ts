/**
 * Age-based sweeper for tool-output storage: what it reaps, what it refuses to
 * reap, how the marker/lock keep concurrent sessions from racing, and why a
 * symlink is never followed out of the target.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
	CLEANUP_CONTROL_SUBDIR,
	CLEANUP_LOCK_FILE,
	CLEANUP_MARKER_FILE,
	getCleanupControlDir,
	runSessionTempCleanup,
	SESSION_TEMP_CLEANUP_DELAY_MS,
	SESSION_TEMP_CLEANUP_INTERVAL_MS,
	SESSION_TEMP_CLEANUP_LOCK_STALE_MS,
	SESSION_TEMP_RETENTION_DAYS,
	SESSION_TEMP_RETENTION_MS,
	sweepSessionDirToolResults,
	sweepSessionTempRoot,
	sweepToolResultsRoot,
} from "../src/core/tools/session-temp-cleanup.ts";
import { TOOL_RESULTS_SUBDIR } from "../src/core/tools/tool-limits.ts";

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
});
