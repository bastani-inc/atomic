import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { test, vi } from "vitest";
import type { ExtensionContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { createHarness, getMessageText } from "../../packages/coding-agent/test/suite/harness.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import type { IntercomExtensionTestOverrides } from "../../packages/intercom/intercom-test-seams.js";
import { createDispatchCounter } from "../helpers/intercom-interrupt-probe.js";

// R1: an event writer may await an ordinary custom-message write while inbound
// protected persistence is waiting for that same event writer. Neither may deadlock.
for (const api of ["single", "batch"] as const) {
	for (const mode of ["child-control-no-inbound", "child-with-inbound"] as const) {
		test(`${api} event-hook messages finish without blocking protected inbound: ${mode}`, async () => {
			const ended = new AbortController();
			const hookEntered = Promise.withResolvers<void>();
			const releaseHook = Promise.withResolvers<void>();
			const toolEntered = Promise.withResolvers<void>();
			const releaseTool = Promise.withResolvers<void>();
			let inbound!: Parameters<NonNullable<IntercomExtensionTestOverrides["captureInboundHandler"]>>[0];
			let ctx!: ExtensionContext;
			let hookDone = false;
			let amended = false;
			const h = await createHarness({
				subagentPolicy: {
					managementActions: "restricted",
					fanoutAuthorized: false,
					inheritProjectContext: false,
					inheritSkills: false,
					executionEnded: ended.signal,
				},
				tools: [
					{
						name: "working",
						label: "Working",
						description: "Controlled active work",
						parameters: Type.Object({}),
						async execute() {
							toolEntered.resolve();
							await releaseTool.promise;
							return { content: [{ type: "text", text: "done" }], details: {} };
						},
					},
				],
				extensionFactories: [
					(pi) => {
						intercomHeavy(pi, {
							captureInboundHandler: (fn) => {
								inbound = fn;
							},
						});
						pi.on("session_start", (_event, context) => {
							ctx = context;
						});
						pi.on("tool_execution_start", async () => {
							hookEntered.resolve();
							await releaseHook.promise;
							const note = { customType: "local-tool-note", content: "ordinary hook note", display: true };
							if (api === "single") await pi.sendMessage(note, { triggerTurn: false });
							else
								await pi.sendMessages([note, { ...note, content: "second hook note" }], { triggerTurn: false });
							hookDone = true;
						});
					},
				],
			});
			await h.session.bindExtensions({ mode: "print" });
			const dispatches = createDispatchCounter([
				() => fauxAssistantMessage(fauxToolCall("working", {}), { stopReason: "toolUse" }),
				(context) => {
					amended = context.messages.some((m) => getMessageText(m).includes("event amendment"));
					return fauxAssistantMessage("done");
				},
			]);
			h.setResponses(dispatches.steps(4));
			const execution = h.session.prompt("original");
			void execution.catch(() => {});
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.all([hookEntered.promise, toolEntered.promise]);
				if (mode !== "child-control-no-inbound")
					await inbound(
						ctx,
						{
							id: "event-peer",
							name: "event-peer",
							cwd: "/event-peer",
							pid: 1,
							startedAt: 1,
							lastActivity: 1,
							model: "faux",
						},
						{ id: "event-cycle", timestamp: Date.now(), content: { text: "event amendment" } },
					);
				releaseHook.resolve();
				if (mode !== "child-control-no-inbound") {
					// R1: with the hook released, inbound protected persistence must not wait
					// behind the hook-owned note. A cyclic wait leaves this card unpersisted.
					await vi.waitFor(() =>
						assert.equal(
							h.sessionManager
								.getEntries()
								.filter((e) => e.type === "custom_message" && e.customType === "intercom_message").length,
							1,
						),
					);
				}
				releaseTool.resolve();
				const DEADLOCK_OBSERVATION_MS = 2000;
				const completed = await Promise.race([
					execution.then(() => true),
					new Promise<boolean>((resolve) => {
						timer = setTimeout(() => resolve(false), DEADLOCK_OBSERVATION_MS);
					}),
				]);
				assert.equal(completed, true, "the event writer and original task must complete without a cyclic wait");
				assert.equal(hookDone, true);
				// Amended contract: the inbound message interrupts the tool and is
				// answered within the same task for both receiver kinds.
				assert.equal(amended, mode !== "child-control-no-inbound");
				assert.equal(dispatches.counts.valid, 2);
				assert.equal(
					h.session.messages.filter((m) => m.role === "user" && getMessageText(m) === "original").length,
					1,
				);
				assert.equal(
					h.sessionManager
						.getEntries()
						.filter((e) => e.type === "custom_message" && e.customType === "local-tool-note").length,
					api === "single" ? 1 : 2,
				);
			} finally {
				clearTimeout(timer);
				releaseHook.resolve();
				releaseTool.resolve();
				ended.abort();
				void h.session.abort().catch(() => {});
				await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				h.session.pauseQueuedMessages();
				h.cleanup();
			}
		});
	}
}
