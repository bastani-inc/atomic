import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterAll, afterEach, describe, test } from "vitest";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.ts";
import {
	BACKGROUND_SESSION_COUNT,
	createGate,
	createRig,
	DUPLICATE_DELIVERY_SETTLE_MS,
	type Gate,
	gateOnce,
	holdTool,
	hookGate,
	isIdleAfterAnswering,
	isVisible,
	type Load,
	RETRY_BACKOFF_MS,
	type Rig,
	type RigOptions,
	releaseOpenGates,
	sleep,
	startBackgroundSessions,
	type Wiring,
} from "./helpers/busy-submission-rig.ts";
import { getMessageText, getUserTexts } from "./suite/harness.ts";

const RECORD_BACKGROUND_SESSIONS = Number(process.env.ATOMIC_BUSY_RECORD_SESSIONS ?? BACKGROUND_SESSION_COUNT);
const RECORD_OUTPUT_PATH = process.env.ATOMIC_BUSY_RECORD_OUT;
const BOUNDARY_WAIT_MS = 5_000;
const DELIVERY_WINDOW_MS = 5_000;
const SAMPLE_INTERVAL_MS = 1;
const BACKGROUND_STARTUP_TIMEOUT_MS = 120_000;
const FALLBACK_MODEL_ID = "record-fallback";
const BOUNDARY_HOLD_MS = 300;
const RUN_TAIL_MS = 300;

interface TrackedMessage {
	text: string;
	submittedAt?: number;
	shownAt?: number;
	queuedAt?: number;
	deliveredAt?: number;
	releasedAt?: number;
}

interface RecordRow {
	config: string;
	state: string;
	message: string;
	shown: boolean;
	queued: boolean;
	delivered: number;
	inOrder: boolean;
	shownMs?: number;
	latencyMs?: number;
	afterReleaseMs?: number;
	notices: string[];
	note: string;
}

interface ScenarioContext {
	rig: Rig;
	wiring: Wiring;
	gate: Gate;
	submit: (text: string) => Promise<void>;
	waitUntil: (predicate: () => boolean) => Promise<boolean>;
	release: () => Promise<void>;
}

interface Scenario {
	state: string;
	expected: string[];
	options: (gate: Gate) => RigOptions;
	responses: (gate: Gate) => FauxResponseStep[];
	run: (context: ScenarioContext) => Promise<void>;
	setup?: (rig: Rig) => void;
	note?: (rig: Rig) => string;
}

const reply = (text: string) => fauxAssistantMessage(text);
const slowReply = (text: string) => async () => {
	await sleep(RUN_TAIL_MS);
	return reply(text);
};
const toolCallReply = () => fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" });
const spareReplies = (count: number) => Array.from({ length: count }, (_, index) => reply(`spare reply ${index + 1}`));
const runWithTail = () => [toolCallReply(), slowReply("final answer"), ...spareReplies(3)];

async function waitForHostIdle(context: ScenarioContext): Promise<void> {
	if (context.wiring === "isolated") await context.waitUntil(() => context.rig.host.onInputCallback !== undefined);
}

async function promptThenSubmitAtGate(context: ScenarioContext, text: string, hostIdle = false): Promise<void> {
	await context.submit("P1");
	await context.gate.entered.promise;
	if (hostIdle) await waitForHostIdle(context);
	await context.submit(text);
	await context.release();
}

