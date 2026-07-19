import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import {
  SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
  SUBAGENT_RESULT_INTERCOM_EVENT,
} from "../../packages/intercom/intercom-utils.js";
import { registerSubagentRelay } from "../../packages/intercom/subagent-relay.js";
import { rejectLazyResultRelay } from "../../packages/intercom/lazy-subagent-ack.js";

interface RelayHarnessOptions {
  liveChecks: boolean[];
	local?: boolean;
	localMatches?: boolean[];
	localFailures?: number;
	runtimeStarted?: boolean;
	ownerGroup?: string;
}

function createRelayHarness(options: RelayHarnessOptions) {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const deliveries: Array<{ requestId?: string; delivered?: boolean; error?: string }> = [];
  const errorEntries: Array<{ type: string; error?: string }> = [];
  let ensureConnectedCalls = 0;
  let sendCalls = 0;
  let localDeliveries = 0;
	let localMatchIndex = 0;
	let liveCheckIndex = 0;
	const sentMessageIds: Array<string | undefined> = [];
	const localEntries: Array<{ from: { group?: string } }> = [];
	const client = {
		async send(_target: string, input: { messageId?: string }) {
			sendCalls += 1;
			sentMessageIds.push(input.messageId);
			return { delivered: true };
		},
	} as never;
  const pi = {
    appendEntry(type: string, data: { error?: string }) { errorEntries.push({ type, error: data.error }); },
    events: {
      on(event: string, handler: (payload: unknown) => void) {
        const handlers = listeners.get(event) ?? [];
        handlers.push(handler);
        listeners.set(event, handlers);
        return () => {
          const index = handlers.indexOf(handler);
          if (index >= 0) handlers.splice(index, 1);
        };
      },
      emit(event: string, payload: unknown) {
        if (event === SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) {
          deliveries.push(payload as { requestId?: string; delivered?: boolean });
        }
        for (const handler of listeners.get(event) ?? []) handler(payload);
      },
    },
  };
  const context = { cwd: "/tmp" } as ExtensionContext;

  registerSubagentRelay(pi as never, {
    runtimeGeneration: () => 1,
    runtimeStarted: () => options.runtimeStarted ?? true,
    runtimeContext: () => context,
    getLiveContext: () => options.liveChecks[liveCheckIndex++] ? context : null,
    currentSessionTargetMatches: () => options.localMatches?.[localMatchIndex++] ?? options.local ?? false,
    sendIncomingMessage: (entry: { from: { group?: string } }) => {
		localEntries.push(entry);
		localDeliveries += 1;
		if (localDeliveries <= (options.localFailures ?? 0)) throw new Error("local send failed");
	},
    ensureConnected: async () => {
      ensureConnectedCalls += 1;
      return client;
    },
    resolveSessionTarget: async () => "resolved-target",
    homeGroup: () => options.ownerGroup ?? "default",
  });

  return {
    deliveries,
    errorEntries,
    emitResult(overrides: { to?: string; message?: string; requestId?: string } = {}) {
      pi.events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, {
        to: overrides.to ?? "target",
        message: overrides.message ?? "done",
        requestId: overrides.requestId ?? "request-1",
      });
    },
		counts: () => ({ ensureConnectedCalls, sendCalls, localDeliveries }),
		sentMessageIds,
		localEntries,
  };
}

