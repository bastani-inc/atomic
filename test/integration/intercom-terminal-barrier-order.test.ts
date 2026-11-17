import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { test, vi } from "vitest";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import {
	type InboundMessageEntry,
	SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT,
} from "../../packages/intercom/intercom-utils.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

type Inbound = (ctx: ExtensionContext, from: SessionInfo, message: Message) => void | Promise<void>;

function session(id: string): SessionInfo {
	return { id, name: id, cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 };
}

const sleep = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

/**
 * A parent session whose writes take `writeDelayMs`, recording the order writes start: a slow write keeps its message's
 * admission in the line while a child finishes.
 */
function parent(writeDelayMs: (id: string) => number) {
	const lifecycle = new Map<string, Array<(event: object, ctx: ExtensionContext) => void | Promise<void>>>();
	const eventHandlers = new Map<string, Array<(event: object) => unknown>>();
	const written: string[] = [];
	const state = { idle: true };
	let inbound!: Inbound;
	const pi = {
		on(name: string, handler: (event: object, ctx: ExtensionContext) => void | Promise<void>) {
			lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		async appendEntry() {},
		getSessionName: () => undefined,
		registerMessageRenderer() {},
		async sendMessage(message: { content: string; details: InboundMessageEntry }) {
			const id = message.details.message.id;
			written.push(id);
			await sleep(writeDelayMs(id));
		},
		async sendMessages(messages: Array<{ content: string; details: InboundMessageEntry }>) {
			for (const message of messages) written.push(message.details.message.id);
		},
		events: {
			on(name: string, handler: (event: object) => unknown) {
				eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
				return () => {};
			},
			emit(name: string, event: object) {
				for (const handler of eventHandlers.get(name) ?? []) handler(event);
			},
		},
	};
	intercomHeavy(pi as never, {
		captureInboundHandler: (handler) => {
			inbound = handler;
		},
	});
	const context = {
		hasUI: true,
		cwd: process.cwd(),
		model: { id: "test" },
		isIdle: () => state.idle,
		getAgentTaskHost: () => ({ hasActiveTaskWaits: false }),
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "parent-session", getBranch: () => [] },
	} as unknown as ExtensionContext;
	return {
		state,
		written,
		async emit(name: string) {
			for (const handler of lifecycle.get(name) ?? []) await handler({ type: name }, context);
		},
		deliver(from: SessionInfo, id: string) {
			return inbound(context, from, { id, timestamp: Date.now(), content: { text: id } });
		},
		/** The child `target` finished: its completion notice goes out behind what it already sent. */
		finish(target: string): Promise<void> {
			const event = {
				runId: "run-1",
				terminalAt: Date.now() + 10_000,
				source: "detached-notify" as const,
				sourceSessionTargets: [target],
				completion: undefined as Promise<void> | undefined,
				dispatch: (prefix: Array<{ details: InboundMessageEntry }>) => {
					for (const message of prefix) written.push(message.details.message.id);
					written.push("COMPLETION-NOTICE");
					return Promise.resolve();
				},
			};
			pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, event);
			assert.ok(event.completion, "the barrier owns the terminal from the moment it fires");
			return event.completion;
		},
	};
}

test("a finished child's completion notice follows its message still being admitted", async () => {
	const current = parent(() => 80);
	await current.emit("session_start");
	try {
		const child = session("worker");
		current.state.idle = false;
		await current.deliver(child, "m1");
		current.state.idle = true;
		const second = current.deliver(child, "m2");
		await sleep(10);
		const notice = current.finish("worker");
		await Promise.all([second, notice]);
		await vi.waitFor(() => assert.deepEqual(current.written, ["m1", "m2", "COMPLETION-NOTICE"]));
	} finally {
		await current.emit("session_shutdown");
	}
});

test("a finished child's completion notice follows its message waiting behind another sender's admission", async () => {
	const current = parent((id) => (id === "peer-1" ? 150 : 0));
	await current.emit("session_start");
	try {
		const peerMessage = current.deliver(session("peer"), "peer-1");
		await sleep(10);
		const childMessage = current.deliver(session("worker"), "m2");
		await sleep(10);
		const notice = current.finish("worker");
		await Promise.all([peerMessage, childMessage, notice]);
		await vi.waitFor(() => assert.deepEqual(current.written, ["peer-1", "m2", "COMPLETION-NOTICE"]));
	} finally {
		await current.emit("session_shutdown");
	}
});
