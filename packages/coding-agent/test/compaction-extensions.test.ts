import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime, type Extension, type SessionBeforeCompactEvent, type SessionBeforeCompactResult, type SessionCompactEvent, type SessionEvent } from "../src/core/extensions/index.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { setSessionAppendImplementationForTest } from "../src/core/session-manager-storage.ts";
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

	function extension(onBefore: (event: SessionBeforeCompactEvent) => SessionBeforeCompactResult | undefined | Promise<SessionBeforeCompactResult | undefined>, onAfter?: (event: SessionCompactEvent) => void): Extension {
		const handlers = new Map<string, ((event: SessionEvent) => Promise<SessionBeforeCompactResult | undefined>)[]>();
		handlers.set("session_before_compact", [async (event) => {
			if (event.type !== "session_before_compact") return undefined;
			before.push(event);
			return await onBefore(event);
		}]);
		handlers.set("session_compact", [async (event) => {
			if (event.type !== "session_compact") return undefined;
			after.push(event);
			onAfter?.(event);
			return undefined;
		}]);
		return { path: "test", resolvedPath: "/test.ts", sourceInfo: createSyntheticSourceInfo("<test>", { source: "test" }), handlers, tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map() };
	}

	function create(ext: Extension, streamFn?: StreamFn, suppliedManager?: SessionManager, cwd = process.cwd()): void {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const manager = suppliedManager ?? SessionManager.inMemory();
		const agent = new Agent({ getApiKey: () => undefined, initialState: { model, systemPrompt: "test", tools: [] }, streamFn });
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({ agent, sessionManager: manager, settingsManager: SettingsManager.inMemory(), cwd, modelRegistry: ModelRegistry.create(authStorage), resourceLoader: { ...createTestResourceLoader(), getExtensions: () => ({ extensions: [ext], errors: [], runtime: createExtensionRuntime() }) } });
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
		await expect(session.compact()).rejects.toThrow(/Compact(ed output|ion range planning)/);
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

	it("reprepares and commits a fresh disk-backed public plan once after a concurrent append", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-stale-public-"));
		const diskManager = SessionManager.create(cwd, cwd);
		let release!: () => void;
		let started!: () => void;
		let hookCalls = 0;
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		const entered = new Promise<void>((resolve) => { started = resolve; });
		create(extension(async () => {
			hookCalls++;
			started();
			await waiting;
			return { compactedText: "[User]: retained" };
		}), undefined, diskManager, cwd);
		const originalLeaf = session.sessionManager.getLeafId();
		const compacting = session.compact();
		await entered;
		const customId = session.sessionManager.appendCustomEntry("ordered", { value: "verbatim" });
		const messageId = session.sessionManager.appendMessage({ role: "user", content: "concurrent message", timestamp: Date.now() });
		release();
		await expect(compacting).resolves.toMatchObject({ rung: "extension" });
		const boundaries = session.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(boundaries).toHaveLength(1);
		expect(boundaries[0].parentId).toBe(messageId);
		expect(hookCalls).toBe(2);
		expect(session.sessionManager.getEntry(customId)?.parentId).toBe(originalLeaf);
		expect(session.sessionManager.getEntry(messageId)?.parentId).toBe(customId);
		expect(session.sessionManager.getLeafId()).toBe(boundaries[0].id);
		const file = session.sessionFile!;
		expect(readdirSync(dirname(file)).filter((name) => name.endsWith(".bak"))).toHaveLength(1);
		const reopened = SessionManager.open(file);
		expect(reopened.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "ordered")).toHaveLength(1);
		expect(reopened.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user" && entry.message.content === "concurrent message")).toHaveLength(1);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("rolls back a public disk compaction partial append and retains its recovery backup", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-partial-public-"));
		const manager = SessionManager.create(cwd, cwd);
		create(extension(() => ({ compactedText: "[User]: retained" })), undefined, manager, cwd);
		const file = session.sessionFile!;
		const beforeBytes = readFileSync(file);
		const beforeEntries = manager.getEntries();
		const beforeLeaf = manager.getLeafId();
		setSessionAppendImplementationForTest((path, data) => {
			appendFileSync(path, data.slice(0, Math.max(1, Math.floor(data.length / 2))));
			throw new Error("injected public partial append");
		});
		try {
			await expect(session.compact()).rejects.toThrow("injected public partial append");
		} finally {
			setSessionAppendImplementationForTest(undefined);
		}
		expect(readFileSync(file)).toEqual(beforeBytes);
		expect(manager.getEntries()).toEqual(beforeEntries);
		expect(manager.getLeafId()).toBe(beforeLeaf);
		expect(readdirSync(dirname(file)).filter((name) => name.endsWith(".bak"))).toHaveLength(1);
		expect(SessionManager.open(file).getEntries()).toEqual(beforeEntries);
		const next = manager.appendMessage({ role: "user", content: "after rollback", timestamp: Date.now() });
		expect(manager.getEntry(next)?.parentId).toBe(beforeLeaf);
		const reopened = SessionManager.open(file);
		expect(reopened.getLeafId()).toBe(next);
		expect(reopened.getEntries()).toEqual(manager.getEntries());
		rmSync(cwd, { recursive: true, force: true });
	});

	it("fails loudly without committing when the bounded fresh retry is stale again", async () => {
		let calls = 0;
		create(extension(() => {
			calls++;
			session.sessionManager.appendCustomEntry("concurrent", { calls });
			return { compactedText: "[User]: retained" };
		}));
		await expect(session.compact()).rejects.toMatchObject({ name: "StaleCompactionPlanError" });
		expect(calls).toBe(2);
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});
});
