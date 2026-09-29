import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model, ToolResultMessage, Usage } from "@bastani/pi-ai/compat";
import { beforeAll, test, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { SessionStats } from "../src/core/agent-session-types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { UsageMeterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { InteractiveEngineGenerationEnded } from "../src/modes/interactive-engine/engine-generation.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import type { RpcEvent, RpcSessionState } from "../src/modes/rpc/rpc-types.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

beforeAll(() => {
	initTheme(undefined, false);
});

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, total = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

function assistantMessage(messageUsage: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "working" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: messageUsage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResultMessage(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tool-call-1",
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function stats(options: {
	tokens: Omit<SessionStats["tokens"], "total">;
	cost: number;
	contextTokens: number | null;
	contextWindow?: number;
	latestAssistantUsage?: Usage;
}): SessionStats {
	const { tokens } = options;
	const contextWindow = options.contextWindow ?? 1_000_000;
	return {
		sessionFile: undefined,
		sessionId: "engine-session",
		userMessages: 1,
		assistantMessages: 1,
		toolCalls: 1,
		toolResults: 0,
		totalMessages: 2,
		tokens: { ...tokens, total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite },
		cost: options.cost,
		contextUsage: {
			tokens: options.contextTokens,
			contextWindow,
			percent: options.contextTokens === null ? null : (options.contextTokens / contextWindow) * 100,
		},
		latestAssistantUsage: options.latestAssistantUsage,
	};
}

const P1 = stats({
	tokens: { input: 10, output: 102, cacheRead: 19_900, cacheWrite: 21_000 },
	cost: 0.172,
	contextTokens: 20_860,
	latestAssistantUsage: usage(10, 102, 19_900, 90),
});
const P1_LINE = "↑10 • ↓102 • R20k • W21k • CH99.5% • $0.172 • 2.1%/1.0M (auto)";

const P2 = stats({
	tokens: { input: 12, output: 300, cacheRead: 49_800, cacheWrite: 30_000 },
	cost: 0.266,
	contextTokens: 30_045,
	latestAssistantUsage: usage(12, 198, 29_880, 108),
});
const P2_LINE = "↑12 • ↓300 • R50k • W30k • CH99.6% • $0.266 • 3.0%/1.0M (auto)";

function servicesFor(harness: Harness) {
	return {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	};
}

function createState(model?: Model<Api>): RpcSessionState {
	return {
		model,
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "engine-session",
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
		queuedMessagesPaused: false,
	};
}

type StatsRequest = {
	deferred: PromiseWithResolvers<SessionStats>;
	messageEndsBefore: number;
	settled: boolean;
};

/** Engine double whose stats requests, by either client route, wait until the test answers them. */
function createStatsEngineClient(model?: Model<Api>) {
	let generation = 1;
	let messageEnds = 0;
	let eventListener: ((event: RpcEvent) => void) | undefined;
	const statsRequests: StatsRequest[] = [];
	const requestStats = (): Promise<SessionStats> => {
		const deferred = Promise.withResolvers<SessionStats>();
		statsRequests.push({ deferred, messageEndsBefore: messageEnds, settled: false });
		return deferred.promise;
	};
	const settle = (index: number): StatsRequest => {
		const request = statsRequests[index];
		if (request === undefined) throw new Error(`no get_session_stats request at index ${index}`);
		if (request.settled) throw new Error(`get_session_stats request ${index} was already answered`);
		request.settled = true;
		return request;
	};
	const client = {
		onEvent(listener: (event: RpcEvent) => void) {
			eventListener = listener;
			return () => {
				if (eventListener === listener) eventListener = undefined;
			};
		},
		onGenerationEnded: (_listener: (event: InteractiveEngineGenerationEnded) => void) => () => {},
		getGeneration: () => generation,
		getState: async () => createState(model),
		getCommands: async () => [],
		getSessionStats: requestStats,
		requestInternal<T>(command: { type: string }): Promise<T> {
			if (command.type === "get_session_stats") return requestStats() as Promise<T>;
			if (command.type === "get_available_models") {
				return Promise.resolve({ models: [], scopedModels: [] } as T);
			}
			if (command.type === "import_session") return Promise.resolve({ cancelled: false } as T);
			return Promise.resolve(undefined as T);
		},
		abort: async () => {},
		stop: async () => {},
		restart: async () => {},
		switchSession: async (_sessionPath: string) => ({ cancelled: false }),
		newSession: async (_parentSession?: string) => ({ cancelled: false }),
		fork: async (_entryId: string) => ({ text: "", cancelled: false }),
		clone: async () => ({ cancelled: false }),
	};
	return {
		client,
		emit(event: RpcEvent): void {
			if (event.type === "message_end") messageEnds += 1;
			eventListener?.(event);
		},
		setGeneration(nextGeneration: number): void {
			generation = nextGeneration;
		},
		get statsRequestCount(): number {
			return statsRequests.length;
		},
		/** How many message_end events the engine had sent when the newest stats request was made. */
		get messageEndsBeforeLastRequest(): number | undefined {
			return statsRequests.at(-1)?.messageEndsBefore;
		},
		pendingStatsIndexes(): number[] {
			return statsRequests.flatMap((request, index) => (request.settled ? [] : [index]));
		},
		resolveStats(index: number, payload: SessionStats): void {
			settle(index).deferred.resolve(payload);
		},
		rejectStats(index: number, error: Error): void {
			settle(index).deferred.reject(error);
		},
		resolvePendingStats(payload: SessionStats): void {
			for (const index of this.pendingStatsIndexes()) this.resolveStats(index, payload);
		},
	};
}

type StatsEngineProbe = ReturnType<typeof createStatsEngineClient>;

function createRuntime(harness: Harness, probe: StatsEngineProbe): IsolatedInteractiveRuntime {
	const localRuntime = new AgentSessionRuntime(harness.session, servicesFor(harness), async () => {
		throw new Error("unused runtime factory");
	});
	return new IsolatedInteractiveRuntime(
		localRuntime,
		async () => {
			throw new Error("unused isolated runtime factory");
		},
		probe.client as never,
	);
}

/** Session replacement creates a file-backed mirror, so keep its directory out of the real agent dir. */
async function createFileBackedHarness(): Promise<Harness> {
	const sessionDir = mkdtempSync(join(tmpdir(), "atomic-footer-stats-"));
	const harness = await createHarness({ sessionManager: SessionManager.create(sessionDir, sessionDir) });
	return {
		...harness,
		cleanup: async () => {
			try {
				await harness.cleanup();
			} finally {
				rmSync(sessionDir, { recursive: true, force: true });
			}
		},
	};
}

function usageLine(runtime: IsolatedInteractiveRuntime): string {
	return stripAnsi(new UsageMeterComponent(runtime.session).render(120)[0] ?? "").trim();
}

function nextMacrotask(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Send one message_end, answer only the stats requests it caused, and wait for the footer to show them. */
async function showStats(
	probe: StatsEngineProbe,
	runtime: IsolatedInteractiveRuntime,
	payload: SessionStats,
	line: string,
) {
	const requestsBefore = probe.statsRequestCount;
	probe.emit({ type: "message_end", message: toolResultMessage() });
	await vi.waitFor(() => {
		assert.ok(
			probe.statsRequestCount > requestsBefore,
			`expected a get_session_stats request after message_end, saw ${probe.statsRequestCount - requestsBefore}`,
		);
	});
	for (const index of probe.pendingStatsIndexes()) {
		if (index >= requestsBefore) probe.resolveStats(index, payload);
	}
	await vi.waitFor(() => {
		assert.equal(usageLine(runtime), line);
	});
}

test("footer follows engine stats after each message_end before agent_end (#3328)", async () => {
	const harness = await createHarness();
	try {
		harness.sessionManager.appendMessage(assistantMessage(usage(100, 10, 50, 50, 0.001)));
		const probe = createStatsEngineClient();
		const runtime = createRuntime(harness, probe);
		const reply = assistantMessage(usage(10, 102, 19_900, 90, 0.172));

		probe.emit({ type: "agent_start" });
		probe.emit({ type: "message_start", message: reply });
		for (const delta of ["work", "ing"]) {
			probe.emit({
				type: "message_update",
				usage: reply.usage,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
			});
		}
		assert.equal(probe.statsRequestCount, 0);

		probe.emit({ type: "message_end", message: reply });
		await vi.waitFor(() => {
			assert.ok(
				probe.statsRequestCount >= 1,
				`expected a get_session_stats request after message_end, saw ${probe.statsRequestCount}`,
			);
		});
		probe.resolvePendingStats(P1);
		await vi.waitFor(() => {
			assert.equal(usageLine(runtime), P1_LINE);
		});
		assert.equal(runtime.session.isStreaming, true);

		probe.emit({ type: "message_end", message: toolResultMessage() });
		await vi.waitFor(() => {
			assert.ok(probe.statsRequestCount >= 2);
		});
		probe.resolvePendingStats(P2);
		await vi.waitFor(() => {
			assert.equal(usageLine(runtime), P2_LINE);
		});
	} finally {
		await harness.cleanup();
	}
});

test("/session and the extension context keep reading the host mirror while the footer shows engine stats (#3328)", async () => {
	const harness = await createHarness();
	try {
		harness.sessionManager.appendMessage(assistantMessage(usage(100, 10, 50, 50, 0.001)));
		const probe = createStatsEngineClient();
		const runtime = createRuntime(harness, probe);
		const mirrorStats = runtime.session.getSessionStats();
		const mirrorContextUsage = runtime.session.getContextUsage();

		await showStats(probe, runtime, P2, P2_LINE);

		const sessionStats = runtime.session.getSessionStats();
		assert.deepEqual(sessionStats.tokens, { input: 100, output: 10, cacheRead: 50, cacheWrite: 50, total: 210 });
		assert.equal(sessionStats.cost, 0.001);
		assert.deepEqual(sessionStats, mirrorStats);
		assert.deepEqual(runtime.session.getContextUsage(), mirrorContextUsage);
		assert.notDeepEqual(runtime.session.getContextUsage(), P2.contextUsage);
	} finally {
		await harness.cleanup();
	}
});

test("a burst of message_end events ends on the reply to the last request (#3328)", async () => {
	const harness = await createHarness();
	try {
		const probe = createStatsEngineClient();
		const runtime = createRuntime(harness, probe);
		const burstStats = (index: number) =>
			stats({
				tokens: { input: 10 * (index + 1), output: 0, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
				contextTokens: 10_000 * (index + 1),
			});

		probe.emit({ type: "agent_start" });
		for (let event = 0; event < 5; event++) {
			probe.emit({
				type: "message_end",
				message: event % 2 === 0 ? assistantMessage(usage(1, 1, 0, 0)) : toolResultMessage(),
			});
			await nextMacrotask();
		}
		for (let round = 0; round < 5 && probe.pendingStatsIndexes().length > 0; round++) {
			for (const index of probe.pendingStatsIndexes().reverse()) probe.resolveStats(index, burstStats(index));
			await nextMacrotask();
		}

		assert.deepEqual(probe.pendingStatsIndexes(), []);
		assert.equal(probe.messageEndsBeforeLastRequest, 5);
		assert.ok(probe.statsRequestCount <= 5, `expected at most 5 requests, saw ${probe.statsRequestCount}`);
		const last = probe.statsRequestCount;
		assert.equal(usageLine(runtime), `↑${10 * last} • ${last}.0%/1.0M (auto)`);
	} finally {
		await harness.cleanup();
	}
});

test("a failed stats request keeps the last footer without an engine diagnostic (#3328)", async () => {
	const harness = await createHarness();
	try {
		const probe = createStatsEngineClient();
		const runtime = createRuntime(harness, probe);
		const diagnostics: string[] = [];
		runtime.onDiagnostic((diagnostic) => diagnostics.push(diagnostic.message));
		await showStats(probe, runtime, P1, P1_LINE);

		probe.emit({ type: "message_end", message: toolResultMessage() });
		await vi.waitFor(() => {
			assert.equal(probe.pendingStatsIndexes().length, 1);
		});
		probe.rejectStats(probe.statsRequestCount - 1, new Error("engine unavailable"));
		await nextMacrotask();

		assert.equal(usageLine(runtime), P1_LINE);
		assert.deepEqual(diagnostics, []);
		assert.equal(runtime.interruptBlockedCallback(), false);
		await showStats(probe, runtime, P2, P2_LINE);
		assert.equal(usageLine(runtime), P2_LINE);
	} finally {
		await harness.cleanup();
	}
});

test("a completed compaction refreshes the footer and an aborted or failed one does not (#3328)", async () => {
	const harness = await createHarness();
	try {
		const probe = createStatsEngineClient();
		const runtime = createRuntime(harness, probe);
		await showStats(probe, runtime, P1, P1_LINE);
		const requestsBefore = probe.statsRequestCount;

		probe.emit({ type: "compaction_start", reason: "manual" });
		probe.emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false });
		probe.emit({ type: "compaction_start", reason: "manual" });
		probe.emit({
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "Compaction failed: provider error",
		});
		await nextMacrotask();
		assert.equal(probe.statsRequestCount, requestsBefore);
		assert.equal(usageLine(runtime), P1_LINE);

		probe.emit({ type: "compaction_start", reason: "threshold" });
		probe.emit({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
		await vi.waitFor(() => {
			assert.ok(probe.statsRequestCount > requestsBefore);
		});
		probe.resolvePendingStats(stats({ tokens: P1.tokens, cost: P1.cost, contextTokens: null }));
		await vi.waitFor(() => {
			assert.match(usageLine(runtime), / • \?\/1\.0M \(auto\)$/);
		});
	} finally {
		await harness.cleanup();
	}
});

test("an engine restart drops the old engine's stats without a diagnostic (#3328)", async () => {
	const harness = await createHarness();
	try {
		harness.sessionManager.appendMessage(assistantMessage(usage(100, 10, 50, 50, 0.001)));
		const probe = createStatsEngineClient(harness.getModel());
		const runtime = createRuntime(harness, probe);
		const mirrorLine = usageLine(runtime);
		const diagnostics: string[] = [];
		runtime.onDiagnostic((diagnostic) => diagnostics.push(diagnostic.message));
		await showStats(probe, runtime, P1, P1_LINE);

		probe.emit({ type: "message_end", message: toolResultMessage() });
		await vi.waitFor(() => {
			assert.equal(probe.pendingStatsIndexes().length, 1);
		});
		const heldRequest = probe.pendingStatsIndexes()[0] ?? -1;
		probe.setGeneration(2);
		probe.resolveStats(heldRequest, P2);
		await nextMacrotask();
		assert.equal(usageLine(runtime), P1_LINE);

		await runtime.initializeFromEngine();
		assert.equal(usageLine(runtime), mirrorLine);
		assert.deepEqual(diagnostics, []);
		await showStats(probe, runtime, P2, P2_LINE);
		assert.equal(usageLine(runtime), P2_LINE);
	} finally {
		await harness.cleanup();
	}
});

for (const operation of ["newSession", "fork", "importFromJsonl"] as const) {
	test(`${operation} never shows the previous session's stats (#3328)`, async () => {
		const harness = await createFileBackedHarness();
		try {
			const probe = createStatsEngineClient(harness.getModel());
			const runtime = createRuntime(harness, probe);
			await showStats(probe, runtime, P1, P1_LINE);
			probe.emit({ type: "message_end", message: toolResultMessage() });
			await vi.waitFor(() => {
				assert.equal(probe.pendingStatsIndexes().length, 1);
			});
			const heldRequest = probe.pendingStatsIndexes()[0] ?? -1;

			if (operation === "newSession") await runtime.newSession();
			else if (operation === "fork") await runtime.fork("entry-1");
			else await runtime.importFromJsonl(join(harness.tempDir, "import.jsonl"));
			const replacedLine = usageLine(runtime);
			assert.doesNotMatch(replacedLine, /\$0\.172|2\.1%\/1\.0M/);
			if (operation === "newSession") assert.match(replacedLine, /^0\.0%\/\S+ \(auto\)$/);

			probe.resolveStats(heldRequest, P1);
			await nextMacrotask();
			assert.equal(usageLine(runtime), replacedLine);

			await showStats(probe, runtime, P2, P2_LINE);
			assert.equal(usageLine(runtime), P2_LINE);
		} finally {
			await harness.cleanup();
		}
	});
}

test("switchSession never shows the previous session's stats, even when the old reply lands last (#3328)", async () => {
	const first = await createHarness();
	const second = await createHarness();
	try {
		const target = SessionManager.create(second.tempDir, second.tempDir);
		target.flush();
		const targetPath = target.getSessionFile();
		if (!targetPath) throw new Error("missing target session path");
		const probe = createStatsEngineClient(first.getModel());
		const localRuntime = new AgentSessionRuntime(first.session, servicesFor(first), async () => {
			throw new Error("unused runtime factory");
		});
		const runtime = new IsolatedInteractiveRuntime(
			localRuntime,
			async () => ({ session: second.session, services: servicesFor(second), diagnostics: [] }) as never,
			probe.client as never,
		);
		await showStats(probe, runtime, P1, P1_LINE);
		probe.emit({ type: "message_end", message: toolResultMessage() });
		await vi.waitFor(() => {
			assert.equal(probe.pendingStatsIndexes().length, 1);
		});
		const heldRequest = probe.pendingStatsIndexes()[0] ?? -1;

		await runtime.switchSession(targetPath);
		assert.equal(runtime.session, second.session);
		assert.doesNotMatch(usageLine(runtime), /\$0\.172|2\.1%\/1\.0M/);

		await showStats(probe, runtime, P2, P2_LINE);
		probe.resolveStats(heldRequest, P1);
		await nextMacrotask();
		assert.equal(usageLine(runtime), P2_LINE);
	} finally {
		await first.cleanup();
		await second.cleanup();
	}
});

test("a model change moves the footer to the new context window (#3328)", async () => {
	const harness = await createHarness();
	try {
		const probe = createStatsEngineClient(harness.getModel());
		const runtime = createRuntime(harness, probe);
		await showStats(probe, runtime, P1, P1_LINE);
		const smaller: Model<Api> = { ...harness.getModel(), id: "faux-small", contextWindow: 200_000 };

		probe.emit({ type: "model_changed", model: smaller, previousModel: harness.getModel(), source: "set" });
		await nextMacrotask();
		probe.resolvePendingStats(
			stats({ tokens: P1.tokens, cost: P1.cost, contextTokens: 20_860, contextWindow: 200_000 }),
		);

		await vi.waitFor(() => {
			assert.match(usageLine(runtime), /%\/200k \(auto\)$/);
		});
	} finally {
		await harness.cleanup();
	}
});

test("stats that land after agent_end ask the host to repaint (#3328)", async () => {
	const harness = await createHarness();
	try {
		const probe = createStatsEngineClient();
		const runtime = createRuntime(harness, probe);
		let repaints = 0;
		// Optional call: this file must load, and fail by assertion, against the runtime before #3328.
		runtime.onSessionStatsChanged?.(() => {
			repaints += 1;
		});

		probe.emit({ type: "agent_start" });
		probe.emit({ type: "message_end", message: assistantMessage(usage(10, 102, 19_900, 90, 0.172)) });
		probe.emit({ type: "agent_end", messages: [] });
		assert.equal(repaints, 0);
		probe.resolvePendingStats(P1);

		await vi.waitFor(() => {
			assert.equal(repaints, 1);
		});
		assert.equal(runtime.session.isStreaming, false);
		assert.equal(usageLine(runtime), P1_LINE);
	} finally {
		await harness.cleanup();
	}
});

test("the in-process footer still counts only its own message entries (#3328)", async () => {
	const harness = await createHarness();
	try {
		harness.sessionManager.appendMessage(assistantMessage(usage(100, 10, 50, 50, 0.001)));
		harness.sessionManager.appendUsage("cache-warm", "anthropic", "claude-test", usage(0, 0, 5_000, 0, 0.5));

		const line = stripAnsi(new UsageMeterComponent(harness.session).render(120)[0] ?? "").trim();

		assert.match(line, /^↑100 • ↓10 • R50 • W50 • CH25\.0% • \$0\.001 • \S+ \(auto\)$/);
	} finally {
		await harness.cleanup();
	}
});
