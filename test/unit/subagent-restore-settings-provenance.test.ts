import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, HostDiagnostic } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { SessionResume, SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import {
	SUBAGENT_CHILD_RECORD_TYPE,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	restoreSubagentChild,
	type SubagentChildRestoreDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.js";

const CLEARED = {
	strategy: "verbatim-lines",
	form: "cleared",
	promptVersion: 7,
	parameters: { query: "clear" },
	stats: {
		linesBefore: 2,
		linesDeleted: 2,
		linesKept: 0,
		rangeCount: 0,
		tokensBefore: 300,
		tokensAfter: 20,
		percentReduction: 93,
	},
} as const;

const BUILTIN_DIAGNOSTIC_CONTEXT_KEY = Symbol.for("atomic.builtin-diagnostic-context.v1");

const MODELS = [
	{ provider: "anthropic", id: "claude-sonnet-5-5", reasoning: true },
	{ provider: "anthropic", id: "claude-opus-5", reasoning: true },
	{ provider: "anthropic", id: "claude-haiku-5", reasoning: true },
] as const;

const WORKER_AGENT: AgentConfig = {
	name: "worker",
	description: "worker",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/worker.md",
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-restore-provenance-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * Prepare a parent session with a restorable child record whose child session:
 * - starts on `claude-haiku-5` / `low` (pre-launch copy),
 * - launches at `launchLeaf` on `launchModel = claude-sonnet-5-5`, `launchThinkingLevel = medium`,
 * - changes model to `claude-opus-5` and thinking level to `high` after launch,
 * - then clears context so both post-launch setting changes lie before the held window.
 */
async function setupCompactedChild(cwd: string, transformChildResume?: (resume: SessionResume) => SessionResume) {
	const backingStore = new MemorySessionStore();
	const parent = await SessionManager.create(backingStore, cwd);
	const child = await SessionManager.create(backingStore, cwd, { internal: true });
	await child.appendModelChange("anthropic", "claude-haiku-5");
	await child.appendThinkingLevelChange("low");
	const launchLeafId = await child.appendMessage({ role: "user", content: "launch point", timestamp: 1 });
	const launchLeafSeq = child.getEntrySeq(launchLeafId)!;
	await child.appendModelChange("anthropic", "claude-opus-5");
	await child.appendThinkingLevelChange("high");
	await child.appendMessage({ role: "user", content: "after switch", timestamp: 2 });
	await child.appendCompaction("Cleared context.", null, 300, CLEARED);
	await child.appendMessage({ role: "user", content: "in window", timestamp: 3 });

	const childSessionId = child.getSessionId();
	const record: SubagentChildRecord = {
		version: 1,
		childId: "prov1:0",
		runId: "prov1",
		index: 0,
		agent: "worker",
		agentSource: "user",
		state: "running",
		cwd,
		owner: { kind: "session", sessionId: parent.getSessionId() },
		childSessionId,
		launchModel: "anthropic/claude-sonnet-5-5",
		launchThinkingLevel: "medium",
		launchLeafId,
		launchLeafSeq,
	};
	await parent.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record);

	let readRangeCalls = 0;
	let loadCalls = 0;
	const baseReadResume = backingStore.readResume.bind(backingStore);
	const baseReadRange = backingStore.readRange.bind(backingStore);
	const baseLoad = backingStore.load.bind(backingStore);
	const wrappedStore: SessionStore = Object.assign(Object.create(backingStore) as SessionStore, {
		readResume: async (sessionId: string, leafId?: string, options?: { deferChildRecords: true }) => {
			const resume = await baseReadResume(sessionId, leafId, options);
			return sessionId === childSessionId && transformChildResume ? transformChildResume(resume) : resume;
		},
		readRange: async (...args: Parameters<MemorySessionStore["readRange"]>) => {
			if (args[0] === childSessionId) readRangeCalls++;
			return baseReadRange(...args);
		},
		load: async (sessionId: string) => {
			if (sessionId === childSessionId) loadCalls++;
			return baseLoad(sessionId);
		},
	});

	const reopenedParent = await SessionManager.open(wrappedStore, parent.getSessionId(), cwd, { history: "tail" });
	const observedOptions: RunSyncOptions[] = [];
	const events = { on: () => {}, off: () => {}, emit: () => {} };
	const pi = {
		events,
		getSessionName: () => undefined,
		appendEntry: async (type: string, data?: unknown) => {
			await reopenedParent.appendCustomEntry(type, data as never);
		},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	const modelRegistry = {
		getAvailable: () => [...MODELS],
		getAll: () => [...MODELS],
		find: (provider: string, id: string) => MODELS.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: () => true,
	};
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: reopenedParent,
		modelRegistry,
		model: MODELS[2],
		thinkingLevel: "low",
	} as unknown as ExtensionContext;
	const deps: SubagentChildRestoreDeps = {
		pi,
		config: {},
		discoverAgents: async () => ({ agents: [WORKER_AGENT] }),
		runtime: {
			runSync: async (_cwd, _agents, _agentName, _task, options) => {
				observedOptions.push(options ?? {});
				return {
					agent: "worker",
					agentSource: "user",
					task: "ok",
					status: "ok",
					exitCode: 0,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
				};
			},
		},
	};
	return {
		ctx,
		deps,
		observedOptions,
		backingStore,
		childSessionId,
		storeReads: () => ({ readRangeCalls, loadCalls }),
	};
}

test("normal partial-history restore recovers post-launch model and thinking with zero diagnostics and zero extra store reads", async () => {
	const cwd = tempDir();
	const { ctx, deps, observedOptions, storeReads } = await setupCompactedChild(cwd);
	const warnings: string[] = [];
	const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
		warnings.push(args.map(String).join(" "));
	});
	try {
		const outcome = await restoreSubagentChild(deps, ctx, "prov1:0");
		assert.equal(outcome.kind, "restored");
		assert.equal(observedOptions.length, 1);
		assert.equal(observedOptions[0]!.modelOverride, "anthropic/claude-opus-5:high");
		assert.deepEqual(warnings, []);
		assert.deepEqual(storeReads(), { readRangeCalls: 0, loadCalls: 0 });
	} finally {
		warnSpy.mockRestore();
	}
});

