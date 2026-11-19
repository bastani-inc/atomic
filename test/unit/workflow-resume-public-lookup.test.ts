import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { onTestFinished, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import { createEngineHostPair } from "../../packages/coding-agent/test/helpers/in-process-engine-pair.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-session-routing.ts";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createWorkflowResumeProvider } from "../../packages/workflows/src/extension/workflow-resume-provider.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { createSessionRunControl } from "../../packages/workflows/src/extension/workflow-session-run-control.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { currentStageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { configureTestStoreBackend } from "../helpers/store-backend.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { openSqlSnapshotJournal } from "../helpers/workflow-snapshot-journal.js";

useTemporaryAgentDir();
const id = "abcd1234-1111-4333-8444-555555555555";

async function publicResumeFixture(reblock = false) {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-resume-lookup-"));
	const { journal, database } = await openSqlSnapshotJournal(join(cwd, "journal.sqlite"));
	const backend = await JournalDurableBackend.open(journal, { runs: [], ownsJournal: false });
	const store = createStore();
	const jobs = createJobTracker();
	configureTestStoreBackend(store, backend);
	onTestFinished(async () => {
		await Promise.all(jobs.runIds().map((runId) => jobs.get(runId)?.promise));
		vi.restoreAllMocks();
		configureTestStoreBackend(store, undefined);
		await backend.close();
		await database.close();
		await rm(cwd, { force: true, recursive: true });
	});
	const owner = {
		store,
		jobs,
		stageControlRegistry: createStageControlRegistry(),
		toolControlRegistry: createToolControlRegistry(),
		stageUiBroker: currentStageUiBroker(),
	};
	const ctx = { cwd, hasUI: false, sessionManager: { getSessionId: () => "lookup-session" }, ui: { notify() {} } };
	const executeBody = vi.fn(async () => ({}));
	const definition = workflow({
		name: "lookup",
		description: "",
		inputs: {},
		outputs: { status: Type.Optional(Type.String()) },
		run: async (ctx) => {
			await executeBody();
			if (reblock) {
				await ctx.tool("before-block", {}, async () => true);
				return { status: "needs_human" };
			}
			return {};
		},
	});
	const runtime = createExtensionRuntime({ cwd, definitions: [definition], ...owner });
	const deps = {
		pi: {},
		overlay: { open() {}, close() {}, toggle() {} },
		owner,
		context: () => ctx,
		runtimeForContext: () => runtime,
		ensureWorkflowResourcesLoaded() {},
	};
	const provider = createWorkflowResumeProvider(deps);
	const errors: string[] = [];
	vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
	const mode = {
		showError: (message: string) => errors.push(message),
		sessionManager: { getSessionStore: () => ({}) },
		ensureDeferredStartupComplete: async () => {},
		runtimeHost: {},
		session: { extensionRunner: { getWorkflowRunControl: () => provider, createCommandContext: () => ctx } },
	} as unknown as InteractiveModeBase;
	return { backend, journal, runtime, deps, ctx, provider, errors, mode, executeBody, definition };
}

test("interactive /resume checks hidden stored roots for prefix collisions before executing (#5569)", async () => {
	const { backend, errors, mode, executeBody, definition, provider } = await publicResumeFixture();
	const eligible = id.replace("1111", "2222");
	for (const workflowId of [id, eligible]) {
		await backend.commitWorkflowRegistration({
			workflowId,
			name: definition.name,
			inputs: {},
			createdAt: 1,
			status: "failed",
			resumable: workflowId === eligible,
		});
		await backend.releaseWorkflow(workflowId);
	}
	assert.deepEqual(
		(await provider.listResumeEntries()).map((row) => row.id),
		[eligible],
	);
	await InteractiveModeBase.prototype.handleResumeTarget.call(mode, id.slice(0, 8).toUpperCase());
	assert.equal(executeBody.mock.calls.length, 0);
	assert.match(errors[0] ?? "", /ambiguous/);
	for (const workflowId of [id, eligible]) assert.ok(errors[0]!.includes(workflowId));
	await InteractiveModeBase.prototype.handleResumeTarget.call(mode, id);
	assert.match(errors[1] ?? "", /not resumable/);
	assert.equal(executeBody.mock.calls.length, 0);
});

test.each(["between listing and picking", "during the pick's lookup"] as const)(
	"an isolated host cannot resume a newer block %s (#5569)",
	async (when) => {
		const { backend, runtime, deps, ctx, mode, provider, errors, executeBody, definition } =
			await publicResumeFixture(true);
		await backend.commitWorkflowRegistration({
			workflowId: id,
			name: definition.name,
			inputs: {},
			createdAt: 1,
			status: "blocked",
			resumable: true,
		});
		await backend.releaseWorkflow(id);
		const execute = makeExecuteWorkflowTool(runtime, () => undefined, deps.ensureWorkflowResourcesLoaded, deps.owner);
		const pair = await createEngineHostPair({
			engineExtensions: [
				(pi) => {
					pi.registerWorkflowRunControl({
						...createSessionRunControl({ ...deps.owner, context: () => ctx, execute }),
						...provider,
					});
				},
			],
		});
		onTestFinished(() => pair.cleanup());
		mode.runtimeHost = pair.runtime;
		const lookup = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const getRows = pair.runtime.getWorkflowResumeEntries.bind(pair.runtime);
		vi.spyOn(pair.runtime, "getWorkflowResumeEntries").mockImplementation(async (target) => {
			const rows = await getRows(target);
			assert.ok(rows.some((row) => row.id === id));
			if (when === "between listing and picking") lookup.resolve();
			else
				vi.spyOn(deps, "ensureWorkflowResourcesLoaded").mockImplementationOnce(async () => {
					lookup.resolve();
					await release.promise;
				});
			return rows;
		});
		if (when === "between listing and picking")
			vi.spyOn(SessionManager, "listAll").mockImplementationOnce(async () => {
				await release.promise;
				return [];
			});
		const picking = InteractiveModeBase.prototype.handleResumeTarget.call(mode, id);
		try {
			await lookup.promise;
			const competing = await runtime.resumeDurableWorkflow(id, { definition });
			assert.ok(competing.ok, competing.message);
			await deps.owner.jobs.get(id)?.promise;
			assert.equal(deps.owner.store.run(id)?.status, "blocked");
			assert.equal(executeBody.mock.calls.length, 1);
		} finally {
			release.resolve();
			await picking;
		}
		assert.equal(executeBody.mock.calls.length, 1);
		assert.match(errors.join("\n"), /changed.*refresh|stale.*refresh/i);
	},
);

test("a local run without progress cannot hide a stored prefix collision from the resume command (#5569)", async () => {
	const { backend, deps, ctx, errors, definition, executeBody } = await publicResumeFixture();
	const other = id.replace("1111", "3333");
	await backend.commitWorkflowRegistration({
		workflowId: id,
		name: definition.name,
		inputs: {},
		createdAt: 1,
		status: "paused",
	});
	await backend.commitWorkflowRegistration({
		workflowId: other,
		name: definition.name,
		inputs: {},
		createdAt: 1,
		status: "failed",
		resumable: true,
	});
	deps.owner.store.recordRunStart({
		id,
		name: definition.name,
		inputs: {},
		status: "paused",
		startedAt: 1,
		stages: [],
		toolNodes: [],
	});
	await handleRunControlCommand(
		"resume",
		[id.slice(0, 8)],
		ctx,
		{ info() {}, error: (message) => errors.push(message) },
		deps,
	);
	assert.match(errors[0] ?? "", /ambiguous/);
	for (const workflowId of [id, other]) assert.ok(errors[0]!.includes(workflowId));
	assert.equal(executeBody.mock.calls.length, 0);
});

test("a run deleted after listing loses its cached resume entry without reading a missing history (#5569)", async () => {
	const { backend, journal, runtime } = await publicResumeFixture();
	await backend.commitWorkflowRegistration({
		workflowId: id,
		name: "lookup",
		inputs: {},
		createdAt: 1,
		status: "failed",
	});
	await backend.releaseWorkflow(id);
	assert.equal((await runtime.prepareDurableResumableForIds!([id])).length, 1);
	const other = await JournalDurableBackend.open(journal, { runs: [id], ownsJournal: false });
	try {
		await other.deleteWorkflow(id);
	} finally {
		await other.close();
	}
	const read = vi.spyOn(journal, "read");
	assert.deepEqual(await runtime.prepareDurableResumableForIds!([id]), []);
	assert.equal(backend.getWorkflow(id), undefined);
	assert.equal(read.mock.calls.length, 0);
});

test.each(["workflow tool", "session SDK", "slash handler", "interactive host"] as const)(
	"%s reads no journal history for a missing resume id (#5569)",
	async (entry) => {
		const { journal, runtime, deps, ctx, mode, errors } = await publicResumeFixture();
		const read = vi.spyOn(journal, "read");
		const execute = makeExecuteWorkflowTool(runtime, () => undefined, deps.ensureWorkflowResourcesLoaded, deps.owner);
		switch (entry) {
			case "workflow tool": {
				const result = await execute({ action: "resume", runId: id }, ctx);
				assert.ok(result.action === "resume");
				assert.equal(result.code, "run_not_found");
				break;
			}
			case "session SDK":
				await assert.rejects(createSessionRunControl({ ...deps.owner, context: () => ctx, execute }).resume(id), {
					name: "WorkflowRunNotFoundError",
				});
				break;
			case "slash handler":
				await handleRunControlCommand(
					"resume",
					[id],
					ctx,
					{ info() {}, error: (message) => errors.push(message) },
					deps,
				);
				assert.match(errors[0] ?? "", /not found|does not hold/i);
				break;
			case "interactive host":
				await InteractiveModeBase.prototype.handleResumeTarget.call(mode, id);
				assert.match(errors[0] ?? "", /No session or resumable workflow matches/);
				break;
		}
		assert.deepEqual(
			read.mock.calls.map(([runId]) => runId),
			[],
		);
	},
);
