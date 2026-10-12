import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { createHarness, getMessageText } from "./suite/harness.ts";

test.each(["steer", "followUp"] as const)(
	"an ordinary-session interrupt preserves a %s custom starter awaiting its hook",
	async (deliverAs) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const interrupted = Promise.withResolvers<void>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.messageType === "custom" && event.message.customType === "original") {
							entered.resolve();
							await release.promise;
						}
					});
				},
			],
		});
		try {
			harness.setResponses([
				async (_context, options) => {
					await new Promise<void>((resolve) => {
						if (options?.signal?.aborted) resolve();
						else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					return fauxAssistantMessage("aborted");
				},
				() => {
					interrupted.resolve();
					return fauxAssistantMessage("interrupt reply");
				},
			]);
			const original = harness.session.sendCustomMessage(
				{ customType: "original", content: "original payload", display: true },
				{ triggerTurn: true, deliverAs },
			);
			await entered.promise;
			const interrupt = harness.session.sendCustomMessage(
				{ customType: "interrupt", content: "interrupt payload", display: true },
				{ triggerTurn: true, deliverAs: "interrupt" },
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(harness.session.agent.state.isStreaming, false, "interrupt must not overtake preparation");
			release.resolve();
			await Promise.all([original, interrupt, interrupted.promise]);
			await harness.session.agent.waitForIdle();
			const custom = harness.session.messages.filter((message) => message.role === "custom");
			assert.deepEqual(custom.map(getMessageText), ["original payload", "interrupt payload"]);
			assert.deepEqual(
				harness.session.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "custom_message")
					.map((entry) => entry.customType),
				["original", "interrupt"],
			);
		} finally {
			release.resolve();
			await harness.cleanup();
		}
	},
);
