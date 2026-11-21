import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { renderEngineDiagnostic } from "../../packages/coding-agent/src/modes/interactive-engine/engine-diagnostic-view.ts";
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

async function hostOf(harness: Harness, getEntries?: () => Promise<unknown>) {
	const engine = engineClient();
	if (getEntries) Object.assign(engine.client, { getEntries });
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
	if (!getEntries)
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
	return { emit: engine.emit, refreshes, seen, session: runtime.session, runtime };
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

test("a listener subscribed during a compaction refresh receives no event from before it subscribed (#5593)", async () => {
	const harness = await createHarness();
	try {
		const host = await hostOf(harness),
			seen: string[] = [];
		const receive = (e: Parameters<Parameters<typeof host.session.subscribe>[0]>[0]) =>
			seen.push(e.type === "message_start" ? (e.message as { content: string }).content : e.type);
		const off = host.session.subscribe(receive);
		host.emit(compactionEnd(true));
		host.emit(user("old subscription"));
		off();
		host.session.subscribe(receive);
		host.emit(user("new subscription"));
		host.refreshes[0]!.resolve();
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(seen, ["new subscription"]);
	} finally {
		await harness.cleanup();
	}
});

test("an engine host shows a compaction's end after a bounded wait when its view does not refresh (#5593)", async () => {
	const harness = await createHarness();
	try {
		vi.useFakeTimers();
		const host = await hostOf(harness);
		const visible: string[] = [];
		host.runtime.onDiagnostic((d) =>
			renderEngineDiagnostic(d, {
				stopWorkingLoader: () => visible.push("stop"),
				showError: (m) => visible.push(m),
				showStatus: (m) => visible.push(m),
			}),
		);
		host.emit(compactionEnd(true));
		host.emit(user("after"));
		assert.deepEqual(host.seen, []);
		vi.advanceTimersByTime(5_000);
		assert.deepEqual(host.seen, ["compaction_end", "message_start:after"]);
		assert.deepEqual(visible, [], "a slow internal view read adds no status to the conversation");
	} finally {
		vi.useRealTimers();
		await harness.cleanup();
	}
});

test.each([false, true])(
	"a compaction refresh overlapping a turn-end refresh shows the new boundary (newer read first: %s, #5593)",
	async (newerFirst) => {
		const harness = await createHarness();
		try {
			const reads: PromiseWithResolvers<unknown>[] = [];
			const host = await hostOf(harness, () => {
				const r = Promise.withResolvers<unknown>();
				reads.push(r);
				return r.promise;
			});
			let shown: string[] | undefined;
			host.session.subscribe((e) => {
				if (e.type === "compaction_end") shown = host.session.sessionManager.getEntries().map((i) => i.type);
			});
			const timestamp = "2026-01-01T00:00:00.000Z";
			const entry = {
				type: "message",
				id: "u1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "old", timestamp: 0 },
			};
			const boundary = {
				type: "compaction",
				id: "c1",
				parentId: "u1",
				timestamp,
				summary: "new",
				firstKeptEntryId: "u1",
				tokensBefore: 10,
			};
			host.emit({ type: "agent_end", messages: [] } as RpcEvent);
			await vi.waitFor(() => assert.ok(reads[0]));
			host.emit(compactionEnd(true));
			await new Promise<void>((r) => setImmediate(r));
			const old = { entries: [entry], leafId: "u1" },
				fresh = { entries: [entry, boundary], leafId: "c1" };
			if (newerFirst && reads[1]) {
				reads[1].resolve(fresh);
				await vi.waitFor(() => assert.ok(shown));
				reads[0]!.resolve(old);
			} else {
				reads[0]!.resolve(old);
				await vi.waitFor(() => assert.ok(reads[1]));
				await new Promise<void>((r) => setImmediate(r));
				reads[1]!.resolve(fresh);
			}
			await vi.waitFor(() => assert.ok(shown));
			await new Promise<void>((r) => setImmediate(r));
			assert.deepEqual(shown, ["message", "compaction"], "the listener receives the clear from its refreshed view");
			assert.deepEqual(
				host.session.sessionManager.getEntries().map((i) => i.type),
				shown,
				"a late read never restores the old view",
			);
		} finally {
			await harness.cleanup();
		}
	},
);

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

/** Collect what the host reports, as the chat shows it, and every rejection nothing handled. */
function watchFailures(host: Awaited<ReturnType<typeof hostOf>>) {
	const shown: string[] = [];
	host.runtime.onDiagnostic((d) =>
		renderEngineDiagnostic(d, {
			stopWorkingLoader: () => {},
			showError: (m) => shown.push(m),
			showStatus: (m) => shown.push(`status: ${m}`),
		}),
	);
	const unhandled: unknown[] = [];
	const record = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", record);
	return { shown, unhandled, stop: () => process.off("unhandledRejection", record) };
}

test("a host listener that throws while a compaction's held events are released is reported, and the rest still arrive (#6107)", async () => {
	const harness = await createHarness();
	const host = await hostOf(harness);
	const failures = watchFailures(host);
	try {
		host.session.subscribe((e) => {
			if (e.type === "message_start")
				throw new Error(`could not draw ${(e.message as { content: string }).content}`);
		});
		const later: string[] = [];
		host.session.subscribe((e) => later.push(e.type));
		host.emit(compactionEnd(true));
		host.emit(user("after"));
		host.emit(user("last"));

		host.refreshes[0]!.resolve();
		await new Promise<void>((r) => setImmediate(r));

		assert.deepEqual(host.seen, ["compaction_end", "message_start:after", "message_start:last"]);
		assert.deepEqual(later, ["compaction_end", "message_start", "message_start"]);
		assert.deepEqual(failures.shown, [
			`Atomic failed while handling the interactive engine's "message_start" event: could not draw after`,
			`Atomic failed while handling the interactive engine's "message_start" event: could not draw last`,
		]);
		assert.deepEqual(failures.unhandled, []);
		assert.equal(host.runtime.interruptBlockedCallback(), false, "the engine is not treated as blocked");
	} finally {
		failures.stop();
		await harness.cleanup();
	}
});

test("a host listener's rejected promise is reported once, not left unhandled (#6107)", async () => {
	const harness = await createHarness();
	const host = await hostOf(harness);
	const failures = watchFailures(host);
	try {
		host.session.subscribe(async (e) => {
			if (e.type === "message_start")
				throw new Error(`could not draw ${(e.message as { content: string }).content}`);
		});

		host.emit(user("one"));
		host.emit(user("two"));
		await new Promise<void>((r) => setImmediate(r));

		assert.deepEqual(host.seen, ["message_start:one", "message_start:two"]);
		assert.deepEqual(failures.shown, [
			`Atomic failed while handling the interactive engine's "message_start" event: could not draw one`,
			`Atomic failed while handling the interactive engine's "message_start" event: could not draw two`,
		]);
		assert.deepEqual(failures.unhandled, []);
	} finally {
		failures.stop();
		await harness.cleanup();
	}
});
