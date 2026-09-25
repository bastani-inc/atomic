import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CACHE_PREFIX_CUSTOM_TYPE } from "../src/core/cache-prefix-fingerprint.ts";
import type { CacheWarmer } from "../src/core/cache-warmer.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

function sseEvent(type: string, data: Record<string, unknown>): string {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function sseResponse(usage: { input: number; read: number; write: number }): string {
	return (
		sseEvent("message_start", {
			message: {
				id: "m",
				type: "message",
				role: "assistant",
				model: "claude-x",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: {
					input_tokens: usage.input,
					cache_read_input_tokens: usage.read,
					cache_creation_input_tokens: usage.write,
					output_tokens: 1,
				},
			},
		}) +
		sseEvent("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
		sseEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }) +
		sseEvent("content_block_stop", { index: 0 }) +
		sseEvent("message_delta", {
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 2 },
		}) +
		sseEvent("message_stop", {})
	);
}

function cachePrefixEntryCount(sessionManager: SessionManager): number {
	return sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === CACHE_PREFIX_CUSTOM_TYPE).length;
}

describe("issue #3261: a cache-warm replay must not persist a competing cache-prefix fingerprint", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("CacheWarmer.refresh() does not add a cache_prefix entry", async () => {
		let responseIndex = 0;
		const usages = [{ input: 5, read: 0, write: 300_000 }];
		const server = createServer((request, response) => {
			request.resume();
			request.on("end", () => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(sseResponse(usages[responseIndex++] ?? usages[usages.length - 1]));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanups.push(async () => {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		});
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const baseUrl = `http://127.0.0.1:${address.port}`;

		const cwd = mkdtempSync(join(tmpdir(), "atomic-3261-warm-isolation-"));
		cleanups.push(async () => rmSync(cwd, { recursive: true, force: true }));
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("fakeanthropic", async () => ({ type: "api_key", key: "sk" }));
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
		modelRuntime.registerProvider("fakeanthropic", {
			baseUrl,
			apiKey: "sk",
			api: "anthropic-messages",
			models: [
				{
					id: "claude-x",
					name: "X",
					reasoning: false,
					input: ["text"],
					cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
					contextWindow: 200_000,
					maxTokens: 8_000,
					promptCache: { short: 300, long: 300 },
				},
			],
		});
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setCacheWarmingMode("idle");
		const sessionManager = SessionManager.inMemory(cwd);
		const resourceLoader = createTestResourceLoader({ systemPrompt: "You are a test assistant." });
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			resourceLoader,
			modelRuntime,
			settingsManager,
			sessionManager,
			model: modelRuntime.getModel("fakeanthropic", "claude-x")!,
		});
		cleanups.push(() => session.dispose());

		await session.prompt("first turn");
		assert.equal(cachePrefixEntryCount(sessionManager), 1, "the real turn persists exactly one cache_prefix entry");

		const internal = session as unknown as {
			_cacheWarmer?: CacheWarmer & { run?: object; refresh: (run: object) => Promise<void> };
		};
		const warmer = internal._cacheWarmer;
		if (!warmer?.run)
			throw new Error(`expected an active cache-warming run; status=${JSON.stringify(warmer?.status)}`);
		await warmer.refresh(warmer.run);
		assert.equal(responseIndex, 2, "the warm replay must actually have reached the mock provider");

		assert.equal(
			cachePrefixEntryCount(sessionManager),
			1,
			"a cache-warm replay must not persist its own cache_prefix entry",
		);
	});
});
