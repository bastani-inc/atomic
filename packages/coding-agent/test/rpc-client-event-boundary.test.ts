import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient, type RpcEvent } from "../src/modes/rpc/rpc-client.ts";
import { INTERACTIVE_ENGINE_PROTOCOL_VERSION } from "../src/modes/interactive-engine/protocol.ts";

interface ExtensionProgressMessage {
	role: "extensionProgress";
	progress: number;
	label: string;
	timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		extensionProgress: ExtensionProgressMessage;
	}
}

const tempDirs: string[] = [];

function writeChildScript(events: readonly object[]): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-rpc-client-events-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	const frames = [...events, { type: "agent_settled" }];
	writeFileSync(
		path,
		`${frames.map((event) => `console.log(${JSON.stringify(JSON.stringify(event))});`).join("\n")}\nprocess.stdin.resume();\n`,
	);
	return path;
}

function assistantMessage(timestamp: number): object {
	return {
		role: "assistant",
		content: [],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

async function receiveScriptedEvents(
	scriptedEvents: readonly object[],
	options: { buffered?: boolean } = {},
): Promise<RpcEvent[]> {
	const events = options.buffered
		? [{ type: "engine_ready", protocolVersion: INTERACTIVE_ENGINE_PROTOCOL_VERSION, pid: 1 }, ...scriptedEvents]
		: scriptedEvents;
	const client = new RpcClient({
		cliPath: writeChildScript(events),
		interactiveEngine: options.buffered ? { onDiagnostic: () => {} } : undefined,
	});
	const received: RpcEvent[] = [];
	let resolveCompletion!: () => void;
	const completion = new Promise<void>((resolve) => {
		resolveCompletion = resolve;
	});
	client.onEvent((event) => {
		if (event.type === "agent_settled") resolveCompletion();
		else received.push(event);
	});

	try {
		await client.start();
		await completion;
		return received;
	} finally {
		await client.stop();
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient event boundary", () => {
	test("drops an out-of-order missing start payload and preserves buffered valid events", async () => {
		const firstPartialMessage = {
			...assistantMessage(1),
			content: [{ type: "text", text: "Recovered first update" }],
		};
		const secondPartialMessage = {
			...assistantMessage(1),
			content: [{ type: "text", text: "Recovered second update" }],
		};
		const completeMessage = {
			...assistantMessage(1),
			content: [{ type: "text", text: "Recovered automatic follow-up" }],
		};
		const firstUpdate = {
			type: "message_update",
			message: firstPartialMessage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Recovered first update" },
		};
		const secondUpdate = {
			type: "message_update",
			message: secondPartialMessage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Recovered second update" },
		};
		const end = { type: "message_end", message: completeMessage };
		const events = await receiveScriptedEvents([
			firstUpdate,
			{ type: "message_start" },
			secondUpdate,
			end,
		], { buffered: true });

		expect(events).toEqual([firstUpdate, secondUpdate, end]);
	});

	test("preserves a declaration-merged public extension message", async () => {
		const extensionMessage: AgentMessage = {
			role: "extensionProgress",
			progress: 0.5,
			label: "Working",
			timestamp: 10,
		};
		const event = { type: "message_start", message: extensionMessage };
		const events = await receiveScriptedEvents([
			{ type: "message_start", message: { role: 42, payload: "malformed" } },
			event,
		]);

		expect(events).toEqual([event]);
	});

	test("ignores an invalid assistant message_start and delivers the next valid assistant start", async () => {
		const validMessage = assistantMessage(2);
		const events = await receiveScriptedEvents([
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_start", message: validMessage },
		]);

		expect(events).toEqual([{ type: "message_start", message: validMessage }]);
	});

	test("ignores a user message_start without content and delivers the next valid follow-up", async () => {
		const userMessage = { role: "user", content: "automatic follow-up", timestamp: 3 };
		const events = await receiveScriptedEvents([
			{ type: "message_start", message: { role: "user" } },
			{ type: "message_start", message: userMessage },
		]);

		expect(events).toEqual([{ type: "message_start", message: userMessage }]);
	});

	test("ignores malformed assistant content and keeps the event stream usable", async () => {
		const validMessage = assistantMessage(4);
		const events = await receiveScriptedEvents([
			{ type: "message_start", message: { role: "assistant", content: [null] } },
			{ type: "message_start", message: validMessage },
		]);

		expect(events).toEqual([{ type: "message_start", message: validMessage }]);
	});

	test("ignores string content for an assistant start", async () => {
		const validMessage = assistantMessage(9);
		const events = await receiveScriptedEvents([
			{ type: "message_start", message: { role: "assistant", content: "bad" } },
			{ type: "message_start", message: validMessage },
		]);

		expect(events).toEqual([{ type: "message_start", message: validMessage }]);
	});

	test("ignores malformed custom content and delivers the next valid custom message", async () => {
		const customMessage = {
			role: "custom", customType: "workflow", content: "completed", display: true, timestamp: 5,
		};
		const events = await receiveScriptedEvents([
			{ type: "message_start", message: { role: "custom", customType: "workflow", display: true } },
			{ type: "message_start", message: customMessage },
		]);

		expect(events).toEqual([{ type: "message_start", message: customMessage }]);
	});

	test("ignores an assistant start with a non-string error message", async () => {
		const validMessage = assistantMessage(6);
		const events = await receiveScriptedEvents([
			{
				type: "message_start",
				message: { role: "assistant", content: [], stopReason: "error", errorMessage: { toString: null } },
			},
			{ type: "message_start", message: validMessage },
		]);

		expect(events).toEqual([{ type: "message_start", message: validMessage }]);
	});

	test("ignores a custom start with a non-string custom type", async () => {
		const customMessage = {
			role: "custom", customType: "workflow", content: "completed", display: true, timestamp: 7,
		};
		const events = await receiveScriptedEvents([
			{
				type: "message_start",
				message: { role: "custom", customType: { toString: null }, content: "bad", display: true },
			},
			{ type: "message_start", message: customMessage },
		]);

		expect(events).toEqual([{ type: "message_start", message: customMessage }]);
	});

	test("ignores a malformed tool-result start and preserves the next valid result", async () => {
		const toolResult = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 8,
		};
		const events = await receiveScriptedEvents([
			{ type: "message_start", message: { role: "toolResult", toolCallId: "call-1", toolName: "read" } },
			{ type: "message_start", message: toolResult },
		]);

		expect(events).toEqual([{ type: "message_start", message: toolResult }]);
	});

	test("preserves valid declaration-merged message roles", async () => {
		const bashExecution = {
			role: "bashExecution",
			command: "pwd",
			output: "/tmp\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 11,
		};
		const branchSummary = {
			role: "branchSummary",
			summary: "Prior branch",
			fromId: "entry-1",
			timestamp: 12,
		};
		const events = await receiveScriptedEvents([
			{ type: "message_start", message: bashExecution },
			{ type: "message_start", message: branchSummary },
		]);

		expect(events).toEqual([
			{ type: "message_start", message: bashExecution },
			{ type: "message_start", message: branchSummary },
		]);
	});
});
