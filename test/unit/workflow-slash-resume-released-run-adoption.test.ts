import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import type {
	ExtensionAPI,
	PiCommandContext,
	PiExecuteContext,
} from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { WorkflowInstanceOwnershipError } from "../../packages/workflows/src/extension/workflow-instance-owner.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const PREVIOUS_SESSION = "previous-session";
const SUCCESSOR_SESSION = "successor-session";
const OTHER_SESSION = "other-session";

type SlashContext = PiCommandContext & { sessionManager: { getSessionId: () => string } };

function slashContext(sessionId: string, cwd: string = process.cwd()): SlashContext {
	return { hasUI: false, cwd, ui: { notify: () => undefined }, sessionManager: { getSessionId: () => sessionId } };
}

function modelContext(sessionId: string): PiExecuteContext {
	return { sessionId, sessionManager: { getSessionId: () => sessionId }, cwd: process.cwd() } as PiExecuteContext;
}

function setup() {
	const definition = workflow({
		name: "session-run-control",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("finish", {}, async () => "done");
			return {};
		},
	});
	const runtime = createExtensionRuntime({ definitions: [definition], store });
	const execute = makeExecuteWorkflowTool(
		runtime,
		() => undefined,
		() => undefined,
	);
	return { runtime, execute };
}

async function registerRun(
	backend: DurableWorkflowBackend,
	runId: string,
	overrides: Partial<Parameters<DurableWorkflowBackend["registerWorkflow"]>[0]> = {},
): Promise<void> {
	await backend.registerWorkflow({
		workflowId: runId,
		name: "session-run-control",
		inputs: {},
		createdAt: 1,
		updatedAt: 1,
		status: "paused",
		completedCheckpoints: 1,
		modelOwner: PREVIOUS_SESSION,
		releasedModelOwner: PREVIOUS_SESSION,
		origin: "agent",
		invocationCwd: process.cwd(),
		...overrides,
	});
}

async function slashResume(
	runtime: ReturnType<typeof setup>["runtime"],
	target: string,
	ctx: SlashContext,
	pi: ExtensionAPI = {},
) {
	const info: string[] = [];
	const errors: string[] = [];
	await handleRunControlCommand(
		"resume",
		[target],
		ctx,
		{ info: (message) => info.push(message), error: (message) => errors.push(message) },
		{
			pi,
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
		},
	);
	return { info, errors };
}

beforeEach(async () => {
	store.clear();
	setDurableBackend(await createMemoryTestBackend());
});

afterEach(() => {
	stageControlRegistry.clear();
	store.clear();
	setDurableBackend(undefined);
});

describe("/workflow resume transfers ownership of a run released by the previous session (#3569)", () => {
	test.sequential("the slash command makes the successor the owner and clears the release record (#3569)", async () => {
		const runId = testRunId("slash-released-adoption");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId);
		const { runtime, execute } = setup();

		const { errors } = await slashResume(runtime, runId, slashContext(SUCCESSOR_SESSION));

		assert.deepEqual(errors, []);
		await vi.waitFor(() => assert.equal(backend.getWorkflow(runId)?.status, "completed"));
		assert.equal(backend.getWorkflow(runId)?.modelOwner, SUCCESSOR_SESSION);
		assert.equal(backend.getWorkflow(runId)?.releasedModelOwner, undefined);

		const detail = await execute({ action: "status", runId }, modelContext(SUCCESSOR_SESSION));
		assert.equal(detail.action, "statusDetail");
		assert.equal("detail" in detail && detail.detail !== undefined, true);
		const stages = await execute({ action: "stages", runId }, modelContext(SUCCESSOR_SESSION));
		assert.equal(stages.action, "stages");
		for (const action of ["status", "stages"] as const) {
			await assert.rejects(
				execute({ action, runId }, modelContext(OTHER_SESSION)),
				WorkflowInstanceOwnershipError,
				action,
			);
		}
	});

	test.sequential("the slash command adopts when the predecessor's snapshot is still in the shared run store (#3569)", async () => {
		const runId = testRunId("slash-released-adoption-shared-store");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId);
		store.recordRunStart({
			id: runId,
			name: "session-run-control",
			inputs: {},
			status: "paused",
			exitReason: "quit",
			resumable: true,
			startedAt: 1,
			toolNodes: [],
			stages: [],
			modelOwner: PREVIOUS_SESSION,
			origin: "agent",
		});
		const { runtime } = setup();

		const { errors } = await slashResume(runtime, runId, slashContext(SUCCESSOR_SESSION));

		assert.deepEqual(errors, []);
		await vi.waitFor(() => assert.equal(backend.getWorkflow(runId)?.status, "completed"));
		assert.equal(backend.getWorkflow(runId)?.modelOwner, SUCCESSOR_SESSION);
		assert.equal(backend.getWorkflow(runId)?.releasedModelOwner, undefined);
	});

	test.sequential("the slash command resolves a run-id prefix and still transfers ownership (#3569)", async () => {
		const runId = testRunId("slash-released-adoption-prefix");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId);
		const { runtime } = setup();

		const { errors } = await slashResume(runtime, runId.slice(0, 8), slashContext(SUCCESSOR_SESSION));

		assert.deepEqual(errors, []);
		await vi.waitFor(() => assert.equal(backend.getWorkflow(runId)?.status, "completed"));
		assert.equal(backend.getWorkflow(runId)?.modelOwner, SUCCESSOR_SESSION);
	});

	test.sequential("slash resume of a run that was never released keeps its owner (#3569)", async () => {
		const cases = [
			{ label: "paused run its owner never released", overrides: { releasedModelOwner: undefined } },
			{ label: "run released by a different owner", overrides: { releasedModelOwner: OTHER_SESSION } },
			{ label: "released run in another project", overrides: { invocationCwd: "/another-project" } },
		];
		for (const [index, { label, overrides }] of cases.entries()) {
			store.clear();
			const runId = testRunId(`slash-unreleased-${index}`);
			const backend = await createMemoryTestBackend();
			setDurableBackend(backend);
			await registerRun(backend, runId, overrides);
			const { runtime } = setup();

			await slashResume(runtime, runId, slashContext(SUCCESSOR_SESSION));

			assert.equal(backend.getWorkflow(runId)?.modelOwner, PREVIOUS_SESSION, label);
		}
	});

	test.sequential("slash resume does not adopt a crashed owner's running run (#3569)", async () => {
		const runId = testRunId("slash-crashed-owner");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId, {
			status: "running",
			releasedModelOwner: undefined,
			ownerExecutorId: "atomic-db-00000000-0000-4000-8000-000000000001",
			ownerLiveness: "dead",
		});
		const { runtime } = setup();

		await slashResume(runtime, runId, slashContext(SUCCESSOR_SESSION));

		assert.equal(backend.getWorkflow(runId)?.modelOwner, PREVIOUS_SESSION);
	});

	test.sequential("the original owner's slash resume of its own released run keeps working (#3569)", async () => {
		const runId = testRunId("slash-released-original-owner");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId);
		const { runtime } = setup();

		const { errors } = await slashResume(runtime, runId, slashContext(PREVIOUS_SESSION));

		assert.deepEqual(errors, []);
		await vi.waitFor(() => assert.equal(backend.getWorkflow(runId)?.status, "completed"));
		assert.equal(backend.getWorkflow(runId)?.modelOwner, PREVIOUS_SESSION);
		assert.equal(backend.getWorkflow(runId)?.releasedModelOwner, undefined);
	});
});

