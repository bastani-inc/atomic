import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, test, vi } from "vitest";
import type { VerbatimCompactionResult } from "../src/core/compaction/index.js";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import type { RpcSlashCommand } from "../src/modes/rpc/rpc-types.js";
import {
	createRig,
	DUPLICATE_DELIVERY_SETTLE_MS,
	type Rig,
	type RigOptions,
	releaseOpenGates,
	sleep,
	type Wiring,
	waitFor,
} from "./helpers/busy-submission-rig.js";
import { pressAltUp } from "./helpers/interactive-submission-host.js";
import { getUserTexts } from "./suite/harness.js";

type CompactionInternals = {
	_applyVerbatimCompaction(): Promise<VerbatimCompactionResult | undefined>;
	_runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<string>;
};

type CompactionKind = "manual" | "automatic";

const rigs: Rig[] = [];
const heldCompactions: Array<() => void> = [];

afterEach(async () => {
	for (const release of heldCompactions.splice(0)) release();
	releaseOpenGates();
	for (const rig of rigs.splice(0)) await rig.stop();
	vi.restoreAllMocks();
});

function workflowCommand(invocations: string[]): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("workflow", {
			description: "Manage workflow runs",
			handler: async (args) => {
				invocations.push(args);
			},
		});
	};
}

/** Commands that send user messages, written like the send-user-message example extension. */
function messageCommands(invocations: string[]): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("ask", {
			description: "Send a user message",
			handler: async (args, ctx) => {
				invocations.push(`ask ${args}`);
				if (!ctx.isIdle()) {
					ctx.ui.notify("Agent is busy", "warning");
					return;
				}
				pi.sendUserMessage(args);
			},
		});
		pi.registerCommand("steer", {
			description: "Send a steering message",
			handler: async (args) => {
				invocations.push(`steer ${args}`);
				pi.sendUserMessage(args, { deliverAs: "steer" });
			},
		});
		pi.registerCommand("followup", {
			description: "Send a follow-up message",
			handler: async (args) => {
				invocations.push(`followup ${args}`);
				pi.sendUserMessage(args, { deliverAs: "followUp" });
			},
		});
	};
}

/** Route the host session's compaction events through InteractiveMode's own event handler, as the TUI does. */
function attachCompactionEventHandler(rig: Rig): void {
	const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
		this: object,
		event: { type: string },
	) => Promise<void>;
	Object.assign(rig.host, {
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: { handleEvent() {} },
		manualCompactionTakeoverPending: false,
		autoCompactionLoader: undefined,
		autoCompactionEscapeHandlerSaved: false,
		statusContainer: new Container(),
		chatContainer: new Container(),
	});
	Object.assign(rig.host.settingsManager, { getShowTerminalProgress: () => false, getClearOnShrink: () => false });
	Object.assign(rig.host.ui, { terminal: { setProgress() {} } });
	Object.defineProperty(rig.host, "compactionActive", {
		configurable: true,
		get: () => rig.host.session.isCompacting || Reflect.get(rig.host, "manualCompactionTakeoverPending") === true,
	});
	rig.host.session.subscribe(async (event) => {
		if (event.type === "compaction_start" || event.type === "compaction_end" || event.type === "agent_continue_error")
			await handleEvent.call(rig.host, event);
	});
}

async function createCompactingRig(
	wiring: Wiring,
	invocations: string[],
	options: Pick<RigOptions, "models" | "settings"> = {},
): Promise<Rig> {
	const rig = await createRig(wiring, "quiet", {
		...options,
		extensions: [workflowCommand(invocations), messageCommands(invocations)],
	});
	rigs.push(rig);
	rig.engine.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("done")));
	attachCompactionEventHandler(rig);
	if (rig.pair) {
		const runtime = rig.pair.runtime;
		await runtime.waitUntilResourcesReady();
		await waitFor("the engine command catalog", () =>
			runtime.getRemoteCommands().some((command) => command.name === "workflow"),
		);
	}
	return rig;
}

function holdCompaction(rig: Rig): () => void {
	const release = Promise.withResolvers<undefined>();
	vi.spyOn(rig.engine.session as unknown as CompactionInternals, "_applyVerbatimCompaction").mockImplementation(
		() => release.promise,
	);
	const releaseCompaction = () => release.resolve(undefined);
	heldCompactions.push(releaseCompaction);
	return releaseCompaction;
}

