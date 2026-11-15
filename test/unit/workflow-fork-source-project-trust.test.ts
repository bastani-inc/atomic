import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	ForkDefinitionMismatchError,
	rehydrateForkError,
	type SerializedForkError,
} from "../../packages/workflows/src/durable/fork-errors.js";
import { WorkflowProjectNotTrustedError } from "../../packages/workflows/src/durable/project-trust.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

afterEach(() => setDurableBackend(undefined));

test("a fork refused for an untrusted source project names the folder and how to trust it, across a worker boundary", () => {
	const error = new ForkDefinitionMismatchError({
		runId: "run-1",
		workflow: "review",
		reason: "project-not-trusted",
		projectDir: "/work/source",
	});
	assert.equal(
		error.message,
		'Fork definition mismatch: workflow "review" of run run-1 is defined in /work/source, which is not a trusted project (definition-mismatch). Start Atomic in /work/source and use /trust to trust it, then fork again.',
	);
	const back = rehydrateForkError(JSON.parse(JSON.stringify(error)) as SerializedForkError);
	assert.ok(back instanceof ForkDefinitionMismatchError);
	assert.equal(back.reason, "project-not-trusted");
	assert.equal(back.projectDir, "/work/source");
	assert.equal(back.message, error.message);
});

test("resuming a run whose workflow is in an untrusted project folder is refused with how to trust it", async () => {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	const workflowId = testRunId("resume-untrusted-folder");
	await backend.commitWorkflowRegistration({
		workflowId,
		name: "review",
		inputs: {},
		createdAt: 1,
		status: "paused",
		completedCheckpoints: 1,
		invocationCwd: "/work/source",
	});
	const registered = workflow({
		name: "review",
		description: "",
		inputs: { topic: Type.Optional(Type.String()) },
		outputs: {},
		run: async () => ({}),
	});
	const result = await resumeDurableWorkflow(workflowId, {
		registry: createRegistry().register(registered),
		durableBackend: backend,
		baseRunOpts: { store: createStore(), cwd: "/work/source" },
		jobs: createJobTracker(),
		resolveDefinition: async (name, cwd) => {
			throw new WorkflowProjectNotTrustedError(name, cwd!);
		},
	});
	assert.equal(result.ok, false);
	assert.equal(result.ok ? undefined : result.reason, "workflow_not_found");
	assert.equal(
		result.message,
		'Workflow "review" is defined in /work/source, which is not a trusted project, so its workflows are not loaded. Start Atomic in /work/source and use /trust to trust it, then try again.',
	);
});

test("an unrelated definition lookup failure still propagates from a resume", async () => {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	const workflowId = testRunId("resume-lookup-failure");
	await backend.commitWorkflowRegistration({
		workflowId,
		name: "review",
		inputs: {},
		createdAt: 1,
		status: "paused",
		completedCheckpoints: 1,
		invocationCwd: "/work/source",
	});
	const failure = new Error("lookup failed");
	await assert.rejects(
		resumeDurableWorkflow(workflowId, {
			registry: createRegistry(),
			durableBackend: backend,
			baseRunOpts: { store: createStore(), cwd: "/work/source" },
			jobs: createJobTracker(),
			resolveDefinition: async () => {
				throw failure;
			},
		}),
		failure,
	);
});
