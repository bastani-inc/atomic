import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore, SessionManager, type SessionStore } from "@bastani/atomic";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { DurableWaitingStage } from "../../packages/workflows/src/durable/stage-primitive.js";
import { assertWaitingStageSessionsExist } from "../../packages/workflows/src/engine/run-resume-preflight.js";
import {
	isStageRehydrationError,
	type StageRehydrationError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { assert } from "./executor-shared.js";

const RUN_ID = "run-preflight";

function waitingStage(sessionId: string, sessionFile?: string): DurableWaitingStage {
	return {
		replayKey: `stage:${sessionId}:1`,
		stageName: sessionId,
		sessionId,
		...(sessionFile === undefined ? {} : { sessionFile }),
		wait: { kind: "release", since: 1, promptsCompleted: 1 },
	};
}

/** A memory store that says it is the given kind of store, and whose sessions are the ones the test saved. */
function describedStore(adapter: string, location: string): MemorySessionStore {
	const store = new MemorySessionStore();
	Object.defineProperty(store, "descriptor", { value: { adapter, location } });
	return store;
}

async function rehydrationFailure(promise: Promise<void>): Promise<StageRehydrationError> {
	const failure = await promise.then(
		() => undefined,
		(error: Error) => error,
	);
	assert.ok(isStageRehydrationError(failure), `expected a StageRehydrationError, got ${String(failure)}`);
	return failure;
}

async function savedSessionId(store: SessionStore, cwd = "/"): Promise<string> {
	const manager = await SessionManager.create(store, cwd);
	await manager.appendMessage({ role: "user", content: "plan", timestamp: 1 });
	return manager.getSessionId();
}

describe("the resume preflight of waiting stages (#4309)", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "waiting-stage-preflight-"));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	test("names a file-backed store by adapter and location, and any other store by adapter only (#4309)", async () => {
		const cases: readonly [string, string, string][] = [
			["sqlite", "/data/sessions.db", "SDK sessionStore option: sqlite /data/sessions.db"],
			["jsonl", "/data/sessions", "SDK sessionStore option: jsonl /data/sessions"],
			["sqlite", "", "SDK sessionStore option: sqlite"],
			["jsonl", "", "SDK sessionStore option: jsonl"],
			["libsql", "libsql://user:token@db.example.com", "SDK sessionStore option: libsql"],
			["memory", "", "SDK sessionStore option: memory"],
			["memory", "somewhere", "SDK sessionStore option: memory"],
		];
		for (const [adapter, location, expected] of cases) {
			const failure = await rehydrationFailure(
				assertWaitingStageSessionsExist([waitingStage("s-1")], RUN_ID, {
					adapters: { sessionStore: describedStore(adapter, location) },
				}),
			);
			assert.equal(failure.fields.storage, expected);
			assert.ok(failure.hint.includes(expected), failure.hint);
		}
	});

	test("reports every missing session once, in order, with the run id, and is not retryable (#4309)", async () => {
		const store = new MemorySessionStore();
		const present = await savedSessionId(store);
		const reads = vi.spyOn(store, "readHeader");
		const failure = await rehydrationFailure(
			assertWaitingStageSessionsExist(
				[waitingStage("gone-2"), waitingStage(present), waitingStage("gone-1"), waitingStage("gone-2")],
				RUN_ID,
				{ adapters: { sessionStore: store } },
			),
		);
		assert.equal(failure.code, "session-not-found");
		assert.equal(failure.retryable, false);
		assert.deepEqual(failure.fields.sessionIds, ["gone-2", "gone-1"]);
		assert.equal(failure.fields.runId, RUN_ID);
		// One header read per distinct session.
		assert.deepEqual(
			reads.mock.calls.map((call) => call[0]),
			["gone-2", present, "gone-1"],
		);
	});

	test("passes when every session is in the store, and never closes a store the caller supplied (#4309)", async () => {
		const store = new MemorySessionStore();
		const first = await savedSessionId(store);
		const second = await savedSessionId(store);
		const close = vi.spyOn(store, "close");
		await assertWaitingStageSessionsExist([waitingStage(first), waitingStage(second)], RUN_ID, {
			adapters: { sessionStore: store },
			defaultSessionDir: join(root, "ignored"),
		});
		assert.equal(close.mock.calls.length, 0);
	});

	test("a stage that kept its session in its own file is found by that absolute file, and by no relative one (#4309)", async () => {
		const store = new MemorySessionStore();
		const kept = join(root, "kept-session.jsonl");
		await writeFile(kept, "{}\n");
		await assertWaitingStageSessionsExist([waitingStage("kept", kept)], RUN_ID, {
			adapters: { sessionStore: store },
		});

		const failure = await rehydrationFailure(
			assertWaitingStageSessionsExist(
				[
					waitingStage("missing-file", join(root, "never-written.jsonl")),
					waitingStage("relative", "kept-session.jsonl"),
					waitingStage("no-file"),
				],
				RUN_ID,
				{ adapters: { sessionStore: store } },
			),
		);
		assert.deepEqual(failure.fields.sessionIds, ["missing-file", "relative", "no-file"]);

		// A relative name is not looked up even where the process happens to find a file by it.
		vi.spyOn(process, "cwd").mockReturnValue(root);
		const relative = await rehydrationFailure(
			assertWaitingStageSessionsExist([waitingStage("relative", "kept-session.jsonl")], RUN_ID, {
				adapters: { sessionStore: store },
			}),
		);
		assert.deepEqual(relative.fields.sessionIds, ["relative"]);
	});

	test("a run started with a session directory is checked in that exact directory, which is opened without scanning and closed after (#4309)", async () => {
		const directory = join(root, "sessions");
		await mkdir(directory);
		const writer = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const saved = await savedSessionId(writer, root);
		await writer.close();

		const original = JsonlSessionStore.open.bind(JsonlSessionStore);
		const closes: ReturnType<typeof vi.spyOn>[] = [];
		const open = vi.spyOn(JsonlSessionStore, "open").mockImplementation(async (...args) => {
			const store = await original(...args);
			closes.push(vi.spyOn(store, "close"));
			return store;
		});

		await assertWaitingStageSessionsExist([waitingStage(saved)], RUN_ID, { defaultSessionDir: directory });
		assert.deepEqual(open.mock.calls, [[directory, { exactDirectory: true, scanExisting: false }]]);
		assert.equal(closes[0]?.mock.calls.length, 1);

		const failure = await rehydrationFailure(
			assertWaitingStageSessionsExist([waitingStage(saved), waitingStage("not-saved")], RUN_ID, {
				defaultSessionDir: directory,
			}),
		);
		assert.deepEqual(failure.fields.sessionIds, ["not-saved"]);
		assert.equal(failure.fields.storage, `session directory: jsonl ${directory}`);
		// The store opened for the check is closed on the failure path too.
		assert.equal(closes[1]?.mock.calls.length, 1);
	});

	test("a run with no stored choice is checked in the configured session storage of its working directory (#4309)", async () => {
		const agentDir = join(root, "agent");
		const configured = join(root, "configured-sessions");
		const project = join(root, "project");
		await mkdir(join(project, ".atomic"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(project, ".atomic", "settings.json"),
			JSON.stringify({ sessions: { storage: { dir: configured } } }),
		);
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("ATOMIC_SESSIONS_STORAGE", "");
		vi.stubEnv("ATOMIC_STORAGE", "");

		const byCwd = await rehydrationFailure(
			assertWaitingStageSessionsExist([waitingStage("gone")], RUN_ID, { cwd: project }),
		);
		assert.equal(byCwd.fields.storage, `configured session storage: jsonl ${configured}`);

		// Without a working directory the process's own is used.
		vi.spyOn(process, "cwd").mockReturnValue(project);
		const byProcess = await rehydrationFailure(assertWaitingStageSessionsExist([waitingStage("gone")], RUN_ID, {}));
		assert.equal(byProcess.fields.storage, `configured session storage: jsonl ${configured}`);
	});
});
