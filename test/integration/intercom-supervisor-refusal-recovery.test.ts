/**
 * A subagent's supervisor capability that the broker refuses: real broker child process, the real Intercom extension
 * in a subagent child, a real supervisor client. A refusal that only lasts until the supervisor is back (it left before
 * the child registered, or a broker restart let the child reconnect first) ends with the child reaching its supervisor
 * through contact_supervisor. A forged or foreign capability stays refused, and never fails the child's start.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SubagentChildPolicy, ToolDefinition } from "@bastani/atomic";
import { afterAll, beforeAll, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { runGenericHandlers } from "../../packages/coding-agent/src/core/extensions/runner-events.js";
import type { Extension, ExtensionError } from "../../packages/coding-agent/src/core/extensions/types.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { sleep } from "../helpers/runtime.js";

const fixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "supervisor-refusal-")));
fixture.overrideAgentDir();
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercom } = await import("../../packages/intercom/index.js");

/** Structural cost: a real broker, restarted in one case, and a child that waits out a refused capability. */
const REAL_BROKER_REFUSAL_TIMEOUT_MS = 90_000;

beforeAll(async () => {
	await fixture.startSourceBroker(20_000);
});
afterAll(() => fixture.cleanup());

function registration(name: string) {
	return {
		name,
		model: "test-model",
		cwd: process.cwd(),
		pid: process.pid,
		status: "idle" as const,
		startedAt: Date.now(),
		lastActivity: Date.now(),
		group: "default",
		groups: ["default"],
	};
}

async function supervisor(
	name: string,
	atomicId = randomUUID(),
	preferredSessionId?: string,
	ownerToken = randomUUID(),
) {
	const client = new IntercomClient(atomicId, preferredSessionId ? { preferredSessionId } : {});
	const received: string[] = [];
	client.on("message", (_from: object, message: { content: { text: string } }) => received.push(message.content.text));
	await client.connect(registration(name), undefined, ownerToken);
	fixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return { client, received, atomicId, ownerToken };
}

function startChild(policy: SubagentChildPolicy) {
	type Handler = (event: object, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDefinition>();
	let sessionName: string | undefined;
	let activeTools: string[] = [];
	const entries: object[] = [];
	const atomic = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		async sendMessage() {},
		async sendMessages() {},
		getSessionName: () => sessionName,
		setSessionName(value: string) {
			sessionName = value;
		},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events: createEventBus(),
	} as never as ExtensionAPI;
	intercom(atomic);
	const extension = {
		path: "<intercom>",
		resolvedPath: "<intercom>",
		sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level" },
		handlers: new Map(
			[...handlers].map(([event, registered]) => [
				event,
				registered.map((handler) => async (event: object, ctx: object) => {
					await handler(event, ctx as ExtensionContext);
				}),
			]),
		),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	} as Partial<Extension> as Extension;
	const childSessionId = randomUUID();
	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {} },
		sessionManager: {
			getSessionId: () => childSessionId,
			getBranch: () => [],
			getEntries: () => entries,
			getSessionFile: () => undefined,
		},
		subagentPolicy: policy,
	} as never as ExtensionContext;
	const emit = async (event: object) => {
		const reported: ExtensionError[] = [];
		await runGenericHandlers([extension], ctx, event as never, (error) => reported.push(error));
		return reported;
	};
	const contactSupervisor = async (message: string) => {
		const tool = tools.get("contact_supervisor");
		assert.ok(tool, "contact_supervisor registered");
		const result = await tool.execute(
			`call-${randomUUID()}`,
			{ reason: "progress_update", message } as never,
			new AbortController().signal,
			undefined,
			ctx as never,
		);
		return result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
	};
	fixture.onCleanup(async () => {
		await emit({ type: "session_shutdown", reason: "quit" });
	});
	return { emit, contactSupervisor };
}

function childPolicy(childName: string, orchestratorTarget: string, capability: string, supervisorSessionId: string) {
	return {
		managementActions: "restricted",
		fanoutAuthorized: false,
		inheritProjectContext: true,
		inheritSkills: true,
		intercomGroup: "default",
		intercom: {
			orchestratorTarget,
			runId: "run1",
			agent: "worker",
			index: 0,
			sessionName: childName,
			supervisor: { capability, supervisorSessionId },
		},
	} as never as SubagentChildPolicy;
}

