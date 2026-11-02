/**
 * A session that falls back to another model tells that model its own name, also when the prompt is the session's
 * transformed prompt that a `before_agent_start` handler appended to (#4188). Real AgentSession and fallback machinery
 * against a local provider; no network is contacted.
 */

import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	getSystemMessageText,
	type Model,
} from "@bastani/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const PROVIDER = "fallback-prompt";
const APPENDED = "Review only; do not edit files.";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

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

async function fallbackPrompts(transform: boolean, appendInHandler: boolean): Promise<Map<string, string>> {
	const base = getModel("anthropic", "claude-sonnet-4-5")!;
	const model = (id: string, name: string): Model<"anthropic-messages"> => ({ ...base, provider: PROVIDER, id, name });
	const primary = model("primary", "Primary Model");
	const fallback = model("fallback", "Fallback Model");
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const prompts = new Map<string, string>();
	runtime.registerProvider(PROVIDER, {
		api: base.api,
		baseUrl: base.baseUrl,
		apiKey: "fixture-key",
		models: [primary, fallback],
		streamSimple: (requestModel, context) => {
			prompts.set(
				requestModel.id,
				context.messages
					.flatMap((message) => (message.role === "system" ? [getSystemMessageText(message)] : []))
					.join("\n"),
			);
			const failed = requestModel.id === primary.id;
			const message: AssistantMessage = {
				role: "assistant",
				content: failed ? [] : [{ type: "text", text: "done" }],
				api: base.api,
				provider: PROVIDER,
				model: requestModel.id,
				usage: usage(),
				stopReason: failed ? "error" : "stop",
				...(failed ? { errorMessage: "503 Service Unavailable: the model is overloaded" } : {}),
				timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
			if (failed) stream.push({ type: "error", reason: "error", error: message });
			else stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		},
	});
	cleanups.push(() => runtime.unregisterProvider(PROVIDER));
	const extensionsResult = appendInHandler
		? await createTestExtensionsResult([
				(pi) => {
					pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n${APPENDED}` }));
				},
			])
		: undefined;
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		modelRuntime: runtime,
		model: primary,
		thinkingLevel: "medium",
		fallbackModels: [`${PROVIDER}/${fallback.id}`],
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		sessionManager: SessionManager.inMemory(),
		resourceLoader: createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined),
		...(transform ? { systemPromptTransform: (prompt: string) => `Transformed child prompt.\n${prompt}` } : {}),
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
	});
	cleanups.push(() => session.dispose());
	await session.prompt("reply");
	return prompts;
}

describe("a fallback model is told its own name", () => {
	for (const [transform, appendInHandler] of [
		[true, false],
		[true, true],
		[false, true],
	] as const) {
		it(`with ${transform ? "a transformed" : "the session's"} prompt${appendInHandler ? " a before_agent_start handler appended to" : ""}`, async () => {
			const prompts = await fallbackPrompts(transform, appendInHandler);

			expect(prompts.get("primary")).toContain("Model name (used for commit attribution): Primary Model");
			const fallbackPrompt = prompts.get("fallback") ?? "";
			expect(fallbackPrompt).toContain("Model name (used for commit attribution): Fallback Model");
			expect(fallbackPrompt).not.toContain("Primary Model");
			if (appendInHandler) expect(fallbackPrompt).toContain(APPENDED);
		});
	}
});