function startCompaction(rig: Rig, kind: CompactionKind): Promise<unknown> {
	if (kind === "manual") return rig.host.session.compact().catch((error: Error) => error);
	return (rig.engine.session as unknown as CompactionInternals)._runAutoCompaction("threshold", false);
}

function providerRequests(rig: Rig): number {
	return rig.engine.faux.state.callCount;
}

for (const wiring of ["local", "isolated"] as const) {
	for (const kind of ["manual", "automatic"] as const) {
		describe(`${wiring} host during ${kind} compaction`, () => {
			test("runs UI and extension commands at once and queues prompts in order (#4251)", async () => {
				const invocations: string[] = [];
				const rig = await createCompactingRig(wiring, invocations);
				let settingsOpened = 0;
				Reflect.set(rig.host, "showSettingsSelector", () => {
					settingsOpened += 1;
				});
				const releaseCompaction = holdCompaction(rig);
				const compaction = startCompaction(rig, kind);
				await waitFor("the host to observe compaction", () => rig.host.session.isCompacting);

				const submit = (text: string) => rig.host.defaultEditor.onSubmit?.(text);
				await submit("first prompt");
				await submit("/workflow connect");
				await submit("/settings");
				await submit("/workflow status");
				await submit("second prompt");

				assert.equal(rig.host.session.isCompacting, true, "compaction must still be running");
				assert.deepEqual(invocations, ["connect", "status"]);
				assert.equal(settingsOpened, 1);
				// The extension command took the message typed before it into the session's hold, in order.
				assert.deepEqual(rig.host.compactionQueuedMessages, [{ text: "second prompt", mode: "steer" }]);
				assert.deepEqual(rig.host.getAllQueuedMessages(), {
					steering: ["first prompt", "second prompt"],
					followUp: [],
				});
				assert.deepEqual(getUserTexts(rig.engine), []);

				// The compaction_end handler releases the held prompts; nothing flushes them by hand.
				releaseCompaction();
				await compaction;
				await waitFor("held prompts to reach the session in order", () =>
					isDeepEqual(getUserTexts(rig.engine), ["first prompt", "second prompt"]),
				);
				assert.deepEqual(rig.host.compactionQueuedMessages, []);
			});

			test("sends a message typed before a message-sending command ahead of the command's message (#4251)", async () => {
				const invocations: string[] = [];
				const rig = await createCompactingRig(wiring, invocations);
				const releaseCompaction = holdCompaction(rig);
				const compaction = startCompaction(rig, kind);
				await waitFor("the host to observe compaction", () => rig.host.session.isCompacting);

				const submit = (text: string) => rig.host.defaultEditor.onSubmit?.(text);
				await submit("typed first");
				await submit("/ask sent by the command");
				await submit("typed last");
				await waitFor("every held message to show as pending", () =>
					isDeepEqual(rig.host.getAllQueuedMessages().steering, [
						"typed first",
						"sent by the command",
						"typed last",
					]),
				);
				assert.equal(providerRequests(rig), 0, "no provider request may start during compaction");

				releaseCompaction();
				await compaction;
				await waitFor("the held messages to be sent in typing order", () =>
					isDeepEqual(getUserTexts(rig.engine), ["typed first", "sent by the command", "typed last"]),
				);
				await waitFor("the session to settle", () => !rig.engine.session.isStreaming);
				await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
				assert.deepEqual(getUserTexts(rig.engine), ["typed first", "sent by the command", "typed last"]);
				assert.deepEqual(rig.host.getAllQueuedMessages(), { steering: [], followUp: [] });
			});

			test("returns held messages to the editor on Alt+Up and sends none of them (#4251)", async () => {
				const invocations: string[] = [];
				const rig = await createCompactingRig(wiring, invocations);
				const releaseCompaction = holdCompaction(rig);
				const compaction = startCompaction(rig, kind);
				await waitFor("the host to observe compaction", () => rig.host.session.isCompacting);

				const submit = (text: string) => rig.host.defaultEditor.onSubmit?.(text);
				await submit("typed first");
				await submit("/ask sent by the command");
				await waitFor("both held messages to show as pending", () =>
					isDeepEqual(rig.host.getAllQueuedMessages().steering, ["typed first", "sent by the command"]),
				);

				assert.equal(await rig.host.restoreQueuedMessagesToEditor(), 2);
				const restored = rig.host.editor.getText();
				assert.ok(restored.includes("typed first"), restored);
				assert.ok(restored.includes("sent by the command"), restored);
				assert.deepEqual(rig.host.getAllQueuedMessages(), { steering: [], followUp: [] });
				await waitFor("the session to give the held messages back", () =>
					isDeepEqual(rig.engine.session.getSteeringMessages(), []),
				);

				releaseCompaction();
				await compaction;
				await waitFor("the host to observe the end of compaction", () => !rig.host.session.isCompacting);
				await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
				assert.equal(providerRequests(rig), 0);
				assert.deepEqual(getUserTexts(rig.engine), []);
				assert.deepEqual(rig.host.getAllQueuedMessages(), { steering: [], followUp: [] });
			});

			test("holds messages an extension command sends until compaction ends, then sends each once (#4251)", async () => {
				const invocations: string[] = [];
				const rig = await createCompactingRig(wiring, invocations);
				const releaseCompaction = holdCompaction(rig);
				const compaction = startCompaction(rig, kind);
				await waitFor("the host to observe compaction", () => rig.host.session.isCompacting);

				const submit = (text: string) => rig.host.defaultEditor.onSubmit?.(text);
				await submit("/ask first");
				await submit("/steer second");
				await submit("/followup third");
				await waitFor("the commands to run during compaction", () => invocations.length === 3);
				await sleep(DUPLICATE_DELIVERY_SETTLE_MS);

				assert.deepEqual(invocations, ["ask first", "steer second", "followup third"]);
				assert.equal(rig.engine.session.isCompacting, true, "compaction must still be running");
				assert.equal(providerRequests(rig), 0, "no provider request may start during compaction");
				assert.deepEqual(getUserTexts(rig.engine), []);

				releaseCompaction();
				await compaction;
				await waitFor("the held messages to be sent after compaction", () =>
					isDeepEqual(getUserTexts(rig.engine), ["first", "second", "third"]),
				);
				await waitFor("the session to settle", () => !rig.engine.session.isStreaming);
				await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
				assert.deepEqual(getUserTexts(rig.engine), ["first", "second", "third"]);
			});
		});
	}
}

