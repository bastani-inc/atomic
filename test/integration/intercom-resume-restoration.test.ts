import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, test } from "vitest";
import { sleep } from "../helpers/runtime.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const agentDir = mkdtempSync(join(tmpdir(), "intercom-resume-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { getBrokerPidPath } = await import("../../packages/intercom/broker/paths.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercomLightweight } = await import("../../packages/intercom/index.js");
const { SUBAGENT_AWAIT_INTERCOM_PEER_EVENT } = await import("../../packages/intercom/session-recovery.js");

/** Spawning the detached broker child is the structural cost of this real-broker suite. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const PEER_TIMEOUT_MS = 15_000;
const POLL_MS = 25;
const SUPERVISOR_AUTHORIZATION_EVENT = "subagent:supervisor-authorization";

type Handler = (event: object, ctx: object) => unknown;
type EventHandler = (payload: object) => void;

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: { delivered?: boolean; error?: boolean };
	isError?: boolean;
}

interface CapturedTool {
	name: string;
	execute: (id: string, params: object, signal: undefined, onUpdate: undefined, ctx: object) => Promise<ToolResult>;
}

function resumedParent(name: string) {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const tools = new Map<string, CapturedTool>();
	let activeTools: string[] = [];
	const history = [
		{
			type: "custom_message",
			id: "card-before-restart",
			customType: "intercom_message",
			content: "earlier",
			display: true,
			timestamp: new Date().toISOString(),
			parentId: null,
		},
	];
	const context = {
		hasUI: false,
		cwd: repoRoot,
		isIdle: () => true,
		model: { id: "test-model" },
		sessionManager: {
			getSessionId: () => "resumed-parent-session",
			getEntries: () => history,
			getBranch: () => history,
		},
		ui: { confirm: async () => true, notify() {} },
	};
	const pi = {
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
		},
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		async sendMessage() {},
		async sendMessages() {},
		getSessionName: () => name,
		setSessionName() {},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events: {
			on(eventName: string, handler: EventHandler) {
				eventHandlers.set(eventName, [...(eventHandlers.get(eventName) ?? []), handler]);
				return () => {};
			},
			emit(eventName: string, payload: object) {
				for (const handler of eventHandlers.get(eventName) ?? []) handler(payload);
			},
		},
	};
	const fire = async <T>(eventName: string, event: object): Promise<T[]> => {
		const results: T[] = [];
		for (const handler of handlers.get(eventName) ?? []) results.push((await handler(event, context)) as T);
		return results;
	};
	return {
		pi,
		fire,
		emit: (eventName: string, payload: object) => pi.events.emit(eventName, payload),
		send: async (to: string, message: string) => {
			const tool = tools.get("intercom");
			assert.ok(tool, "the intercom tool must be registered");
			return tool.execute("call", { action: "send", to, message }, undefined, undefined, context);
		},
	};
}

async function probeSessionNames(): Promise<string[]> {
	const probe = new IntercomClient(`resume-probe-${Math.random().toString(16).slice(2)}`);
	try {
		await probe.connect({
			name: "resume-probe",
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: "default",
			groups: ["default"],
		});
		return (await probe.listSessions()).map((session) => session.name ?? "");
	} finally {
		await probe.disconnect().catch(() => undefined);
	}
}

async function waitForName(name: string): Promise<void> {
	const deadline = Date.now() + PEER_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const names: string[] = await probeSessionNames().catch(() => []);
		if (names.includes(name)) return;
		await sleep(POLL_MS);
	}
	throw new Error(`${name} never registered with the broker`);
}

afterAll(() => {
	try {
		const pid = Number.parseInt(readFileSync(getBrokerPidPath(agentDir), "utf8").trim(), 10);
		if (Number.isFinite(pid) && pid > 0) process.kill(pid, "SIGKILL");
	} catch {
		// No broker was spawned, or it already exited.
	}
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	rmSync(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

test(
	"a resumed session re-registers, a restored child is reachable by its original name, and a gone peer is reported (#3760)",
	async () => {
		const parent = resumedParent("resume-parent");
		intercomLightweight(parent.pi as never);
		await parent.fire("session_start", { type: "session_start", reason: "resume" });

		await parent.fire("session_recovery_restore", { type: "session_recovery_restore", reason: "resume" });
		await waitForName("resume-parent");

		const childName = "subagent-worker-run3760-1";
		const goneName = "subagent-worker-run3760-2";
		const beforeRestore = await parent.send(childName, "are you there?");
		assert.notEqual(beforeRestore.details.delivered, true);
		assert.match(beforeRestore.content.map((part) => part.text).join("\n"), /Session not found/);

		const authorization: {
			childName: string;
			completion?: Promise<{ capability: string; supervisorSessionId: string }>;
		} = { childName };
		parent.emit(SUPERVISOR_AUTHORIZATION_EVENT, authorization);
		assert.ok(authorization.completion);
		const grant = await authorization.completion;

		const awaited: { name: string; timeoutMs: number; completion?: Promise<boolean> } = {
			name: childName,
			timeoutMs: PEER_TIMEOUT_MS,
		};
		parent.emit(SUBAGENT_AWAIT_INTERCOM_PEER_EVENT, awaited);
		assert.ok(awaited.completion);

		const child = new IntercomClient("restored-child-session");
		const received = Promise.withResolvers<string>();
		child.on("message", (_from: object, message: { content: { text: string } }) =>
			received.resolve(message.content.text),
		);
		await child.connect(
			{
				name: childName,
				model: "test-model",
				cwd: repoRoot,
				pid: process.pid,
				status: "idle",
				startedAt: Date.now(),
				lastActivity: Date.now(),
				group: "default",
				groups: ["default"],
			},
			{ capability: grant.capability, supervisorSessionId: grant.supervisorSessionId },
		);
		try {
			assert.equal(await awaited.completion, true);
			assert.equal(child.supervisorSessionId, grant.supervisorSessionId);

			const afterRestore = await parent.send(childName, "lane 1: continue after resume");
			assert.equal(afterRestore.details.delivered, true);
			assert.equal(await received.promise, "lane 1: continue after resume");

			const gonePeer: { name: string; timeoutMs: number; completion?: Promise<boolean> } = {
				name: goneName,
				timeoutMs: 0,
			};
			parent.emit(SUBAGENT_AWAIT_INTERCOM_PEER_EVENT, gonePeer);
			assert.equal(await gonePeer.completion, false);

			const card = (entryId: string, sender: string, text: string) => ({
				entryId,
				customType: "intercom_message",
				content: text,
				details: {
					from: {
						id: `${sender}-old-id`,
						name: sender,
						cwd: repoRoot,
						model: "m",
						pid: 1,
						startedAt: 1,
						lastActivity: 1,
					},
					message: { id: `${entryId}-id`, timestamp: Date.now(), content: { text } },
					bodyText: text,
				},
				timestamp: new Date().toISOString(),
				stageAdmissionKey: `intercom:${entryId}-id`,
				delivery: "steer",
			});
			const [plan] = await parent.fire<{ decisions: object[]; notices?: string[] }>("session_recovery_replay", {
				type: "session_recovery_replay",
				reason: "resume",
				pending: [card("from-restored", childName, "lane 1 progress"), card("from-gone", goneName, "lane 2 stale")],
			});
			assert.deepEqual(plan?.decisions, [
				{ entryId: "from-restored", action: "replay" },
				{ entryId: "from-gone", action: "drop" },
			]);
			assert.match(plan?.notices?.[0] ?? "", new RegExp(`Intercom peer \`${goneName}\` is gone`));
		} finally {
			await child.disconnect().catch(() => undefined);
			await parent.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
