import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import type { RpcEvent } from "../../packages/coding-agent/src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";

afterEach(() => {
	vi.useRealTimers();
});

/** An engine client whose events the test sends; every subscriber gets them, as the RPC client delivers them. */
function engineClient() {
	const listeners: ((event: RpcEvent) => void)[] = [];
	const client = {
		onInteractiveEngineMessage: () => () => {},
		onGenerationEnded: () => () => {},
		onEvent(listener: (event: RpcEvent) => void) {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		getGeneration: () => 1,
		getState: async () => ({ resourceExtensions: [] }),
		requestInternal: async () => undefined,
		stop: async () => {},
		restart: async () => {},
	};
	return {
		client,
		emit: (event: RpcEvent) => {
			for (const listener of [...listeners]) listener(event);
		},
	};
}

async function hostOf(harness: Harness) {
	const engine = engineClient();
	const local = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	const runtime = new IsolatedInteractiveRuntime(
		local,
		async () => {
			throw new Error("unused isolated runtime factory");
		},
		engine.client as never,
	);
	// The host's view of the engine's session: the test decides when its refresh from the store settles.
	const refreshes: PromiseWithResolvers<void>[] = [];
	Object.assign(runtime, {
		refreshSessionView: () => {
			const refresh = Promise.withResolvers<void>();
			refreshes.push(refresh);
			return refresh.promise;
		},
	});
	const seen: string[] = [];
	runtime.session.subscribe((event) => {
		seen.push(
			event.type === "message_start"
				? `message_start:${(event.message as { content: string }).content}`
				: event.type,
		);
	});
	return { emit: engine.emit, refreshes, seen };
}

const user = (content: string) =>
	({ type: "message_start", message: { role: "user", content, timestamp: 0 } }) as unknown as RpcEvent;
const compactionEnd = (result: boolean, aborted = false) =>
	({
		type: "compaction_end",
		reason: "manual",
		aborted,
		willRetry: false,
		...(result ? { result: { compactedText: "", firstKeptEntryId: null, tokensBefore: 1 } } : {}),
	}) as unknown as RpcEvent;

test("an engine host shows a compaction's end and what follows, in order, once its session view has the boundary (#5593)", async () => {
	const harness = await createHarness();
	try {
		const host = await hostOf(harness);
		host.emit(user("before"));
		assert.deepEqual(host.seen, ["message_start:before"], "events outside a compaction pass straight through");
		host.emit(compactionEnd(true));
		host.emit(user("after"));
		host.emit(compactionEnd(true));
		host.emit(user("last"));
		assert.deepEqual(host.seen, ["message_start:before"], "the compaction and later events wait for the view");
		assert.equal(host.refreshes.length, 1);
		host.refreshes[0]!.resolve();
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(host.seen, ["message_start:before", "compaction_end", "message_start:after"]);
		assert.equal(host.refreshes.length, 2, "a later compaction refreshes the view again before it is shown");
		host.refreshes[1]!.reject(new Error("store unavailable"));
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(host.seen, [
			"message_start:before",
			"compaction_end",
			"message_start:after",
			"compaction_end",
			"message_start:last",
		]);
	} finally {
		await harness.cleanup();
	}
});

test("an engine host shows a compaction's end after a bounded wait when its view does not refresh (#5593)", async () => {
	const harness = await createHarness();
	try {
		vi.useFakeTimers();
		const host = await hostOf(harness);
		host.emit(compactionEnd(true));
		host.emit(user("after"));
		assert.deepEqual(host.seen, []);
		vi.advanceTimersByTime(5_000);
		assert.deepEqual(host.seen, ["compaction_end", "message_start:after"]);
	} finally {
		vi.useRealTimers();
		await harness.cleanup();
	}
});

test("a compaction that changed nothing is shown at once on an engine host (#5593)", async () => {
	const harness = await createHarness();
	try {
		const host = await hostOf(harness);
		host.emit(compactionEnd(false));
		host.emit(compactionEnd(true, true));
		host.emit(user("next"));
		assert.deepEqual(host.seen, ["compaction_end", "compaction_end", "message_start:next"]);
		assert.equal(host.refreshes.length, 0);
	} finally {
		await harness.cleanup();
	}
});
