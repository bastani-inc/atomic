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
	releaseOpenGates,
	sleep,
	type Wiring,
	waitFor,
} from "./helpers/busy-submission-rig.js";
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
		if (event.type === "compaction_start" || event.type === "compaction_end") await handleEvent.call(rig.host, event);
	});
}

async function createCompactingRig(wiring: Wiring, invocations: string[]): Promise<Rig> {
	const rig = await createRig(wiring, "quiet", {
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
				assert.deepEqual(rig.host.compactionQueuedMessages, [
					{ text: "first prompt", mode: "steer" },
					{ text: "second prompt", mode: "steer" },
				]);
				assert.deepEqual(getUserTexts(rig.engine), []);

				// The compaction_end handler releases the held prompts; nothing flushes them by hand.
				releaseCompaction();
				await compaction;
				await waitFor("held prompts to reach the session in order", () =>
					isDeepEqual(getUserTexts(rig.engine), ["first prompt", "second prompt"]),
				);
				assert.deepEqual(rig.host.compactionQueuedMessages, []);
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
