import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "@bastani/atomic";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { DurableWaitingStage } from "../../packages/workflows/src/durable/stage-primitive.js";
import { assertWaitingStageSessionsExist } from "../../packages/workflows/src/engine/run-resume-preflight.js";
import { deliverStageWake, run as sdkRun } from "../../packages/workflows/src/sdk-surface.js";
import {
	isStageRehydrationError,
	isStageWaitConfigError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { assert, createStore, run, workflow } from "./executor-shared.js";

const RUN_ID = "run-surfaces-preflight";

function waitingStage(sessionId: string, sessionFile?: string): DurableWaitingStage {
	return {
		replayKey: `stage:${sessionId}:1`,
		stageName: sessionId,
		sessionId,
		...(sessionFile === undefined ? {} : { sessionFile }),
		wait: { kind: "release", since: 1, promptsCompleted: 1 },
	};
}

const empty = workflow({ name: "empty-run", description: "", inputs: {}, outputs: {}, run: async () => ({}) });
const withTool = workflow({
	name: "tool-run",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("noop", {}, async () => "done");
		return {};
	},
});

describe("a run's waiting-stage surfaces at its start and end (#4309)", () => {
	test("the SDK refuses an invalid releaseWhenWaiting before it opens the run's journal or starts a run (#4309)", async () => {
		const store = createStore();
		const directory = await mkdtemp(join(tmpdir(), "waiting-stage-sdk-validation-"));
		const path = join(directory, "journal.db");
		try {
			await assert.rejects(
				sdkRun(empty, {}, { store, journal: { path }, releaseWhenWaiting: { afterMs: -1 } }),
				(error: unknown) => isStageWaitConfigError(error),
			);
			assert.equal(store.runs().length, 0);
			assert.equal(existsSync(path), false, "the run's journal was opened for a run that was refused");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("a message sent to a stage of a run that has ended finds no live run (#4309)", async () => {
		const result = await run(withTool, {}, { store: createStore() });

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(deliverStageWake(result.runId, "any-stage", { kind: "tool-results", results: [] }), {
			status: "run-not-live",
		});
	});
});

describe("the resume preflight's session storage (#4309)", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "waiting-stage-preflight-storage-"));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	test("the configured session storage opened for the check is closed after it (#4309)", async () => {
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
		const close = vi.spyOn(JsonlSessionStore.prototype, "close");

		await assert.rejects(
			assertWaitingStageSessionsExist([waitingStage("gone")], RUN_ID, { cwd: project }),
			(error: unknown) => isStageRehydrationError(error),
		);
		assert.equal(close.mock.calls.length, 1);
	});

	test("a stage's session file named relative to the process's directory does not count as found (#4309)", async () => {
		// The test process runs in the repository root, where this file exists.
		assert.ok(existsSync("package.json"));

		await assert.rejects(
			assertWaitingStageSessionsExist([waitingStage("relative", "package.json")], RUN_ID, {
				adapters: { sessionStore: new MemorySessionStore() },
			}),
			(error: unknown) => isStageRehydrationError(error) && error.fields.sessionIds?.[0] === "relative",
		);
	});
});
