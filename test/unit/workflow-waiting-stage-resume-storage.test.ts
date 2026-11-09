import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "@bastani/atomic";
import { afterEach, beforeEach, describe, vi } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import {
	createStageReplayKeyGenerator,
	recordStageSessionCheckpoint,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { assert, createStore, test, workflow } from "./executor-shared.js";

const WORKFLOW_NAME = "resume-storage";
/** Answers prompts without a session, so the only session store a resume opens is its preflight's. */
const PROMPT_ONLY: Pick<NonNullable<RunOpts["adapters"]>, "prompt"> = { prompt: { prompt: async () => "done" } };

const definition = workflow({
	name: WORKFLOW_NAME,
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.stage("plain").prompt("go");
		return {};
	},
});

function failedSource(runId: string): RunSnapshot {
	return {
		id: runId,
		name: WORKFLOW_NAME,
		inputs: {},
		startedAt: 1_000,
		status: "failed",
		stages: [],
		toolNodes: [],
		resumable: true,
	};
}

/** A failed, resumable run started in `invocationCwd` (none recorded when undefined), whose stage `alpha` waited released with session `sessionId`. */
async function seedFailedRun(invocationCwd: string | undefined, waitingSessionId?: string) {
	const runId = crypto.randomUUID();
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: WORKFLOW_NAME,
		inputs: {},
		createdAt: 1_000,
		...(invocationCwd === undefined ? {} : { invocationCwd }),
		status: "failed",
		resumable: true,
		error: "the stage's store was unreachable",
	});
	if (waitingSessionId !== undefined)
		await recordStageSessionCheckpoint(
			{
				workflowId: runId,
				backend,
				nextCheckpointId: createCheckpointIdGenerator(),
				nextReplayKey: createStageReplayKeyGenerator(runId),
				now: () => 3_000,
			},
			{
				id: "stage-alpha",
				name: "alpha",
				replayKey: "stage:alpha:1",
				status: "suspended",
				parentIds: [],
				toolEvents: [],
				startedAt: 1_000,
				sessionId: waitingSessionId,
				wait: { kind: "release", since: 3_000, promptsCompleted: 0 },
			},
			{ force: true },
		);
	return { runId, backend };
}

function resume(runId: string, backend: JournalDurableBackend, baseRunOpts: Partial<RunOpts> = {}) {
	return resumeDurableWorkflow(runId, {
		registry: createRegistry([definition as unknown as WorkflowDefinition]),
		durableBackend: backend,
		baseRunOpts: {
			store: createStore(),
			adapters: PROMPT_ONLY,
			continuation: { source: failedSource(runId) },
			...baseRunOpts,
		},
	});
}

describe("the session storage a resume checks its waiting stages in (#4309)", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "waiting-stage-resume-storage-"));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	test("a run with no stored storage choice is checked in the configured storage of the directory it was started in (#4309)", async () => {
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
		const seeded = await seedFailedRun(project, "gone-session");

		const result = await resume(seeded.runId, seeded.backend);

		assert.equal(result.ok, false);
		assert.ok(!result.ok && result.reason === "startup_failed");
		assert.ok(result.message.includes(`configured session storage: jsonl ${configured}`), result.message);
		await seeded.backend.close();
	});

	test("a run that recorded no directory is checked in the configured storage of the directory the resume runs in (#4309)", async () => {
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
		const seeded = await seedFailedRun(undefined, "gone-session");

		const result = await resume(seeded.runId, seeded.backend, { cwd: project });

		assert.ok(!result.ok && result.reason === "startup_failed");
		assert.ok(result.message.includes(`configured session storage: jsonl ${configured}`), result.message);
		await seeded.backend.close();
	});

	test("a run with no stage left waiting opens no session store to check (#4309)", async () => {
		const directory = join(root, "sessions");
		await mkdir(directory);
		const seeded = await seedFailedRun(root);
		const open = vi.spyOn(JsonlSessionStore, "open");

		await resume(seeded.runId, seeded.backend, { defaultSessionDir: directory });

		assert.deepEqual(
			open.mock.calls.filter(([, options]) => options?.scanExisting === false),
			[],
		);
		await seeded.backend.close();
	});
});