test("when a partial resume omits model provenance, restore keeps launchModel, preserves retained thinking, and emits a diagnostic", async () => {
	const cwd = tempDir();
	const { ctx, deps, observedOptions, storeReads } = await setupCompactedChild(cwd, (resume) => ({
		...resume,
		state: resume.state.filter((row) => row.entry.type !== "model_change"),
		retainedSettings: {
			model: { status: "not-held" },
			thinkingLevel: resume.retainedSettings!.thinkingLevel,
		},
	}));
	const warnings: string[] = [];
	const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
		warnings.push(args.map(String).join(" "));
	});
	try {
		const outcome = await restoreSubagentChild(deps, ctx, "prov1:0");
		assert.equal(outcome.kind, "restored");
		assert.equal(observedOptions.length, 1);
		assert.equal(
			observedOptions[0]!.modelOverride,
			"anthropic/claude-sonnet-5-5:high",
			"model falls back to launchModel while retained thinkingLevel stays high",
		);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /prov1:0/);
		assert.match(warnings[0]!, /\bmodel\b/);
		assert.doesNotMatch(warnings[0]!, /thinking level/);
		assert.deepEqual(storeReads(), { readRangeCalls: 0, loadCalls: 0 });
	} finally {
		warnSpy.mockRestore();
	}
});

test("when a partial resume omits thinkingLevel provenance, restore uses retained model, keeps launchThinkingLevel, and emits a diagnostic", async () => {
	const cwd = tempDir();
	const { ctx, deps, observedOptions } = await setupCompactedChild(cwd, (resume) => ({
		...resume,
		state: resume.state.filter((row) => row.entry.type !== "thinking_level_change"),
		retainedSettings: {
			model: resume.retainedSettings!.model,
			thinkingLevel: { status: "not-held" },
		},
	}));
	const warnings: string[] = [];
	const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
		warnings.push(args.map(String).join(" "));
	});
	try {
		const outcome = await restoreSubagentChild(deps, ctx, "prov1:0");
		assert.equal(outcome.kind, "restored");
		assert.equal(
			observedOptions[0]!.modelOverride,
			"anthropic/claude-opus-5:medium",
			"retained model wins while thinkingLevel falls back to launchThinkingLevel",
		);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /prov1:0/);
		assert.match(warnings[0]!, /thinking level/);
		assert.doesNotMatch(warnings[0]!, /\bmodel\b/);
	} finally {
		warnSpy.mockRestore();
	}
});

