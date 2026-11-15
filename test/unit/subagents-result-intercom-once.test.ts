import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { test, vi } from "vitest";
import {
	parseSubagentIntercomPayload,
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
} from "../../packages/intercom/intercom-utils.js";
import { registerSubagentRelay } from "../../packages/intercom/subagent-relay.js";
import {
	deliverSubagentIntercomMessageEvent,
	RESULT_RELAY_COMMITTED_TIMEOUT_MS,
} from "../../packages/subagents/src/intercom/result-intercom.js";
import { maybeBuildForegroundIntercomReceipt } from "../../packages/subagents/src/runs/foreground/subagent-executor-status.js";
import type { Details } from "../../packages/subagents/src/shared/types.js";
import { sleep } from "../helpers/runtime.js";

/** The foreground emitter's own wait before it decides how to return the result. */
const RELAY_ACK_THRESHOLD_MS = 500;
const SLOW_MS = RELAY_ACK_THRESHOLD_MS + 300;
const FAST_MS = 20;

interface OrchestratorOptions {
	/** How long the orchestrator's local append of the relayed message takes. */
	localMs?: number;
	/** How long the relay's broker connection takes before it can route the result. */
	connectMs?: number;
	/** The broker send hands the message over, then fails as if its connection dropped. */
	sendDropsAfterHandoff?: boolean;
	/** The connected broker resolves the orchestrator target to this session, so the relay delivers locally. */
	resolvesToSelf?: boolean;
}

/** The real foreground result emitter wired to the real Intercom relay of the orchestrator session. */
async function runForegroundResult(options: OrchestratorOptions) {
	const listeners = new Map<string, Array<(payload: unknown) => void>>();
	const inbox: string[] = [];
	const acknowledged = Promise.withResolvers<{ delivered?: boolean }>();
	const local = options.connectMs === undefined && !options.sendDropsAfterHandoff;
	const pi = {
		async appendEntry() {},
		getSessionName: () => "orchestrator",
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
				if (event === SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT)
					acknowledged.resolve(payload as { delivered?: boolean });
				for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
			},
		},
	};
	const context = { cwd: "/tmp" } as ExtensionContext;
	const client = {
		async send(_target: string, input: { text: string }) {
			inbox.push(input.text);
			if (options.sendDropsAfterHandoff) throw new Error("connection dropped before the broker replied");
			return { delivered: true };
		},
	} as never;
	registerSubagentRelay(
		pi as never,
		{
			runtimeGeneration: () => 1,
			runtimeStarted: () => true,
			runtimeContext: () => context,
			getLiveContext: () => context,
			currentSessionTargetMatches: (_to: string, resolvedTo?: string | null) =>
				local || (options.resolvesToSelf === true && resolvedTo !== undefined),
			sendIncomingMessage: async (entry: { bodyText: string }) => {
				await sleep(options.localMs ?? 0);
				inbox.push(entry.bodyText);
			},
			ensureConnected: async () => {
				await sleep(options.connectMs ?? 0);
				return client;
			},
			resolveSessionTarget: async () => "orchestrator-id",
			homeGroup: () => "default",
		} as never,
	);

	const details = {
		mode: "single",
		results: [
			{
				agent: "worker",
				task: "t",
				exitCode: 0,
				status: "ok",
				messages: [],
				usage: {},
				finalOutput: "THE FULL RESULT",
			},
		],
	} as unknown as Details;
	const receipt = await maybeBuildForegroundIntercomReceipt({
		pi: pi as never,
		intercomBridge: {
			active: true,
			mode: "always",
			orchestratorTarget: "orchestrator",
			extensionDir: "",
			instruction: "",
		},
		runId: "run-5018",
		mode: "single",
		details,
	});
	const ack = await acknowledged.promise;
	const inline = receipt === null ? 1 : 0;
	return { receipt, ack, inline, intercom: inbox.length, total: inline + inbox.length };
}

test("a result relay acknowledged after 500 ms reaches the orchestrator exactly once (#5018)", async () => {
	const outcome = await runForegroundResult({ localMs: SLOW_MS });
	assert.equal(outcome.total, 1, `inline=${outcome.inline} intercom=${outcome.intercom}`);
	assert.match(outcome.receipt?.text ?? "", /^Delivered single subagent result via intercom\./);
});

test("a result relay still connecting after 500 ms reaches the orchestrator exactly once (#5018)", async () => {
	const outcome = await runForegroundResult({ connectMs: SLOW_MS });
	assert.equal(outcome.total, 1, `inline=${outcome.inline} intercom=${outcome.intercom}`);
	assert.equal(outcome.inline, 1);
	assert.equal(outcome.ack.delivered, false);
});

test("a slow relay that resolves the orchestrator to this session drops the late result (#5018)", async () => {
	const outcome = await runForegroundResult({ connectMs: SLOW_MS, resolvesToSelf: true });
	assert.equal(outcome.total, 1, `inline=${outcome.inline} intercom=${outcome.intercom}`);
	assert.equal(outcome.inline, 1);
	assert.equal(outcome.ack.delivered, false);
});

test("an unconfirmed result relay reaches the orchestrator exactly once (#5018)", async () => {
	const outcome = await runForegroundResult({ connectMs: 0, sendDropsAfterHandoff: true });
	assert.equal(outcome.total, 1, `inline=${outcome.inline} intercom=${outcome.intercom}`);
	assert.match(outcome.receipt?.text ?? "", /^Sent single subagent result via intercom; delivery was not confirmed\./);
	assert.match(
		outcome.receipt?.text ?? "",
		/Full grouped output was sent over intercom; if it does not arrive, read the artifacts or sessions above\.$/,
	);
});

