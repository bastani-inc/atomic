import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SubagentChildPolicy, ToolDefinition } from "@bastani/atomic";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { runGenericHandlers } from "../../packages/coding-agent/src/core/extensions/runner-events.js";
import type { Extension, ExtensionError } from "../../packages/coding-agent/src/core/extensions/types.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

/** Structural cost: a real broker, restarted in one case, and a child that waits out a refused capability. */
export const REAL_BROKER_REFUSAL_TIMEOUT_MS = 90_000;

export function registration(name: string) {
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

export function childPolicy(
	childName: string,
	orchestratorTarget: string,
	capability: string,
	supervisorSessionId: string,
) {
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

export async function createSupervisorRefusalHarness(tempPrefix: string) {
	const fixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), tempPrefix)));
	fixture.overrideAgentDir();
	const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
	const { default: intercom } = await import("../../packages/intercom/index.js");

	async function supervisor(
		name: string,
		atomicId = randomUUID(),
		preferredSessionId?: string,
		ownerToken = randomUUID(),
	) {
		const client = new IntercomClient(atomicId, preferredSessionId ? { preferredSessionId } : {});
		const received: string[] = [];
		client.on("message", (_from: object, message: { content: { text: string } }) =>
			received.push(message.content.text),
		);
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

	return {
		fixture,
		IntercomClient,
		supervisor,
		startChild,
	};
}