test("when a custom partial resume omits retainedSettings and leaves a stale pre-window model, restore keeps launch settings and emits one diagnostic via the host reporter when bound", async () => {
	const cwd = tempDir();
	let staleEntry: SessionResume["branch"][number]["entry"] | undefined;
	const { ctx, deps, observedOptions, backingStore, childSessionId } = await setupCompactedChild(cwd, (resume) => ({
		...resume,
		state: [
			...resume.state.filter(
				(row) => row.entry.type !== "model_change" && row.entry.type !== "thinking_level_change",
			),
			...(staleEntry ? [{ seq: 1, entry: staleEntry, onBranch: true }] : []),
		],
		retainedSettings: undefined,
	}));
	staleEntry = (await backingStore.load(childSessionId)).entries[0];

	const host = globalThis as typeof globalThis & {
		[BUILTIN_DIAGNOSTIC_CONTEXT_KEY]?: AsyncLocalStorage<(d: Omit<HostDiagnostic, "sessionId">) => void>;
	};
	host[BUILTIN_DIAGNOSTIC_CONTEXT_KEY] ??= new AsyncLocalStorage();
	const hostDiagnostics: Omit<HostDiagnostic, "sessionId">[] = [];
	const consoleWarnings: string[] = [];
	const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
		consoleWarnings.push(args.map(String).join(" "));
	});
	try {
		const outcome = await host[BUILTIN_DIAGNOSTIC_CONTEXT_KEY].run(
			(diagnostic) => hostDiagnostics.push(diagnostic),
			() => restoreSubagentChild(deps, ctx, "prov1:0"),
		);
		assert.equal(outcome.kind, "restored");
		assert.equal(
			observedOptions[0]!.modelOverride,
			"anthropic/claude-sonnet-5-5:medium",
			"keeps both launch settings and rejects the stale pre-window haiku entry",
		);
		assert.equal(hostDiagnostics.length, 1);
		assert.equal(hostDiagnostics[0]!.level, "warning");
		assert.equal(hostDiagnostics[0]!.source, "subagents");
		assert.match(hostDiagnostics[0]!.message, /prov1:0/);
		assert.match(hostDiagnostics[0]!.message, /model and thinking level/);
		assert.deepEqual(consoleWarnings, [], "does not duplicate to console.warn when host reporter handled it");
	} finally {
		warnSpy.mockRestore();
	}
});

test("a throwing host diagnostic reporter does not abort restoration and falls back to console.warn", async () => {
	const cwd = tempDir();
	const { ctx, deps, observedOptions } = await setupCompactedChild(cwd, (resume) => ({
		...resume,
		state: resume.state.filter((row) => row.entry.type !== "model_change"),
		retainedSettings: {
			model: { status: "not-held" },
			thinkingLevel: resume.retainedSettings!.thinkingLevel,
		},
	}));
	const host = globalThis as typeof globalThis & {
		[BUILTIN_DIAGNOSTIC_CONTEXT_KEY]?: AsyncLocalStorage<(d: Omit<HostDiagnostic, "sessionId">) => void>;
	};
	host[BUILTIN_DIAGNOSTIC_CONTEXT_KEY] ??= new AsyncLocalStorage();
	const consoleWarnings: string[] = [];
	const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
		consoleWarnings.push(args.map(String).join(" "));
	});
	try {
		const outcome = await host[BUILTIN_DIAGNOSTIC_CONTEXT_KEY].run(
			() => {
				throw new Error("observer crashed");
			},
			() => restoreSubagentChild(deps, ctx, "prov1:0"),
		);
		assert.equal(outcome.kind, "restored");
		assert.equal(observedOptions[0]!.modelOverride, "anthropic/claude-sonnet-5-5:high");
		assert.equal(consoleWarnings.length, 1);
		assert.match(consoleWarnings[0]!, /prov1:0/);
	} finally {
		warnSpy.mockRestore();
	}
});

