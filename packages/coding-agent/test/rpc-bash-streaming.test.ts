import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import { createRpcInputLineHandler } from "../src/modes/rpc/rpc-input.ts";
import { createRpcInputScheduler } from "../src/modes/rpc/rpc-input-scheduler.ts";
import { RpcSessionBinding } from "../src/modes/rpc/rpc-session-binding.ts";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { delayedOutputCommand, gatedOutputCommand, outputCommand } from "./helpers/rpc-shell-commands.js";
import { createHarness } from "./suite/harness.ts";

function runtimeFor(session: Awaited<ReturnType<typeof createHarness>>["session"]): AgentSessionRuntime {
	return { session, services: { agentDir: "/tmp/unused" } } as AgentSessionRuntime;
}

function handlerFor(harness: Awaited<ReturnType<typeof createHarness>>, output: (value: object) => void = () => {}) {
	return createRpcCommandHandler({
		runtimeHost: runtimeFor(harness.session),
		getSession: () => harness.session,
		rebindSession: async () => {},
		output,
	});
}

const REPLACEMENT_READY_TIMEOUT_MS = 10_000;
const REPLACEMENT_SETTLE_TIMEOUT_MS = 10_000;
const REPLACEMENT_DRAIN_TIMEOUT_MS = 5_000;

