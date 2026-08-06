import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import { RpcSessionBinding } from "../src/modes/rpc/rpc-session-binding.ts";
import type { RpcCommand } from "../src/modes/rpc/rpc-types.ts";
import { createHarness } from "./suite/harness.ts";

const RPC_OUTPUT_WAIT_TIMEOUT_MS = 10_000,
	RPC_OUTPUT_POLL_INTERVAL_MS = 5;

/**
 * Holds a bash command in flight until the test releases it.
 *
 * These tests must issue the session replacement *while* the execution is still
 * owned by the starting session. A fixed `sleep` cannot express that: the shell
 * writes before and after it can be delivered in a single pipe read, so the
 * observable output jumps straight to `beforeafter` and the intended in-flight
 * window never exists. Blocking on a marker file makes the window explicit and
 * independent of how the runtime chunks stdout.
 *
 * The marker lives in a freshly created temp directory that also serves as the
 * session cwd, so the command can name it relatively (no Windows path quoting)
 * and no leftover marker from an earlier run can release a later one early.
 */
function createBashGate(label: string) {
	const cwd = mkdtempSync(join(tmpdir(), `atomic-rpc-bash-${label}-`));
	return {
		cwd,
		command: (marker: string, before = "before", after = "after") =>
			`: > '${marker}.waiting'; printf '${before}'; while [ ! -f '${marker}' ]; do sleep 0.01; done; printf '${after}'`,
		isWaiting: (marker: string) => existsSync(join(cwd, `${marker}.waiting`)) && !existsSync(join(cwd, marker)),
		release: (marker: string) => writeFileSync(join(cwd, marker), ""),
		cleanup: () => {
			try {
				rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
			} catch {
				// Left for the OS to reclaim if a spawned shell still holds the cwd.
			}
		},
	};
}

async function createRealReplacementContext() {
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
	return {
		first,
		second,
		output,
		handle,
		cleanup: () => {
			binding.disposeSubscriptions();
			second.cleanup();
			first.cleanup();
		},
	};
}

function updatesFor(output: object[], id: string): string {
	return output
		.filter(
			(event) =>
				(event as { type?: string; id?: string }).type === "bash_execution_update" &&
				(event as { id?: string }).id === id,
		)
		.map((event) => (event as { delta: string }).delta)
		.join("");
}

