import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { test } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createHarness } from "./suite/harness.js";

test("nested calls validate arguments, run hooks, and record only the parent's result", async () => {
	const calls: string[] = [];
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "child",
					label: "Child",
					description: "child",
					exposure: "codemode",
					parameters: Type.Object({ value: Type.String() }),
					execute: async (_id, args) => {
						calls.push(args.value);
						return { content: [{ type: "text", text: args.value }], details: {} };
					},
				});
				pi.registerTool({
					name: "parent",
					label: "Parent",
					description: "parent",
					concurrency: "exclusive",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						const bad = await ctx.executeTool("child", {});
						assert.equal(bad.isError, true);
						const good = await ctx.executeTool("child", { value: "ok" });
						return good.result;
					},
				});
				pi.on("tool_call", (event) => {
					if (event.parentToolCallId) calls.push("hook");
				});
			},
		],
		initialActiveToolNames: ["parent"],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run parent");
		assert.deepEqual(calls, ["hook", "ok"]);
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		assert.equal(results.length, 1);
		assert.equal(results[0].nestedCalls?.calls.length, 2);
		assert.equal(results[0].nestedCalls?.calls[0].status, "error");
		assert.equal(results[0].nestedCalls?.calls[1].status, "ok");
	} finally {
		await harness.cleanup();
	}
});

test("nested records remain bounded while usage includes every call exactly once", async () => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "priced",
					label: "Priced",
					description: "fixture",
					exposure: "codemode",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
						usage: {
							input: 10,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 10,
							cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
						},
					}),
				});
				pi.registerTool({
					name: "parent",
					label: "Parent",
					description: "parent",
					concurrency: "exclusive",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						for (let i = 0; i < 260; i++) await ctx.executeTool("priced", {});
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				});
			},
		],
		initialActiveToolNames: ["parent"],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run batch");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		assert(result?.role === "toolResult");
		assert.equal(result.nestedCalls?.calls.length, 256);
		assert.equal(result.nestedCalls?.complete, false);
		assert.equal(result.usage?.input, 2600);
		assert.equal(result.usage?.cost.total, 260);
	} finally {
		await harness.cleanup();
	}
});

test("retained nested-tool context cannot borrow a completed parent's execution", async () => {
	let retained: ExtensionToolContext | undefined;
	let executed = false;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "child",
					label: "Child",
					description: "fixture",
					exposure: "codemode",
					parameters: Type.Object({}),
					execute: async () => {
						executed = true;
						return { content: [], details: {} };
					},
				});
				pi.registerTool({
					name: "parent",
					label: "Parent",
					description: "fixture",
					concurrency: "exclusive",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						retained = ctx;
						return { content: [], details: {} };
					},
				});
			},
		],
		initialActiveToolNames: ["parent"],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("capture tool context");
		assert(retained);
		await assert.rejects(
			retained.executeTool("child", {}, { signal: new AbortController().signal }),
			/execution has ended/,
		);
		assert.equal(executed, false);
	} finally {
		await harness.cleanup();
	}
});

test("nested tools honor sequential execution mode inside parallel script calls", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const calls: string[] = [];
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "serial",
					label: "Serial",
					description: "fixture",
					exposure: "codemode",
					executionMode: "sequential",
					parameters: Type.Object({ id: Type.String() }),
					execute: async (_id, args) => {
						calls.push(`start:${args.id}`);
						if (args.id === "A") {
							started.resolve();
							await release.promise;
						}
						calls.push(`end:${args.id}`);
						return { content: [], details: {} };
					},
				});
				pi.registerTool({
					name: "parent",
					label: "Parent",
					description: "fixture",
					concurrency: "exclusive",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						await Promise.all([ctx.executeTool("serial", { id: "A" }), ctx.executeTool("serial", { id: "B" })]);
						return { content: [], details: {} };
					},
				});
			},
		],
		initialActiveToolNames: ["parent"],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const prompt = harness.session.prompt("run parallel script calls");
		await started.promise;
		for (let i = 0; i < 10; i++) await Promise.resolve();
		assert.deepEqual(calls, ["start:A"]);
		release.resolve();
		await prompt;
		assert.deepEqual(calls, ["start:A", "end:A", "start:B", "end:B"]);
	} finally {
		release.resolve();
		await harness.cleanup();
	}
});

test.each([
	["tool", "explicit"],
	["tool", "parent"],
	["tool", "combined parent"],
	["session", "explicit"],
	["session", "parent"],
	["session", "combined parent"],
	["native exclusive", "explicit"],
	["native exclusive", "parent"],
	["native exclusive", "combined parent"],
	["native shared", "explicit"],
	["native shared", "parent"],
	["native shared", "combined parent"],
] as const)("%s nested calls cancel queued execution through the %s signal", async (mode, cancellation) => {
	const started = Promise.withResolvers<void>();
	const admitted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const cancel = new AbortController();
	const calls: string[] = [];
	const ended: boolean[] = [];
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("tool_call", (event) => {
					if (event.toolName === "serial" && event.input.id === "B") admitted.resolve();
				});
				pi.on("tool_execution_end", (event) => {
					if (event.toolName === "serial") ended.push(event.isError);
				});
				pi.registerTool({
					name: "serial",
					label: "Serial",
					description: "fixture",
					exposure: "codemode",
					executionMode: mode === "tool" ? "sequential" : "parallel",
					concurrency: (args) =>
						mode === "native exclusive" || (mode === "native shared" && args.id === "A") ? "exclusive" : "shared",
					parameters: Type.Object({ id: Type.String() }),
					execute: async (_id, args) => {
						calls.push(args.id);
						if (args.id === "A") {
							started.resolve();
							await release.promise;
							return {
								content: [],
								details: {},
								usage: {
									input: 10,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 10,
									cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
								},
							};
						}
						return { content: [], details: {} };
					},
				});
				pi.registerTool({
					name: "parent",
					label: "Parent",
					description: "fixture",
					concurrency: "exclusive",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						const options = cancellation === "parent" ? {} : { signal: cancel.signal };
						const outcomes = await Promise.all([
							ctx.executeTool("serial", { id: "A" }, options),
							ctx.executeTool("serial", { id: "B" }, options),
						]);
						assert.equal(outcomes[0].isError, false);
						assert.equal(outcomes[1].isError, true);
						assert.deepEqual(outcomes[1].result.content, [{ type: "text", text: "Operation aborted" }]);
						assert.equal(outcomes[1].result.usage, undefined);
						return { content: [], details: {} };
					},
				});
			},
		],
		initialActiveToolNames: ["parent"],
	});
	try {
		if (mode === "session") harness.session.agent.toolExecution = "sequential";
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const prompt = harness.session.prompt("cancel queued script calls");
		await started.promise;
		await admitted.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(calls, ["A"]);
		if (cancellation === "explicit") cancel.abort();
		else harness.session.agent.abort();
		release.resolve();
		await prompt;
		assert.deepEqual(calls, ["A"]);
		assert.deepEqual(ended, [false, true]);
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		assert.equal(results.length, 1);
		assert.equal(results[0].isError, false);
		assert.deepEqual(
			results[0].nestedCalls?.calls.map((call) => call.status),
			["ok", "error"],
		);
		assert.equal(results[0].nestedCalls?.calls[1].error, "Operation aborted");
		assert.equal(results[0].nestedCalls?.complete, true);
		assert.equal(results[0].usage?.input, 10);
		assert.equal(results[0].usage?.cost.total, 1);
	} finally {
		release.resolve();
		await harness.cleanup();
	}
});
