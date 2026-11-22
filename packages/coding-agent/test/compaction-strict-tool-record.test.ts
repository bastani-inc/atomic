/**
 * A session resumed after compactions removed every reply that recorded a strict-tool fallback still tells the provider
 * about it, whichever prompt it sends: its own, a transformed one, or one a `before_agent_start` handler forced.
 * Real AgentSession against a local provider; no network is contacted.
 */

import { recordsStrictToolLimits } from "@bastani/atomic-ai/api/strict-tool-limits";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Model,
} from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { VerbatimCompactionDetails } from "../src/core/compaction/compaction-types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { assistantMsg, createTestExtensionsResult, createTestResourceLoader, userMsg } from "./utilities.ts";

const PROVIDER = "strict-record";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const details: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: 2,
	parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "task" },
	stats: {
		linesBefore: 4,
		linesDeleted: 2,
		linesKept: 2,
		rangeCount: 1,
		tokensBefore: 10,
		tokensAfter: 5,
		percentReduction: 50,
	},
	rung: "planned",
};

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

type PromptKind = "own" | "transformed" | "forced by a handler";

/** Whether the first request after the resume carries the record. */
async function firstRequestRecords(kind: PromptKind, recorded: boolean): Promise<boolean> {
	const base = getModel("anthropic", "claude-sonnet-4-5")!;
	const model: Model<"anthropic-messages"> = { ...base, provider: PROVIDER, id: "claude", name: "Claude" };
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const records: boolean[] = [];
	runtime.registerProvider(PROVIDER, {
		api: base.api,
		baseUrl: base.baseUrl,
		apiKey: "fixture-key",
		models: [model],
		streamSimple: (_model, context) => {
			records.push(recordsStrictToolLimits(context.messages));
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: base.api,
				provider: PROVIDER,
				model: model.id,
				usage: usage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		},
	});
	cleanups.push(() => runtime.unregisterProvider(PROVIDER));

	// The session before the exit: a reply that recorded the fallback, then two compactions, the last without replies.
	const sessionManager = SessionManager.inMemory();
	await sessionManager.appendMessage({
		role: "system",
		content: "base",
		toolsAdded: [{ name: "lookup", description: "Look up", parameters: Type.Object({}) }],
		timestamp: 1,
	});
	await sessionManager.appendMessage(userMsg("question"));
	await sessionManager.appendMessage({
		...assistantMsg("answer"),
		...(recorded ? { strictToolsDisabled: true } : {}),
	});
	await sessionManager.appendCompaction("[User]: question", null, 10, details);
	await sessionManager.appendMessage(userMsg("before the exit"));
	await sessionManager.appendCompaction("[User]: before the exit", null, 10, details);

	const extensionsResult =
		kind === "forced by a handler"
			? await createTestExtensionsResult([
					(atomic) => {
						atomic.on("before_agent_start", () => ({ systemPrompt: "A prompt of the handler's own." }));
					},
				])
			: undefined;
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		modelRuntime: runtime,
		model,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		sessionManager,
		resourceLoader: createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined),
		...(kind === "transformed"
			? { systemPromptTransform: (prompt: string) => `Transformed child prompt.\n${prompt}` }
			: {}),
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
	});
	cleanups.push(() => session.dispose());
	await session.prompt("after the resume");
	return records[0]!;
}

describe("a strict-tool fallback recorded before compactions reaches the first request after a resume (#6119)", () => {
	for (const kind of ["own", "transformed", "forced by a handler"] as const) {
		it(`with the session's ${kind} prompt`, async () => {
			expect(await firstRequestRecords(kind, true)).toBe(true);
			expect(await firstRequestRecords(kind, false)).toBe(false);
		});
	}
});
