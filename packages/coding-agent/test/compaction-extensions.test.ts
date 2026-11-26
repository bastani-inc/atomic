import { Agent, type StreamFn } from "@bastani/atomic-agent-core";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	createExtensionRuntime,
	type Extension,
	type SessionBeforeCompactEvent,
	type SessionBeforeCompactResult,
	type SessionCompactEvent,
	type SessionEvent,
} from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

/** Compaction makes no model call; any request fails the test. */
const refusingStream: StreamFn = () => {
	throw new Error("compaction called a model");
};

describe("compaction extension hooks", () => {
	let session: AgentSession;
	let before: SessionBeforeCompactEvent[];
	let after: SessionCompactEvent[];

	beforeEach(() => {
		before = [];
		after = [];
	});
	afterEach(() => session?.dispose());

	function extension(
		onBefore: (event: SessionBeforeCompactEvent) => SessionBeforeCompactResult | undefined,
		onAfter?: (event: SessionCompactEvent) => void,
	): Extension {
		const handlers = new Map<string, ((event: SessionEvent) => Promise<SessionBeforeCompactResult | undefined>)[]>();
		handlers.set("session_before_compact", [
			async (event) => {
				if (event.type !== "session_before_compact") return undefined;
				before.push(event);
				return onBefore(event);
			},
		]);
		handlers.set("session_compact", [
			async (event) => {
				if (event.type !== "session_compact") return undefined;
				after.push(event);
				onAfter?.(event);
				return undefined;
			},
		]);
		return {
			path: "test",
			resolvedPath: "/test.ts",
			sourceInfo: createSyntheticSourceInfo("<test>", { source: "test" }),
			handlers,
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
	}

	async function create(ext: Extension, streamFn: StreamFn = refusingStream): Promise<void> {
		const model = getFixtureModel("anthropic", "claude-sonnet-4-5")!;
		const manager = SessionManager.inMemory();
		const agent = new Agent({
			getApiKey: () => undefined,
			initialState: { model, systemPrompt: "test", tools: [] },
			streamFn,
		});
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory(),
			cwd: process.cwd(),
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: {
				...createTestResourceLoader(),
				getExtensions: () => ({ extensions: [ext], errors: [], runtime: createExtensionRuntime() }),
			},
		});
		const now = Date.now();
		for (let turn = 0; turn < 5; turn++) {
			await manager.appendMessage({
				role: "user",
				content: `task ${turn}\nline a\nline b`,
				timestamp: now + turn * 2,
			});
			await manager.appendMessage(assistant(`answer ${turn}\nline c\nline d`, now + turn * 2 + 1));
		}
		agent.state.messages = manager.buildSessionContext().messages;
	}

	it("accepts a non-empty compactedText override, freezes the preparation and emits an observe-only result", async () => {
		await create(
			extension((event) => {
				const lines = event.preparation.region.lines;
				expect(() => lines.push("x")).toThrow();
				return { compactedText: "[User]: retained exactly" };
			}),
		);
		const result = await session.compact();
		expect(result.form).toBe("compacted");
		expect(result.backend).toBe("extension");
		expect(result.compactedText).toContain("<compacted-context>\n[User]: retained exactly\n</compacted-context>");
		expect(result.compactedText).toContain(`history://sessions/${session.sessionId}`);
		expect(Object.isFrozen(before[0].preparation)).toBe(true);
		expect(after).toHaveLength(1);
		expect(after[0].compactionEntry.type).toBe("compaction");
		expect(after[0].compactionEntry.summary).toBe(result.compactedText);
		expect(after[0].fromExtension).toBe(true);
	});

	it("hands the hook the whole context since the last boundary, with no kept tail", async () => {
		await create(extension(() => undefined));
		await session.compact({ query: "focus on task 4" });
		const preparation = before[0].preparation;
		expect(preparation.firstKeptEntryId).toBeNull();
		expect(preparation.keptTailMessageCount).toBe(0);
		expect(preparation.parameters).toEqual({ query: "focus on task 4" });
		expect(before[0].parameters).toEqual({ query: "focus on task 4" });
		expect(preparation.region.lines.join("\n")).toContain("task 0");
		expect(preparation.region.lines.join("\n")).toContain("answer 4");
		expect(preparation.regionEntryIds).toHaveLength(10);
	});

	it("passes the previous boundary text first on a repeated compaction", async () => {
		await create(extension(() => undefined));
		const first = await session.compact();
		expect(first.form).toBe("cleared");
		await session.sessionManager.appendMessage({ role: "user", content: "new request", timestamp: Date.now() });
		session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
		await session.compact();
		const region = before[1].preparation.region;
		expect(region.messageSpans?.[0]?.previousSummary).toBe(true);
		expect(region.lines[0]).toBe(first.compactedText.split("\n")[0]);
		expect(region.lines.join("\n")).toContain("new request");
	});

	it("cancels without persistence", async () => {
		await create(extension(() => ({ cancel: true })));
		await expect(session.compact()).rejects.toThrow("Compaction cancelled");
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("treats whitespace extension text as no override and clears the context with no model call (#4977)", async () => {
		await create(extension(() => ({ compactedText: "  \n" })));
		const result = await session.compact();
		expect(result.form).toBe("cleared");
		expect(result.compactedText.startsWith("Context cleared.")).toBe(true);
	});

	it("clears the context instead when the extension text is over the compacted-output cap", async () => {
		await create(extension(() => ({ compactedText: "word ".repeat(200_000) })));
		const result = await session.compact();
		expect(result.form).toBe("cleared");
		expect(result.backend).toBeUndefined();
		expect(result.fallbackReason).toMatch(/^extension failed: output too long \(\d+ > \d+ tokens\)$/u);
		expect(result.compactedText).not.toContain("word word");
		expect(after[0].compactionEntry.summary).toBe(result.compactedText);
	});

	it("isolates errors from the post-commit observer", async () => {
		await create(
			extension(
				() => ({ compactedText: "[User]: retained" }),
				() => {
					throw new Error("observer failed");
				},
			),
		);
		await expect(session.compact()).resolves.toMatchObject({ form: "compacted", backend: "extension" });
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});
});