async function settleRelay(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("subagent result relay lifecycle acknowledgements", () => {
  test("negatively acknowledges once when the relay is retired before connecting", async () => {
    const harness = createRelayHarness({ liveChecks: [false] });

    harness.emitResult();
    await settleRelay();

    assert.deepEqual(harness.deliveries, [{ requestId: "request-1", delivered: false }]);
    assert.deepEqual(harness.counts(), { ensureConnectedCalls: 0, sendCalls: 0, localDeliveries: 0 });
  });

  test("negatively acknowledges once when the relay retires while connecting", async () => {
    const harness = createRelayHarness({ liveChecks: [true, false] });

    harness.emitResult();
    await settleRelay();

    assert.deepEqual(harness.deliveries, [{ requestId: "request-1", delivered: false }]);
    assert.deepEqual(harness.counts(), { ensureConnectedCalls: 1, sendCalls: 0, localDeliveries: 0 });
  });

  test("acknowledges the completed send once if the relay retires after its side effect", async () => {
    const harness = createRelayHarness({ liveChecks: [true, true, false] });

    harness.emitResult();
    await settleRelay();

    assert.deepEqual(harness.deliveries, [{ requestId: "request-1", delivered: true }]);
    assert.deepEqual(harness.counts(), { ensureConnectedCalls: 1, sendCalls: 1, localDeliveries: 0 });
  });

	test("passes the stable completion request id to the broker as messageId", async () => {
		const harness = createRelayHarness({ liveChecks: [true, true, true] });
		harness.emitResult();
		await settleRelay();
		assert.deepEqual(harness.sentMessageIds, ["request-1"]);
	});

	test("lazy relay initialization failure emits a definitive negative acknowledgement", () => {
		const emitted: unknown[] = [];
		const pi = { events: { emit: (_event: string, payload: unknown) => emitted.push(payload) } } as never;
		rejectLazyResultRelay(pi, SUBAGENT_RESULT_INTERCOM_EVENT, { requestId: "lazy-request" }, new Error("retired"));
		assert.deepEqual(emitted, [{ requestId: "lazy-request", delivered: false, error: "retired" }]);
	});

	test("acknowledges duplicate local completion request ids without forwarding twice", async () => {
		const harness = createRelayHarness({ liveChecks: [true, true], local: true });
		harness.emitResult();
		harness.emitResult();
		await settleRelay();
		assert.equal(harness.counts().localDeliveries, 1);
		assert.deepEqual(harness.deliveries, [
			{ requestId: "request-1", delivered: true },
			{ requestId: "request-1", delivered: true },
		]);
	});


	test("rejects conflicting local request-id reuse without forwarding the new payload", async () => {
		const harness = createRelayHarness({ liveChecks: [true, true], local: true });
		harness.emitResult();
		harness.emitResult({ message: "different" });
		await settleRelay();
		assert.equal(harness.counts().localDeliveries, 1);
		assert.deepEqual(harness.deliveries.map((entry) => entry.delivered), [true, false]);
	});

	test("local result handoffs carry the relay owner group", async () => {
		const harness = createRelayHarness({ liveChecks: [true], local: true, ownerGroup: "reviewers" });
		harness.emitResult();
		await settleRelay();
		assert.equal(harness.localEntries[0]?.from.group, "reviewers");
	});

	test("local delivered-id caches are isolated per relay session", async () => {
		const first = createRelayHarness({ liveChecks: [true], local: true });
		const second = createRelayHarness({ liveChecks: [true], local: true });
		first.emitResult();
		second.emitResult();
		await settleRelay();
		assert.equal(first.counts().localDeliveries, 1);
		assert.equal(second.counts().localDeliveries, 1);
	});
	test("negatively acknowledges a local failure without an unhandled rejection and can retry", async () => {
		const harness = createRelayHarness({ liveChecks: [true, true], local: true, localFailures: 1 });
		harness.emitResult();
		await settleRelay();
		harness.emitResult();
		await settleRelay();
		assert.equal(harness.counts().localDeliveries, 2);
		assert.deepEqual(harness.deliveries, [
			{ requestId: "request-1", delivered: false, error: "local send failed" },
			{ requestId: "request-1", delivered: true },
		]);
	});

	test("guards local delivery after target resolution too", async () => {
		const harness = createRelayHarness({
			liveChecks: [true, true, true, true],
			localMatches: [false, true, false, true],
			localFailures: 1,
		});
		harness.emitResult();
		await settleRelay();
		harness.emitResult();
		await settleRelay();
		assert.equal(harness.counts().ensureConnectedCalls, 2);
		assert.deepEqual(harness.deliveries.map((entry) => entry.delivered), [false, true]);
	});

	test("delivers locally when the runtime never started but the target matches this session", async () => {
		const harness = createRelayHarness({ liveChecks: [false, false], runtimeStarted: false, local: true });
		harness.emitResult();
		await settleRelay();
		assert.equal(harness.counts().localDeliveries, 1);
		assert.deepEqual(harness.deliveries, [{ requestId: "request-1", delivered: true }]);
		assert.deepEqual(harness.errorEntries, []);
	});

	test("acknowledges quietly when the runtime never started and the target is remote", async () => {
		const harness = createRelayHarness({ liveChecks: [false, false], runtimeStarted: false, local: false });
		harness.emitResult();
		await settleRelay();
		assert.deepEqual(harness.deliveries, [
			{ requestId: "request-1", delivered: false, error: "Intercom runtime not initialized" },
		]);
		assert.equal(harness.counts().ensureConnectedCalls, 0, "an uninitialized runtime never attempts a broker connection");
		assert.deepEqual(harness.errorEntries, [], "no misleading connection-error entries are recorded");
	});
});
