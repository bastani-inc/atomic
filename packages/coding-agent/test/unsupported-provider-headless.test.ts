import { ChildProcess, type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempRootReleasingBroker } from "../../../test/helpers/detached-broker.js";
import { SessionManager } from "../src/core/session-manager.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";
import { terminateRpcClientProcess } from "../src/modes/rpc/rpc-client-process.js";
import type { RpcCommand, RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { bunExecutable, cliPath, runCliProcess } from "./cli-test-helpers.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return { ...original, spawn: vi.fn(original.spawn), spawnSync: vi.fn(original.spawnSync) };
});

const RPC_COMMAND_TIMEOUT_MS = 30_000;
const REAL_HEADLESS_RPC_TEST_TIMEOUT_MS = 120_000;

const WARNING =
	"Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.";
const tempDirs: string[] = [];
const activeRpcs = new Set<RpcHarness>();

type RpcCommandBody = RpcCommand extends infer T ? (T extends { id?: string } ? Omit<T, "id"> : never) : never;

interface RpcHarness {
	send(command: RpcCommandBody): Promise<RpcResponse>;
	stop(): Promise<void>;
	stderr(): string;
	records(): Array<{ type?: string }>;
}

function writeIsolatedState(agentDir: string, baseUrl: string): void {
	const removedProvider = ["cur", "sor"].join("");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: removedProvider,
			defaultModel: ["composer", "-2"].join(""),
		}),
	);
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({
			[removedProvider]: { type: "api_key", key: "stale-proof" },
		}),
	);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				recovery: {
					baseUrl,
					api: "openai-responses",
					apiKey: "test-key",
					models: [
						{
							id: "recovery-model",
							name: "Recovery model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 16_000,
							maxTokens: 1024,
						},
						{
							id: "recovery-model-2",
							name: "Recovery model 2",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 16_000,
							maxTokens: 1024,
						},
					],
				},
			},
		}),
	);
}

function commonArgs(sessionId?: string): string[] {
	return [
		...(sessionId ? ["--session", sessionId] : ["--no-session"]),
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
	];
}

function isolatedEnv(agentDir: string, sessionDir: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		ATOMIC_CODING_AGENT_DIR: agentDir,
		ATOMIC_CODING_AGENT_SESSION_DIR: sessionDir,
		ATOMIC_OFFLINE: "1",
		ATOMIC_INTERACTIVE_ENGINE_CHILD: undefined,
		ATOMIC_INTERACTIVE_ENGINE_API_KEY: undefined,
		ATOMIC_INTERCOM_GROUP: undefined,
		PI_INTERCOM_GROUP: undefined,
		ATOMIC_SKIP_VERSION_CHECK: "1",
		NO_COLOR: "1",
	};
}

function startRpc(cwd: string, agentDir: string, sessionDir: string, sessionFile?: string): RpcHarness {
	const child = spawn(bunExecutable(), [cliPath, "--mode", "rpc", ...commonArgs(sessionFile)], {
		cwd,
		env: isolatedEnv(agentDir, sessionDir),
		stdio: "pipe",
		windowsHide: true,
	}) as ChildProcessWithoutNullStreams;
	let stderr = "";
	let nextId = 0;
	const pending = new Map<
		string,
		{ resolve(value: RpcResponse): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
	>();
	const records: Array<{ type?: string }> = [];
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const detach = attachJsonlLineReader(child.stdout, (line) => {
		const parsed = JSON.parse(line) as RpcResponse;
		records.push(parsed);
		if (parsed.type !== "response" || !parsed.id) return;
		const request = pending.get(parsed.id);
		if (!request) return;
		clearTimeout(request.timer);
		pending.delete(parsed.id);
		request.resolve(parsed);
	});
	child.once("exit", (code, signal) => {
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(new Error(`RPC exited code=${code} signal=${signal}: ${stderr}`));
		}
		pending.clear();
	});
	const closed =
		child.pid !== undefined
			? new Promise<void>((resolve) => {
					child.once("close", () => resolve());
				})
			: Promise.resolve();
	let stopping: Promise<void> | undefined;
	const harness: RpcHarness = {
		send(command) {
			const id = `unsupported_${++nextId}`;
			return new Promise<RpcResponse>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`Timed out waiting for ${command.type}: ${stderr}`));
				}, RPC_COMMAND_TIMEOUT_MS);
				pending.set(id, { resolve, reject, timer });
				child.stdin.write(serializeJsonLine({ ...command, id } as RpcCommand));
			});
		},
		stop() {
			stopping ??= (async () => {
				try {
					detach();
					child.stdout.resume();
					child.stderr.resume();
					if (
						process.platform === "win32" &&
						child.pid !== undefined &&
						child.exitCode === null &&
						child.signalCode === null
					) {
						const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
						spawnSync(
							win32.join(systemRoot, "System32", "taskkill.exe"),
							["/F", "/T", "/PID", String(child.pid)],
							{
								cwd: systemRoot,
								stdio: "ignore",
								windowsHide: true,
							},
						);
					}
					await terminateRpcClientProcess(child, false);
					child.stdin.destroy();
					await closed;
				} finally {
					activeRpcs.delete(harness);
				}
			})();
			return stopping;
		},
		stderr: () => stderr,
		records: () => [...records],
	};
	activeRpcs.add(harness);
	return harness;
}

