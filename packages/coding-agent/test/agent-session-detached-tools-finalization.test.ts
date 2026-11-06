/**
 * What the session's finalization does to a call's result before it enters history (#4309): the same for a call that
 * ran inline and for a detached call whose result is handed back later. Extension `tool_result` handlers replace what
 * they return and nothing else, and a finalization that throws fails the call.
 */
import assert from "node:assert/strict";
import { fauxAssistantMessage, type ToolResultMessage } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, test } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import { DEFAULT_MAX_RESULT_SIZE_CHARS, PERSISTED_OUTPUT_TAG } from "../src/core/tools/tool-limits.js";
import {
	harnessPool,
	reopenedAfterDetaching,
	settlesWithin,
	untilStarted,
	waitForCiTurn,
	waitTool,
} from "./helpers/detached-tools.js";
import { getMessageText, type Harness } from "./suite/harness.js";

const pool = harnessPool();
afterEach(() => pool.cleanup());

type Route = "inline" | "detached";
const ROUTES: readonly Route[] = ["inline", "detached"];

const usage = (input: number) => ({
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** What a `tool_result` handler returns: a replacement of the fields it names. */
interface Replacement {
	readonly content?: { readonly type: "text"; readonly text: string }[];
	readonly details?: unknown;
	readonly isError?: boolean;
	readonly structuredContent?: { readonly [key: string]: string };
	readonly usage?: ReturnType<typeof usage>;
}

interface SeenToolResult {
	readonly type: string;
	readonly toolName: string;
	readonly toolCallId: string;
	readonly input: unknown;
	readonly isError: boolean;
	readonly content: unknown;
	readonly details: unknown;
	readonly structuredContent: unknown;
	readonly usage: unknown;
	readonly parentToolCallId: string | undefined;
}

interface Outcome {
	readonly saved: ToolResultMessage;
	readonly ended: { readonly result: AgentToolResult; readonly isError: boolean };
	readonly seen: SeenToolResult[];
	readonly harness: Harness;
}

interface FinalizedCall {
	readonly output: AgentToolResult;
	readonly replacement?: Replacement;
	/** Runs on the session that finalizes the call, before it does. */
	readonly prepare?: (harness: Harness) => void;
}

/** The result one `wait_for_ci` call is saved with once `output` is its work's outcome. */
async function finalizedCall(route: Route, call: FinalizedCall): Promise<Outcome> {
	const seen: SeenToolResult[] = [];
	const extension: ExtensionFactory = (pi) => {
		pi.on("tool_result", (event) => {
			seen.push({
				type: event.type,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				input: event.input,
				isError: event.isError,
				content: event.content,
				details: event.details,
				structuredContent: event.structuredContent,
				usage: event.usage,
				parentToolCallId: event.parentToolCallId,
			});
			return call.replacement;
		});
	};
	const tool = waitTool();
	let harness: Harness;
	if (route === "inline") {
		harness = await pool.harnessWith([tool.definition], undefined, [extension]);
		call.prepare?.(harness);
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("done")]);
		const turn = harness.session.prompt("watch ci");
		await untilStarted(tool);
		tool.finishWith(0, call.output);
		await settlesWithin(turn);
	} else {
		({ reopened: harness } = await reopenedAfterDetaching(
			pool,
			[tool.definition],
			[waitForCiTurn("ci-1")],
			[extension],
		));
		call.prepare?.(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.resumeDetachedTurn([
			{ toolCallId: "ci-1", toolName: "wait_for_ci", result: call.output, isError: call.output.isError === true },
		]);
	}
	const saved = harness.sessionManager
		.buildSessionProjection()
		.messages.find((message) => message.role === "toolResult");
	assert.ok(saved?.role === "toolResult", "the call's result was saved");
	const [ended] = harness.eventsOfType("tool_execution_end");
	assert.ok(ended !== undefined, "the call's end reached the session's subscribers");
	return { saved, ended, seen, harness };
}

const text = (value: string): { type: "text"; text: string }[] => [{ type: "text", text: value }];

for (const route of ROUTES) {
	describe(`a call that ran ${route} is finalized by the session (#4309)`, () => {
		test("an extension sees the call as its tool reported it (#4309)", async () => {
			const reported = { content: text("passed"), details: { run: "7" }, usage: usage(5) };

			const { seen, saved } = await finalizedCall(route, { output: reported });

			assert.deepEqual(seen, [
				{
					type: "tool_result",
					toolName: "wait_for_ci",
					toolCallId: "ci-1",
					input: { run: "7" },
					isError: false,
					content: text("passed"),
					details: { run: "7" },
					structuredContent: undefined,
					usage: usage(5),
					parentToolCallId: undefined,
				},
			]);
			assert.equal(getMessageText(saved), "passed");
			assert.deepEqual(saved.details, { run: "7" });
			assert.deepEqual(saved.usage, usage(5));
		});

		test("an extension that returns nothing leaves the result as reported (#4309)", async () => {
			const reported: AgentToolResult = { content: text("3 tests failed"), details: { failed: 3 }, isError: true };

			const { saved, ended } = await finalizedCall(route, { output: reported });

			assert.equal(getMessageText(saved), "3 tests failed");
			assert.deepEqual(saved.details, { failed: 3 });
			assert.equal(saved.isError, true);
			assert.equal(ended.isError, true);
		});

		test("an extension that marks a successful call as failed makes it a failure, and nothing else changes (#4309)", async () => {
			const reported: AgentToolResult = { content: text("passed"), details: { run: "7" }, usage: usage(5) };

			const { saved, ended } = await finalizedCall(route, { output: reported, replacement: { isError: true } });

			assert.equal(saved.isError, true);
			assert.equal(ended.isError, true);
			assert.equal(getMessageText(saved), "passed");
			assert.deepEqual(saved.details, { run: "7" });
			assert.deepEqual(saved.usage, usage(5));
		});

		test("an extension that changes only the content keeps the failure the tool reported (#4309)", async () => {
			const reported: AgentToolResult = { content: text("3 tests failed"), details: undefined, isError: true };

			const { saved } = await finalizedCall(route, {
				output: reported,
				replacement: { content: text("[redacted]") },
			});

			assert.equal(getMessageText(saved), "[redacted]");
			assert.equal(saved.isError, true);
		});

		test("the usage an extension reports replaces the usage the tool reported, and is kept when it reports none (#4309)", async () => {
			const withUsage: AgentToolResult = { content: text("passed"), details: undefined, usage: usage(5) };
			const withoutUsage: AgentToolResult = { content: text("passed"), details: undefined };

			const replaced = await finalizedCall(route, { output: withUsage, replacement: { usage: usage(9) } });
			const added = await finalizedCall(route, { output: withoutUsage, replacement: { usage: usage(9) } });
			const kept = await finalizedCall(route, { output: withUsage, replacement: { content: text("ok") } });

			assert.deepEqual(replaced.saved.usage, usage(9));
			assert.deepEqual(replaced.ended.result.usage, usage(9));
			assert.deepEqual(added.saved.usage, usage(9));
			assert.deepEqual(kept.saved.usage, usage(5));
			assert.deepEqual(kept.ended.result.usage, usage(5));
		});

		test("the details an extension reports replace the details the tool reported (#4309)", async () => {
			const withDetails: AgentToolResult = { content: text("passed"), details: { run: "7" } };
			const withoutDetails: AgentToolResult = { content: text("passed"), details: undefined };

			const replaced = await finalizedCall(route, { output: withDetails, replacement: { details: { by: "hook" } } });
			const added = await finalizedCall(route, { output: withoutDetails, replacement: { details: { by: "hook" } } });

			assert.deepEqual(replaced.saved.details, { by: "hook" });
			assert.deepEqual(added.saved.details, { by: "hook" });
		});

		test("machine-readable content follows the content: dropped when only the content is replaced, kept otherwise (#4309)", async () => {
			const reported: AgentToolResult = {
				content: text("passed"),
				details: undefined,
				structuredContent: { run: "7" },
			};

			const contentOnly = await finalizedCall(route, {
				output: reported,
				replacement: { content: text("[redacted]") },
			});
			const detailsOnly = await finalizedCall(route, { output: reported, replacement: { details: { by: "hook" } } });
			const replaced = await finalizedCall(route, {
				output: reported,
				replacement: { content: text("[redacted]"), structuredContent: { run: "redacted" } },
			});
			const added = await finalizedCall(route, {
				output: { content: text("passed"), details: undefined },
				replacement: { structuredContent: { run: "hook" } },
			});

			assert.equal(Object.hasOwn(contentOnly.ended.result, "structuredContent"), false);
			assert.deepEqual(detailsOnly.ended.result.structuredContent, { run: "7" });
			assert.deepEqual(replaced.ended.result.structuredContent, { run: "redacted" });
			assert.deepEqual(added.ended.result.structuredContent, { run: "hook" });
		});

		test("an oversized result is spilled with the failure, details and usage an extension left it (#4309)", async () => {
			const reported: AgentToolResult = {
				content: text(`BEGIN\n${"o".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1)}`),
				details: { run: "7" },
				usage: usage(5),
			};

			const { saved, ended } = await finalizedCall(route, {
				output: reported,
				replacement: { isError: true, details: { by: "hook" }, usage: usage(9) },
			});

			assert.ok(getMessageText(saved).startsWith(PERSISTED_OUTPUT_TAG));
			assert.equal(saved.isError, true);
			assert.equal(ended.isError, true);
			assert.deepEqual(saved.details, { by: "hook" });
			assert.deepEqual(saved.usage, usage(9));
		});

		test("an oversized result no extension touched keeps the details and usage the tool reported (#4309)", async () => {
			const reported: AgentToolResult = {
				content: text(`BEGIN\n${"o".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1)}`),
				details: { run: "7" },
				usage: usage(5),
			};

			const { saved } = await finalizedCall(route, { output: reported });

			assert.ok(getMessageText(saved).startsWith(PERSISTED_OUTPUT_TAG));
			assert.deepEqual(saved.details, { run: "7" });
			assert.deepEqual(saved.usage, usage(5));
			assert.equal(saved.isError, false);
		});

		test("a finalization that throws fails the call with that error (#4309)", async () => {
			const reported: AgentToolResult = { content: text("passed"), details: { run: "7" } };

			const { saved, ended } = await finalizedCall(route, {
				output: reported,
				prepare: (harness) => {
					harness.settingsManager.getImageAutoResize = () => {
						throw new Error("settings unreadable");
					};
				},
			});

			assert.equal(saved.isError, true);
			assert.equal(ended.isError, true);
			assert.deepEqual(saved.content, text("settings unreadable"));
		});
	});
}