test("a result relay acknowledged within 500 ms is still delivered over intercom with a receipt (#5018)", async () => {
	const outcome = await runForegroundResult({ localMs: FAST_MS });
	assert.equal(outcome.intercom, 1);
	assert.equal(outcome.inline, 0);
	assert.match(outcome.receipt?.text ?? "", /^Delivered single subagent result via intercom\./);
});

/** An event bus whose relay is scripted by the test instead of the real Intercom relay. */
function scriptedRelay(
	onRelay: (payload: { requestId: string; claimDelivery: () => boolean }, ack: (data: object) => void) => void,
) {
	const listeners = new Map<string, Array<(payload: unknown) => void>>();
	const emit = (event: string, payload: unknown) => {
		if (event === SUBAGENT_RESULT_INTERCOM_EVENT) {
			onRelay(payload as { requestId: string; claimDelivery: () => boolean }, (data) =>
				emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, data),
			);
			return;
		}
		for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
	};
	return {
		on(event: string, handler: (payload: unknown) => void) {
			const handlers = listeners.get(event) ?? [];
			handlers.push(handler);
			listeners.set(event, handlers);
			return () => handlers.splice(handlers.indexOf(handler), 1);
		},
		emit,
	};
}

test("a relay's answer decides how the result was delivered (#5018)", async () => {
	for (const [answer, expected] of [
		[{ delivered: true }, "delivered"],
		[{ delivered: false, unconfirmed: true }, "unconfirmed"],
		[{ delivered: false }, "undelivered"],
	] as const) {
		const events = scriptedRelay((payload, ack) => {
			assert.equal(payload.claimDelivery(), true);
			ack({ requestId: payload.requestId, ...answer });
		});
		assert.equal(await deliverSubagentIntercomMessageEvent(events, "orchestrator", "result"), expected);
	}
});

test("a bus that cannot relay leaves the result to the caller (#5018)", async () => {
	const events = scriptedRelay(() => assert.fail("nothing is relayed"));
	assert.equal(await deliverSubagentIntercomMessageEvent({ on: events.on } as never, "o", "r"), "undelivered");
	assert.equal(await deliverSubagentIntercomMessageEvent({ emit: events.emit } as never, "o", "r"), "undelivered");
});

test("a relay that throws before claiming leaves the result inline, after claiming leaves it unconfirmed (#5018)", async () => {
	const before = scriptedRelay(() => {
		throw new Error("relay failed");
	});
	assert.equal(await deliverSubagentIntercomMessageEvent(before, "o", "r"), "undelivered");
	const after = scriptedRelay((payload) => {
		payload.claimDelivery();
		throw new Error("relay failed");
	});
	assert.equal(await deliverSubagentIntercomMessageEvent(after, "o", "r"), "unconfirmed");
});

test("a relay that claims the result but never answers reports it unconfirmed, never inline (#5018)", async () => {
	vi.useFakeTimers();
	try {
		let claim: (() => boolean) | undefined;
		const events = scriptedRelay((payload) => {
			assert.equal(payload.claimDelivery(), true);
			claim = payload.claimDelivery;
		});
		let settled: string | undefined;
		void deliverSubagentIntercomMessageEvent(events, "o", "r").then((value) => {
			settled = value;
		});
		await vi.advanceTimersByTimeAsync(RELAY_ACK_THRESHOLD_MS + 1);
		assert.equal(settled, undefined);
		assert.equal(claim?.(), true);
		await vi.advanceTimersByTimeAsync(RESULT_RELAY_COMMITTED_TIMEOUT_MS);
		assert.equal(settled, "unconfirmed");
	} finally {
		vi.useRealTimers();
	}
});

test("a relay that has not claimed the result by the deadline loses it to the inline result (#5018)", async () => {
	vi.useFakeTimers();
	try {
		let claim: (() => boolean) | undefined;
		const events = scriptedRelay((payload) => {
			claim = payload.claimDelivery;
		});
		const delivery = deliverSubagentIntercomMessageEvent(events, "o", "r");
		await vi.advanceTimersByTimeAsync(RELAY_ACK_THRESHOLD_MS);
		assert.equal(await delivery, "undelivered");
		assert.equal(claim?.(), false);
	} finally {
		vi.useRealTimers();
	}
});

test("without a deadline the caller waits for the relay however long it takes (#5018)", async () => {
	vi.useFakeTimers();
	try {
		const events = scriptedRelay(() => {});
		let settled: string | undefined;
		void deliverSubagentIntercomMessageEvent(events, "o", "r", false).then((value) => {
			settled = value;
		});
		await vi.advanceTimersByTimeAsync(RESULT_RELAY_COMMITTED_TIMEOUT_MS * 2);
		assert.equal(settled, undefined);
	} finally {
		vi.useRealTimers();
	}
});

test("only a function is taken as the sender's delivery claim (#5018)", () => {
	assert.equal(
		parseSubagentIntercomPayload({ to: "o", message: "m", claimDelivery: "yes" })?.claimDelivery,
		undefined,
	);
	const claimDelivery = () => true;
	assert.equal(parseSubagentIntercomPayload({ to: "o", message: "m", claimDelivery })?.claimDelivery, claimDelivery);
});

test("a bus that went stale before subscribing leaves the result to the caller (#5018)", async () => {
	const events = {
		on() {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
		emit: () => assert.fail("nothing is relayed"),
	};
	assert.equal(await deliverSubagentIntercomMessageEvent(events, "o", "r"), "undelivered");
});
