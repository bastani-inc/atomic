import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import type { VerbatimCompactionResult } from "../src/core/compaction/index.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import type { RpcSlashCommand } from "../src/modes/rpc/rpc-types.ts";
import { createRig, type Rig, releaseOpenGates, type Wiring, waitFor } from "./helpers/busy-submission-rig.ts";
import { getUserTexts } from "./suite/harness.ts";

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

async function createCompactingRig(wiring: Wiring, invocations: string[]): Promise<Rig> {
	const rig = await createRig(wiring, "quiet", { extensions: [workflowCommand(invocations)] });
	rigs.push(rig);
	rig.engine.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("done")));
	Object.defineProperty(rig.host, "compactionActive", {
		configurable: true,
		get: () => rig.host.session.isCompacting,
	});
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

				releaseCompaction();
				await compaction;
				await waitFor("the host to observe the end of compaction", () => !rig.host.session.isCompacting);
				await rig.host.flushCompactionQueue({ willRetry: false });

				await waitFor("held prompts to reach the session in order", () =>
					isDeepEqual(getUserTexts(rig.engine), ["first prompt", "second prompt"]),
				);
				assert.deepEqual(rig.host.compactionQueuedMessages, []);
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
