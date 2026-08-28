import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Server } from "ssh2";
import { describe, test } from "vitest";
import {
	bashResultFromExecOutcome,
	createRunEnvironmentExecTransport,
	type RemoteOperatingSystem,
	type RunEnvironmentProcess,
	type RunEnvironmentProcessResult,
	type RunEnvironmentProcessRunner,
} from "../../packages/workflows/src/runs/shared/run-environment-exec.js";
import { createRunEnvironmentWriteToolDefinition } from "../../packages/workflows/src/runs/shared/run-environment-tools.js";
import { reportedCoderAgent } from "../helpers/coder-agent.js";
import { spawnSyncCollect } from "../helpers/runtime.js";

const reportedAgents = {
	linux: await reportedCoderAgent("linux"),
	darwin: await reportedCoderAgent("darwin"),
	windows: await reportedCoderAgent("windows"),
};

interface RecordedProcess {
	readonly command: string;
	readonly args: readonly string[];
	readonly process: ScriptedProcess;
}

class ScriptedProcess implements RunEnvironmentProcess {
	private readonly events = new EventEmitter();
	private readonly resultPromise: Promise<RunEnvironmentProcessResult>;
	private resolveResult!: (result: RunEnvironmentProcessResult) => void;
	private settled = false;
	killed = false;
	settleOnKill = true;
	readonly killSignals: NodeJS.Signals[] = [];
	stdin?: Buffer;
	stdinEnded = false;
	stdinError?: Error;
	get finished(): boolean {
		return this.settled;
	}

	constructor() {
		this.resultPromise = new Promise((resolve) => {
			this.resolveResult = resolve;
		});
	}

	onStdout(listener: (chunk: Buffer) => void): void {
		this.events.on("stdout", listener);
	}

	onStderr(listener: (chunk: Buffer) => void): void {
		this.events.on("stderr", listener);
	}

	writeStdout(value: string): void {
		if (!this.settled) this.events.emit("stdout", Buffer.from(value));
	}

	writeStderr(value: string): void {
		if (!this.settled) this.events.emit("stderr", Buffer.from(value));
	}
	async endStdin(content?: Buffer): Promise<void> {
		this.stdin = content;
		this.stdinEnded = true;
		if (this.stdinError !== undefined) throw this.stdinError;
	}

	wait(): Promise<RunEnvironmentProcessResult> {
		return this.resultPromise;
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		this.killed = true;
		this.killSignals.push(signal);
		if (this.settleOnKill) queueMicrotask(() => this.finish(null, signal));
	}

	finish(code: number | null, signal: NodeJS.Signals | null = null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveResult({ code, signal });
	}
}

function expandProxyCommandPercentTokens(value: string): string | undefined {
	let expanded = "";
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] !== "%") {
			expanded += value[index];
			continue;
		}
		if (value[index + 1] !== "%") return undefined;
		expanded += "%";
		index += 1;
	}
	return expanded;
}

function splitProxyCommand(value: string): readonly string[] | undefined {
	const expanded = expandProxyCommandPercentTokens(value);
	if (expanded === undefined) return undefined;
	const tokens: string[] = [];
	let token = "";
	let quote: "single" | "double" | undefined;
	for (let index = 0; index < expanded.length; index += 1) {
		const character = expanded[index];
		if (character === "'" && quote !== "double") {
			quote = quote === "single" ? undefined : "single";
			continue;
		}
		if (character === '"' && quote !== "single") {
			quote = quote === "double" ? undefined : "double";
			continue;
		}
		if (quote !== "single" && (character === "$" || character === "`")) return undefined;
		if (quote !== "single" && character === "\\" && expanded[index + 1] === '"') {
			token += '"';
			index += 1;
			continue;
		}
		if (quote === undefined && character === " ") {
			if (token.length > 0) tokens.push(token);
			token = "";
			continue;
		}
		token += character;
	}
	if (quote !== undefined) return undefined;
	if (token.length > 0) tokens.push(token);
	return tokens;
}

class ScriptedRunner implements RunEnvironmentProcessRunner {
	readonly processes: RecordedProcess[] = [];
	readonly master = new ScriptedProcess();
	executeStarted?: (process: ScriptedProcess) => void;
	executeCompletes = true;
	checkMaster?: (process: ScriptedProcess, checkNumber: number) => void;
	exitMaster?: (process: ScriptedProcess) => void;
	executionStdinError?: Error;
	private masterStarted = false;
	private checkCount = 0;