test("a full (uncompacted) child resume restores post-launch settings with zero diagnostics and zero extra reads", async () => {
	const cwd = tempDir();
	const backingStore = new MemorySessionStore();
	const parent = await SessionManager.create(backingStore, cwd);
	const child = await SessionManager.create(backingStore, cwd, { internal: true });
	const launchLeafId = await child.appendMessage({ role: "user", content: "launch", timestamp: 1 });
	const launchLeafSeq = child.getEntrySeq(launchLeafId)!;
	await child.appendModelChange("anthropic", "claude-opus-5");
	await child.appendThinkingLevelChange("high");
	await child.appendMessage({ role: "user", content: "after switch", timestamp: 2 });

	const record: SubagentChildRecord = {
		version: 1,
		childId: "full1:0",
		runId: "full1",
		index: 0,
		agent: "worker",
		agentSource: "user",
		state: "running",
		cwd,
		owner: { kind: "session", sessionId: parent.getSessionId() },
		childSessionId: child.getSessionId(),
		launchModel: "anthropic/claude-sonnet-5-5",
		launchThinkingLevel: "medium",
		launchLeafId,
		launchLeafSeq,
	};
	await parent.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record);

	const observedOptions: RunSyncOptions[] = [];
	const pi = {
		events: { on: () => {}, off: () => {}, emit: () => {} },
		getSessionName: () => undefined,
		appendEntry: async (type: string, data?: unknown) => {
			await parent.appendCustomEntry(type, data as never);
		},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: parent,
		modelRegistry: {
			getAvailable: () => [...MODELS],
			getAll: () => [...MODELS],
			find: (provider: string, id: string) => MODELS.find((m) => m.provider === provider && m.id === id),
			hasConfiguredAuth: () => true,
		},
		model: MODELS[2],
		thinkingLevel: "low",
	} as unknown as ExtensionContext;
	const deps: SubagentChildRestoreDeps = {
		pi,
		config: {},
		discoverAgents: async () => ({ agents: [WORKER_AGENT] }),
		runtime: {
			runSync: async (_cwd, _agents, _agentName, _task, options) => {
				observedOptions.push(options ?? {});
				return {
					agent: "worker",
					agentSource: "user",
					task: "ok",
					status: "ok",
					exitCode: 0,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
				};
			},
		},
	};
	const warnings: string[] = [];
	const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
		warnings.push(args.map(String).join(" "));
	});
	try {
		const outcome = await restoreSubagentChild(deps, ctx, "full1:0");
		assert.equal(outcome.kind, "restored");
		assert.equal(observedOptions[0]!.modelOverride, "anthropic/claude-opus-5:high");
		assert.deepEqual(warnings, []);
	} finally {
		warnSpy.mockRestore();
	}
});

test("remains compatible with an older getLatestBranchSettings shape lacking status fields", async () => {
	const cwd = tempDir();
	const { ctx, deps, observedOptions } = await setupCompactedChild(cwd);
	const original = SessionManager.prototype.getLatestBranchSettings;
	const warnings: string[] = [];
	const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
		warnings.push(args.map(String).join(" "));
	});
	vi.spyOn(SessionManager.prototype, "getLatestBranchSettings").mockImplementation(function (
		this: SessionManager,
		afterSeq?: number,
	) {
		const res = original.call(this, afterSeq);
		return {
			...(res.model.status === "found" ? { model: { entry: res.model.entry, seq: res.model.seq } } : {}),
			...(res.thinkingLevel.status === "found"
				? { thinkingLevel: { entry: res.thinkingLevel.entry, seq: res.thinkingLevel.seq } }
				: {}),
		} as unknown as ReturnType<SessionManager["getLatestBranchSettings"]>;
	});
	try {
		const outcome = await restoreSubagentChild(deps, ctx, "prov1:0");
		assert.equal(outcome.kind, "restored");
		assert.equal(observedOptions[0]!.modelOverride, "anthropic/claude-opus-5:high");
		assert.deepEqual(warnings, []);
	} finally {
		vi.restoreAllMocks();
		warnSpy.mockRestore();
	}
});

test("remains compatible with an external session manager lacking getLatestBranchSettings", async () => {
	const cwd = tempDir();
	const { ctx, deps, observedOptions } = await setupCompactedChild(cwd);
	const original = SessionManager.prototype.getLatestBranchSettings;
	const warnings: string[] = [];
	const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
		warnings.push(args.map(String).join(" "));
	});
	// Simulate an external SDK SessionManager without getLatestBranchSettings.
	Object.defineProperty(SessionManager.prototype, "getLatestBranchSettings", {
		value: undefined,
		configurable: true,
		writable: true,
	});
	try {
		const outcome = await restoreSubagentChild(deps, ctx, "prov1:0");
		assert.equal(outcome.kind, "restored");
		assert.equal(observedOptions[0]!.modelOverride, "anthropic/claude-opus-5:high");
		assert.deepEqual(warnings, []);
	} finally {
		Object.defineProperty(SessionManager.prototype, "getLatestBranchSettings", {
			value: original,
			configurable: true,
			writable: true,
		});
		warnSpy.mockRestore();
	}
});