for (const wiring of ["local", "isolated"] as const) {
	describe(`${wiring} host during automatic compaction at the end of a turn`, () => {
		test("sends held messages in typing order while the turn's run is still open (#4251)", async () => {
			const invocations: string[] = [];
			// Every reply crosses the compaction threshold, so compaction starts as the first turn ends.
			const rig = await createCompactingRig(wiring, invocations, {
				models: [{ id: "small-window", contextWindow: 1000 }],
				settings: { compaction: { enabled: true, reserveTokens: 990 } },
			});
			const releaseCompaction = holdCompaction(rig);
			const submit = (text: string) => rig.host.defaultEditor.onSubmit?.(text);
			await submit("start a turn");
			await waitFor("compaction to start at the end of the turn", () => rig.host.session.isCompacting);
			const requestsBefore = providerRequests(rig);

			await submit("typed first");
			await submit("/ask sent by the command");
			await submit("typed last");
			await waitFor("every held message to show as pending", () =>
				isDeepEqual(rig.host.getAllQueuedMessages().steering, ["typed first", "sent by the command", "typed last"]),
			);
			assert.equal(providerRequests(rig), requestsBefore, "no provider request may start during compaction");

			releaseCompaction();
			await waitFor("the held messages to be sent in typing order", () =>
				isDeepEqual(getUserTexts(rig.engine), ["start a turn", "typed first", "sent by the command", "typed last"]),
			);
			await waitFor(
				"the session to settle",
				() => !rig.engine.session.isStreaming && !rig.host.session.isCompacting,
			);
			await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
			assert.deepEqual(getUserTexts(rig.engine), [
				"start a turn",
				"typed first",
				"sent by the command",
				"typed last",
			]);
		});
	});
}