async function settleWithin<T>(pending: Promise<T>, timeoutMs: number, description: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([pending, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

async function runEveryCleanup(steps: ReadonlyArray<() => unknown>): Promise<void> {
	const failures: unknown[] = [];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, `${failures.length} cleanup steps failed`);
}

describe("correlated RPC bash streaming", () => {
	it("preserves observed stdout/stderr order in typed events before completion", async () => {
		const harness = await createHarness();
		const events: Array<{ id?: string; channel: "stdout" | "stderr"; delta: string }> = [];
		let executionEnv: NodeJS.ProcessEnv | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "bash_execution_update")
				events.push({ id: event.id, channel: event.channel, delta: event.delta });
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				executionEnv = options.env;
				options.onData(Buffer.from("out-1"), "stdout");
				options.onData(Buffer.from("err-1"), "stderr");
				options.onData(Buffer.from("out-2"), "stdout");
				return { exitCode: 0 };
			},
		};
		const result = await harness.session.executeBash("custom", undefined, { id: "rpc-order", operations });
		expect(events).toEqual([
			{ id: "rpc-order", channel: "stdout", delta: "out-1" },
			{ id: "rpc-order", channel: "stderr", delta: "err-1" },
			{ id: "rpc-order", channel: "stdout", delta: "out-2" },
		]);
		expect(executionEnv).toMatchObject({
			ATOMIC_SESSION_ID: harness.session.sessionId,
			PI_SESSION_ID: harness.session.sessionId,
			ATOMIC_PROVIDER: harness.session.model?.provider,
			PI_PROVIDER: harness.session.model?.provider,
		});
		expect(result).toMatchObject({ output: "out-1err-1out-2", exitCode: 0, cancelled: false });
		harness.cleanup();
	});

	it("correlates direct RPC bash output and returns one terminal response", async () => {
		const harness = await createHarness();
		const updates: Array<{ id?: string; channel: string; delta: string }> = [];
		const handle = handlerFor(harness, (event) => {
			if ((event as { type?: string }).type === "bash_execution_update") {
				updates.push(event as { id?: string; channel: string; delta: string });
			}
		});
		const response = await handle({
			id: "rpc-direct",
			type: "bash",
			command: `${outputCommand("stdout")}; ${outputCommand("stderr", "stderr")}`,
		});
		expect(updates.map(({ id, channel, delta }) => ({ id, channel, delta }))).toEqual([
			{ id: "rpc-direct", channel: "stdout", delta: "stdout" },
			{ id: "rpc-direct", channel: "stderr", delta: "stderr" },
		]);
		expect(response).toMatchObject({
			id: "rpc-direct",
			type: "response",
			command: "bash",
			success: true,
			data: { output: "stdoutstderr", exitCode: 0, cancelled: false },
		});
		harness.cleanup();
	});

	it("isolates concurrent request streams and targets cancellation by request ID", async () => {
		const harness = await createHarness();
		const updates: Array<{ id?: string; delta: string }> = [];
		const handle = handlerFor(harness, (event) => {
			if ((event as { type?: string }).type === "bash_execution_update") {
				updates.push({ id: (event as { id?: string }).id, delta: (event as { delta: string }).delta });
			}
		});
		const first = handle({
			id: "rpc-cancel",
			type: "bash",
			command: delayedOutputCommand("cancel-start", 1, "cancel-end"),
		});
		const second = handle({
			id: "rpc-keep",
			type: "bash",
			command: delayedOutputCommand("keep-start", 0.1, "keep-end"),
		});
		while (!updates.some((event) => event.id === "rpc-cancel") || !updates.some((event) => event.id === "rpc-keep")) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const abortResponse = await handle({ id: "abort-command", type: "abort_bash", requestId: "rpc-cancel" });
		const [cancelled, kept] = await Promise.all([first, second]);
		expect(abortResponse).toMatchObject({ id: "abort-command", success: true });
		expect(cancelled).toMatchObject({ id: "rpc-cancel", success: true, data: { cancelled: true } });
		expect(kept).toMatchObject({ id: "rpc-keep", success: true, data: { cancelled: false, exitCode: 0 } });
		expect(
			updates
				.filter((event) => event.id === "rpc-cancel")
				.map((event) => event.delta)
				.join(""),
		).toContain("cancel-start");
		expect(
			updates
				.filter((event) => event.id === "rpc-cancel")
				.map((event) => event.delta)
				.join(""),
		).not.toContain("cancel-end");
		expect(
			updates
				.filter((event) => event.id === "rpc-keep")
				.map((event) => event.delta)
				.join(""),
		).toBe("keep-startkeep-end");
		harness.cleanup();
	});

	// #3105: replacement drains cancelled shell output into its original session.
	it("keeps cancelled bash output with its source during real session replacement (#4220)", async ({
		onTestFinished,
	}) => {
		const first = await createHarness();
		const second = await createHarness();
		const secondServices = {
			cwd: second.tempDir,
			agentDir: second.tempDir,
			settingsManager: second.settingsManager,
			modelRegistry: second.session.modelRegistry,
			resourceLoader: second.session.resourceLoader,
		};
		const runtime = new AgentSessionRuntime(
			first.session,
			{ cwd: first.tempDir, agentDir: first.tempDir } as never,
			async () => ({ session: second.session, services: secondServices, diagnostics: [] }) as never,
		);
		const output: object[] = [];
		const binding = new RpcSessionBinding({
			runtimeHost: runtime,
			output: (event) => output.push(event),
			pendingExtensionRequests: new Map(),
			requestShutdown: () => {},
		});
		await binding.rebindSession();
		const handle = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => binding.currentSession,
			rebindSession: () => binding.rebindSession(),
			output: (event) => output.push(event),
		});

		const releaseMarker = join(first.tempDir, "replacement-bash.release");
		const bash = handle({
			id: "replacement-bash",
			type: "bash",
			command: gatedOutputCommand(releaseMarker, "before", "after"),
		});
		onTestFinished(() =>
			runEveryCleanup([
				() => first.session.abortBash("replacement-bash"),
				() => writeFileSync(releaseMarker, ""),
				() =>
					settleWithin(
						bash.catch(() => undefined),
						REPLACEMENT_DRAIN_TIMEOUT_MS,
						"the replacement bash request to drain",
					),
				() => binding.disposeSubscriptions(),
				() => second.cleanup(),
				() => first.cleanup(),
			]),
		);
		await vi.waitFor(
			() => {
				const started = output.some(
					(event) =>
						(event as { type?: string; delta?: string }).type === "bash_execution_update" &&
						(event as { delta?: string }).delta === "before",
				);
				if (!started) throw new Error("bash has not streamed its first output yet");
			},
			{ timeout: REPLACEMENT_READY_TIMEOUT_MS, interval: 5 },
		);
		const [replacement, bashResult] = await settleWithin(
			Promise.all([handle({ id: "replace", type: "new_session" }), bash]),
			REPLACEMENT_SETTLE_TIMEOUT_MS,
			"session replacement to cancel the bash request",
		);
		expect(replacement).toMatchObject({ success: true });
		expect(bashResult).toMatchObject({
			id: "replacement-bash",
			success: true,
			data: { output: "before", cancelled: true },
		});
		const updates = output
			.filter((event) => (event as { type?: string }).type === "bash_execution_update")
			.map((event) => (event as { id?: string; delta?: string }).delta);
		expect(updates).toEqual(["before"]);
		expect(first.session.messages.filter((message) => message.role === "bashExecution")).toHaveLength(1);
		expect(second.session.messages.filter((message) => message.role === "bashExecution")).toHaveLength(0);
	});

	it("emits exactly one correlated error response when bash execution throws", async () => {
		const harness = await createHarness();
		vi.spyOn(harness.session, "executeBash").mockRejectedValueOnce(new Error("spawn failed exactly once"));
		const output: object[] = [];
		const handle = handlerFor(harness, (value) => output.push(value));
		const handleLine = createRpcInputLineHandler({
			output: (value) => output.push(value),
			pendingExtensionRequests: new Map(),
			handleCommand: handle,
			checkShutdownRequested: async () => {},
		});
		await handleLine(JSON.stringify({ id: "rpc-error", type: "bash", command: "ignored" }));
		expect(output).toEqual([
			{
				id: "rpc-error",
				type: "response",
				command: "bash",
				success: false,
				error: "spawn failed exactly once",
			} satisfies RpcResponse,
		]);
		await expect(handle.disposeActiveBash()).resolves.toBeUndefined();
		harness.cleanup();
	});

	it("schedules separate bash requests concurrently while retaining the ordered ordinary lane", async () => {
		const started: string[] = [],
			releases = new Map<string, () => void>();
		const scheduler = createRpcInputScheduler(async (line) => {
			const value = JSON.parse(line) as { id: string; type: string };
			started.push(value.id);
			if (value.type === "bash") await new Promise<void>((resolve) => releases.set(value.id, resolve));
		});
		scheduler(JSON.stringify({ id: "bash-a", type: "bash", command: "a" }));
		scheduler(JSON.stringify({ id: "ordinary", type: "get_state" }));
		scheduler(JSON.stringify({ id: "bash-b", type: "bash", command: "b" }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(started).toEqual(["bash-a", "ordinary", "bash-b"]);
		releases.get("bash-a")?.();
		releases.get("bash-b")?.();
	});

	it("does not let a model refresh block a model selection on the ordinary lane", async () => {
		const started: string[] = [];
		let releaseRefresh!: () => void;
		const scheduler = createRpcInputScheduler(async (line) => {
			const value = JSON.parse(line) as { id: string; type: string };
			started.push(value.id);
			if (value.type === "refresh_models") {
				await new Promise<void>((resolve) => {
					releaseRefresh = resolve;
				});
			}
		});

		scheduler(JSON.stringify({ id: "refresh", type: "refresh_models" }));
		scheduler(JSON.stringify({ id: "select", type: "set_model", provider: "openai", modelId: "gpt" }));
		await vi.waitFor(() => expect(started).toEqual(["refresh", "select"]));
		releaseRefresh();
	});

	it("streams correlated channels through the isolated runtime and maps targeted cancellation", async () => {
		const harness = await createHarness();
		let release!: () => void;
		const aborted: Array<string | undefined> = [];
		const client = {
			onEvent: () => () => {},
			onGenerationEnded: () => () => {},
			userBashWithUpdates: async (
				_command: string,
				onUpdate: (delta: string, channel: "stdout" | "stderr") => void,
				options: { onRequestId?: (id: string) => void },
			) => {
				options.onRequestId?.("engine-request-1");
				onUpdate("out", "stdout");
				onUpdate("err", "stderr");
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return { output: "outerr", exitCode: undefined, cancelled: true, truncated: false };
			},
			abortBash: async (requestId?: string) => {
				aborted.push(requestId);
			},
		};
		const local = new AgentSessionRuntime(
			harness.session,
			{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
			async () => {
				throw new Error("unused isolated runtime factory");
			},
		);
		const runtime = new IsolatedInteractiveRuntime(
			local,
			async () => {
				throw new Error("unused");
			},
			client as never,
		);
		const chunks: Array<{ delta: string; channel: string }> = [];
		const execution = runtime.session.executeBash("remote", (delta, channel) => chunks.push({ delta, channel }), {
			id: "local-request",
		});
		expect(runtime.session.isBashRunning).toBe(true);
		runtime.session.abortBash("local-request");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(aborted).toEqual(["engine-request-1"]);
		expect(chunks).toEqual([
			{ delta: "out", channel: "stdout" },
			{ delta: "err", channel: "stderr" },
		]);
		release();
		await expect(execution).resolves.toMatchObject({ cancelled: true });
		expect(runtime.session.isBashRunning).toBe(false);
		harness.cleanup();
	});
});
