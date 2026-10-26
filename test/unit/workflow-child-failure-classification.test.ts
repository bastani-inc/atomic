import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { bindChildWorkerDispatcher } from "../../packages/workflows/src/workers/dispatch.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { makeMockSession, type StageSessionCreateOptions } from "./stage-runner-helpers.js";

afterEach(closeMemoryTestBackends);

import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";

const ORDINARY = "ENOENT: no such file or directory, open '/tmp/missing-input.json'";
const RATE_LIMITED = "429 Too Many Requests";

function failingChild(name: string, message: string) {
	return workflow({
		name,
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("fail", {}, async () => {
				throw new Error(message);
			});
			return {};
		},
	});
}

function parentOf(name: string, child: WorkflowDefinition) {
	return workflow({
		name,
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.workflow(child);
			return {};
		},
	});
}

async function runRoot(root: WorkflowDefinition, runId: string) {
	const store = createStore();
	const result = await run(root, {}, { runId, store });
	return { result, snapshot: store.runs().find((snapshot) => snapshot.id === runId) };
}

test("a child named rate-limit-child that fails on an ordinary error fails the root (#4031)", async () => {
	const { result, snapshot } = await runRoot(parentOf("root", failingChild("rate-limit-child", ORDINARY)), "named");
	assert.equal(result.status, "failed", JSON.stringify(result));
	assert.equal(
		result.error,
		`atomic-workflows: child workflow "rate-limit-child" (rate-limit-child) failed with status failed: ${ORDINARY}`,
	);
	assert.equal(snapshot?.failureKind, "unknown");
	assert.notEqual(snapshot?.failureDisposition, "active_blocked");
});

test("a child named plain that fails on a 429 blocks the root resumably (#4031)", async () => {
	const { result, snapshot } = await runRoot(parentOf("root", failingChild("plain", RATE_LIMITED)), "limited");
	assert.equal(result.status, "running", JSON.stringify(result));
	assert.equal(
		result.error,
		`atomic-workflows: child workflow "plain" (plain) failed with status failed: ${RATE_LIMITED}`,
	);
	assert.equal(snapshot?.failureKind, "rate_limit");
	assert.equal(snapshot?.failureDisposition, "active_blocked");
	assert.equal(snapshot?.resumable, true);
});

test("a 429 two child levels down still blocks the root resumably (#4031)", async () => {
	const middle = parentOf("plain-middle", failingChild("plain-leaf", RATE_LIMITED));
	const { result, snapshot } = await runRoot(parentOf("root", middle), "nested-limited");
	assert.equal(result.status, "running", JSON.stringify(result));
	assert.equal(snapshot?.failureKind, "rate_limit");
	assert.equal(snapshot?.failureDisposition, "active_blocked");
});

test("an ordinary error under rate-limit-named children two levels down fails the root (#4031)", async () => {
	const middle = parentOf("overloaded-middle", failingChild("rate-limit-leaf", ORDINARY));
	const { result, snapshot } = await runRoot(parentOf("root", middle), "nested-named");
	assert.equal(result.status, "failed", JSON.stringify(result));
	assert.match(result.error ?? "", /child workflow "overloaded-middle".*child workflow "rate-limit-leaf".*ENOENT/);
	assert.equal(snapshot?.failureKind, "unknown");
});

test("a failed run reports its own failure classification (#4031)", async () => {
	const limited = await runRoot(failingChild("plain", RATE_LIMITED), "own-limited");
	assert.deepEqual(limited.result.failure, {
		kind: "rate_limit",
		code: "rate_limited",
		retryable: true,
		resumable: true,
		recoverability: "recoverable",
	});
	const ordinary = await runRoot(failingChild("plain", ORDINARY), "own-ordinary");
	assert.equal(ordinary.result.failure?.kind, "unknown");
	const blocked = await runRoot(parentOf("root", failingChild("plain", RATE_LIMITED)), "own-blocked");
	assert.equal(blocked.result.failure?.kind, "rate_limit");
	assert.equal(blocked.result.failure?.disposition, "active_blocked");
});