async function waitForOutput(output: object[], id: string, expectedPrefix: string): Promise<void> {
	const deadline = Date.now() + RPC_OUTPUT_WAIT_TIMEOUT_MS;
	while (true) {
		const observed = updatesFor(output, id);
		if (observed.startsWith(expectedPrefix)) return;
		if (Date.now() >= deadline) {
			throw new Error(
				`Timed out after ${RPC_OUTPUT_WAIT_TIMEOUT_MS}ms waiting for RPC bash ${JSON.stringify(id)} output prefix ${JSON.stringify(expectedPrefix)}; observed accumulated output: ${JSON.stringify(observed)}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, RPC_OUTPUT_POLL_INTERVAL_MS));
	}
}

describe("RPC bash ownership across session replacement", () => {
	it("recognizes an expected prefix delivered in one coalesced RPC delta", async () => {
		const output = [{ type: "bash_execution_update", id: "coalesced", channel: "stdout", delta: "beforeafter" }];

		await waitForOutput(output, "coalesced", "before");
		expect(updatesFor(output, "coalesced")).toBe("beforeafter");
	});

	it("keeps targeted cancellation reachable in the starting session after replacement", async () => {
		const context = await createRealReplacementContext();
		vi.spyOn(context.first.session, "isStreaming", "get").mockReturnValue(true);
		const execution = context.handle({
			id: "old-target",
			type: "bash",
			command: "printf old-start; sleep 1; printf old-end",
		});
		await waitForOutput(context.output, "old-target", "old-start");
		await context.handle({ id: "replace", type: "new_session" });
		await expect(
			context.handle({ id: "cancel-old", type: "abort_bash", requestId: "old-target" }),
		).resolves.toMatchObject({ success: true });
		await expect(execution).resolves.toMatchObject({
			id: "old-target",
			success: true,
			data: { cancelled: true },
		});
		expect(updatesFor(context.output, "old-target")).toBe("old-start");
		const sourceReader = createRpcCommandHandler({
			runtimeHost: { services: { agentDir: context.first.tempDir } } as unknown as AgentSessionRuntime,
			getSession: () => context.first.session,
			rebindSession: async () => {},
			output: () => {},
		});
		const sourceEntries = (await sourceReader({ id: "source-entries", type: "get_entries" })) as {
			data: { entries: Array<{ type: string; message?: { role?: string } }> };
		};
		const targetEntries = (await context.handle({ id: "target-entries", type: "get_entries" })) as {
			data: { entries: Array<{ type: string; message?: { role?: string } }> };
		};
		expect(sourceEntries.data.entries.some((entry) => entry.message?.role === "bashExecution")).toBe(true);
		expect(targetEntries.data.entries.some((entry) => entry.message?.role === "bashExecution")).toBe(false);
		expect(context.first.session.messages.filter((message) => message.role === "bashExecution")).toHaveLength(1);
		expect(context.second.session.messages.filter((message) => message.role === "bashExecution")).toHaveLength(0);
		context.cleanup();
	});

	it("legacy abort reaches concurrent owners on both sides of a replacement", async () => {
		const context = await createRealReplacementContext();
		const oldExecution = context.handle({
			id: "old-all",
			type: "bash",
			command: "printf old-start; sleep 1; printf old-end",
		});
		await waitForOutput(context.output, "old-all", "old-start");
		await context.handle({ id: "replace", type: "new_session" });
		const newExecution = context.handle({
			id: "new-all",
			type: "bash",
			command: "printf new-start; sleep 1; printf new-end",
		});
		await waitForOutput(context.output, "new-all", "new-start");
		await context.handle({ id: "cancel-all", type: "abort_bash" });
		const [oldResult, newResult] = await Promise.all([oldExecution, newExecution]);
		expect(oldResult).toMatchObject({ success: true, data: { cancelled: true } });
		expect(newResult).toMatchObject({ success: true, data: { cancelled: true } });
		expect(updatesFor(context.output, "old-all")).toBe("old-start");
		expect(updatesFor(context.output, "new-all")).toBe("new-start");
		context.cleanup();
	});

	it("retains source ownership for every RPC replacement command and reload control", async () => {
		const gate = createBashGate("replacement");
		try {
			const first = await createHarness({ sessionManager: SessionManager.inMemory(gate.cwd) });
			const second = await createHarness();
			let current: AgentSession = first.session;
			const replace = async () => {
				current = second.session;
				return { cancelled: false };
			};
			const runtimeHost = {
				services: { agentDir: first.tempDir },
				get session() {
					return current;
				},
				newSession: replace,
				switchSession: replace,
				importFromJsonl: replace,
				fork: async () => ({ ...(await replace()), selectedText: undefined }),
			} as unknown as AgentSessionRuntime;
			const output: object[] = [];
			const handle = createRpcCommandHandler({
				runtimeHost,
				getSession: () => current,
				rebindSession: async () => {},
				output: (event) => output.push(event),
			});
			vi.spyOn(first.session.sessionManager, "getLeafId").mockReturnValue("leaf-for-clone");
			vi.spyOn(first.session, "reload").mockResolvedValue();
			const transitions: Array<{ name: string; command: RpcCommand; replaces: boolean }> = [
				{ name: "new", command: { id: "swap-new", type: "new_session" }, replaces: true },
				{
					name: "switch",
					command: { id: "swap-switch", type: "switch_session", sessionPath: "/tmp/target.jsonl" },
					replaces: true,
				},
				{
					name: "import",
					command: { id: "swap-import", type: "import_session", inputPath: "/tmp/import.jsonl" },
					replaces: true,
				},
				{ name: "fork", command: { id: "swap-fork", type: "fork", entryId: "entry" }, replaces: true },
				{ name: "clone", command: { id: "swap-clone", type: "clone" }, replaces: true },
				{ name: "reload", command: { id: "same-reload", type: "reload" }, replaces: false },
			];

			for (const transition of transitions) {
				current = first.session;
				const id = `bash-${transition.name}`;
				const marker = `${transition.name}.release`;
				const execution = handle({ id, type: "bash", command: gate.command(marker) });
				try {
					await waitForOutput(output, id, "before");
					await expect(handle(transition.command)).resolves.toMatchObject({ success: true });
					expect(current === second.session).toBe(transition.replaces);
				} finally {
					gate.release(marker);
				}
				await expect(execution).resolves.toMatchObject({ success: true, data: { output: "beforeafter" } });
				expect(updatesFor(output, id)).toBe("beforeafter");
			}
			expect(first.session.messages.filter((message) => message.role === "bashExecution")).toHaveLength(
				transitions.length,
			);
			expect(second.session.messages.filter((message) => message.role === "bashExecution")).toHaveLength(0);
			second.cleanup();
			first.cleanup();
		} finally {
			gate.cleanup();
		}
	});

	it("leaves ownership unchanged when a replacement is cancelled", async () => {
		const gate = createBashGate("cancelled-swap");
		try {
			const harness = await createHarness({ sessionManager: SessionManager.inMemory(gate.cwd) });
			const output: object[] = [];
			const runtimeHost = {
				services: { agentDir: harness.tempDir },
				newSession: async () => ({ cancelled: true }),
			} as unknown as AgentSessionRuntime;
			const handle = createRpcCommandHandler({
				runtimeHost,
				getSession: () => harness.session,
				rebindSession: async () => {
					throw new Error("must not rebind cancelled replacement");
				},
				output: (event) => output.push(event),
			});
			const marker = "cancelled-swap.release";
			const execution = handle({ id: "cancelled-swap-bash", type: "bash", command: gate.command(marker) });
			try {
				await waitForOutput(output, "cancelled-swap-bash", "before");
				await expect(handle({ id: "cancelled-swap", type: "new_session" })).resolves.toMatchObject({
					success: true,
					data: { cancelled: true },
				});
			} finally {
				gate.release(marker);
			}
			await expect(execution).resolves.toMatchObject({ success: true, data: { output: "beforeafter" } });
			expect(updatesFor(output, "cancelled-swap-bash")).toBe("beforeafter");
			harness.cleanup();
		} finally {
			gate.cleanup();
		}
	});

	it("does not append a late result to the shared target manager after an actual unpersisted clone", async () => {
		const gate = createBashGate("shared-manager");
		try {
			const source = await createHarness({ sessionManager: SessionManager.inMemory(gate.cwd) });
			source.session.recordBashResult("seed", {
				output: "seed",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			});
			const startingSessionId = source.sessionManager.getSessionId();
			let target: Awaited<ReturnType<typeof createHarness>> | undefined;
			const runtime = new AgentSessionRuntime(
				source.session,
				{ cwd: source.tempDir, agentDir: source.tempDir } as never,
				(async (options: { sessionManager: typeof source.sessionManager }) => {
					target = await createHarness({ sessionManager: options.sessionManager });
					target.session.agent.state.messages = options.sessionManager.buildSessionContext().messages;
					return {
						session: target.session,
						services: {
							cwd: target.tempDir,
							agentDir: target.tempDir,
							settingsManager: target.settingsManager,
							modelRegistry: target.session.modelRegistry,
							resourceLoader: target.session.resourceLoader,
						},
						diagnostics: [],
					};
				}) as never,
			);
			let current = source.session;
			const output: object[] = [];
			const handle = createRpcCommandHandler({
				runtimeHost: runtime,
				getSession: () => current,
				rebindSession: async () => {
					current = runtime.session;
				},
				output: (event) => output.push(event),
			});
			const marker = "shared-manager.release";
			const execution = handle({
				id: "shared-manager",
				type: "bash",
				command: gate.command(marker, "source", "result"),
			});
			try {
				await waitForOutput(output, "shared-manager", "source");
				expect(gate.isWaiting(marker)).toBe(true);
				await expect(handle({ id: "clone", type: "clone" })).resolves.toMatchObject({ success: true });
				expect(source.sessionManager.getSessionId()).not.toBe(startingSessionId);
			} finally {
				gate.release(marker);
			}

			await expect(execution).resolves.toMatchObject({ success: true, data: { output: "sourceresult" } });
			expect(source.session.messages.filter((message) => message.role === "bashExecution")).toHaveLength(2);
			expect(target?.session.messages.filter((message) => message.role === "bashExecution")).toHaveLength(1);
			expect(
				source.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "message" && entry.message.role === "bashExecution"),
			).toHaveLength(1);

			target?.cleanup();
			source.cleanup();
		} finally {
			gate.cleanup();
		}
	});

	it("cancels and drains active owners during RPC shutdown", async () => {
		const harness = await createHarness();
		const output: object[] = [];
		const handle = createRpcCommandHandler({
			runtimeHost: { services: { agentDir: harness.tempDir } } as unknown as AgentSessionRuntime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			output: (event) => output.push(event),
		});
		const execution = handle({ id: "shutdown-bash", type: "bash", command: "printf start; sleep 1; printf end" });
		await waitForOutput(output, "shutdown-bash", "start");
		await handle.disposeActiveBash();
		await expect(execution).resolves.toMatchObject({ success: true, data: { cancelled: true } });
		expect(updatesFor(output, "shutdown-bash")).toBe("start");
		harness.cleanup();
	});
});
