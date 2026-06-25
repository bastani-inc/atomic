import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";
import type { RpcCommand, RpcResponse } from "../src/modes/rpc/rpc-types.ts";

type RpcCommandBody = RpcCommand extends infer T ? (T extends { id?: string } ? Omit<T, "id"> : never) : never;

interface PendingRequest {
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
	timeout: ReturnType<typeof setTimeout>;
}

interface RpcHarness {
	send(command: RpcCommandBody): Promise<RpcResponse>;
	stop(): Promise<void>;
	getStderr(): string;
}

function bunExecutable(): string {
	const npmExecPath = process.env.npm_execpath;
	if (npmExecPath?.endsWith("bun") || npmExecPath?.endsWith("bun.exe")) {
		return npmExecPath;
	}
	return "bun";
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, "..");
const CLI_PATH = resolve(PACKAGE_ROOT, "src/cli.ts");

function writeCustomModels(agentDir: string): void {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				custom: {
					baseUrl: "https://example.invalid/v1",
					apiKey: "test-key",
					api: "openai-responses",
					models: [
						{
							id: "selectable-context",
							name: "Selectable Context",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 400_000,
							contextWindowOptions: [1_000_000],
							maxTokens: 4096,
						},
					],
				},
			},
		}),
	);
}

function readPersistedDefaultContextWindow(agentDir: string): number | undefined {
	const settingsPath = join(agentDir, "settings.json");
	if (!existsSync(settingsPath)) {
		return undefined;
	}
	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { defaultContextWindow?: number };
	return settings.defaultContextWindow;
}

function startRpcHarness(options: { cwd: string; agentDir: string; sessionDir: string }): RpcHarness {
	const child = spawn(
		bunExecutable(),
		[
			CLI_PATH,
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--model",
			"custom/selectable-context",
		],
		{
			cwd: options.cwd,
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: options.agentDir,
				ATOMIC_CODING_AGENT_SESSION_DIR: options.sessionDir,
				ATOMIC_OFFLINE: "1",
				ATOMIC_SKIP_VERSION_CHECK: "1",
				NO_COLOR: "1",
			},
			stdio: "pipe",
		},
	) as ChildProcessWithoutNullStreams;

	let requestId = 0;
	let stderr = "";
	const pending = new Map<string, PendingRequest>();

	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});

	const rejectPending = (error: Error): void => {
		for (const [id, request] of pending) {
			clearTimeout(request.timeout);
			pending.delete(id);
			request.reject(error);
		}
	};

	child.once("exit", (code, signal) => {
		rejectPending(new Error(`RPC child exited before response (code=${code} signal=${signal}). Stderr: ${stderr}`));
	});
	child.once("error", (error) => {
		rejectPending(error);
	});

	const detachStdout = attachJsonlLineReader(child.stdout, (line) => {
		const parsed = JSON.parse(line) as { type?: string; id?: string };
		if (parsed.type !== "response" || !parsed.id) {
			return;
		}
		const request = pending.get(parsed.id);
		if (!request) {
			return;
		}
		pending.delete(parsed.id);
		clearTimeout(request.timeout);
		request.resolve(parsed as RpcResponse);
	});

	return {
		send(command) {
			const id = `ctx_${++requestId}`;
			const fullCommand = { ...command, id } as RpcCommand;
			return new Promise<RpcResponse>((resolve, reject) => {
				const timeout = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`Timed out waiting for ${command.type}. Stderr: ${stderr}`));
				}, 10_000);
				pending.set(id, { resolve, reject, timeout });
				child.stdin.write(serializeJsonLine(fullCommand));
			});
		},
		async stop() {
			detachStdout();
			for (const [id, request] of pending) {
				clearTimeout(request.timeout);
				pending.delete(id);
				request.reject(new Error("RPC harness stopped before response"));
			}
			if (child.exitCode !== null || child.killed) {
				return;
			}
			child.kill("SIGTERM");
			await new Promise<void>((resolveStop) => {
				const timeout = setTimeout(() => {
					child.kill("SIGKILL");
					resolveStop();
				}, 1_000);
				child.once("exit", () => {
					clearTimeout(timeout);
					resolveStop();
				});
			});
		},
		getStderr() {
			return stderr;
		},
	};
}

function responseData<T>(response: RpcResponse): T {
	if (!response.success) {
		throw new Error(response.error);
	}
	return response.data as T;
}

describe("RPC context-window commands", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let sessionDir: string;
	let rpc: RpcHarness | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-rpc-context-window-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "cwd");
		agentDir = join(tempDir, "agent");
		sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		writeCustomModels(agentDir);
	});

	afterEach(async () => {
		await rpc?.stop();
		rpc = undefined;
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("lists the current model's available context windows", async () => {
		rpc = startRpcHarness({ cwd, agentDir, sessionDir });

		const response = await rpc.send({ type: "get_available_context_windows" });

		expect(response).toMatchObject({ type: "response", command: "get_available_context_windows", success: true });
		expect(responseData(response)).toEqual({
			contextWindows: [400_000, 1_000_000],
			currentContextWindow: 400_000,
			supportsSelection: true,
		});
	}, 20_000);

	test("sets the runtime context window without persisting default settings", async () => {
		rpc = startRpcHarness({ cwd, agentDir, sessionDir });

		const setResponse = await rpc.send({ type: "set_context_window", contextWindow: "1m" });
		expect(setResponse).toMatchObject({ type: "response", command: "set_context_window", success: true });

		const stateResponse = await rpc.send({ type: "get_state" });
		const state = responseData<{ model?: { contextWindow?: number } }>(stateResponse);
		expect(state.model?.contextWindow).toBe(1_000_000);
		expect(readPersistedDefaultContextWindow(agentDir)).toBeUndefined();
	}, 20_000);

	test("set_model returns the effective session model after context-window replay", async () => {
		rpc = startRpcHarness({ cwd, agentDir, sessionDir });

		await rpc.send({ type: "set_context_window", contextWindow: "1m" });
		const response = await rpc.send({ type: "set_model", provider: "custom", modelId: "selectable-context" });

		expect(response).toMatchObject({ type: "response", command: "set_model", success: true });
		const model = responseData<{ contextWindow?: number }>(response);
		expect(model.contextWindow).toBe(1_000_000);
	}, 20_000);

	test("returns a clear error for unsupported runtime context windows", async () => {
		rpc = startRpcHarness({ cwd, agentDir, sessionDir });

		const response = await rpc.send({ type: "set_context_window", contextWindow: 2_000_000 });

		expect(response).toMatchObject({ type: "response", command: "set_context_window", success: false });
		if (response.success) {
			throw new Error("Expected set_context_window to fail");
		}
		expect(response.error).toContain("Context window 2m is not supported by custom/selectable-context");
		expect(response.error).toContain("Supported values: 400k, 1m");
	}, 20_000);
});
