import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { setUpResumedBlueprints, withWorktreeRootMappings } from "../../packages/coding-agent/src/index.js";
import { stripWorkflowOnlyOptions } from "../../packages/workflows/src/runs/foreground/stage-runner-options.js";
import { isReopenableSession } from "../../packages/workflows/src/shared/session-transcript.js";

for (const sessionId of ["shared-id", ""]) {
	test(`stage resume and fork load ${JSON.stringify(sessionId)} from the selected project store`, async () => {
		const selected = new MemorySessionStore();
		const other = new MemorySessionStore();
		for (const [store, content] of [
			[selected, "selected project"],
			[other, "   "],
		] as const) {
			const source = new MemorySessionStore();
			const writer = await SessionManager.create(source, process.cwd());
			await writer.appendMessage({ role: "user", content, timestamp: Date.now() });
			const snapshot = await source.load(writer.getSessionId());
			await store.create({ ...snapshot.header, id: sessionId }, snapshot.entries);
		}
		const meta = { runId: "run", stageId: "stage", stageName: "build" };
		const resumed = await stripWorkflowOnlyOptions(
			{ sessionStore: selected, resumeFromSessionId: sessionId },
			undefined,
			meta,
		);
		assert.ok(resumed.sessionManager);
		assert.equal(resumed.sessionManager.getSessionId(), sessionId);
		assert.equal(resumed.sessionManager.getSessionStore(), selected);
		const resumedMessage = resumed.sessionManager.buildSessionContext().messages[0];
		assert.equal(resumedMessage?.role, "user");
		assert.ok(resumedMessage?.role === "user");
		assert.equal(resumedMessage.content, "selected project");
		assert.equal(await isReopenableSession(selected, sessionId), true);
		assert.equal(await isReopenableSession(other, sessionId), false);
		const forked = await stripWorkflowOnlyOptions(
			{ sessionStore: selected, context: "fork", forkFromSessionId: sessionId },
			undefined,
			meta,
		);
		assert.ok(forked.sessionManager);
		assert.notEqual(forked.sessionManager.getSessionId(), sessionId);
		assert.equal(forked.sessionManager.getSessionStore(), selected);
		assert.equal(forked.sessionManager.getHeader()?.parentSessionId, sessionId);
		assert.deepEqual(
			forked.sessionManager.buildSessionContext().messages,
			resumed.sessionManager.buildSessionContext().messages,
		);
		assert.equal((await selected.load(forked.sessionManager.getSessionId())).header.internal, true);
		assert.equal((await other.load(sessionId)).entries.length, 1);
	});
}

test("transcript validation does not create missing or blank sessions", async () => {
	const store = new MemorySessionStore();
	assert.equal(await isReopenableSession(store, "missing"), false);
	assert.equal(await store.readHeader("missing"), undefined);
	const blank = await SessionManager.create(store, process.cwd());
	assert.equal(await isReopenableSession(store, blank.getSessionId()), false);
	await blank.appendMessage({ role: "user", content: "   ", timestamp: Date.now() });
	assert.equal(await isReopenableSession(store, blank.getSessionId()), false);
	await blank.appendMessage({ role: "user", content: "usable", timestamp: Date.now() });
	assert.equal(await isReopenableSession(store, blank.getSessionId()), true);
});

test("a stage that starts in a worktree a resume restored is told that worktree's blueprint context once (#4588)", async () => {
	const sandbox = mkdtempSync(join(tmpdir(), "stage-blueprint-context-"));
	try {
		const agentDir = join(sandbox, "agent");
		const storeDir = join(agentDir, "worktree-snapshots");
		const root = join(storeDir, "worktrees", "abc-123");
		mkdirSync(join(root, ".atomic"), { recursive: true });
		writeFileSync(
			join(root, ".atomic", "blueprint.yaml"),
			"initialize: exit 7\nknowledge:\n  - name: test\n    contents: make stage-test\n",
		);
		const resumed = await setUpResumedBlueprints({
			restored: [{ root, remotes: [] }],
			config: {
				agentDir,
				storeDir,
				trusted: () => true,
				homeDir: sandbox,
				environment: { PATH: process.env.PATH ?? "" },
			},
		});
		assert.equal(resumed.notices.length, 1);

		const meta = { runId: "run", stageId: "stage", stageName: "build" };
		const store = new MemorySessionStore();
		const options = { sessionStore: store, agentDir, cwd: join(root, "packages", "app") };
		const stage = await stripWorkflowOnlyOptions(options, undefined, meta);
		const contexts = (manager: SessionManager | undefined) =>
			manager
				?.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "blueprint-context") ?? [];
		assert.equal(contexts(stage.sessionManager).length, 1);
		const message = contexts(stage.sessionManager)[0];
		assert.ok(message?.type === "custom_message" && String(message.content).includes("make stage-test"));
		assert.ok(message?.type === "custom_message" && String(message.content).includes("NOT RUN"));

		const recorded = join(sandbox, "recorded-on-node-a");
		const mapped = await withWorktreeRootMappings(
			[{ from: recorded, to: root, snapshotId: "snapshot", tree: "tree", restoredAt: "2026-11-09T00:00:00.000Z" }],
			() => stripWorkflowOnlyOptions({ sessionStore: store, agentDir, cwd: join(recorded, "src") }, undefined, meta),
		);
		assert.equal(contexts(mapped.sessionManager).length, 1);

		const elsewhere = await stripWorkflowOnlyOptions(
			{ sessionStore: store, agentDir, cwd: sandbox },
			undefined,
			meta,
		);
		assert.equal(contexts(elsewhere.sessionManager).length, 0);
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
});

test("a stage without any session store or directory starts without a session manager and without blueprint context (#4588)", async () => {
	const stage = await stripWorkflowOnlyOptions({ cwd: process.cwd() }, undefined, {
		runId: "run",
		stageId: "stage",
		stageName: "build",
	});
	assert.equal(stage.sessionManager, undefined);
});

test("a stage in a restored worktree still starts when its kept blueprint context cannot be read (#4588)", async () => {
	const sandbox = mkdtempSync(join(tmpdir(), "stage-blueprint-unreadable-"));
	try {
		const agentDir = join(sandbox, "agent");
		const storeDir = join(agentDir, "worktree-snapshots");
		const root = join(storeDir, "worktrees", "abc-123");
		mkdirSync(join(root, ".atomic"), { recursive: true });
		writeFileSync(join(root, ".atomic", "blueprint.yaml"), "knowledge:\n  - name: test\n    contents: make test\n");
		await setUpResumedBlueprints({
			restored: [{ root, remotes: [] }],
			config: {
				agentDir,
				storeDir,
				trusted: () => true,
				homeDir: sandbox,
				environment: { PATH: process.env.PATH ?? "" },
			},
		});
		const kept = join(storeDir, "blueprint-context");
		for (const name of readdirSync(kept)) {
			rmSync(join(kept, name));
			mkdirSync(join(kept, name));
		}
		const warnings: string[] = [];
		const warn = vi.spyOn(console, "warn").mockImplementation((message: string) => void warnings.push(message));
		try {
			const stage = await stripWorkflowOnlyOptions(
				{ sessionStore: new MemorySessionStore(), agentDir, cwd: root },
				undefined,
				{ runId: "run", stageId: "stage", stageName: "build" },
			);
			assert.ok(stage.sessionManager);
			assert.equal(stage.sessionManager.getBranch().filter((entry) => entry.type === "custom_message").length, 0);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0] ?? "", /^atomic-workflows: .*could not be read/);
		} finally {
			warn.mockRestore();
		}
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
});
