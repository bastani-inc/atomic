import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { type FauxModelDefinition, fauxAssistantMessage } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";
import { createEngineHostPair, type EngineHostPair } from "./in-process-engine-pair.ts";
import {
	createInteractiveSubmissionHost,
	type InteractiveSubmissionHost,
	startInteractiveInputLoop,
} from "./interactive-submission-host.ts";

export const SETTLE_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 2;
export const RETRY_BACKOFF_MS = 400;
export const BACKGROUND_SESSION_COUNT = 8;
const BACKGROUND_REPLY_DELAY_MS = 6;
const EVENT_LOOP_STALL_MS = 25;
const EVENT_LOOP_STALL_PERIOD_MS = 30;
const PIPE_LAG_MS = 20;
export const DUPLICATE_DELIVERY_SETTLE_MS = 50;

export type Wiring = "local" | "isolated";
export type Load = "quiet" | "loaded";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let stateDescriber: () => string = () => "";

export function describeState(): string {
	return stateDescriber();
}

export async function waitFor(description: string, predicate: () => boolean): Promise<void> {
	const deadline = performance.now() + SETTLE_TIMEOUT_MS;
	while (!predicate()) {
		if (performance.now() > deadline) assert.fail(`timed out waiting for ${description}; ${describeState()}`);
		await sleep(POLL_INTERVAL_MS);
	}
}

export interface Gate {
	entered: PromiseWithResolvers<void>;
	release: PromiseWithResolvers<void>;
}

const openGates: Gate[] = [];

export function createGate(): Gate {
	const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
	openGates.push(gate);
	return gate;
}

export function releaseOpenGates(): void {
	for (const gate of openGates.splice(0)) gate.release.resolve();
}

export function gateOnce(gate: Gate): () => Promise<void> {
	let armed = true;
	return async () => {
		if (!armed) return;
		armed = false;
		gate.entered.resolve();
		await gate.release.promise;
	};
}

export function hookGate(event: "before_agent_start" | "agent_start" | "agent_settled", gate: Gate): ExtensionFactory {
	const run = gateOnce(gate);
	return (pi) => {
		pi.on(event, async () => {
			await run();
		});
	};
}

export function holdTool(gate?: Gate): AgentTool {
	const run = gate ? gateOnce(gate) : async () => {};
	return {
		name: "hold",
		label: "Hold",
		description: "Holds the run open until released",
		parameters: Type.Object({}),
		execute: async () => {
			await run();
			return { content: [{ type: "text", text: "held" }], details: {} };
		},
	};
}

export function startEventLoopLoad(): () => void {
	const timer = setInterval(() => {
		const end = performance.now() + EVENT_LOOP_STALL_MS;
		while (performance.now() < end) {
			Math.sqrt(end);
		}
	}, EVENT_LOOP_STALL_PERIOD_MS);
	return () => clearInterval(timer);
}

export async function startBackgroundSessions(count: number): Promise<() => Promise<void>> {
	const sessions: Harness[] = [];
	const loops: Promise<void>[] = [];
	let stopped = false;
	for (let index = 0; index < count; index++) {
		const background = await createHarness();
		sessions.push(background);
		background.setResponses(
			Array.from({ length: 2000 }, () => async () => {
				await sleep(BACKGROUND_REPLY_DELAY_MS);
				return fauxAssistantMessage("background reply");
			}),
		);
		loops.push(
			(async () => {
				while (!stopped) await background.session.prompt("background").catch(() => {});
			})(),
		);
	}
	return async () => {
		stopped = true;
		await Promise.allSettled(loops);
		for (const background of sessions) await background.cleanup();
	};
}

export interface Rig {
	engine: Harness;
	host: InteractiveSubmissionHost;
	pair: EngineHostPair | undefined;
	stop: () => Promise<void>;
}

export interface RigOptions {
	extensions?: ExtensionFactory[];
	tools?: AgentTool[];
	settings?: Partial<Settings>;
	models?: FauxModelDefinition[];
	backgroundSessions?: number;
	stallEventLoop?: boolean;
}

export async function createRig(wiring: Wiring, load: Load, options: RigOptions): Promise<Rig> {
	const stops: Array<() => Promise<void> | void> = [];
	if (load === "loaded") {
		if (options.stallEventLoop ?? true) stops.push(startEventLoopLoad());
		const backgroundSessions = options.backgroundSessions ?? BACKGROUND_SESSION_COUNT;
		if (backgroundSessions > 0) stops.push(await startBackgroundSessions(backgroundSessions));
	}
	let engine: Harness;
	let host: InteractiveSubmissionHost;
	let pair: EngineHostPair | undefined;
	if (wiring === "isolated") {
		pair = await createEngineHostPair({
			engineExtensions: options.extensions,
			tools: options.tools,
			settings: options.settings,
			models: options.models,
		});
		if (load === "loaded") pair.setLag({ toEngineMs: PIPE_LAG_MS, toHostMs: PIPE_LAG_MS });
		engine = pair.engine;
		host = createInteractiveSubmissionHost(pair.runtime.session);
		host.runtimeHost = pair.runtime;
		stops.push(() => pair?.cleanup());
	} else {
		engine = await createHarness({
			extensionFactories: options.extensions,
			tools: options.tools,
			settings: options.settings,
			models: options.models,
		});
		host = createInteractiveSubmissionHost(engine.session);
		stops.push(() => engine.cleanup());
	}
	host.session.subscribe((event) => {
		if (event.type === "queue_update") host.updatePendingMessagesDisplay();
	});
	stateDescriber = () =>
		JSON.stringify({
			transcript: engine.session.messages.map((message) => `${message.role}:${getMessageText(message)}`),
			notices: host.notices,
			rendered: host.rendered,
			discarded: host.discarded,
			engineSteering: engine.session.getSteeringMessages(),
			held: host.compactionQueuedMessages,
			streaming: engine.session.isStreaming,
		});
	const loop = startInteractiveInputLoop(host);
	stops.push(() => loop.stop());
	return {
		engine,
		host,
		pair,
		stop: async () => {
			for (const stop of stops.reverse()) await stop();
		},
	};
}

export function isVisible(host: InteractiveSubmissionHost, text: string): boolean {
	const pending = host.pendingMessagesContainer.render(200).join("\n");
	return pending.includes(text) || (host.rendered.includes(text) && !host.discarded.includes(text));
}

export function countOf(texts: string[], text: string): number {
	return texts.filter((candidate) => candidate === text).length;
}

export function isIdleAfterAnswering(engine: Harness): boolean {
	return !engine.session.isStreaming && engine.session.messages.at(-1)?.role === "assistant";
}