for (const wiring of ["local", "isolated"] as const) {
	describe(`${wiring} host when a handed-off message fails after compaction`, () => {
		test("keeps the message queued, shows the error once and sends it once later (#4251)", async () => {
			const invocations: string[] = [];
			const rig = await createCompactingRig(wiring, invocations);
			const releaseCompaction = holdCompaction(rig);
			const compaction = startCompaction(rig, "manual");
			await waitFor("the host to observe compaction", () => rig.host.session.isCompacting);

			const submit = (text: string) => rig.host.defaultEditor.onSubmit?.(text);
			await submit("typed first");
			await submit("/workflow connect");
			await waitFor("the session to hold the handed-off message", () =>
				isDeepEqual(rig.engine.session.getSteeringMessages(), ["typed first"]),
			);
			// Credentials go away (for example /logout) before compaction ends.
			const auth = vi.spyOn(rig.engine.session.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);

			releaseCompaction();
			await compaction;
			const failures = () =>
				rig.host.notices.filter((notice) => notice.startsWith("error: Failed to send queued message"));
			await waitFor("the failure to be shown", () => failures().length > 0);
			await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
			assert.equal(failures().length, 1, JSON.stringify(rig.host.notices));
			assert.match(failures()[0] ?? "", /No API key/);
			assert.deepEqual(rig.engine.session.getSteeringMessages(), ["typed first"]);
			await waitFor("the host to list the kept message", () =>
				rig.host.getAllQueuedMessages().steering.includes("typed first"),
			);
			assert.equal(providerRequests(rig), 0);

			auth.mockRestore();
			await submit("next prompt");
			await waitFor("both messages to be sent", () => getUserTexts(rig.engine).length === 2);
			await waitFor("the session to settle", () => !rig.engine.session.isStreaming);
			await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
			// Like the paused queue, a kept message joins after the next ordinary submission starts the turn.
			assert.deepEqual(getUserTexts(rig.engine), ["next prompt", "typed first"]);
		});
	});
}

describe("isolated host hand-off during manual compaction", () => {
	test("restores a handed-off message the engine has not listed yet on Alt+Up and sends nothing (#4251)", async () => {
		const invocations: string[] = [];
		const rig = await createCompactingRig("isolated", invocations);
		const releaseCompaction = holdCompaction(rig);
		const compaction = startCompaction(rig, "manual");
		await waitFor("the host to observe compaction", () => rig.host.session.isCompacting);

		let restoring: Promise<number> | undefined;
		rig.host.session.subscribe((event) => {
			if (restoring !== undefined || event.type !== "queue_update") return;
			if (!event.steering.includes("typed A") || event.steering.includes("typed B")) return;
			// Alt+Up lands after the engine listed A and before it took B.
			restoring = rig.host.restoreQueuedMessagesToEditor();
		});
		const submit = (text: string) => rig.host.defaultEditor.onSubmit?.(text);
		await submit("typed A");
		await submit("typed B");
		await submit("/workflow connect");
		await waitFor("Alt+Up between the engine's queue updates", () => restoring !== undefined);
		assert.equal(await restoring, 2);
		const restored = rig.host.editor.getText();
		assert.equal(restored, "typed A\n\ntyped B");
		await waitFor("the engine to give the held messages back", () =>
			isDeepEqual(rig.engine.session.getSteeringMessages(), []),
		);

		releaseCompaction();
		await compaction;
		await waitFor("the host to observe the end of compaction", () => !rig.host.session.isCompacting);
		await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
		assert.equal(providerRequests(rig), 0);
		assert.deepEqual(getUserTexts(rig.engine), []);
	});
});

/** Long enough that the engine's answers are still on their way to the host while the test acts. */
const ENGINE_TO_HOST_LAG_MS = 150;

/** Let every request and answer between the host and the engine arrive and be handled. */
async function settleTraffic(rig: Rig): Promise<void> {
	if (rig.pair) await rig.pair.drain();
	else await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
}

for (const wiring of ["local", "isolated"] as const) {
	describe(`${wiring} host restoring a queue held by both the editor and the session during compaction`, () => {
		test("restores every message in order once, including ones the host has not heard of yet (#4257)", async () => {
			const invocations: string[] = [];
			const rig = await createCompactingRig(wiring, invocations);
			const releaseCompaction = holdCompaction(rig);
			const compaction = startCompaction(rig, "manual");
			await waitFor("the host to observe compaction", () => rig.host.session.isCompacting);
			rig.pair?.setLag({ toHostMs: ENGINE_TO_HOST_LAG_MS });

			const submit = (text: string) => rig.host.defaultEditor.onSubmit?.(text);
			await submit("typed first");
			// The commands hand "typed first" to the engine and send their own messages from there.
			const commands = [submit("/ask sent by the command"), submit("/followup follow-up by the command")];
			await waitFor("the engine to hold the messages the commands sent", () =>
				isDeepEqual(
					[rig.engine.session.getSteeringMessages(), rig.engine.session.getFollowUpMessages()],
					[["typed first", "sent by the command"], ["follow-up by the command"]],
				),
			);
			await submit("typed last");
			if (rig.pair) {
				assert.deepEqual(rig.host.session.getFollowUpMessages(), [], "the host must not have heard of them yet");
			}

			pressAltUp(rig.host);
			await settleTraffic(rig);
			await Promise.all(commands);

			assert.equal(
				rig.host.editor.getText(),
				"typed first\n\nsent by the command\n\ntyped last\n\nfollow-up by the command",
			);
			assert.deepEqual(rig.host.getAllQueuedMessages(), { steering: [], followUp: [] });
			assert.deepEqual(rig.engine.session.getSteeringMessages(), []);
			assert.deepEqual(rig.engine.session.getFollowUpMessages(), []);

			releaseCompaction();
			await compaction;
			await waitFor("the host to observe the end of compaction", () => !rig.host.session.isCompacting);
			await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
			assert.equal(providerRequests(rig), 0, "a restored message must not also be sent");
			assert.deepEqual(getUserTexts(rig.engine), []);
		});
	});
}

