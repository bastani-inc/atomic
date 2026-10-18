import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function busyHarnessWithSlowInputHook(slowText: string) {
	const toolRelease = Promise.withResolvers<void>();
	const hookRelease = Promise.withResolvers<void>();
	const slowHookEntered = Promise.withResolvers<void>();
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({
		tools: [waitTool],
		extensionFactories: [
			(pi) => {
				pi.on("input", async (event) => {
					if (event.text !== slowText) return;
					slowHookEntered.resolve();
					await hookRelease.promise;
				});
			},
		],
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("after steer"),
		fauxAssistantMessage("after follow-ups"),
		fauxAssistantMessage("done"),
	]);
	const toolStarted = Promise.withResolvers<void>();
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			unsubscribe();
			toolStarted.resolve();
		}
	});
	const run = harness.session.prompt("start");
	await toolStarted.promise;
	return { harness, run, toolRelease, hookRelease, slowHookEntered };
}

it.each(["steer", "followUp"] as const)(
	"queues %s messages in submission order when an earlier input hook is slower (#3590)",
	async (streamingBehavior) => {
		const { harness, run, toolRelease, hookRelease, slowHookEntered } = await busyHarnessWithSlowInputHook("A");
		const queued =
			streamingBehavior === "steer"
				? () => harness.session.getSteeringMessages()
				: () => harness.session.getFollowUpMessages();

		const first = harness.session.prompt("A", { streamingBehavior });
		await slowHookEntered.promise;
		const second = harness.session.prompt("B", { streamingBehavior });
		await new Promise((resolve) => setImmediate(resolve));
		hookRelease.resolve();
		await Promise.all([first, second]);

		assert.deepEqual([...queued()], ["A", "B"]);
		toolRelease.resolve();
		await run;
	},
);

it("orders steer() calls behind a slower earlier input hook (#3590)", async () => {
	const { harness, run, toolRelease, hookRelease, slowHookEntered } = await busyHarnessWithSlowInputHook("A");

	const first = harness.session.steer("A");
	await slowHookEntered.promise;
	const second = harness.session.steer("B");
	await new Promise((resolve) => setImmediate(resolve));
	hookRelease.resolve();
	assert.deepEqual(await Promise.all([first, second]), ["queued", "queued"]);

	assert.deepEqual([...harness.session.getSteeringMessages()], ["A", "B"]);
	toolRelease.resolve();
	await run;
});

it("does not hold input that an input hook submits and awaits behind the hook's own message (#3590)", async () => {
	const toolRelease = Promise.withResolvers<void>();
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	let session: Harness["session"] | undefined;
	const harness = await createHarness({
		tools: [waitTool],
		extensionFactories: [
			(pi) => {
				pi.on("input", async (event) => {
					if (event.text === "A") await session?.prompt("nested", { streamingBehavior: "steer" });
				});
			},
		],
	});
	harnesses.push(harness);
	session = harness.session;
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const toolStarted = Promise.withResolvers<void>();
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			unsubscribe();
			toolStarted.resolve();
		}
	});
	const run = harness.session.prompt("start");
	await toolStarted.promise;

	await harness.session.prompt("A", { streamingBehavior: "steer" });

	assert.deepEqual([...harness.session.getSteeringMessages()], ["nested", "A"]);
	toolRelease.resolve();
	await run;
});

it("lets a reload awaited by an input hook finish while later input waits behind that hook (#3590)", async () => {
	const toolRelease = Promise.withResolvers<void>();
	const laterInputWaiting = Promise.withResolvers<void>();
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	let session: Harness["session"] | undefined;
	const reloaded = Promise.withResolvers<void>();
	const harness = await createHarness({
		tools: [waitTool],
		extensionFactories: [
			(pi) => {
				pi.on("input", async (event) => {
					if (event.text !== "A") return;
					await laterInputWaiting.promise;
					await session?.reload();
					reloaded.resolve();
				});
			},
		],
	});
	harnesses.push(harness);
	session = harness.session;
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const toolStarted = Promise.withResolvers<void>();
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			unsubscribe();
			toolStarted.resolve();
		}
	});
	const run = harness.session.prompt("start").catch(() => undefined);
	await toolStarted.promise;

	const first = harness.session.prompt("A", { streamingBehavior: "steer" }).catch(() => undefined);
	const second = harness.session.prompt("B", { streamingBehavior: "steer" }).catch(() => undefined);
	await new Promise((resolve) => setImmediate(resolve));
	laterInputWaiting.resolve();
	toolRelease.resolve();

	await reloaded.promise;
	await Promise.all([first, second, run]);
});