for (const accept of [false, true]) {
	test.sequential(`cross-project slash resume ${accept ? "forks on yes" : "aborts on no"} (#3577)`, async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		const runId = testRunId(`slash-cross-project-${accept}`);
		await registerRun(backend, runId, {
			invocationCwd: "/other-project",
			label: "Saved objective",
			summary: "Review finished; implementation pending.",
			summarizedThrough: 1234,
		});
		await backend.recordCheckpoint({
			kind: "ui",
			workflowId: runId,
			checkpointId: "answer",
			promptKind: "confirm",
			message: "Continue?",
			promptHash: "answer",
			response: true,
			completedAt: 1,
		});
		const original = structuredClone(backend.getWorkflow(runId));
		const { runtime } = setup();
		const ctx = slashContext(SUCCESSOR_SESSION);
		ctx.hasUI = true;
		let prompts = 0;
		ctx.ui.confirm = async (_title, message) => {
			prompts++;
			assert.equal(
				message,
				"Workflow run found in different project: /other-project. Fork it into the current directory?",
			);
			return accept;
		};
		const messages: string[] = [];
		const result = await slashResume(runtime, runId, ctx, {
			sendMessage: (message, options) => {
				assert.equal(options?.triggerTurn, false);
				assert.equal(store.runs().length, 0, "summary reaches context before the fork starts");
				messages.push(typeof message.content === "string" ? message.content : "");
			},
		});
		assert.equal(prompts, 1);
		assert.deepEqual(backend.getWorkflow(runId), original);
		if (accept) {
			assert.deepEqual(result.errors, []);
			await vi.waitFor(() => assert.equal(store.runs().find((run) => run.id !== runId)?.status, "completed"));
			assert.equal(
				backend.getWorkflow(store.runs().find((run) => run.id !== runId)!.id)?.invocationCwd,
				process.cwd(),
			);
			assert.equal(
				backend.getWorkflow(store.runs().find((run) => run.id !== runId)!.id)?.modelOwner,
				SUCCESSOR_SESSION,
			);
			const fork = backend.getWorkflow(store.runs().find((run) => run.id !== runId)!.id)!;
			assert.equal(fork.label, "Saved objective");
			assert.equal(fork.summary, "Review finished; implementation pending.");
			assert.equal(fork.summarizedThrough, 1234);
			assert.equal(messages.length, 1);
			assert.ok(messages[0].includes(`Workflow resume context: ${fork.workflowId} (forked from ${runId})`));
			assert.ok(messages[0].includes("Review finished; implementation pending."));
		} else {
			assert.match(result.errors.join("\n"), /cancelled/);
			assert.equal(store.runs().length, 0);
			assert.deepEqual(messages, []);
		}
	});
}

test.sequential("cross-project tool and headless resume give an actionable error (#3577)", async () => {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	const runId = testRunId("cross-project-headless");
	await registerRun(backend, runId, { invocationCwd: "/other-project" });
	const original = structuredClone(backend.getWorkflow(runId));
	const { runtime, execute } = setup();
	const result = await slashResume(runtime, runId, slashContext(SUCCESSOR_SESSION));
	assert.match(result.errors.join("\n"), /\/workflow resume.*interactive/);
	await assert.rejects(
		execute({ action: "resume", runId }, modelContext(PREVIOUS_SESSION)),
		/\/workflow resume.*interactive/,
	);
	assert.deepEqual(backend.getWorkflow(runId), original);
	assert.equal(store.runs().length, 0);
});
