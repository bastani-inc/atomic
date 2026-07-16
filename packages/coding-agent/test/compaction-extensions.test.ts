import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime, type Extension, type SessionBeforeCompactEvent, type SessionBeforeCompactResult, type SessionCompactEvent, type SessionEvent } from "../src/core/extensions/index.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createTestResourceLoader } from "./utilities.ts";
import { createFauxStreamFn } from "./test-harness.ts";

function assistant(text: string, timestamp: number): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp };
}

describe("verbatim compaction extension hooks", () => {
	let session: AgentSession;
	let before: SessionBeforeCompactEvent[];
	let after: SessionCompactEvent[];

	beforeEach(() => { before = []; after = []; });
	afterEach(() => session?.dispose());

	function extension(onBefore: (event: SessionBeforeCompactEvent) => SessionBeforeCompactResult | undefined, onAfter?: (event: SessionCompactEvent) => void): Extension {
		const handlers = new Map<string, ((event: SessionEvent) => Promise<SessionBeforeCompactResult | undefined>)[]>();
		handlers.set("session_before_compact", [async (event) => {
			if (event.type !== "session_before_compact") return undefined;
			before.push(event);
			return onBefore(event);
		}]);
		handlers.set("session_compact", [async (event) => {
			if (event.type !== "session_compact") return undefined;
			after.push(event);
			onAfter?.(event);
			return undefined;
		}]);
		return { path: "test", resolvedPath: "/test.ts", sourceInfo: createSyntheticSourceInfo("<test>", { source: "test" }), handlers, tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map() };
	}

	function create(ext: Extension, streamFn?: StreamFn): void {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const manager = SessionManager.inMemory();
		const agent = new Agent({ getApiKey: () => undefined, initialState: { model, systemPrompt: "test", tools: [] }, streamFn });
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({ agent, sessionManager: manager, settingsManager: SettingsManager.inMemory(), cwd: process.cwd(), modelRegistry: ModelRegistry.create(authStorage), resourceLoader: { ...createTestResourceLoader(), getExtensions: () => ({ extensions: [ext], errors: [], runtime: createExtensionRuntime() }) } });
		const now = Date.now();
		for (let turn = 0; turn < 5; turn++) {
			manager.appendMessage({ role: "user", content: `task ${turn}\nline a\nline b`, timestamp: now + turn * 2 });
			manager.appendMessage(assistant(`answer ${turn}\nline c\nline d`, now + turn * 2 + 1));
		}
		agent.state.messages = manager.buildSessionContext().messages;
	}

	it("accepts a non-empty offline compactedText override and emits observe-only result", async () => {
		create(extension((event) => {
			const headers = event.preparation.region.headerLineNumbers as Set<number>;
			const markers = event.preparation.region.priorMarkerNs as Map<number, number>;
			expect(() => headers.add(999)).toThrow("Cannot mutate frozen compaction preparation");
			expect(() => markers.set(999, 1)).toThrow("Cannot mutate frozen compaction preparation");
			return { compactedText: "[User]: retained exactly\n(filtered 3 lines)" };
		}));
		const result = await session.compact({ preserve_recent: 2 });
		expect(result.rung).toBe("extension");
		expect(result.compactedText).toBe("[User]: retained exactly\n(filtered 3 lines)");
		expect(Object.isFrozen(before[0].preparation)).toBe(true);
		expect(after).toHaveLength(1);
		expect(after[0].compactionEntry.type).toBe("compaction");
		expect(after[0].compactionEntry.summary).toBe(result.compactedText);
		expect(after[0].fromExtension).toBe(true);
	});

	it("cancels without persistence", async () => {
		create(extension(() => ({ cancel: true })));
		await expect(session.compact()).rejects.toThrow("Compaction cancelled");
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("rejects whitespace extension text before persistence", async () => {
		create(extension(() => ({ compactedText: "  \n" })));
		await expect(session.compact()).rejects.toThrow("No compacted text provided by extension");
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it.each([
		["malformed", "not valid records"],
		["empty", ""],
	])("does not persist a compaction entry after one %s planner response", async (_label, response) => {
		const faux = createFauxStreamFn([response]);
		create(extension(() => undefined), faux.streamFn);
		await expect(session.compact()).rejects.toThrow(/Compaction range planning/);
		expect(faux.state.callCount).toBe(1);
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("does not persist after a provider failure", async () => {
		let calls = 0;
		const failingStream: StreamFn = () => {
			calls++;
			throw new Error("provider unavailable");
		};
		create(extension(() => undefined), failingStream);
		await expect(session.compact()).rejects.toThrow("provider unavailable");
		expect(calls).toBe(1);
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});
	it("isolates errors from the post-commit observer", async () => {
		create(extension(() => ({ compactedText: "[User]: retained" }), () => { throw new Error("observer failed"); }));
		await expect(session.compact()).resolves.toMatchObject({ rung: "extension" });
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});
});
