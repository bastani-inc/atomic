import { describe, expect, test, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import type { RpcEvent, RpcSessionState } from "../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const UNRESPONSIVE_REPLACEMENT_GUARD_MS = 1_000;

class InspectableAgentSessionRuntime extends AgentSessionRuntime {
	settleForTest(): Promise<void> {
		return this.settleActiveResponseBeforeTeardown();
	}
}

function servicesFor(harness: Harness) {
	return {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		settingsManager: harness.settingsManager,
		modelRegistry: harness.session.modelRegistry,
		resourceLoader: harness.session.resourceLoader,
	};
}

function createState(): RpcSessionState {
	return {
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "engine-session",
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
		queuedMessagesPaused: false,
	};
}

function createUnresponsiveEngineClient() {
	let eventListener: ((event: RpcEvent) => void) | undefined;
	let abortCalls = 0;
	let releaseAbort = () => {};
	const client = {
		onEvent(listener: (event: RpcEvent) => void) {
			eventListener = listener;
			return () => {
				if (eventListener === listener) eventListener = undefined;
			};
		},
		onGenerationEnded: () => () => {},
		switchSession: async (_sessionPath: string) => ({ cancelled: false }),
		getState: async () => createState(),
		requestInternal: async <T>(command: { type: string }): Promise<T> => {
			if (command.type === "get_available_models") {
				return { models: [], scopedModels: [] } as T;
			}
			return undefined as T;
		},
		getCommands: async () => [],
		abort: async () => {
			abortCalls += 1;
			await new Promise<void>((resolve) => {
				releaseAbort = resolve;
			});
		},
		stop: async () => {},
	};
	return {
		client,
		emit(event: RpcEvent): void {
			eventListener?.(event);
		},
		get abortCalls(): number {
			return abortCalls;
		},
		releaseAbort(): void {
			releaseAbort();
		},
	};
}

async function completesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("AgentSessionRuntime teardown settling", () => {
	test("does not abort an idle session before replacement", async () => {
		const harness = await createHarness();
		try {
			const runtime = new InspectableAgentSessionRuntime(
				harness.session,
				servicesFor(harness) as never,
				async () => {
					throw new Error("unused runtime factory");
				},
			);
			const abort = vi.spyOn(harness.session, "abort").mockResolvedValue();
			vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(false);

			await runtime.settleForTest();

			expect(abort).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
		}
	});

	test("aborts a streaming session before replacement", async () => {
		const harness = await createHarness();
		try {
			const runtime = new InspectableAgentSessionRuntime(
				harness.session,
				servicesFor(harness) as never,
				async () => {
					throw new Error("unused runtime factory");
				},
			);
			const abort = vi.spyOn(harness.session, "abort").mockResolvedValue();
			vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);

			await runtime.settleForTest();

			expect(abort).toHaveBeenCalledTimes(1);
		} finally {
			harness.cleanup();
		}
	});
});

describe("isolated interactive engine session replacement", () => {
	test("replaces a session even when the engine cannot answer abort", async () => {
		const first = await createHarness();
		const second = await createHarness();
		const targetManager = SessionManager.create(second.tempDir, second.tempDir);
		targetManager.flush();
		const targetSessionPath = targetManager.getSessionFile();
		if (!targetSessionPath) throw new Error("Missing target session path");

		const probe = createUnresponsiveEngineClient();
		const localRuntime = new AgentSessionRuntime(first.session, servicesFor(first) as never, async () => {
			throw new Error("unused local runtime factory");
		});
		const runtime = new IsolatedInteractiveRuntime(
			localRuntime,
			async () => ({ session: second.session, services: servicesFor(second), diagnostics: [] }) as never,
			probe.client as never,
		);
		probe.emit({ type: "agent_start" });
		expect(runtime.session.isStreaming).toBe(true);

		const replacement = runtime.switchSession(targetSessionPath);
		try {
			expect(await completesWithin(replacement, UNRESPONSIVE_REPLACEMENT_GUARD_MS)).toBe(true);
			expect(probe.abortCalls).toBe(0);
			expect(runtime.session).toBe(second.session);
		} finally {
			probe.releaseAbort();
			await replacement.catch(() => {});
			first.cleanup();
			second.cleanup();
		}
	});
});