	start(command: string, args: readonly string[]): RunEnvironmentProcess {
		const isMaster = args.includes("-M");
		const process = isMaster ? this.master : new ScriptedProcess();
		this.processes.push({ command, args: [...args], process });
		if (args[0] === "config-ssh") {
			queueMicrotask(() => process.finish(0));
		} else if (isMaster) {
			this.masterStarted = true;
		} else if (args.includes("check")) {
			this.checkCount += 1;
			const checkNumber = this.checkCount;
			queueMicrotask(() => {
				if (this.checkMaster !== undefined) this.checkMaster(process, checkNumber);
				else process.finish(this.masterStarted && !this.master.finished ? 0 : 255);
			});
		} else if (args[args.indexOf("-O") + 1] === "proxy") {
			const controlPathIndex = args.indexOf("-S");
			queueMicrotask(() => {
				const reachesMaster =
					this.masterStarted &&
					!this.master.finished &&
					controlPathIndex >= 0 &&
					args[controlPathIndex + 1]?.endsWith("master.sock") === true;
				process.finish(reachesMaster ? 0 : 255);
			});
		} else if (args.includes("exit")) {
			queueMicrotask(() => {
				if (this.exitMaster !== undefined) this.exitMaster(process);
				else {
					process.finish(this.masterStarted ? 0 : 255);
					this.master.finish(0);
				}
			});
		} else {
			process.stdinError = this.executionStdinError;
			const controlPathIndex = args.indexOf("-S");
			const proxyOption = args.find((arg) => arg.startsWith("ProxyCommand="));
			const proxyArgs =
				proxyOption === undefined ? undefined : splitProxyCommand(proxyOption.slice("ProxyCommand=".length));
			const usesDirectMaster = controlPathIndex >= 0 && args[controlPathIndex + 1]?.endsWith("master.sock") === true;
			const beginExecution = (usesMaster: boolean): void => {
				if (!usesMaster || !this.masterStarted || this.master.finished) {
					process.finish(255);
					return;
				}
				if (!this.executeCompletes) {
					this.executeStarted?.(process);
					return;
				}
				const remote = new ScriptedProcess();
				remote.onStdout((chunk) => process.writeStdout(chunk.toString()));
				remote.onStderr((chunk) => process.writeStderr(chunk.toString()));
				void remote.wait().then(async (result) => {
					if (result.code === 255) {
						const logPath = args[args.indexOf("-E") + 1];
						if (logPath !== undefined) await writeFile(logPath, "debug1: Exit status 255\n");
					}
					process.finish(result.code, result.signal);
				});
				this.executeStarted?.(remote);
			};
			if (usesDirectMaster) {
				queueMicrotask(() => beginExecution(true));
			} else if (proxyArgs !== undefined && proxyArgs.length > 1) {
				const proxy = this.start(proxyArgs[0] ?? "", proxyArgs.slice(1));
				void proxy.wait().then((result) => beginExecution(result.code === 0));
			} else {
				queueMicrotask(() => beginExecution(false));
			}
		}
		return process;
	}
}
class AbortDuringExecutionStartRunner extends ScriptedRunner {
	constructor(private readonly controller: AbortController) {
		super();
	}

	override start(command: string, args: readonly string[]): RunEnvironmentProcess {
		const process = super.start(command, args);
		if (command === "/usr/bin/ssh" && !args.includes("-M") && !args.includes("-O")) this.controller.abort();
		return process;
	}
}

class RealSshRunner implements RunEnvironmentProcessRunner {
	readonly processes: Array<{ readonly command: string; readonly args: readonly string[] }> = [];