function responseSuccess(response: RpcResponse): boolean {
	return response.type === "response" && response.success;
}

function responseError(response: RpcResponse): string | undefined {
	return response.type === "response" && !response.success ? response.error : undefined;
}

describe("headless RPC harness shutdown", () => {
	for (const alreadySignalled of [false, true]) {
		it(`waits for exit before cleanup when already signalled is ${alreadySignalled} (#4610)`, async () => {
			vi.useFakeTimers();
			const child = Object.assign(new ChildProcess(), {
				stdin: new PassThrough(),
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				killed: alreadySignalled,
			}) as ChildProcessWithoutNullStreams;
			child.kill = vi.fn(() => {
				child.killed = true;
				return true;
			});
			vi.mocked(spawn).mockReturnValueOnce(child);
			try {
				const rpc = startRpc("cwd", "agent", "sessions");
				let stopped = false;
				const stopping = rpc.stop().then(() => {
					stopped = true;
				});
				await vi.advanceTimersByTimeAsync(1_000);
				expect(stopped).toBe(false);
				expect(child.kill).toHaveBeenCalledWith("SIGKILL");
				child.emit("exit", null, "SIGKILL");
				await stopping;
				expect(stopped).toBe(true);
			} finally {
				vi.useRealTimers();
				vi.mocked(spawn).mockReset();
			}
		});
	}

	it("kills the Windows process tree and waits for stdio close before cleanup (#4655)", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { value: "win32" });
		vi.stubEnv("SystemRoot", "D:\\Windows");
		const events: string[] = [];
		const child = Object.assign(new ChildProcess(), {
			pid: 4242,
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			exitCode: null,
			signalCode: null,
		}) as ChildProcessWithoutNullStreams;
		child.kill = vi.fn(() => {
			events.push("kill");
			child.exitCode = 1;
			child.emit("exit", 1, null);
			return true;
		});
		vi.mocked(spawn).mockReturnValueOnce(child);
		vi.mocked(spawnSync).mockImplementationOnce((command, args, options) => {
			events.push("taskkill");
			expect(command).toBe(win32.join("D:\\Windows", "System32", "taskkill.exe"));
			expect(args).toEqual(["/F", "/T", "/PID", "4242"]);
			expect(options?.cwd).toBe("D:\\Windows");
			return { pid: 99, output: [], stdout: "", stderr: "", status: 0, signal: null };
		});
		try {
			const rpc = startRpc("cwd", "agent", "sessions");
			let stopped = false;
			const stopping = rpc.stop().then(() => {
				stopped = true;
			});
			await Promise.resolve();
			await Promise.resolve();
			expect(events).toEqual(["taskkill", "kill"]);
			expect(stopped).toBe(false);
			child.emit("close", 1, null);
			await stopping;
			expect(stopped).toBe(true);
		} finally {
			vi.unstubAllEnvs();
			Object.defineProperty(process, "platform", platform);
			vi.mocked(spawn).mockReset();
			vi.mocked(spawnSync).mockReset();
		}
	});
});