const SCENARIOS: Scenario[] = [
	{
		state: "idle",
		expected: ["M-idle"],
		options: () => ({}),
		responses: () => [reply("idle answer"), ...spareReplies(2)],
		run: async ({ submit }) => {
			await submit("M-idle");
		},
	},
	{
		state: "preparation (before_agent_start)",
		expected: ["P1", "M-prep"],
		options: (gate) => ({ extensions: [hookGate("before_agent_start", gate)], tools: [holdTool()] }),
		responses: runWithTail,
		run: (context) => promptThenSubmitAtGate(context, "M-prep"),
	},
	{
		state: "same tick as the prompt",
		expected: ["P1", "M-tick"],
		options: () => ({ tools: [holdTool()] }),
		responses: runWithTail,
		run: async ({ submit }) => {
			await Promise.all([submit("P1"), submit("M-tick")]);
		},
	},
	{
		state: "pre-agent_start / stale host mirror",
		expected: ["P1", "M-stale"],
		options: (gate) => ({ extensions: [hookGate("agent_start", gate)], tools: [holdTool()] }),
		responses: runWithTail,
		run: (context) => promptThenSubmitAtGate(context, "M-stale", true),
	},
	{
		state: "mid-stream",
		expected: ["P1", "M-stream"],
		options: () => ({ tools: [holdTool()] }),
		responses: (gate) => {
			const hold = gateOnce(gate);
			return [
				async () => {
					await hold();
					return toolCallReply();
				},
				slowReply("final answer"),
				...spareReplies(3),
			];
		},
		run: (context) => promptThenSubmitAtGate(context, "M-stream"),
	},
	{
		state: "tool in flight",
		expected: ["P1", "M-tool"],
		options: (gate) => ({ tools: [holdTool(gate)] }),
		responses: runWithTail,
		run: (context) => promptThenSubmitAtGate(context, "M-tool"),
	},
	{
		state: "auto-retry backoff",
		expected: ["P1", "M-retry"],
		options: () => ({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: RETRY_BACKOFF_MS } } }),
		responses: () => [
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			reply("recovered"),
			...spareReplies(3),
		],
		run: async ({ rig, submit, waitUntil }) => {
			let retrying = false;
			rig.engine.session.subscribe((event) => {
				if (event.type === "auto_retry_start") retrying = true;
			});
			await submit("P1");
			await waitUntil(() => retrying);
			await submit("M-retry");
		},
	},
	{
		state: "model fallback switch",
		expected: ["P1", "M-fallback"],
		options: () => ({
			models: [{ id: "record-primary" }, { id: FALLBACK_MODEL_ID }],
			settings: { retry: { enabled: true, maxRetries: 0, baseDelayMs: RETRY_BACKOFF_MS } },
		}),
		setup: (rig) => {
			const session = rig.engine.session as typeof rig.engine.session &
				Pick<AgentSessionInternalSurface, "_fallbackModels">;
			session._fallbackModels = [`faux/${FALLBACK_MODEL_ID}`];
		},
		responses: () => [
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			slowReply("fallback answer"),
			...spareReplies(3),
		],
		run: async ({ rig, submit, waitUntil }) => {
			let failed = false;
			rig.engine.session.subscribe((event) => {
				if (
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.stopReason === "error"
				)
					failed = true;
			});
			await submit("P1");
			await waitUntil(() => failed);
			await submit("M-fallback");
		},
		note: (rig) =>
			rig.engine.session.model?.id === FALLBACK_MODEL_ID
				? "fallback model answered"
				: `fallback not triggered (model ${rig.engine.session.model?.id})`,
	},
	{
		state: "after agent_end, agent_settled handlers running",
		expected: ["P1", "M-settled"],
		options: (gate) => ({ extensions: [hookGate("agent_settled", gate)] }),
		responses: () => [reply("first answer"), ...spareReplies(3)],
		run: (context) => promptThenSubmitAtGate(context, "M-settled", true),
	},
	{
		state: "compaction queue tail",
		expected: ["C1", "C2", "C3"],
		options: () => ({}),
		responses: () => spareReplies(6),
		run: async ({ rig, submit }) => {
			rig.host.compactionQueuedMessages = [
				{ text: "C1", mode: "steer" },
				{ text: "C2", mode: "steer" },
				{ text: "C3", mode: "followUp" },
			];
			rig.host.updatePendingMessagesDisplay();
			for (const text of ["C1", "C2", "C3"]) await submit(`@held:${text}`);
			await rig.host.flushCompactionQueue({ willRetry: false });
		},
	},
	{
		state: "paused after Escape",
		expected: ["P1", "M-paused"],
		options: (gate) => ({ tools: [holdTool(gate)] }),
		responses: runWithTail,
		run: async ({ rig, submit, gate, waitUntil }) => {
			await submit("P1");
			await gate.entered.promise;
			rig.host.defaultEditor.onEscape?.();
			gate.release.resolve();
			await waitUntil(() => !rig.engine.session.isStreaming);
			await submit("M-paused");
		},
	},
];