test(
	"A: supervisor left before the child registered; child starts, then contact_supervisor after the supervisor is back",
	async () => {
		const childName = `subagent-worker-a${randomUUID().slice(0, 6)}-1`;
		const sup = await supervisor("refusal-supervisor-a");
		const supId = sup.client.sessionId!;
		const authorization = await sup.client.authorizeSupervisorChild(childName);
		await sup.client.disconnect();
		const child = startChild(childPolicy(childName, supId, authorization.capability, supId));
		const reported = await child.emit({ type: "session_start", reason: "startup" });
		assert.deepEqual(reported, [], "a refused capability never fails the child's start");
		// The supervisor's session reopens under its id and restores the capability, as a reopened stage does.
		const back = await supervisor("refusal-supervisor-a", sup.atomicId, supId, sup.ownerToken);
		await back.client.authorizeSupervisorChild(childName, authorization.capability);
		const text = await child.contactSupervisor("A-progress");
		await sleep(500);
		assert.ok(
			back.received.some((received) => received.includes("A-progress")),
			`contact_supervisor: ${text}`,
		);
	},
	REAL_BROKER_REFUSAL_TIMEOUT_MS,
);

test(
	"B: broker restart; the child reconnects before its supervisor restores the capability",
	async () => {
		const childName = `subagent-worker-b${randomUUID().slice(0, 6)}-1`;
		const sup = await supervisor("refusal-supervisor-b");
		const supId = sup.client.sessionId!;
		const authorization = await sup.client.authorizeSupervisorChild(childName);
		const child = startChild(childPolicy(childName, supId, authorization.capability, supId));
		const reported = await child.emit({ type: "session_start", reason: "startup" });
		assert.deepEqual(reported, []);
		const before = await child.contactSupervisor("B-before-restart");
		await sleep(300);
		assert.ok(
			sup.received.some((received) => received.includes("B-before-restart")),
			before,
		);

		// Broker restart: the broker dies; the supervisor stays away until the child has reconnected.
		const { stopDetachedBroker } = await import("../helpers/detached-broker.js");
		await fixture.stopBroker();
		await stopDetachedBroker(fixture.agentDir).catch(() => undefined);
		await sleep(200);
		// The child reconnects on its own backoff and spawns a successor broker; the supervisor stays away meanwhile.
		await sleep(6_000);
		const probe = new IntercomClient(randomUUID());
		await vi.waitFor(async () => probe.connect(registration(`refusal-probe-${randomUUID().slice(0, 4)}`)), {
			timeout: 20_000,
			interval: 250,
		});
		const back = await supervisor("refusal-supervisor-b", sup.atomicId, supId, sup.ownerToken);
		await back.client.authorizeSupervisorChild(childName, authorization.capability);
		// Give the child's own reconnect backoff time to try again with its capability.
		await sleep(15_000);
		const after = await child.contactSupervisor("B-after-restart");
		await sleep(500);
		await probe.disconnect().catch(() => undefined);
		assert.ok(
			back.received.some((received) => received.includes("B-after-restart")),
			`contact_supervisor: ${after}`,
		);
	},
	REAL_BROKER_REFUSAL_TIMEOUT_MS,
);

test(
	"C: a forged or foreign capability is still refused: no supervisor channel, no held sends, no startup crash",
	async () => {
		const childName = `subagent-worker-c${randomUUID().slice(0, 6)}-1`;
		const otherName = `subagent-worker-o${randomUUID().slice(0, 6)}-1`;
		const sup = await supervisor("refusal-supervisor-c");
		const supId = sup.client.sessionId!;
		const authorization = await sup.client.authorizeSupervisorChild(childName);
		// The real child's starting hold, as holdStartingChild makes it.
		await sup.client.reserveRestoringRecipient(authorization.capability, { group: "default", holdMs: 600_000 });
		const peer = await supervisor("refusal-peer-c");
		let heldOutcome: unknown;
		const held = peer.client.send(childName, { text: "C-held-for-the-real-child" }).then((result) => {
			heldOutcome = result;
			return result;
		});
		await sleep(300);
		// A forged capability under the real child's name, and a foreign one (issued for another child).
		const forger = startChild(childPolicy(childName, supId, `${randomUUID()}.AAAAforgedmacAAAA`, supId));
		const forgedStart = await forger.emit({ type: "session_start", reason: "startup" });
		const foreignAuth = await sup.client.authorizeSupervisorChild(otherName);
		const foreign = startChild(childPolicy(childName, supId, foreignAuth.capability, supId));
		const foreignStart = await foreign.emit({ type: "session_start", reason: "startup" });
		await sleep(500);
		const forgedContact = await forger.contactSupervisor("C-forged");
		const foreignContact = await foreign.contactSupervisor("C-foreign");
		await sleep(300);
		assert.deepEqual(forgedStart, []);
		assert.deepEqual(foreignStart, []);
		assert.match(forgedContact, /Supervisor channel is not authorized/);
		assert.match(foreignContact, /Supervisor channel is not authorized/);
		assert.equal(heldOutcome, undefined, "the held send was not handed to a session that proved nothing");
		assert.deepEqual(sup.received, []);
		await sup.client
			.releaseRestoringRecipient(authorization.capability, { refusal: "audit cleanup" })
			.catch(() => undefined);
		await held.catch(() => undefined);
	},
	REAL_BROKER_REFUSAL_TIMEOUT_MS,
);