describe("unsupported provider in headless modes", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	let sessionDir: string;
	let persistedSessionId: string;
	let server: Server | undefined;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "atomic-unsupported-headless-"));
		tempDirs.push(root);
		cwd = join(root, "cwd");
		agentDir = join(root, "agent");
		sessionDir = join(root, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		server = createServer((_request, response) => {
			const event = {
				type: "response.completed",
				response: {
					id: "resp_recovered",
					status: "completed",
					usage: {
						input_tokens: 0,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens: 0,
						total_tokens: 0,
					},
				},
			};
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		writeIsolatedState(agentDir, `http://127.0.0.1:${address.port}/v1`);
		const removedProvider = ["cur", "sor"].join("");
		const persisted = await SessionManager.create(cwd, sessionDir);
		await persisted.appendModelChange(removedProvider, ["composer", "-2"].join(""));
		await persisted.appendMessage({
			role: "user",
			content: [{ type: "text", text: "persisted stale model" }],
			timestamp: Date.now(),
		});
		await persisted.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "persisted stale response" }],
			api: "anthropic-messages",
			provider: removedProvider,
			model: ["composer", "-2"].join(""),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const createdFile = persisted.getSessionFile();
		if (!createdFile) throw new Error("persisted session fixture did not create a file");
		persistedSessionId = persisted.getSessionId();
	});

	afterEach(async () => {
		for (const rpc of [...activeRpcs]) await rpc.stop();
		if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
		server = undefined;
		for (const dir of tempDirs.splice(0)) await removeTempRootReleasingBroker(dir);
	});

	for (const mode of ["text", "json"] as const) {
		it(`${mode} print fails before prompting and keeps stdout clean`, async () => {
			const args =
				mode === "text"
					? ["-p", "do not send", ...commonArgs()]
					: ["--mode", "json", "do not send", ...commonArgs()];
			const result = await runCliProcess(args, { cwd, env: isolatedEnv(agentDir, sessionDir) });
			expect(result.timedOut).toBe(false);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(WARNING);
			expect(result.stderr).not.toContain("API key");
			expect(result.stdout).toBe("");
			for (const line of result.stdout.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
		});
	}

	for (const mode of ["text", "json"] as const) {
		it(`${mode} print classifies a persisted stale model plus unsupported default before prompting`, async () => {
			const args =
				mode === "text"
					? ["-p", "do not send", ...commonArgs(persistedSessionId)]
					: ["--mode", "json", "do not send", ...commonArgs(persistedSessionId)];
			const result = await runCliProcess(args, { cwd, env: isolatedEnv(agentDir, sessionDir) });
			expect(result.timedOut).toBe(false);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(WARNING);
			expect(result.stderr).not.toContain("API key");
			expect(result.stdout).toBe("");
		});
	}

	it(
		"RPC keeps persisted stale state recoverable through explicit set_model",
		async () => {
			const rpc = startRpc(cwd, agentDir, sessionDir, persistedSessionId);
			try {
				const blocked = await rpc.send({ type: "prompt", message: "blocked persisted prompt" });
				expect(responseError(blocked)).toBe(WARNING);
				expect(responseError(blocked)).not.toContain("API key");
				expect(responseSuccess(await rpc.send({ type: "get_available_models" }))).toBe(true);
				expect(
					responseSuccess(await rpc.send({ type: "set_model", provider: "recovery", modelId: "recovery-model" })),
				).toBe(true);
				expect(responseSuccess(await rpc.send({ type: "prompt", message: "recovered" }))).toBe(true);
				await expect
					.poll(() => rpc.records().some((record) => record.type === "agent_end"), {
						timeout: RPC_COMMAND_TIMEOUT_MS,
					})
					.toBe(true);
				expect(rpc.stderr()).not.toContain("API key");
			} finally {
				await rpc.stop();
			}
		},
		REAL_HEADLESS_RPC_TEST_TIMEOUT_MS,
	);
	it(
		"RPC cycle_model clears persisted unsupported lock before the next prompt",
		async () => {
			const rpc = startRpc(cwd, agentDir, sessionDir, persistedSessionId);
			try {
				expect(responseError(await rpc.send({ type: "prompt", message: "blocked before cycle" }))).toBe(WARNING);
				const cycled = await rpc.send({ type: "cycle_model", direction: "forward" });
				expect(responseSuccess(cycled)).toBe(true);
				const prompt = await rpc.send({ type: "prompt", message: "recovered by cycle" });
				expect(responseSuccess(prompt)).toBe(true);
				await expect
					.poll(() => rpc.records().some((record) => record.type === "agent_end"), {
						timeout: RPC_COMMAND_TIMEOUT_MS,
					})
					.toBe(true);
				expect(rpc.stderr()).not.toContain("API key");
			} finally {
				await rpc.stop();
			}
		},
		REAL_HEADLESS_RPC_TEST_TIMEOUT_MS,
	);
	it(
		"RPC remains live and accepts set_model recovery before prompting",
		async () => {
			const rpc = startRpc(cwd, agentDir, sessionDir);
			try {
				const blocked = await rpc.send({ type: "prompt", message: "blocked" });
				expect(responseError(blocked)).toBe(WARNING);
				expect(responseError(blocked)).not.toContain("API key");
				const catalog = await rpc.send({ type: "get_available_models" });
				expect(responseSuccess(catalog)).toBe(true);
				const recovered = await rpc.send({ type: "set_model", provider: "recovery", modelId: "recovery-model" });
				expect(responseSuccess(recovered)).toBe(true);
				const prompt = await rpc.send({ type: "prompt", message: "recovered" });
				expect(responseSuccess(prompt)).toBe(true);
				await expect
					.poll(() => rpc.records().some((record) => record.type === "agent_end"), {
						timeout: RPC_COMMAND_TIMEOUT_MS,
					})
					.toBe(true);
				expect(rpc.stderr()).not.toContain("API key");
			} finally {
				await rpc.stop();
			}
		},
		REAL_HEADLESS_RPC_TEST_TIMEOUT_MS,
	);
});