test.each([
	["an ordinary error", ORDINARY, "failed", "unknown"],
	["a 429", RATE_LIMITED, "running", "rate_limit"],
] as const)(
	"a stored child result without its classification is classified from its own error under nested wrappers: %s (#4031)",
	async (_label, inner, status, failureKind) => {
		const backend = await createMemoryTestBackend();
		const child = failingChild("rate-limit-child", inner);
		let dispatched = 0;
		// A result an older release stored: the error text only, itself a child-workflow wrapper naming workflows.
		const release = bindChildWorkerDispatcher(backend, {
			validateOptions() {},
			async run(_definition, _inputs, options) {
				dispatched += 1;
				return {
					runId: options.runId ?? "child",
					status: "failed",
					error: `atomic-workflows: child workflow "overloaded-grandchild" (overloaded-grandchild) failed with status failed: ${inner}`,
					stages: [],
					toolNodes: [],
				};
			},
		});
		try {
			const store = createStore();
			const result = await run(
				parentOf("root", child),
				{},
				{ runId: `stored-${status}`, store, durableBackend: backend },
			);
			assert.equal(dispatched, 1);
			assert.equal(result.status, status, JSON.stringify(result));
			assert.equal(store.runs().find((snapshot) => snapshot.id === `stored-${status}`)?.failureKind, failureKind);
		} finally {
			release();
		}
	},
);

/** A failure a component can throw with a code its message alone does not explain. */
function signInRequired(): Error {
	return Object.assign(new Error("Please sign in"), { code: "auth_required" });
}

test("a child whose stage needs sign-in keeps the root login-blocked, whatever the message says (#4031)", async () => {
	const child = workflow({
		name: "plain-child",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.stage("work").prompt("Do the work");
			return {};
		},
	});
	const store = createStore();
	const adapters = {
		agentSession: {
			async create(options: StageSessionCreateOptions) {
				return makeMockSession({
					model: options.model,
					async prompt() {
						throw signInRequired();
					},
				}).session;
			},
		},
	};
	const result = await run(parentOf("root", child), {}, { runId: "sign-in", store, adapters });
	const childStage = store
		.runs()
		.find((snapshot) => snapshot.id !== "sign-in")
		?.stages.find((stage) => stage.name === "work");
	assert.equal(childStage?.failureCode, "login_required");
	assert.equal(childStage?.failureDisposition, "active_blocked");
	assert.equal(result.status, "running", JSON.stringify(result));
	const snapshot = store.runs().find((entry) => entry.id === "sign-in");
	assert.equal(snapshot?.failureKind, "auth");
	assert.equal(snapshot?.failureCode, "login_required");
	assert.equal(snapshot?.failureDisposition, "active_blocked");
	assert.equal(snapshot?.resumable, true);
});

const CHILD_ERRORS = [
	["503", () => new Error("503 Service Unavailable"), "provider", "running"],
	["ENOENT", () => new Error(ORDINARY), "unknown", "failed"],
	["auth_required", signInRequired, "auth", "running"],
] as const;

test.each(CHILD_ERRORS)(
	"a child failing on %s gives the root the same outcome whatever the child is named (#4031)",
	async (label, error, failureKind, status) => {
		const outcomes = [];
		for (const name of ["plain-child", "cancelled-child", "rate-limit-child", "auth-child"]) {
			const child = workflow({
				name,
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx.tool("fail", {}, async () => {
						throw error();
					});
					return {};
				},
			});
			const runId = `matrix-${label}-${name}`;
			const { result, snapshot } = await runRoot(parentOf("root", child), runId);
			outcomes.push({
				status: result.status,
				failureKind: snapshot?.failureKind,
				failureCode: snapshot?.failureCode,
				disposition: snapshot?.failureDisposition,
			});
		}
		assert.equal(outcomes[0]!.status, status, JSON.stringify(outcomes));
		assert.equal(outcomes[0]!.failureKind, failureKind, JSON.stringify(outcomes));
		for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0]);
	},
);