	start(
		command: string,
		args: readonly string[],
		options?: { readonly environment?: NodeJS.ProcessEnv },
	): RunEnvironmentProcess {
		this.processes.push({ command, args: [...args] });
		if (command === "coder-test-double") {
			const process = new ScriptedProcess();
			const configPath = args[args.indexOf("--ssh-config-file") + 1];
			if (configPath === undefined) {
				queueMicrotask(() => process.finish(1));
				return process;
			}
			void writeFile(configPath, this.sshConfig).then(
				() => process.finish(0),
				(error: Error) => {
					process.writeStderr(error.message);
					process.finish(1);
				},
			);
			return process;
		}

		const child = spawn(command, [...args], {
			env: options?.environment,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		let resolveResult!: (result: RunEnvironmentProcessResult) => void;
		let settled = false;
		const result = new Promise<RunEnvironmentProcessResult>((resolve) => {
			resolveResult = resolve;
		});
		const finish = (value: RunEnvironmentProcessResult): void => {
			if (settled) return;
			settled = true;
			resolveResult(value);
		};
		child.once("error", (error) => finish({ code: null, signal: null, error }));
		child.once("close", (code, signal) => finish({ code, signal }));
		return {
			onStdout(listener) {
				child.stdout.on("data", listener);
			},
			onStderr(listener) {
				child.stderr.on("data", listener);
			},
			endStdin(content) {
				return new Promise<void>((resolve, reject) => {
					let settled = false;
					child.stdin.on("error", (error) => {
						if (settled) return;
						settled = true;
						reject(error);
					});
					child.stdin.end(content, () => {
						if (settled) return;
						settled = true;
						resolve();
					});
				});
			},
			wait: () => result,
			kill: () => {
				child.kill();
			},
		};
	}

	constructor(private readonly sshConfig: string) {}
}

function gitOpenSshPath(): string {
	if (process.platform !== "win32") return "ssh";
	const candidates = [
		process.env.ProgramW6432 === undefined
			? undefined
			: join(process.env.ProgramW6432, "Git", "usr", "bin", "ssh.exe"),
		process.env.ProgramFiles === undefined
			? undefined
			: join(process.env.ProgramFiles, "Git", "usr", "bin", "ssh.exe"),
		process.env.LOCALAPPDATA === undefined
			? undefined
			: join(process.env.LOCALAPPDATA, "Programs", "Git", "usr", "bin", "ssh.exe"),
	].filter((candidate): candidate is string => candidate !== undefined);
	for (const candidate of candidates) {
		try {
			const result = spawnSyncCollect([candidate, "-V"]);
			if (result.exitCode === 0) return candidate;
		} catch {
			// Continue through the documented Git for Windows installation roots.
		}
	}
	throw new Error("Git for Windows OpenSSH must be installed for Windows execution transport tests");
}

async function withTransport(
	runner: ScriptedRunner,
	run: (transport: Awaited<ReturnType<typeof createRunEnvironmentExecTransport>>) => Promise<void>,
	operatingSystem: RemoteOperatingSystem = "linux",
	controlPlatform: NodeJS.Platform = "linux",
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "atomic-exec-test-"));
	const transport = await createRunEnvironmentExecTransport({
		coderPath: "/pinned/coder",
		sshPath: "/usr/bin/ssh",
		workspaceName: "run-123",
		agent: reportedAgents[operatingSystem],
		controlPlatform,
		runtimeDirectory: directory,
		processRunner: runner,
		masterReadyTimeoutMs: 1_000,
		processStopTimeoutMs: 10,
		controlOperationTimeoutMs: 10,
	});
	try {
		await run(transport);
	} finally {
		await transport.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function executionCalls(runner: ScriptedRunner): readonly RecordedProcess[] {
	return runner.processes.filter(
		({ command, args }) => command === "/usr/bin/ssh" && !args.includes("-M") && !args.includes("-O"),
	);
}

async function executeWriteTool(
	tool: ReturnType<typeof createRunEnvironmentWriteToolDefinition>,
	input: { readonly path: string; readonly content: string },
): Promise<void> {
	await tool.execute("call", input, new AbortController().signal, undefined, {} as never);
}

describe("run-environment execute transport", () => {
	test("a remote write reports an early stdin close without crashing the control process", async () => {
		const runner = new ScriptedRunner();
		runner.executionStdinError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
		await withTransport(runner, async (transport) => {
			const write = createRunEnvironmentWriteToolDefinition("/workspace", { transport });

			await assert.rejects(executeWriteTool(write, { path: "large.txt", content: "x".repeat(1_000_000) }), /EPIPE/u);

			assert.equal(executionCalls(runner).length, 1);
		});
	});

	test("configures Coder SSH once and multiplexes every command through one environment master", async () => {
		const runner = new ScriptedRunner();
		let execution = 0;
		runner.executeStarted = (process) => {
			execution += 1;
			process.writeStdout(`stdout-${execution}`);
			process.writeStderr(`stderr-${execution}`);
			process.finish(execution === 1 ? 0 : 7);
		};

		await withTransport(runner, async (transport) => {
			const output: Array<{ channel: string; text: string }> = [];
			const sink = {
				write(chunk: Buffer, channel: "stdout" | "stderr") {
					output.push({ channel, text: chunk.toString() });
				},
			};
			const first = await transport.execute(
				{ argv: ["printf", "%s", "first argument"], cwd: "/workspace", environment: { MODE: "test" } },
				sink,
				new AbortController().signal,
			);
			const second = await transport.execute({ argv: ["false"] }, sink, new AbortController().signal);

			assert.deepEqual(first, { kind: "exited", code: 0 });
			assert.deepEqual(second, { kind: "exited", code: 7 });
			assert.deepEqual(output, [
				{ channel: "stdout", text: "stdout-1" },
				{ channel: "stderr", text: "stderr-1" },
				{ channel: "stdout", text: "stdout-2" },
				{ channel: "stderr", text: "stderr-2" },
			]);
		});

		const coderCalls = runner.processes.filter(({ command }) => command === "/pinned/coder");
		assert.equal(coderCalls.length, 1);
		assert.equal(coderCalls[0]?.args[0], "config-ssh");
		assert.ok(coderCalls[0]?.args.includes("--yes"));
		assert.ok(coderCalls[0]?.args.includes("--ssh-config-file"));
		assert.equal(runner.processes.filter(({ args }) => args.includes("-M")).length, 1);
		assert.equal(executionCalls(runner).length, 2);
		for (const call of executionCalls(runner)) {
			assert.ok(call.args.includes("ControlMaster=no"));
			assert.ok(call.args.includes("ProxyCommand=none"));
			assert.ok(call.args.includes("HostName=127.0.0.1"));
		}
		assert.equal(
			executionCalls(runner)[0]?.args.at(-1),
			"cd -- '/workspace' && exec 'env' '--' 'MODE=test' 'printf' '%s' 'first argument'",
		);
		assert.equal(
			runner.processes.some(({ command, args }) => command === "/pinned/coder" && args.includes("ssh")),
			false,
		);
	});

	test("streams a remote command payload through stdin", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = (process) => process.finish(0);

		await withTransport(runner, async (transport) => {
			const payload = Buffer.from("payload larger than argv");
			const outcome = await transport.execute(
				{ argv: ["cat"], stdin: payload },
				{ write() {} },
				new AbortController().signal,
			);

			assert.deepEqual(outcome, { kind: "exited", code: 0 });
			assert.deepEqual(executionCalls(runner)[0]?.process.stdin, payload);
		});
	});

	test("closes remote command stdin when no payload is supplied", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = (process) => process.finish(0);

		await withTransport(runner, async (transport) => {
			const outcome = await transport.execute(
				{ argv: ["rg", "needle", "."] },
				{ write() {} },
				new AbortController().signal,
			);

			assert.deepEqual(outcome, { kind: "exited", code: 0 });
			assert.equal(executionCalls(runner)[0]?.process.stdinEnded, true);
		});
	});

	test("stops waiting when a control-master readiness check wedges", async () => {
		const runner = new ScriptedRunner();
		runner.checkMaster = () => {};
		const directory = await mkdtemp(join(tmpdir(), "atomic-exec-ready-timeout-test-"));
		try {
			const creation = createRunEnvironmentExecTransport({
				coderPath: "/pinned/coder",
				sshPath: "/usr/bin/ssh",
				workspaceName: "run-123",
				agent: reportedAgents.linux,
				controlPlatform: "linux",
				runtimeDirectory: directory,
				processRunner: runner,
				masterReadyTimeoutMs: 10,
			});
			const result = await Promise.race([
				creation.then(
					() => "created" as const,
					(error: Error) => error,
				),
				new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
			]);

			assert.notEqual(result, "hung");
			assert.notEqual(result, "created");
			assert.match((result as Error).message, /did not become ready/u);
			assert.equal(runner.processes.find(({ args }) => args.includes("check"))?.process.killed, true);
			assert.equal(runner.master.killed, true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("cancels a wedged control-master readiness check", async () => {
		const runner = new ScriptedRunner();
		const controller = new AbortController();
		runner.checkMaster = () => controller.abort();
		const directory = await mkdtemp(join(tmpdir(), "atomic-exec-ready-abort-test-"));
		try {
			await assert.rejects(
				createRunEnvironmentExecTransport({
					coderPath: "/pinned/coder",
					sshPath: "/usr/bin/ssh",
					workspaceName: "run-123",
					agent: reportedAgents.linux,
					controlPlatform: "linux",
					runtimeDirectory: directory,
					processRunner: runner,
					masterReadyTimeoutMs: 1_000,
					signal: controller.signal,
				}),
				/^Error: aborted$/u,
			);
			assert.equal(runner.processes.find(({ args }) => args.includes("check"))?.process.killed, true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("stops a wedged readiness check when the control master exits", async () => {
		const runner = new ScriptedRunner();
		runner.checkMaster = () => {
			runner.master.writeStderr("master disconnected");
			runner.master.finish(255);
		};
		const directory = await mkdtemp(join(tmpdir(), "atomic-exec-ready-master-exit-test-"));
		try {
			await assert.rejects(
				createRunEnvironmentExecTransport({
					coderPath: "/pinned/coder",
					sshPath: "/usr/bin/ssh",
					workspaceName: "run-123",
					agent: reportedAgents.linux,
					controlPlatform: "linux",
					runtimeDirectory: directory,
					processRunner: runner,
					masterReadyTimeoutMs: 1_000,
				}),
				/master disconnected/u,
			);
			assert.equal(runner.processes.find(({ args }) => args.includes("check"))?.process.killed, true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "win32")(
		"runs Windows native commands in the requested working directory",
		async () => {
			const runner = new ScriptedRunner();
			const directory = await mkdtemp(join(tmpdir(), "atomic windows cwd "));
			let output = "";
			runner.executeStarted = (remoteProcess) => {
				const rendered = runner.processes.at(-1)?.args.at(-1) ?? "";
				const encoded = rendered.split(" ").at(-1) ?? "";
				const result = spawnSyncCollect([
					"powershell.exe",
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-EncodedCommand",
					encoded,
				]);
				remoteProcess.writeStdout(result.stdout.toString());
				remoteProcess.writeStderr(result.stderr.toString());
				remoteProcess.finish(result.exitCode);
			};

			try {
				await withTransport(
					runner,
					async (transport) => {
						const outcome = await transport.execute(
							{ argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"], cwd: directory },
							{ write: (chunk, channel) => (output += channel === "stdout" ? chunk.toString() : "") },
							new AbortController().signal,
						);
						assert.deepEqual(outcome, { kind: "exited", code: 0 });
						const missingExecutable = await transport.execute(
							{ argv: [join(directory, "missing.exe")], cwd: directory },
							{ write() {} },
							new AbortController().signal,
						);
						assert.deepEqual(missingExecutable, { kind: "exited", code: 127 });
					},
					"windows",
				);
				assert.equal(output, directory);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
	test.skipIf(process.platform !== "win32")(
		"preserves empty argv entries through Windows PowerShell 5.1",
		async () => {
			const runner = new ScriptedRunner();
			let output = "";
			runner.executeStarted = (remoteProcess) => {
				const rendered = executionCalls(runner).at(-1)?.args.at(-1) ?? "";
				const encoded = rendered.split(" ").at(-1) ?? "";
				const result = spawnSyncCollect([
					"powershell.exe",
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-EncodedCommand",
					encoded,
				]);
				remoteProcess.writeStdout(result.stdout.toString());
				remoteProcess.writeStderr(result.stderr.toString());
				remoteProcess.finish(result.exitCode);
			};

			await withTransport(
				runner,
				async (transport) => {
					const outcome = await transport.execute(
						{
							argv: [
								process.execPath,
								"-e",
								"process.stdout.write(JSON.stringify(process.argv.slice(1)))",
								"",
								"tail",
							],
						},
						{ write: (chunk, channel) => (output += channel === "stdout" ? chunk.toString() : "") },
						new AbortController().signal,
					);
					assert.deepEqual(outcome, { kind: "exited", code: 0 });
				},
				"windows",
			);

			assert.equal(output, '["","tail"]');
		},
	);
	test.skipIf(process.platform !== "win32")(
		"preserves an explicitly empty environment variable on Windows",
		async () => {
			const runner = new ScriptedRunner();
			let output = "";
			runner.executeStarted = (remoteProcess) => {
				const rendered = executionCalls(runner).at(-1)?.args.at(-1) ?? "";
				const encoded = rendered.split(" ").at(-1) ?? "";
				const result = spawnSyncCollect([
					"powershell.exe",
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-EncodedCommand",
					encoded,
				]);
				remoteProcess.writeStdout(result.stdout.toString());
				remoteProcess.writeStderr(result.stderr.toString());
				remoteProcess.finish(result.exitCode);
			};

			await withTransport(
				runner,
				async (transport) => {
					const outcome = await transport.execute(
						{
							argv: [
								process.execPath,
								"-e",
								"process.stdout.write(JSON.stringify({ present: Object.hasOwn(process.env, 'FLAG'), value: process.env.FLAG }))",
							],
							environment: { FLAG: "" },
						},
						{ write: (chunk, channel) => (output += channel === "stdout" ? chunk.toString() : "") },
						new AbortController().signal,
					);
					assert.deepEqual(outcome, { kind: "exited", code: 0 });
				},
				"windows",
			);

			assert.deepEqual(JSON.parse(output), { present: true, value: "" });
		},
	);
	test("ignores GIT_SSH variants and selects Git for Windows OpenSSH", async () => {
		const directory = await mkdtemp(join(tmpdir(), "atomic-exec-windows-test-"));
		const sshPath = join(directory, "Git", "usr", "bin", "ssh.exe");
		const plinkPath = join(directory, "plink.exe");
		await mkdir(join(directory, "Git", "usr", "bin"), { recursive: true });
		await Promise.all([writeFile(sshPath, "git ssh"), writeFile(plinkPath, "plink")]);
		const runner = new ScriptedRunner();
		const runtimeDirectory = join(directory, "runtime");
		try {
			const transport = await createRunEnvironmentExecTransport({
				coderPath: "/pinned/coder",
				workspaceName: "run-123",
				agent: reportedAgents.linux,
				controlPlatform: "win32",
				environment: { GIT_SSH: plinkPath, ProgramFiles: directory },
				runtimeDirectory,
				processRunner: runner,
				masterReadyTimeoutMs: 1_000,
			});
			await transport.close();
			assert.equal(runner.processes.find(({ args }) => args.includes("-M"))?.command, sshPath);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("runs real commands through the multiplexed transport and ignores forged completion output", async () => {
		const sshPath = gitOpenSshPath();
		const keygenPath = process.platform === "win32" ? join(dirname(sshPath), "ssh-keygen.exe") : "ssh-keygen";
		const directory = await mkdtemp(join(tmpdir(), "ax%$`-"));
		const hostKeyPath = join(directory, "host-key");
		const keygen = spawnSyncCollect([keygenPath, "-q", "-t", "ed25519", "-N", "", "-f", hostKeyPath]);
		assert.equal(keygen.exitCode, 0, keygen.stderr.toString());

		let connections = 0;
		let forwardedConnections = 0;
		const commands: string[] = [];
		const server = new Server({ hostKeys: [await readFile(hostKeyPath)] }, (client) => {
			connections += 1;
			client
				.on("authentication", (context) => {
					if (context.method === "none") context.accept();
					else context.reject(["none"]);
				})
				.on("ready", () => {
					client.on("tcpip", (accept, _reject, info) => {
						forwardedConnections += 1;
						const stream = accept();
						const socket = connect(info.destPort, info.destIP, () => stream.pipe(socket).pipe(stream));
						socket.on("error", () => stream.close());
					});
					client.on("session", (accept) => {
						const session = accept();
						session.on("shell", (accept) => {
							forwardedConnections += 1;
							const stream = accept();
							const address = server.address() as AddressInfo;
							const socket = connect(address.port, "127.0.0.1", () => stream.pipe(socket).pipe(stream));
							socket.on("error", () => stream.close());
						});
						session.on("exec", (accept, _reject, info) => {
							commands.push(info.command);
							const stream = accept();
							const child = spawn(info.command, { shell: true, windowsHide: true });
							stream.pipe(child.stdin);
							child.stdout.pipe(stream, { end: false });
							child.stderr.pipe(stream.stderr, { end: false });
							child.once("error", (error) => {
								stream.stderr.write(error.message);
								stream.exit(127);
								stream.end();
							});
							child.once("close", (code) => {
								stream.exit(code ?? 255);
								stream.end();
							});
						});
					});
				});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		const port = (server.address() as AddressInfo).port;
		const runner = new RealSshRunner(`Host atomic.run-123
	HostName 127.0.0.1
	Port ${port}
	User atomic-test
	PreferredAuthentications none
	PubkeyAuthentication no
	PasswordAuthentication no
	KbdInteractiveAuthentication no
	StrictHostKeyChecking no
	UserKnownHostsFile /dev/null
	LogLevel ERROR
`);
		const runtimeDirectory = join(directory, "r 50%$`");
		let transport: Awaited<ReturnType<typeof createRunEnvironmentExecTransport>> | undefined;
		try {
			transport = await createRunEnvironmentExecTransport({
				coderPath: "coder-test-double",
				sshPath,
				workspaceName: "run-123",
				agent: reportedAgents[process.platform === "win32" ? "windows" : "linux"],
				controlPlatform: process.platform,
				runtimeDirectory,
				processRunner: runner,
				masterReadyTimeoutMs: 10_000,
			});
			const releasePath = join(directory, "release-output");
			const liveOutputTimeoutMs = 2_000;
			const script = String.raw`
				const { execFileSync } = require("node:child_process");
				const { existsSync, readFileSync } = require("node:fs");
				const readParentCommandLine = () => {
					if (process.platform === "linux") {
						return readFileSync("/proc/" + process.ppid + "/cmdline", "utf8").replaceAll("\0", " ");
					}
					if (process.platform === "darwin") {
						return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(process.ppid)], { encoding: "utf8" });
					}
					return execFileSync("powershell.exe", [
						"-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
						"(Get-CimInstance Win32_Process -Filter 'ProcessId = " + process.ppid + "').CommandLine",
					], { encoding: "utf8" });
				};
				let parentCommandLine = process.argv.join(" ") + "\n" + readParentCommandLine();
				const encodedCommand = parentCommandLine.match(/-EncodedCommand\s+([^\s]+)/i)?.[1];
				if (encodedCommand) parentCommandLine += "\n" + Buffer.from(encodedCommand, "base64").toString("utf16le");
				const markerPrefix = ["atomic", "exec", "result"].join("-");
				const markers = [...parentCommandLine.matchAll(new RegExp(markerPrefix + "-[0-9a-f-]+:", "g"))].map(
					(match) => match[0],
				);
				const mirroredParentCommandLine = parentCommandLine.replaceAll(/[\0\r\n]/g, " ");
				const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
				(async () => {
					process.stdout.write("stdout-one\n");
					while (!existsSync(process.argv[1])) await wait(10);
					await wait(40);
					process.stderr.write(
						markers.map((marker) => marker + "0;").join("\n") + "\nmirrored-parent-command-line\n" +
						mirroredParentCommandLine +
						"\nend-mirrored-parent-command-line\nstderr-one\n",
					);
					await wait(40);
					process.stdout.write("stdout-two\n");
					await wait(40);
					process.stderr.write("stderr-two\n");
					await wait(40);
					process.exit(23);
				})();
			`;
			const observedLines: Array<{ readonly channel: string; readonly text: string }> = [];
			const channelBuffers = { stdout: "", stderr: "" };
			let resolveFirstLine!: () => void;
			const firstLine = new Promise<void>((resolve) => {
				resolveFirstLine = resolve;
			});
			const decoyMarker = `atomic-exec-result-${randomUUID()}:`;
			let executionSettled = false;
			const execution = transport
				.execute(
					{ argv: [process.execPath, "-e", script, releasePath, decoyMarker], timeoutSeconds: 5 },
					{
						write(chunk, channel) {
							channelBuffers[channel] += chunk.toString();
							for (;;) {
								const newline = channelBuffers[channel].indexOf("\n");
								if (newline < 0) break;
								observedLines.push({ channel, text: channelBuffers[channel].slice(0, newline) });
								channelBuffers[channel] = channelBuffers[channel].slice(newline + 1);
								resolveFirstLine();
							}
						},
					},
					new AbortController().signal,
				)
				.finally(() => {
					executionSettled = true;
				});
			let liveOutputTimeout: NodeJS.Timeout | undefined;
			const sawLiveOutput = await Promise.race([
				firstLine.then(() => true),
				new Promise<false>((resolve) => {
					liveOutputTimeout = setTimeout(() => resolve(false), liveOutputTimeoutMs);
				}),
			]);
			if (liveOutputTimeout !== undefined) clearTimeout(liveOutputTimeout);
			if (!sawLiveOutput) {
				await execution;
				assert.fail(`no output streamed within ${liveOutputTimeoutMs}ms while the command was running`);
			}
			assert.equal(executionSettled, false, "the command must still be running when its first output is observed");
			assert.deepEqual(observedLines, [{ channel: "stdout", text: "stdout-one" }]);
			await writeFile(releasePath, "continue");
			const outcome = await execution;
			const exit255 = await transport.execute(
				{ argv: [process.execPath, "-e", "process.exit(255)"] },
				{ write() {} },
				new AbortController().signal,
			);

			assert.deepEqual(outcome, { kind: "exited", code: 23 });
			assert.deepEqual(exit255, { kind: "exited", code: 255 });
			assert.deepEqual(observedLines[0], { channel: "stdout", text: "stdout-one" });
			const mirroredStart = observedLines.findIndex(({ text }) => text === "mirrored-parent-command-line");
			assert.ok(mirroredStart > 1, "the command must extract and emit sentinel-shaped values from its parent argv");
			const forgedLines = observedLines.slice(1, mirroredStart);
			assert.ok(forgedLines.every(({ channel }) => channel === "stderr"));
			assert.ok(
				forgedLines.some(({ text }) => text === `${decoyMarker}0;`),
				`expected forged ${decoyMarker}0; in ${JSON.stringify(forgedLines)}`,
			);
			assert.ok(forgedLines.every(({ text }) => /^atomic-exec-result-[0-9a-f-]+:0;$/u.test(text)));
			assert.equal(observedLines[mirroredStart]?.channel, "stderr");
			assert.equal(observedLines[mirroredStart + 1]?.channel, "stderr");
			assert.ok(
				observedLines[mirroredStart + 1]?.text.length,
				"the malicious command must mirror its parent's command line",
			);
			assert.deepEqual(observedLines[mirroredStart + 2], {
				channel: "stderr",
				text: "end-mirrored-parent-command-line",
			});
			assert.deepEqual(observedLines.slice(mirroredStart + 3), [
				{ channel: "stderr", text: "stderr-one" },
				{ channel: "stdout", text: "stdout-two" },
				{ channel: "stderr", text: "stderr-two" },
			]);
			assert.deepEqual(channelBuffers, { stdout: "", stderr: "" });
			assert.equal(commands.length, 2);
			assert.equal(runner.processes.filter(({ args }) => args.includes("-M")).length, 1);
			if (process.platform === "win32") {
				assert.equal(connections, 3);
				assert.equal(forwardedConnections, 2);
			} else {
				assert.equal(connections, 1);
			}
		} finally {
			await transport?.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("preserves a remote exit code 255 while the control master is alive", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = (process) => process.finish(255);

		await withTransport(runner, async (transport) => {
			const outcome = await transport.execute(
				{ argv: ["exit", "255"] },
				{ write() {} },
				new AbortController().signal,
			);

			assert.deepEqual(outcome, { kind: "exited", code: 255 });
		});
	});
	test("returns TransportLost when a command channel fails while the control master remains alive", async () => {
		const runner = new ScriptedRunner();
		runner.executeCompletes = false;
		runner.executeStarted = (process) => {
			process.writeStderr("mux_client_request_session: session request failed");
			process.finish(255);
		};

		await withTransport(runner, async (transport) => {
			const outcome = await transport.execute({ argv: ["true"] }, { write() {} }, new AbortController().signal);

			assert.equal(outcome.kind, "transport_lost");
			if (outcome.kind === "transport_lost") assert.match(outcome.detail, /session request failed/u);
			assert.equal(runner.master.finished, false);
		});
	});
	test("returns TransportLost when a command channel drops after streaming output", async () => {
		const runner = new ScriptedRunner();
		runner.executeCompletes = false;
		runner.executeStarted = (process) => {
			process.writeStdout("started");
			process.writeStderr("connection reset during command");
			process.finish(255);
		};
		let stdout = "";

		await withTransport(runner, async (transport) => {
			const outcome = await transport.execute(
				{ argv: ["long-command"] },
				{ write: (chunk, channel) => (stdout += channel === "stdout" ? chunk.toString() : "") },
				new AbortController().signal,
			);

			assert.equal(stdout, "started");
			assert.equal(outcome.kind, "transport_lost");
			if (outcome.kind === "transport_lost") assert.match(outcome.detail, /connection reset during command/u);
			assert.equal(runner.master.finished, false);
		});
	});

	test("returns TransportLost when an exit 255 has no client-owned exit-status evidence", async () => {
		const runner = new ScriptedRunner();
		runner.executeCompletes = false;
		runner.executeStarted = (process) => process.finish(255);
		runner.checkMaster = (process, checkNumber) => process.finish(checkNumber === 1 ? 0 : 255);

		await withTransport(runner, async (transport) => {
			const outcome = await transport.execute({ argv: ["true"] }, { write() {} }, new AbortController().signal);

			assert.equal(outcome.kind, "transport_lost");
			if (outcome.kind === "transport_lost") assert.match(outcome.detail, /SSH transport lost/u);
		});
	});
	test("returns TimedOut and preserves the builtin bash timeout error", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = () => {};

		await withTransport(runner, async (transport) => {
			const outcome = await transport.execute(
				{ argv: ["sleep", "30"], timeoutSeconds: 0.01 },
				{ write() {} },
				new AbortController().signal,
			);

			assert.deepEqual(outcome, { kind: "timed_out", seconds: 0.01 });
			assert.equal(executionCalls(runner)[0]?.process.killed, true);
			assert.throws(() => bashResultFromExecOutcome(outcome), /^Error: timeout:0\.01$/u);
		});
	});

	test("returns TimedOut after bounded termination when the SSH process will not close", async () => {
		const runner = new ScriptedRunner();
		runner.executeCompletes = false;
		let executing: ScriptedProcess | undefined;
		runner.executeStarted = (process) => {
			process.settleOnKill = false;
			executing = process;
		};

		await withTransport(runner, async (transport) => {
			const startedAt = Date.now();
			const outcome = await transport.execute(
				{ argv: ["sleep", "30"], timeoutSeconds: 0.01 },
				{ write() {} },
				new AbortController().signal,
			);

			assert.deepEqual(outcome, { kind: "timed_out", seconds: 0.01 });
			assert.equal(executing?.killed, true);
			assert.ok(Date.now() - startedAt < 200, "termination waits must stay bounded");
		});
	});
	test("flushes buffered stderr when an execution times out", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = (process) => process.writeStderr("partial diagnostic");
		let stderr = "";

		await withTransport(runner, async (transport) => {
			const outcome = await transport.execute(
				{ argv: ["sleep", "30"], timeoutSeconds: 0.01 },
				{ write: (chunk, channel) => (stderr += channel === "stderr" ? chunk.toString() : "") },
				new AbortController().signal,
			);

			assert.deepEqual(outcome, { kind: "timed_out", seconds: 0.01 });
			assert.equal(stderr, "partial diagnostic");
		});
	});

	test("does not time out after the remote command has exited", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = (process) => process.finish(0);

		await withTransport(runner, async (transport) => {
			const outcome = await transport.execute(
				{ argv: ["true"], timeoutSeconds: 0.01 },
				{ write() {} },
				new AbortController().signal,
			);

			assert.deepEqual(outcome, { kind: "exited", code: 0 });
		});
	});

	test("returns Aborted and preserves the builtin bash abort error", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = () => {};

		await withTransport(runner, async (transport) => {
			const controller = new AbortController();
			const pending = transport.execute({ argv: ["long-command"] }, { write() {} }, controller.signal);
			await new Promise((resolve) => setImmediate(resolve));
			controller.abort();
			const outcome = await pending;

			assert.deepEqual(outcome, { kind: "aborted" });
			assert.equal(executionCalls(runner)[0]?.process.killed, true);
			assert.throws(() => bashResultFromExecOutcome(outcome), /^Error: aborted$/u);
		});
	});

	test("returns Aborted when cancellation races with starting the SSH command", async () => {
		const controller = new AbortController();
		const runner = new AbortDuringExecutionStartRunner(controller);
		runner.executeCompletes = false;
		runner.executeStarted = () => {};

		await withTransport(runner, async (transport) => {
			const outcome = await Promise.race([
				transport.execute({ argv: ["long-command"] }, { write() {} }, controller.signal),
				new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
			]);

			assert.notEqual(outcome, "hung");
			assert.deepEqual(outcome, { kind: "aborted" });
			assert.equal(executionCalls(runner)[0]?.process.killed, true);
		});
	});

	test("preserves an exited outcome when per-command log cleanup fails", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = (process) => {
			const logPath = executionCalls(runner).at(-1)?.args.at(2);
			assert.ok(logPath);
			void mkdir(logPath).then(() => process.finish(0));
		};

		await withTransport(runner, async (transport) => {
			const outcome = await transport.execute({ argv: ["true"] }, { write() {} }, new AbortController().signal);

			assert.deepEqual(outcome, { kind: "exited", code: 0 });
		});
	});

	test("bounds exit-proof reads and runtime cleanup when filesystem operations stall", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = (process) => process.finish(255);
		const stalled = new Promise<never>(() => {});
		const removedPaths: string[] = [];
		const transport = await createRunEnvironmentExecTransport({
			coderPath: "/pinned/coder",
			sshPath: "/usr/bin/ssh",
			workspaceName: "run-123",
			agent: reportedAgents.linux,
			controlPlatform: "linux",
			processRunner: runner,
			masterReadyTimeoutMs: 1_000,
			processStopTimeoutMs: 10,
			controlOperationTimeoutMs: 10,
			fileOperations: {
				readText: () => stalled,
				remove: (path) => {
					removedPaths.push(path);
					return stalled;
				},
			},
		});
		try {
			const executeStartedAt = Date.now();
			const outcome = await transport.execute(
				{ argv: ["exit", "255"] },
				{ write() {} },
				new AbortController().signal,
			);
			assert.equal(outcome.kind, "transport_lost");
			assert.ok(Date.now() - executeStartedAt < 200, "exit-proof and command cleanup waits must stay bounded");

			const closeStartedAt = Date.now();
			await transport.close();
			assert.ok(Date.now() - closeStartedAt < 200, "runtime cleanup waits must stay bounded");
		} finally {
			await transport.close();
			const runtimeDirectory = removedPaths.at(-1);
			if (runtimeDirectory !== undefined) await rm(runtimeDirectory, { recursive: true, force: true });
		}
	});

	test("returns Aborted after bounded termination when the SSH process will not close", async () => {
		const runner = new ScriptedRunner();
		runner.executeCompletes = false;
		let executing: ScriptedProcess | undefined;
		runner.executeStarted = (process) => {
			process.settleOnKill = false;
			executing = process;
		};

		await withTransport(runner, async (transport) => {
			const controller = new AbortController();
			const pending = transport.execute({ argv: ["long-command"] }, { write() {} }, controller.signal);
			await new Promise((resolve) => setImmediate(resolve));
			const startedAt = Date.now();
			controller.abort();

			assert.deepEqual(await pending, { kind: "aborted" });
			assert.equal(executing?.killed, true);
			assert.deepEqual(executing?.killSignals, ["SIGTERM", "SIGKILL"]);
			assert.ok(Date.now() - startedAt < 200, "termination waits must stay bounded");
		});
	});

	test("an abort interrupts a hung post-command master probe", async () => {
		const runner = new ScriptedRunner();
		runner.executeCompletes = false;
		runner.executeStarted = (process) => process.finish(255);
		runner.checkMaster = (process, checkNumber) => {
			if (checkNumber === 1) process.finish(0);
			else process.settleOnKill = false;
		};

		await withTransport(runner, async (transport) => {
			const controller = new AbortController();
			const pending = transport.execute({ argv: ["true"] }, { write() {} }, controller.signal);
			await new Promise((resolve) => setImmediate(resolve));
			controller.abort();
			const outcome = await Promise.race([
				pending,
				new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
			]);

			assert.notEqual(outcome, "hung");
			assert.deepEqual(outcome, { kind: "aborted" });
			const checks = runner.processes.filter(({ args }) => args.includes("check"));
			assert.deepEqual(checks.at(-1)?.process.killSignals, ["SIGTERM", "SIGKILL"]);
		});
	});

	test("bounds command shutdown after control-master loss", async () => {
		const runner = new ScriptedRunner();
		runner.executeCompletes = false;
		let executing: ScriptedProcess | undefined;
		runner.executeStarted = (process) => {
			process.settleOnKill = false;
			executing = process;
			runner.master.writeStderr("master disconnected");
			runner.master.finish(255);
		};

		await withTransport(runner, async (transport) => {
			const startedAt = Date.now();
			const outcome = await transport.execute(
				{ argv: ["long-command"] },
				{ write() {} },
				new AbortController().signal,
			);

			assert.equal(outcome.kind, "transport_lost");
			assert.deepEqual(executing?.killSignals, ["SIGTERM", "SIGKILL"]);
			assert.ok(Date.now() - startedAt < 200, "master-loss shutdown must stay bounded");
		});
	});

	test("bounds close when ssh -O exit and the control master will not close", async () => {
		const runner = new ScriptedRunner();
		runner.master.settleOnKill = false;
		let exiting: ScriptedProcess | undefined;
		runner.exitMaster = (process) => {
			process.settleOnKill = false;
			exiting = process;
		};
		const directory = await mkdtemp(join(tmpdir(), "atomic-exec-close-timeout-test-"));
		try {
			const transport = await createRunEnvironmentExecTransport({
				coderPath: "/pinned/coder",
				sshPath: "/usr/bin/ssh",
				workspaceName: "run-123",
				agent: reportedAgents.linux,
				controlPlatform: "linux",
				runtimeDirectory: directory,
				processRunner: runner,
				masterReadyTimeoutMs: 1_000,
				processStopTimeoutMs: 10,
				controlOperationTimeoutMs: 10,
			});
			const startedAt = Date.now();
			await transport.close();

			assert.deepEqual(exiting?.killSignals, ["SIGTERM", "SIGKILL"]);
			assert.deepEqual(runner.master.killSignals, ["SIGTERM", "SIGKILL"]);
			assert.ok(Date.now() - startedAt < 200, "close waits must stay bounded");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test.each(["linux", "windows"] as const)(
		"close unblocks a wedged %s execution as TransportLost",
		async (operatingSystem) => {
			const runner = new ScriptedRunner();
			runner.executeCompletes = false;
			let executing: ScriptedProcess | undefined;
			runner.executeStarted = (process) => {
				process.settleOnKill = false;
				executing = process;
			};

			await withTransport(
				runner,
				async (transport) => {
					const pending = transport.execute(
						{ argv: ["long-command"] },
						{ write() {} },
						new AbortController().signal,
					);
					await new Promise((resolve) => setImmediate(resolve));
					await transport.close();
					const outcome = await Promise.race([
						pending,
						new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
					]);

					if (outcome === "hung") assert.fail("execute remained blocked after close");
					assert.equal(outcome.kind, "transport_lost");
					if (outcome.kind === "transport_lost") assert.match(outcome.detail, /closed/u);
					assert.equal(executing?.killed, true);
				},
				operatingSystem,
				operatingSystem === "windows" ? "win32" : "linux",
			);
		},
	);

	test("keeps a completed SSH exit primary when the master drops afterward", async () => {
		const runner = new ScriptedRunner();
		runner.executeCompletes = false;
		runner.executeStarted = (process) => {
			process.finish(0);
			runner.master.writeStderr("connection closed");
			runner.master.finish(255);
		};

		await withTransport(runner, async (transport) => {
			const outcome = await transport.execute({ argv: ["true"] }, { write() {} }, new AbortController().signal);

			assert.deepEqual(outcome, { kind: "exited", code: 0 });
		});
	});
});