const rows: RecordRow[] = [];
const loopDelay = new Map<string, { p99Ms: number; maxMs: number }>();

function sampleMessage(rig: Rig, message: TrackedMessage, now: number): void {
	if (message.submittedAt === undefined || message.deliveredAt !== undefined) return;
	const { host, engine } = rig;
	if (message.shownAt === undefined && isVisible(host, message.text)) message.shownAt = now;
	const queued =
		host.getAllQueuedMessages().steering.includes(message.text) ||
		host.getAllQueuedMessages().followUp.includes(message.text) ||
		engine.session.getSteeringMessages().includes(message.text) ||
		engine.session.getFollowUpMessages().includes(message.text);
	if (message.queuedAt === undefined && queued) message.queuedAt = now;
}

async function recordScenario(wiring: Wiring, load: Load, scenario: Scenario): Promise<RecordRow[]> {
	const gate = createGate();
	const rig = await createRig(wiring, load, {
		...scenario.options(gate),
		backgroundSessions: 0,
		stallEventLoop: load === "loaded",
	});
	try {
		scenario.setup?.(rig);
		rig.engine.setResponses(scenario.responses(gate));
		const tracked = new Map(scenario.expected.map((text) => [text, { text } as TrackedMessage]));
		const sampleAll = () => {
			const now = performance.now();
			for (const message of tracked.values()) sampleMessage(rig, message, now);
		};
		rig.engine.session.subscribe((event) => {
			if (event.type !== "message_start" || event.message.role !== "user") return;
			const message = tracked.get(getMessageText(event.message));
			if (!message || message.deliveredAt !== undefined) return;
			message.deliveredAt = performance.now();
		});
		const sampler = setInterval(sampleAll, SAMPLE_INTERVAL_MS);
		const waitUntil = async (predicate: () => boolean): Promise<boolean> => {
			const deadline = performance.now() + BOUNDARY_WAIT_MS;
			while (!predicate()) {
				if (performance.now() > deadline) return false;
				await sleep(SAMPLE_INTERVAL_MS);
			}
			return true;
		};
		const submit = async (text: string): Promise<void> => {
			const heldText = text.startsWith("@held:") ? text.slice("@held:".length) : undefined;
			const message = tracked.get(heldText ?? text);
			if (message) message.submittedAt = performance.now();
			if (heldText === undefined) await rig.host.defaultEditor.onSubmit?.(text);
			if (message && message.shownAt === undefined && message.deliveredAt !== undefined)
				message.shownAt = message.deliveredAt;
			sampleAll();
		};
		const release = async (): Promise<void> => {
			await sleep(BOUNDARY_HOLD_MS);
			const now = performance.now();
			for (const message of tracked.values()) message.releasedAt ??= now;
			gate.release.resolve();
		};
		try {
			await scenario.run({ rig, wiring, gate, submit, waitUntil, release });
			const deadline = performance.now() + DELIVERY_WINDOW_MS;
			while (
				performance.now() < deadline &&
				!(
					[...tracked.values()].every((message) => message.deliveredAt !== undefined) &&
					isIdleAfterAnswering(rig.engine)
				)
			) {
				await sleep(SAMPLE_INTERVAL_MS);
			}
			gate.release.resolve();
			await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
		} finally {
			clearInterval(sampler);
		}
		const users = getUserTexts(rig.engine);
		const positions = scenario.expected.map((text) => users.indexOf(text));
		const inOrder = positions.every(
			(position, index) => position >= 0 && (index === 0 || position > positions[index - 1]),
		);
		const note = scenario.note?.(rig) ?? "";
		return [...tracked.values()].map((message) => ({
			config: `${wiring}/${load}`,
			state: scenario.state,
			message: message.text,
			shown: message.shownAt !== undefined,
			queued: message.queuedAt !== undefined,
			delivered: users.filter((text) => text === message.text).length,
			inOrder,
			shownMs:
				message.shownAt !== undefined && message.submittedAt !== undefined
					? Math.round(message.shownAt - message.submittedAt)
					: undefined,
			latencyMs:
				message.deliveredAt !== undefined && message.submittedAt !== undefined
					? Math.round(message.deliveredAt - message.submittedAt)
					: undefined,
			afterReleaseMs:
				message.deliveredAt !== undefined && message.releasedAt !== undefined
					? Math.round(message.deliveredAt - message.releasedAt)
					: undefined,
			notices: [...rig.host.notices],
			note,
		}));
	} finally {
		gate.release.resolve();
		await rig.stop();
	}
}

