/**
 * Unit tests for the shared post-mortem stage-chat resolver.
 *
 * Verifies:
 *  - eligible completed agent stages with a valid retained session revive into
 *    a detached, interactive handle that appends follow-up without mutating
 *    run/stage status;
 *  - single-flight: repeated calls reuse one handle / one session create;
 *  - explicit unavailable reasons for non-terminal / session-less / invalid /
 *    adapter-less stages so callers preserve the read-only transcript.
 *
 * cross-ref: src/runs/foreground/postmortem-stage-chat.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@bastani/atomic";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import {
	acquirePostMortemStageHandle,
	createPostMortemStageHandle,
	ensurePostMortemStageHandle,
	isPostMortemEligibleStage,
} from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { mockSession, type StageSessionRuntime } from "./executor-shared.js";

let tempDir = "";
let sessionStore: JsonlSessionStore;
beforeEach(async () => {
	tempDir = mkdtempSync(join(tmpdir(), "atomic-postmortem-"));
	sessionStore = await JsonlSessionStore.open(tempDir, { exactDirectory: true });
});
afterEach(async () => {
	await sessionStore.close();
	rmSync(tempDir, { recursive: true, force: true });
});

function retainedSession(name: string): { sessionFile: string; sessionId: string } {
	const path = join(tempDir, `${name}.jsonl`);
	writeFileSync(
		path,
		`${[
			JSON.stringify({
				type: "session",
				version: 4,
				id: `${name}-session`,
				createdAt: new Date().toISOString(),
				cwd: tempDir,
			}),
			JSON.stringify({
				type: "message",
				id: `${name}-message`,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Original stage request", timestamp: Date.now() },
			}),
		].join("\n")}\n`,
	);
	return { sessionFile: path, sessionId: `${name}-session` };
}

function completedStage(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return {
		id: "stage-1",
		name: "final",
		status: "completed",
		parentIds: [],
		toolEvents: [],
		...overrides,
	};
}

function adaptersRecording(session: StageSessionRuntime, counter: { creates: number }): StageAdapters {
	return {
		sessionStore,
		agentSession: {
			async create() {
				counter.creates += 1;
				return session;
			},
		},
	};
}

describe("ensurePostMortemStageHandle", () => {
	test("revives a detached interactive handle and appends follow-up without mutating status", async () => {
		const registry = createStageControlRegistry();
		const { sessionFile, sessionId } = retainedSession("revive");
		const promptCalls: string[] = [];
		const session: StageSessionRuntime = {
			...mockSession(),
			sessionFile,
			async prompt(text: string) {
				promptCalls.push(text);
			},
		};
		const counter = { creates: 0 };
		const stage = completedStage({ sessionId, sessionFile });

		const result = await ensurePostMortemStageHandle("run-1", stage, {
			registry,
			adapters: adaptersRecording(session, counter),
			cwd: tempDir,
		});

		assert.equal(result.ok, true);
		if (!result.ok) return;
		// Detached from run-level control, still resolvable as a chat handle.
		assert.equal(registry.get("run-1", "stage-1"), result.handle);
		assert.deepEqual(registry.run("run-1").stages(), []);

		await result.handle.prompt("What next?");
		assert.equal(counter.creates, 1);
		assert.deepEqual(promptCalls, ["What next?"]);
		assert.equal(stage.status, "completed");
	});

	test("reopens a removed custom-store stage handle without falling back to the host store", async () => {
		const registry = createStageControlRegistry();
		const customStore = await JsonlSessionStore.open(join(tempDir, "custom"), { exactDirectory: true });
		const manager = await SessionManager.create(customStore, tempDir);
		await manager.appendMessage({ role: "user", content: "Custom conversation", timestamp: 1 });
		const stage = completedStage({ sessionId: manager.getSessionId() });
		let restored: SessionManager | undefined;
		const adapters: StageAdapters = {
			sessionStore,
			agentSession: {
				async create(options) {
					restored = options.sessionManager;
					return mockSession();
				},
			},
		};
		const original = createPostMortemStageHandle(
			"run-1",
			stage,
			manager.getSessionId(),
			adapters,
			tempDir,
			undefined,
			customStore,
		);
		const unregister = registry.register(original);
		unregister();
		await original.dispose?.();
		try {
			const result = await ensurePostMortemStageHandle("run-1", stage, { registry, adapters, cwd: tempDir });
			assert.equal(result.ok, true);
			if (!result.ok) return;
			await result.handle.ensureAttached();
			assert.deepEqual(restored?.buildSessionContext().messages, manager.buildSessionContext().messages);
			assert.equal(restored?.getSessionStore(), customStore);
		} finally {
			await registry.clear();
			await customStore.close();
		}
	});

	test("single-flights repeated calls onto one handle and one session create", async () => {
		const registry = createStageControlRegistry();
		const { sessionFile, sessionId } = retainedSession("single-flight");
		const counter = { creates: 0 };
		const session: StageSessionRuntime = { ...mockSession(), sessionFile };
		const stage = completedStage({ sessionId, sessionFile });
		const deps = { registry, adapters: adaptersRecording(session, counter), cwd: tempDir };

		const first = await ensurePostMortemStageHandle("run-1", stage, deps);
		const second = await ensurePostMortemStageHandle("run-1", stage, deps);
		assert.equal(first.ok && second.ok, true);
		if (!first.ok || !second.ok) return;
		assert.equal(first.handle, second.handle);
		await first.handle.ensureAttached();
		await second.handle.ensureAttached();
		assert.equal(counter.creates, 1);
	});

	test("disposes a pending lazy session when the registry is cleared", async () => {
		const registry = createStageControlRegistry();
		const { sessionFile, sessionId } = retainedSession("clear-race");
		const created = Promise.withResolvers<StageSessionRuntime>();
		const creating = Promise.withResolvers<void>();
		let disposeCalls = 0;
		const session: StageSessionRuntime = {
			...mockSession(),
			sessionFile,
			dispose() {
				disposeCalls += 1;
			},
		};
		const stage = completedStage({ sessionId, sessionFile });
		const result = await ensurePostMortemStageHandle("run-1", stage, {
			registry,
			adapters: {
				sessionStore,
				agentSession: {
					async create() {
						creating.resolve();
						return created.promise;
					},
				},
			},
			cwd: tempDir,
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;

		const attaching = result.handle.ensureAttached();
		await creating.promise;
		registry.clear();
		created.resolve(session);

		await assert.rejects(attaching, /session has been disposed/);
		assert.equal(disposeCalls, 1);
		assert.equal(result.handle.isDisposed, true);
		assert.deepEqual(registry.forRun("run-1"), []);
	});
	for (const resolve of [ensurePostMortemStageHandle, acquirePostMortemStageHandle]) {
		test(`${resolve.name} does not register a retained handle after its registry is cleared during validation`, async () => {
			const registry = createStageControlRegistry();
			const stage = completedStage(retainedSession("shutdown-race"));
			const started = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const load = sessionStore.load.bind(sessionStore);
			const loading = vi.spyOn(sessionStore, "load").mockImplementation(async (id) => {
				started.resolve();
				await finish.promise;
				return load(id);
			});
			try {
				const pending = resolve("run-1", stage, {
					registry,
					adapters: adaptersRecording(mockSession(), { creates: 0 }),
				});
				await started.promise;
				await registry.clear();
				finish.resolve();
				assert.equal((await pending).ok, false);
				assert.deepEqual(registry.forRun("run-1"), []);
			} finally {
				finish.resolve();
				loading.mockRestore();
				await registry.clear();
			}
		});
	}

	test("rejects post-mortem pause and resume without appending a prompt", async () => {
		const registry = createStageControlRegistry();
		const { sessionFile, sessionId } = retainedSession("no-resume");
		const promptCalls: string[] = [];
		const counter = { creates: 0 };
		const session: StageSessionRuntime = {
			...mockSession(),
			sessionFile,
			async prompt(text: string) {
				promptCalls.push(text);
			},
		};
		const stage = completedStage({ sessionId, sessionFile });
		const result = await ensurePostMortemStageHandle("run-1", stage, {
			registry,
			adapters: adaptersRecording(session, counter),
			cwd: tempDir,
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;

		const expected = /Post-mortem stage chat cannot pause or resume workflow execution\./;
		await assert.rejects(() => result.handle.pause(), expected);
		await assert.rejects(() => result.handle.resume("resume should be rejected"), expected);
		assert.deepEqual(promptCalls, []);
		assert.equal(counter.creates, 0);
		assert.equal(result.handle.status, "completed");
		assert.equal(stage.status, "completed");
	});

	test("returns not_terminal for a running stage", async () => {
		const registry = createStageControlRegistry();
		const { sessionFile, sessionId } = retainedSession("running");
		const result = await ensurePostMortemStageHandle(
			"run-1",
			completedStage({ status: "running", sessionId, sessionFile }),
			{
				registry,
				adapters: adaptersRecording({ ...mockSession(), sessionFile }, { creates: 0 }),
			},
		);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.reason, "not_terminal");
	});

	test("returns no_session when a completed stage has no retained session", async () => {
		const registry = createStageControlRegistry();
		const result = await ensurePostMortemStageHandle("run-1", completedStage(), {
			registry,
			adapters: adaptersRecording(mockSession(), { creates: 0 }),
		});
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.reason, "no_session");
	});

	test("returns invalid_session for a missing / malformed transcript", async () => {
		const registry = createStageControlRegistry();
		const missing = join(tempDir, "does-not-exist.jsonl");
		const result = await ensurePostMortemStageHandle(
			"run-1",
			completedStage({ sessionId: "missing", sessionFile: missing }),
			{
				registry,
				adapters: adaptersRecording(mockSession(), { creates: 0 }),
			},
		);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.reason, "invalid_session");
	});

	test("returns no_adapter when no agent-session adapter is available", async () => {
		const registry = createStageControlRegistry();
		const { sessionFile, sessionId } = retainedSession("no-adapter");
		const result = await ensurePostMortemStageHandle("run-1", completedStage({ sessionId, sessionFile }), {
			registry,
		});
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.reason, "no_adapter");
	});

	test("reuses an existing non-disposed handle instead of validating again", async () => {
		const registry = createStageControlRegistry();
		const { sessionFile, sessionId } = retainedSession("existing");
		const counter = { creates: 0 };
		const stage = completedStage({ sessionId, sessionFile });
		const deps = { registry, adapters: adaptersRecording({ ...mockSession(), sessionFile }, counter), cwd: tempDir };
		const first = await ensurePostMortemStageHandle("run-1", stage, deps);
		assert.equal(first.ok, true);
		// Even if the session file is deleted, the existing handle is reused.
		rmSync(sessionFile);
		const second = await ensurePostMortemStageHandle("run-1", stage, deps);
		assert.equal(first.ok && second.ok && first.handle === second.handle, true);
	});

	test("adopts the queue a restored session already holds", async () => {
		const registry = createStageControlRegistry();
		const { sessionFile, sessionId } = retainedSession("restored-queue");
		const stage = completedStage({ sessionId, sessionFile });
		// The session this adapter hands back already carries queued text: it
		// published that queue while the stage's own listeners were bound to the
		// session it replaced, so no later `queue_update` will ever repeat it.
		const restored: StageSessionRuntime = {
			...mockSession(),
			sessionFile,
			getSteeringMessages: () => ["redirect"],
			getFollowUpMessages: () => ["afterwards"],
		};
		const result = await ensurePostMortemStageHandle("run-1", stage, {
			registry,
			adapters: adaptersRecording(restored, { creates: 0 }),
			cwd: tempDir,
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.handle.queuedUserMessages?.(), { steering: [], followUp: [] });

		await result.handle.ensureAttached();
		assert.deepEqual(result.handle.queuedUserMessages?.(), {
			steering: ["redirect"],
			followUp: ["afterwards"],
		});
	});

	test("does not reuse a retained handle after the authoritative stage becomes non-resumable", async () => {
		const registry = createStageControlRegistry();
		const { sessionFile, sessionId } = retainedSession("became-failed");
		const completed = completedStage({ sessionId, sessionFile });
		const deps = {
			registry,
			adapters: adaptersRecording({ ...mockSession(), sessionFile }, { creates: 0 }),
		};
		assert.equal((await ensurePostMortemStageHandle("run-1", completed, deps)).ok, true);

		const failed = await ensurePostMortemStageHandle("run-1", { ...completed, status: "failed" }, deps);
		assert.equal(failed.ok, false);
		if (failed.ok) return;
		assert.equal(failed.reason, "not_terminal");
	});
});

describe("isPostMortemEligibleStage", () => {
	test("true only for completed stages with a retained session ID", () => {
		assert.equal(isPostMortemEligibleStage(completedStage({ sessionId: "retained" })), true);
		assert.equal(isPostMortemEligibleStage(completedStage()), false);
		assert.equal(isPostMortemEligibleStage(completedStage({ status: "running", sessionId: "retained" })), false);
		assert.equal(isPostMortemEligibleStage(completedStage({ status: "failed", sessionId: "retained" })), false);
	});
});
