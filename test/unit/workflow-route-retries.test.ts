import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { type JevFixtureRequest, jevFixtureResponse } from "../helpers/jev-tournament.js";
import { workflowRouterContext } from "../helpers/workflow-router.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function fixture() {
	const store = createStore();
	const jobs = createJobTracker();
	const body = vi.fn(async () => ({}));
	const definition = workflow({
		name: "registered",
		description: "Approved implementation",
		inputs: { objective: Type.String() },
		outputs: {},
		run: body,
	});
	const runtime = createExtensionRuntime({ registry: createRegistry().register(definition), store, jobs });
	const execute = makeExecuteWorkflowTool(
		runtime,
		() => undefined,
		() => {},
		{
			...captureWorkflowOwnerResources(),
			store,
			jobs,
		},
	);
	const ctx = { ...workflowRouterContext("registered"), sessionId: "retry-owner" };
	ctx.getRouterModel = () => "typesafe-ai/jev-latest";
	// No current chat model: these tests exercise Jev-side bounded repair, which
	// only runs when no chat fallback exists (#3206).
	ctx.model = undefined;
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
	const attempts = Array.from({ length: 4 }, () => ({
		entered: Promise.withResolvers<JevFixtureRequest>(),
		response: Promise.withResolvers<Response>(),
	}));
	const transport = vi.fn((_url: string, init: RequestInit) => {
		const attempt = attempts[transport.mock.calls.length - 1];
		assert.ok(attempt, "route must not multiply its four-request budget");
		attempt.entered.resolve(JSON.parse(String(init.body)) as JevFixtureRequest);
		return attempt.response.promise;
	});
	vi.stubGlobal("fetch", transport);
	const controller = new AbortController();
	const result = execute(
		{ action: "route", state: { task: "Implement the approved change" } },
		ctx,
		controller.signal,
	);
	let settled = false;
	void result.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	function assertNoLaunch() {
		assert.deepEqual(store.runs(), []);
		assert.deepEqual(jobs.runIds(), []);
		assert.equal(body.mock.calls.length, 0);
	}
	async function pendingAttempt(index: number) {
		const request = await Promise.race([
			attempts[index]!.entered.promise,
			result.then(() => {
				throw new Error("route settled before its next request");
			}),
		]);
		await setImmediate();
		assert.equal(settled, false, "no public result while an actual provider request is pending");
		assert.equal(transport.mock.calls.length, index + 1);
		assertNoLaunch();
		return request;
	}
	function respond(index: number, request: JevFixtureRequest, valid: boolean) {
		const response = jevFixtureResponse(
			request,
			(_keys, id) =>
				({
					workflow: "registered",
					duration: "15min",
					interaction: "executable",
					complexity: "workflow_beneficial",
					preference: "unspecified",
					budget: "preserve",
				})[id]!,
		);
		if (!valid) response.answers.workflow!.choice = "absent";
		attempts[index]!.response.resolve(Response.json(response));
	}
	return { execute, ctx, controller, result, transport, pendingAttempt, respond, assertNoLaunch };
}

// These exercise the public tool with the real router and Jev adapter, not a mocked routing result.
test.each([2, 3, 4])(
	"public route recovers on actual Jev request %i without exposing intermediate failures",
	async (count) => {
		const f = fixture();
		for (let index = 0; index < count; index++) {
			const request = await f.pendingAttempt(index);
			f.respond(index, request, index === count - 1);
		}
		const result = await f.result;
		assert.equal(result.action, "route");
		assert.equal("status" in result && result.status, "reserved");
		assert.ok("workflowId" in result && result.workflowId);
		assert.equal(f.transport.mock.calls.length, count);
		f.assertNoLaunch();
	},
);

test("public route reports exhaustion only after four malformed Jev responses", async () => {
	const f = fixture();
	for (let index = 0; index < 4; index++) {
		const request = await f.pendingAttempt(index);
		f.respond(index, request, false);
	}
	const result = await f.result;
	assert.equal(result.action, "route");
	assert.equal("status" in result && result.status, "failed");
	assert.equal("workflowId" in result && result.workflowId, "");
	assert.equal(
		"error" in result && result.error,
		"Malformed Jev structured decision response (choice_key). Routing output repair exhausted after 4 attempts.",
	);
	assert.equal(f.transport.mock.calls.length, 4);
	f.assertNoLaunch();
	const run = await f.execute({ action: "run", workflowId: "", inputs: { objective: "must not launch" } }, f.ctx);
	assert.equal("status" in run && run.status, "failed");
	f.assertNoLaunch();
	assert.equal(f.transport.mock.calls.length, 4);
});

test("public route falls back to the chat model on a malformed Jev response (#3206)", async () => {
	const store = createStore();
	const jobs = createJobTracker();
	const definition = workflow({
		name: "registered",
		description: "Approved implementation",
		inputs: { objective: Type.String() },
		outputs: {},
		run: async () => ({}),
	});
	const runtime = createExtensionRuntime({ registry: createRegistry().register(definition), store, jobs });
	const execute = makeExecuteWorkflowTool(
		runtime,
		() => undefined,
		() => {},
		{ ...captureWorkflowOwnerResources(), store, jobs },
	);
	const ctx = { ...workflowRouterContext("registered"), sessionId: "retry-owner-fallback" };
	ctx.getRouterModel = () => "typesafe-ai/jev-latest";
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const transport = vi.fn(async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as JevFixtureRequest;
		const response = jevFixtureResponse(body);
		response.answers.workflow!.choice = "absent";
		return Response.json(response);
	});
	vi.stubGlobal("fetch", transport);
	const result = await execute({ action: "route", state: { task: "Implement the approved change" } }, ctx);
	assert.equal(result.action, "route");
	assert.equal("status" in result && result.status, "reserved");
	assert.equal(transport.mock.calls.length, 1);
});

test.each([false, true])("public route cancellation during repair ignores a late valid=%s response", async (valid) => {
	const f = fixture();
	f.respond(0, await f.pendingAttempt(0), false);
	const request = await f.pendingAttempt(1);
	const reason = new Error("user cancelled route");
	const rejected = assert.rejects(f.result, (error) => error === reason);
	f.controller.abort(reason);
	await rejected;
	assert.equal(f.transport.mock.calls.length, 2);
	f.assertNoLaunch();
	// Even a transport that ignores AbortSignal cannot reserve or launch after cancellation.
	f.respond(1, request, valid);
	await setImmediate();
	assert.equal(f.transport.mock.calls.length, 2);
	f.assertNoLaunch();
});
