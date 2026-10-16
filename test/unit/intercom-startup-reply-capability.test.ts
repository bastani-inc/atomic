import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { spawnBrokerIfNeeded } from "../../packages/intercom/broker/spawn.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

for (const suspension of ["beforeConnect", "spawn"] as const) {
	for (const outcome of ["completed", "failed", "cancelled", "interrupted"]) {
		test(`${outcome} during ${suspension} is terminal in the initial startup registration`, async () => {
			const entered = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const execution = new AbortController();
			const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => void | Promise<void>>>();
			const gate = async () => {
				entered.resolve();
				await resume.promise;
			};
			vi.mocked(spawnBrokerIfNeeded).mockImplementation(async () => {
				if (suspension === "spawn") await gate();
			});
			const registrations: Array<Parameters<IntercomClient["connect"]>[0]> = [];
			// Observe admission before connect resolves: a later presence update cannot repair this assertion.
			vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async (registration) => {
				registrations.push(structuredClone(registration));
			});
			vi.spyOn(IntercomClient.prototype, "registerLiveWorkflowStageRoute").mockResolvedValue();
			vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
			const pi = {
				on(name: string, handler: (event: never, ctx: ExtensionContext) => void | Promise<void>) {
					handlers.set(name, [...(handlers.get(name) ?? []), handler]);
				},
				registerTool() {},
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				async appendEntry() {},
				getSessionName: () => undefined,
				events: createEventBus(),
			};
			intercomHeavy(pi as never, {
				beforeConnectAttempt: suspension === "beforeConnect" ? gate : undefined,
			});
			const ctx = {
				hasUI: false,
				cwd: process.cwd(),
				isIdle: () => true,
				ui: { notify() {} },
				sessionManager: { getSessionId: () => "startup-terminal-child", getBranch: () => [] },
				subagentPolicy: { executionEnded: execution.signal },
				orchestrationContext: {
					kind: "workflow-stage",
					workflowRunId: "run",
					workflowStageId: "stage",
					workflowStageName: "stage",
					pendingStageDelivery: { routeCapability: "capability", deliverPending: async () => {} },
				},
			} as unknown as ExtensionContext;
			const fire = async (name: string) => {
				for (const handler of handlers.get(name) ?? []) await handler({} as never, ctx);
			};
			const startup = fire("session_start");
			try {
				await entered.promise;
				assert.equal(registrations.length, 0);
				execution.abort(outcome);
				resume.resolve();
				await startup;
				assert.equal(registrations.length, 1);
				assert.equal(registrations[0]?.replyCapability, "terminal");
			} finally {
				resume.resolve();
				await startup;
				await fire("session_shutdown");
			}
		});
	}
}