describe("isolated host when the engine cannot clear its queue", () => {
	test("keeps every message queued and reports the failure, then restores them on the next Alt+Up (#4257)", async () => {
		const invocations: string[] = [];
		const rig = await createCompactingRig("isolated", invocations);
		const pair = rig.pair;
		assert.ok(pair, "isolated rigs have an engine");
		const releaseCompaction = holdCompaction(rig);
		const compaction = startCompaction(rig, "manual");
		await waitFor("the host to observe compaction", () => rig.host.session.isCompacting);

		const submit = (text: string) => rig.host.defaultEditor.onSubmit?.(text);
		await submit("typed first");
		await submit("/ask sent by the command");
		await submit("typed last");
		const everyMessage = ["typed first", "sent by the command", "typed last"];
		await waitFor("every message to show as queued", () =>
			isDeepEqual(rig.host.getAllQueuedMessages().steering, everyMessage),
		);

		pair.failCommand("clear_queue", "engine unavailable");
		pressAltUp(rig.host);
		await settleTraffic(rig);

		assert.equal(rig.host.editor.getText(), "", "nothing may reach the editor while the engine still holds messages");
		assert.deepEqual(
			rig.host.notices.filter((notice) => notice.startsWith("error:")),
			["error: Failed to restore queued messages: engine unavailable"],
		);
		assert.deepEqual(rig.host.getAllQueuedMessages().steering, everyMessage);
		assert.deepEqual(rig.engine.session.getSteeringMessages(), ["typed first", "sent by the command"]);

		pair.failCommand("clear_queue", undefined);
		pressAltUp(rig.host);
		await settleTraffic(rig);

		assert.equal(rig.host.editor.getText(), everyMessage.join("\n\n"));
		assert.deepEqual(rig.host.getAllQueuedMessages(), { steering: [], followUp: [] });
		assert.deepEqual(rig.engine.session.getSteeringMessages(), []);

		releaseCompaction();
		await compaction;
		await waitFor("the host to observe the end of compaction", () => !rig.host.session.isCompacting);
		await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
		assert.deepEqual(getUserTexts(rig.engine), []);
	});
});

describe("engine command catalog", () => {
	function engineHost(commands: RpcSlashCommand[]): { session: object; runtimeHost: IsolatedInteractiveRuntime } {
		const runtimeHost = Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime;
		Object.defineProperty(runtimeHost, "getRemoteCommands", { value: () => commands });
		return { session: { extensionRunner: { getCommand: () => undefined } }, runtimeHost };
	}

	const sourceInfo = { path: "/fixture", source: "fixture", scope: "user", origin: "top-level" } as const;
	const isExtensionCommand = Reflect.get(InteractiveMode.prototype, "isExtensionCommand") as (
		this: object,
		text: string,
	) => boolean;

	test("only lets engine extension commands bypass the compaction queue (#4251)", () => {
		const host = engineHost([
			{ name: "workflow", source: "extension", sourceInfo },
			{ name: "skill:review", source: "skill", sourceInfo },
			{ name: "fix-tests", source: "prompt", sourceInfo },
		]);

		assert.equal(isExtensionCommand.call(host, "/workflow connect"), true);
		assert.equal(isExtensionCommand.call(host, "/workflow"), true);
		assert.equal(isExtensionCommand.call(host, "/skill:review the diff"), false);
		assert.equal(isExtensionCommand.call(host, "/fix-tests"), false);
		assert.equal(isExtensionCommand.call(host, "/unknown"), false);
		assert.equal(isExtensionCommand.call(host, "workflow connect"), false);
	});
});

function isDeepEqual(actual: unknown, expected: unknown): boolean {
	try {
		assert.deepEqual(actual, expected);
		return true;
	} catch {
		return false;
	}
}
