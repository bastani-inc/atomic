import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT } from "../../packages/intercom/intercom-utils.js";
import { registerSubagentRelay } from "../../packages/intercom/subagent-relay.js";
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
	const acknowledged = Promise.withResolvers<void>();
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
				if (event === SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) acknowledged.resolve();
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
	await acknowledged.promise;
	const inline = receipt === null ? 1 : 0;
	return { receipt, inline, intercom: inbox.length, total: inline + inbox.length };
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
});

test("a slow relay that resolves the orchestrator to this session drops the late result (#5018)", async () => {
	const outcome = await runForegroundResult({ connectMs: SLOW_MS, resolvesToSelf: true });
	assert.equal(outcome.total, 1, `inline=${outcome.inline} intercom=${outcome.intercom}`);
	assert.equal(outcome.inline, 1);
});

test("an unconfirmed result relay reaches the orchestrator exactly once (#5018)", async () => {
	const outcome = await runForegroundResult({ connectMs: 0, sendDropsAfterHandoff: true });
	assert.equal(outcome.total, 1, `inline=${outcome.inline} intercom=${outcome.intercom}`);
	assert.match(outcome.receipt?.text ?? "", /not confirmed/);
});

test("a result relay acknowledged within 500 ms is still delivered over intercom with a receipt (#5018)", async () => {
	const outcome = await runForegroundResult({ localMs: FAST_MS });
	assert.equal(outcome.intercom, 1);
	assert.equal(outcome.inline, 0);
	assert.match(outcome.receipt?.text ?? "", /^Delivered single subagent result via intercom\./);
});
