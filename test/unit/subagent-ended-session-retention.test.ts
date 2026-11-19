import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { bindSubagentChildCards } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	clearSubagentControls,
	FINISHED_RUN_CONTROL_RETENTION,
	findSubagentControl,
	getOrCreateSubagentControl,
	subagentControlCount,
} from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import type { ParentContext } from "../../packages/subagents/src/runs/inprocess/runner.js";
import { collectEverythingTracked, trackCollection } from "../helpers/collect-garbage.js";

const roots: string[] = [];

function sessionRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-control-retention-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	clearSubagentControls();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A parent whose closures reach `session`, as a launching session's `getChildSessionOptions` reaches its session. */
function parentOf(path: string, session: object): ParentContext {
	return {
		path,
		depth: 0,
		sessionId: `session-of-${path}`,
		intercomGroup: "group",
		getChildSessionOptions: (options) => ({ ...options, parentSession: session }) as typeof options,
	};
}

test("a run's control keeps who launched it, not the launching session its parent's closures reach", async () => {
	const sessions = trackCollection();
	const root = sessionRoot();
	const control = (() => {
		const session = { history: Array.from({ length: 10_000 }, (_, index) => `message ${index}`) };
		sessions.track(session);
		return getOrCreateSubagentControl(parentOf("run-keeps-identity", session), root);
	})();
	await collectEverythingTracked(sessions);
	assert.equal(sessions.collected(), 1, "the launching session was collected while its run's control stays");
	assert.equal(findSubagentControl("run-keeps-identity"), control);
	assert.deepEqual(control.parent, {
		path: "run-keeps-identity",
		depth: 0,
		sessionId: "session-of-run-keeps-identity",
		intercomGroup: "group",
	});
});

test("finished runs keep at most FINISHED_RUN_CONTROL_RETENTION controls, the oldest dropped first and a run with a pending child never", () => {
	const root = sessionRoot();
	const busy = getOrCreateSubagentControl({ path: "run-with-pending-child", depth: 0 }, root);
	busy.native.registerAgent("worker");
	const admitted = busy.native.admitChildSession(
		{ taskName: "worker", agentName: "worker", cwd: process.cwd() },
		{ path: busy.parent.path, depth: 0 },
	);
	assert.equal(admitted.child?.status, "pending");
	const extra = 10;
	for (let run = 0; run < FINISHED_RUN_CONTROL_RETENTION + extra; run++)
		getOrCreateSubagentControl({ path: `finished-run-${run}`, depth: 0 }, root);
	assert.equal(subagentControlCount(), FINISHED_RUN_CONTROL_RETENTION + 1);
	assert.equal(findSubagentControl("run-with-pending-child"), busy, "a run with a pending child is kept");
	for (let run = 0; run < extra; run++)
		assert.equal(findSubagentControl(`finished-run-${run}`), undefined, `the oldest finished run ${run} was dropped`);
	assert.ok(findSubagentControl(`finished-run-${extra}`), "the newer finished runs stay");
	assert.ok(findSubagentControl(`finished-run-${FINISHED_RUN_CONTROL_RETENTION + extra - 1}`));
});

test("binding a session's child cards keeps its session store, not the session after it ended", async () => {
	const store = new MemorySessionStore();
	const sessions = trackCollection();
	await (async () => {
		const sessionManager = await SessionManager.create(store, process.cwd());
		const context = { sessionManager };
		sessions.track(context);
		sessions.track(sessionManager);
		bindSubagentChildCards(context);
	})();
	await collectEverythingTracked(sessions);
	assert.deepEqual(sessions.uncollected(), [], "the last bound context and its session manager were collected");
	await store.close();
});