function renderTable(): string {
	const header =
		"| Config | State | Message | Shown before delivery | Queued | Delivered | In order | Shown after submit (ms) | Delivered after submit (ms) | Delivered after boundary release (ms) | Notices | Note |\n" +
		"|---|---|---|---|---|---|---|---|---|---|---|---|";
	const body = rows.map((row) =>
		[
			row.config,
			row.state,
			row.message,
			row.shown ? "yes" : "NO",
			row.queued ? "yes" : "no",
			row.delivered === 1 ? "once" : row.delivered === 0 ? "NEVER" : `${row.delivered}x`,
			row.inOrder ? "yes" : "NO",
			row.shownMs ?? "-",
			row.latencyMs ?? "never",
			row.afterReleaseMs ?? "-",
			row.notices.join("; ").replaceAll("|", "/") || "-",
			row.note || "-",
		].join(" | "),
	);
	const delays = [...loopDelay.entries()].map(
		([config, delay]) => `- ${config}: event-loop delay p99 ${delay.p99Ms} ms, max ${delay.maxMs} ms`,
	);
	return [
		`Background sessions: ${RECORD_BACKGROUND_SESSIONS} (loaded configs only), event-loop stalls on loaded configs.`,
		"",
		...delays,
		"",
		header,
		...body.map((line) => `| ${line} |`),
	].join("\n");
}

afterAll(() => {
	if (RECORD_OUTPUT_PATH) writeFileSync(RECORD_OUTPUT_PATH, `${renderTable()}\n`);
});

describe.each([
	["local", "quiet"],
	["local", "loaded"],
	["isolated", "quiet"],
	["isolated", "loaded"],
] as const)("per-message record, %s host, %s process", (wiring, load) => {
	let stopBackground: (() => Promise<void>) | undefined;
	const delay = monitorEventLoopDelay({ resolution: 1 });
	afterEach(() => {
		releaseOpenGates();
	});
	afterAll(async () => {
		delay.disable();
		loopDelay.set(`${wiring}/${load}`, {
			p99Ms: Math.round(delay.percentile(99) / 1e6),
			maxMs: Math.round(delay.max / 1e6),
		});
		await stopBackground?.();
	});

	test(
		"starts the background sessions",
		async () => {
			if (load === "loaded") stopBackground = await startBackgroundSessions(RECORD_BACKGROUND_SESSIONS);
			delay.enable();
		},
		BACKGROUND_STARTUP_TIMEOUT_MS,
	);

	test.each(SCENARIOS.map((scenario) => [scenario.state, scenario] as const))(
		"%s: every message is shown, delivered exactly once and in order",
		async (_state, scenario) => {
			const recorded = await recordScenario(wiring, load, scenario);
			rows.push(...recorded);
			for (const row of recorded) {
				assert.equal(row.shown, true, `${row.message} was never shown`);
				assert.equal(row.delivered, 1, `${row.message} was not delivered exactly once`);
				assert.equal(row.inOrder, true, `${row.message} was delivered out of order`);
				assert.deepEqual(row.notices, [], `${row.message} produced a notice`);
			}
		},
	);
});
