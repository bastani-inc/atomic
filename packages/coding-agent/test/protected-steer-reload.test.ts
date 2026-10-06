import assert from "node:assert/strict";
import { fauxAssistantMessage, getApiProvider, registerApiProvider } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../src/core/agent-session-persistent-custom-messages.js";
import type { ExtensionFactory } from "../src/index.js";
import { createHarness, getMessageText } from "./suite/harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

test.each([
	{ transactional: false, outcome: "success" },
	{ transactional: true, outcome: "success" },
	{ transactional: true, outcome: "paused" },
	{ transactional: true, outcome: "rejected" },
])(
	"reload preserves multiple protected steers ($outcome, transactional: $transactional) (#3468)",
	async ({ transactional, outcome }) => {
		let generation = 0;
		let restoreApi = () => {};
		const observed: number[] = [];
		const factories: ExtensionFactory[] = [
			(pi) => {
				const current = ++generation;
				pi.on("context", () => {
					restoreApi();
					observed.push(current);
				});
			},
		];
		let loaded = await createTestExtensionsResult(factories);
		const resourceLoader = createTestResourceLoader({ extensionsResult: loaded });
		resourceLoader.getExtensions = () => loaded;
		resourceLoader.reload = async () => {
			loaded = await createTestExtensionsResult(factories);
		};
		const harness = await createHarness({ resourceLoader });
		if (transactional) {
			resourceLoader.prepareReload = async () => {
				if (outcome === "rejected") throw new Error("rejected candidate");
				const candidate = await createTestExtensionsResult(factories);
				return {
					loader: createTestResourceLoader({ extensionsResult: candidate }),
					activate: () => {},
					commit: () => {
						loaded = candidate;
					},
				};
			};
		}
		let entered!: () => void;
		const streams = getApiProvider(harness.faux.api)!;
		restoreApi = () =>
			registerApiProvider({ api: harness.faux.api, stream: streams.stream, streamSimple: streams.streamSimple });
		const blocked = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const requests: string[] = [];
		harness.setResponses([
			async (_context, options) => {
				entered();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("interrupted");
			},
			...Array.from({ length: 3 }, () => (context: import("@bastani/pi-ai/compat").Context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("successor answered notices");
			}),
		]);
		try {
			await harness.session.bindExtensions({ shutdownHandler: () => {} });
			const retiring = harness.session.extensionRunner;
			const active = harness.session.prompt("blocked model turn");
			await blocked;
			for (const content of ["first protected notice", "second protected notice", "third protected notice"]) {
				await harness.session.sendCustomMessage(
					{ customType: "workflow-notice", content, display: true },
					{
						triggerTurn: true,
						deliverAs: "steer",
						persistWhenStreaming: true,
					},
				);
			}
			if (outcome === "paused") harness.session.pauseQueuedMessages();
			if (outcome === "rejected") {
				await assert.rejects(harness.session.reload(), /rejected candidate/);
				assert.equal(harness.session.extensionRunner, retiring);
				assert.equal(requests.length, 0);
				await harness.session.prompt("explicit retry driver");
			} else {
				await harness.session.reload();
				assert.notEqual(harness.session.extensionRunner, retiring);
				if (outcome === "paused") {
					assert.equal(requests.length, 0);
					assert.equal(harness.session.queuedMessagesPaused, true);
					assert.equal(
						harness.session.sessionManager
							.getEntries()
							.filter(
								(entry) =>
									entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE,
							).length,
						0,
					);
					await harness.session.resumeQueuedMessages();
					await harness.session.prompt("explicit paused queue driver");
				}
			}
			await active;
			await harness.session.agent.waitForIdle();
			assert.deepEqual(
				harness.session.messages
					.filter((message) => message.role === "assistant" && message.stopReason === "error")
					.map((message) => message.errorMessage),
				[],
			);
			assert.equal(requests.length, 3);
			for (const content of ["first protected notice", "second protected notice", "third protected notice"]) {
				assert.ok(requests[2].includes(content));
				assert.equal(
					harness.session.messages.filter(
						(message) =>
							message.role === "custom" &&
							message.customType === "workflow-notice" &&
							getMessageText(message) === content,
					).length,
					1,
				);
			}
			assert.deepEqual(observed, outcome === "rejected" ? [1, 1, 1, 1] : [1, 2, 2, 2]);
			assert.equal(
				harness.session.sessionManager
					.getEntries()
					.filter(
						(entry) =>
							entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE,
					).length,
				3,
			);
			assert.ok(
				harness.session.messages.some((message) => getMessageText(message) === "successor answered notices"),
			);
		} finally {
			harness.session.pauseQueuedMessages();
			await harness.cleanup();
		}
	},
);
