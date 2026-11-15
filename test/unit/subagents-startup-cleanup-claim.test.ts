import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
	claimStartupCleanup,
	createSubagentStartupMaintenance,
	type SubagentStartupMaintenance,
} from "../../packages/subagents/src/extension/startup-maintenance.js";
import type { SubagentState } from "../../packages/subagents/src/shared/types.js";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function state(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		subagentInProgress: false,
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
}

/** A session's maintenance whose scans are queued here instead of on the real timers. */
function sessionMaintenance(): {
	maintenance: SubagentStartupMaintenance;
	pending: () => number;
	runAll: () => void;
} {
	const macrotasks = new Set<() => void>();
	const delayed = new Set<() => void>();
	const queue = (into: Set<() => void>, task: () => void) => {
		into.add(task);
		return () => void into.delete(task);
	};
	const maintenance = createSubagentStartupMaintenance(state(), {
		artifactCleanupDays: 1,
		scheduleMacrotask: (task) => queue(macrotasks, task),
		scheduleDelayed: (task) => queue(delayed, task),
	});
	return {
		maintenance,
		pending: () => macrotasks.size + delayed.size,
		runAll: () => {
			for (const task of [...macrotasks]) {
				macrotasks.delete(task);
				task();
			}
			for (const task of [...delayed]) {
				delayed.delete(task);
				task();
			}
		},
	};
}

test("the process's startup scans are scheduled by one session at a time and run once, however many sessions start (#5186)", () => {
	// The scans run for real at the end: keep them to an agent directory of this test's own.
	const agentDir = mkdtempSync(join(tmpdir(), "atomic-startup-claim-"));
	roots.push(agentDir);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	const first = sessionMaintenance();
	const releaseFirst = claimStartupCleanup(first.maintenance);
	assert.equal(first.pending(), 1, "the first session schedules the startup scans");

	const children = Array.from({ length: 50 }, () => sessionMaintenance());
	const releases = children.map((child) => claimStartupCleanup(child.maintenance));
	assert.deepEqual(
		children.map((child) => child.pending()),
		children.map(() => 0),
		"no later session schedules a scan or a timer while one is pending",
	);

	// The session holding them stops before they ran: its timers end with it, and a session still waiting takes them.
	first.maintenance.stop();
	releaseFirst();
	assert.equal(first.pending(), 0, "a stopped session leaves no timer behind");
	const next = children[0]!;
	assert.equal(next.pending(), 1, "the next waiting session schedules them");
	assert.deepEqual(
		children.slice(1).map((child) => child.pending()),
		children.slice(1).map(() => 0),
		"only one session takes them over",
	);

	// A session that waited and stopped never takes them over.
	releases[1]!();
	children[1]!.maintenance.stop();
	next.maintenance.stop();
	releases[0]!();
	assert.equal(children[1]!.pending(), 0, "a stopped waiting session schedules nothing");
	const holder = children[2]!;
	assert.equal(holder.pending(), 1, "the next session still waiting takes them over");

	holder.runAll();
	for (const release of releases) release();
	const late = sessionMaintenance();
	claimStartupCleanup(late.maintenance);
	assert.equal(late.pending(), 0, "once they ran, no session schedules them again");
});
