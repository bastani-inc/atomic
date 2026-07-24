import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../src/core/agent-session-persistent-custom-messages.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type ShutdownContext = {
	isShuttingDown: boolean;
	runtimeHost: AgentSessionRuntime;
	themeController: { disableAutoSync(): void };
	ui: { terminal: { drainInput(maxMs: number, idleMs: number): Promise<void> } };
	stop(): void;
	sessionManager: Harness["session"]["sessionManager"];
};

const shutdown = Reflect.get(InteractiveMode.prototype, "shutdown") as (
	this: ShutdownContext,
	options?: { fromSignal?: boolean },
) => Promise<void>;

function runtimeFor(harness: Harness): AgentSessionRuntime {
	const unusedFactory = (async () => {
		throw new Error("replacement factory must not run during shutdown");
	}) as CreateAgentSessionRuntimeFactory;
	return new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.session.sessionManager.getCwd(), agentDir: harness.tempDir } as AgentSessionServices,
		unusedFactory,
	);
}

async function queueProtectedHold(harness: Harness): Promise<void> {
	harness.session.pauseQueuedMessages();
	await harness.session.sendCustomMessage(
		{
			customType: "paused-shutdown-protected-card",
			content: [{ type: "text", text: "persist without a provider turn" }],
			display: true,
			details: { retained: true },
		},
		{ triggerTurn: true, persistWhenStreaming: true },
	);
}

function hiddenEntries(harness: Harness) {
	return harness.session.sessionManager.getEntries().filter(
		(entry) => entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE,
	);
}

describe("paused protected reconciliation shutdown", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	test("AgentSessionRuntime.dispose persists a held protected reconciliation without starting a turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await queueProtectedHold(harness);
		const responsesBeforeDispose = harness.getPendingResponseCount();

		await expect(runtimeFor(harness).dispose()).resolves.toBeUndefined();

		expect(harness.getPendingResponseCount()).toBe(responsesBeforeDispose);
		expect(hiddenEntries(harness)).toHaveLength(1);
		expect(hiddenEntries(harness)[0]).toMatchObject({
			display: false,
			content: [{ type: "text", text: "persist without a provider turn" }],
		});
	});

	test("InteractiveMode shutdown completes with a paused protected hold", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await queueProtectedHold(harness);
		const events: string[] = [];
		const exit = new Error("test process exit");
		vi.spyOn(process, "exit").mockImplementation((() => { throw exit; }) as typeof process.exit);
		const context: ShutdownContext = {
			isShuttingDown: false,
			runtimeHost: runtimeFor(harness),
			themeController: { disableAutoSync() { events.push("theme"); } },
			ui: { terminal: { async drainInput() { events.push("drain"); } } },
			stop() { events.push("stop"); },
			sessionManager: harness.session.sessionManager,
		};

		await expect(shutdown.call(context)).rejects.toBe(exit);

		expect(context.isShuttingDown).toBe(true);
		expect(events).toEqual(["theme", "drain", "stop"]);
		expect(hiddenEntries(harness)).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
