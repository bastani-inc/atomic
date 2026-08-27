import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SSH_TRANSPORT_EXIT_CODE = 255;
const DIAGNOSTIC_LIMIT_BYTES = 16_384;
const DEFAULT_MASTER_READY_TIMEOUT_MS = 15_000;
const MASTER_CHECK_INTERVAL_MS = 25;
const SSH_HOST_PREFIX = "atomic.";

export type RemoteOperatingSystem = "linux" | "darwin" | "windows";
export type OutputChannel = "stdout" | "stderr";

export interface RemoteCommand {
	readonly argv: readonly string[];
	readonly cwd?: string;
	readonly environment?: Readonly<Record<string, string>>;
	readonly timeoutSeconds?: number;
}

export interface OutputSink {
	write(chunk: Buffer, channel: OutputChannel): void;
}

export type ExecOutcome =
	| { readonly kind: "exited"; readonly code: number }
	| { readonly kind: "timed_out"; readonly seconds: number }
	| { readonly kind: "aborted" }
	| { readonly kind: "transport_lost"; readonly detail: string };

export interface RunEnvironmentProcessResult {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly error?: Error;
}

export interface RunEnvironmentProcess {
	onStdout(listener: (chunk: Buffer) => void): void;
	onStderr(listener: (chunk: Buffer) => void): void;
	wait(): Promise<RunEnvironmentProcessResult>;
	kill(): void;
}

export interface RunEnvironmentProcessOptions {
	readonly environment?: NodeJS.ProcessEnv;
}

export interface RunEnvironmentProcessRunner {
	start(command: string, args: readonly string[], options?: RunEnvironmentProcessOptions): RunEnvironmentProcess;
}

export interface CreateRunEnvironmentExecTransportOptions {
	readonly coderPath: string;
	readonly sshPath?: string;
	readonly workspaceName: string;
	readonly operatingSystem: RemoteOperatingSystem;
	readonly environment?: NodeJS.ProcessEnv;
	readonly runtimeDirectory?: string;
	readonly processRunner?: RunEnvironmentProcessRunner;
	readonly masterReadyTimeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface RunEnvironmentExecTransport {
	execute(command: RemoteCommand, sink: OutputSink, signal: AbortSignal): Promise<ExecOutcome>;
	close(): Promise<void>;
}

interface ProcessSettlement {
	readonly kind: "process";
	readonly result: RunEnvironmentProcessResult;
}

type InterruptedSettlement =
	| { readonly kind: "aborted" }
	| { readonly kind: "timed_out"; readonly seconds: number }
	| { readonly kind: "master_lost" };

type ExecutionSettlement = ProcessSettlement | InterruptedSettlement;

function createNodeProcessRunner(): RunEnvironmentProcessRunner {
	return {
		start(command, args, options) {
			const child = spawn(command, [...args], {
				env: options?.environment,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			const result = new Promise<RunEnvironmentProcessResult>((resolve) => {
				let settled = false;
				const finish = (value: RunEnvironmentProcessResult): void => {
					if (settled) return;
					settled = true;
					resolve(value);
				};
				child.once("error", (error) => finish({ code: null, signal: null, error }));
				child.once("close", (code, signal) => finish({ code, signal }));
			});
			return {
				onStdout(listener) {
					child.stdout.on("data", listener);
				},
				onStderr(listener) {
					child.stderr.on("data", listener);
				},
				wait: () => result,
				kill: () => {
					child.kill();
				},
			};
		},
	};
}

function appendDiagnostic(current: string, chunk: Buffer): string {
	const next = current + chunk.toString();
	return Buffer.byteLength(next) <= DIAGNOSTIC_LIMIT_BYTES ? next : next.slice(-DIAGNOSTIC_LIMIT_BYTES);
}

function processFailureDetail(label: string, result: RunEnvironmentProcessResult, stderr: string): string {
	const diagnostic = stderr.trim();
	if (result.error !== undefined) return `${label}: ${result.error.message}`;
	if (diagnostic.length > 0) return `${label}: ${diagnostic}`;
	if (result.signal !== null) return `${label}: signal ${result.signal}`;
	return `${label}: exit ${String(result.code)}`;
}

async function waitForSetupProcess(process: RunEnvironmentProcess, label: string, signal?: AbortSignal): Promise<void> {
	let stderr = "";
	process.onStderr((chunk) => {
		stderr = appendDiagnostic(stderr, chunk);
	});
	if (signal?.aborted) {
		process.kill();
		throw new Error("aborted");
	}
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<RunEnvironmentProcessResult>((resolve) => {
		onAbort = () => {
			process.kill();
			resolve({ code: null, signal: null, error: new Error("aborted") });
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	try {
		const result = signal === undefined ? await process.wait() : await Promise.race([process.wait(), aborted]);
		if (result.error?.message === "aborted") throw result.error;
		if (result.code !== 0 || result.error !== undefined) throw new Error(processFailureDetail(label, result, stderr));
	} finally {
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
	}
}

function quotePosix(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function renderPosixCommand(command: RemoteCommand): string {
	const environment = Object.entries(command.environment ?? {}).map(([name, value]) => `${name}=${value}`);
	const invocation = ["env", "--", ...environment, ...command.argv].map(quotePosix).join(" ");
	return command.cwd === undefined ? `exec ${invocation}` : `cd -- ${quotePosix(command.cwd)} && exec ${invocation}`;
}

function powershellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function renderWindowsCommand(command: RemoteCommand): string {
	const lines = [
		"$ErrorActionPreference = 'Stop'",
		...(command.cwd === undefined ? [] : [`Set-Location -LiteralPath ${powershellLiteral(command.cwd)}`]),
		...Object.entries(command.environment ?? {}).map(
			([name, value]) =>
				`Set-Item -LiteralPath ${powershellLiteral(`Env:${name}`)} -Value ${powershellLiteral(value)}`,
		),
		`& ${command.argv.map(powershellLiteral).join(" ")}`,
		"if ($null -eq $LASTEXITCODE) { exit 0 } else { exit $LASTEXITCODE }",
	];
	const encoded = Buffer.from(lines.join("\r\n"), "utf16le").toString("base64");
	return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function renderRemoteCommand(command: RemoteCommand, operatingSystem: RemoteOperatingSystem): string {
	if (command.argv.length === 0) throw new TypeError("Remote command argv must not be empty");
	for (const name of Object.keys(command.environment ?? {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
			throw new TypeError(`Invalid remote environment variable name: ${name}`);
	}
	return operatingSystem === "windows" ? renderWindowsCommand(command) : renderPosixCommand(command);
}

function validateTimeoutSeconds(seconds: number | undefined): void {
	if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
		throw new TypeError("Remote command timeout must be a positive finite number");
	}
}

function transportDetail(result: RunEnvironmentProcessResult, stderr: string): string {
	return processFailureDetail("SSH transport lost", result, stderr);
}

export function bashResultFromExecOutcome(outcome: ExecOutcome): { readonly exitCode: number } {
	switch (outcome.kind) {
		case "exited":
			return { exitCode: outcome.code };
		case "timed_out":
			throw new Error(`timeout:${outcome.seconds}`);
		case "aborted":
			throw new Error("aborted");
		case "transport_lost":
			throw new Error(outcome.detail);
	}
}

export async function createRunEnvironmentExecTransport(
	options: CreateRunEnvironmentExecTransportOptions,
): Promise<RunEnvironmentExecTransport> {
	const runner = options.processRunner ?? createNodeProcessRunner();
	const sshPath = options.sshPath ?? "ssh";
	const ownsRuntimeDirectory = options.runtimeDirectory === undefined;
	const runtimeDirectory = options.runtimeDirectory ?? (await mkdtemp(join(tmpdir(), "atomic-ssh-")));
	await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
	const configPath = join(runtimeDirectory, "config");
	const controlPath = join(runtimeDirectory, "master.sock");
	const host = `${SSH_HOST_PREFIX}${options.workspaceName}`;
	const processOptions = { environment: options.environment };
	let closed = false;
	let closing = false;
	let masterLostDetail: string | undefined;
	let resolveMasterLost!: () => void;
	const masterLost = new Promise<void>((resolve) => {
		resolveMasterLost = resolve;
	});
	const activeProcesses = new Set<RunEnvironmentProcess>();
	let startingMaster: RunEnvironmentProcess | undefined;

	try {
		const configure = runner.start(
			options.coderPath,
			[
				"config-ssh",
				"--yes",
				"--ssh-config-file",
				configPath,
				"--coder-binary-path",
				options.coderPath,
				`--ssh-host-prefix=${SSH_HOST_PREFIX}`,
				"--hostname-suffix=",
				"--disable-autostart=true",
			],
			processOptions,
		);
		await waitForSetupProcess(configure, "coder config-ssh failed", options.signal);

		const master = runner.start(
			sshPath,
			["-F", configPath, "-M", "-N", "-S", controlPath, "-o", "ControlMaster=yes", "-o", "ControlPersist=no", host],
			processOptions,
		);
		startingMaster = master;
		let masterStderr = "";
		master.onStderr((chunk) => {
			masterStderr = appendDiagnostic(masterStderr, chunk);
		});
		void master.wait().then((result) => {
			if (closing) return;
			masterLostDetail = processFailureDetail("SSH control master exited", result, masterStderr);
			resolveMasterLost();
		});

		const readyTimeoutMs = options.masterReadyTimeoutMs ?? DEFAULT_MASTER_READY_TIMEOUT_MS;
		if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) {
			throw new TypeError("SSH control master readiness timeout must be positive");
		}
		const readyDeadline = Date.now() + readyTimeoutMs;
		for (;;) {
			if (masterLostDetail !== undefined) throw new Error(masterLostDetail);
			const check = runner.start(
				sshPath,
				["-F", configPath, "-S", controlPath, "-O", "check", host],
				processOptions,
			);
			const result = await check.wait();
			if (result.code === 0 && result.error === undefined) break;
			if (Date.now() >= readyDeadline) {
				master.kill();
				throw new Error(processFailureDetail("SSH control master did not become ready", result, ""));
			}
			await new Promise((resolve) => setTimeout(resolve, MASTER_CHECK_INTERVAL_MS));
		}

		return {
			async execute(command, sink, signal) {
				if (closed || closing) return { kind: "transport_lost", detail: "SSH transport is closed" };
				if (masterLostDetail !== undefined) return { kind: "transport_lost", detail: masterLostDetail };
				validateTimeoutSeconds(command.timeoutSeconds);
				if (signal.aborted) return { kind: "aborted" };
				const remoteCommand = renderRemoteCommand(command, options.operatingSystem);
				let stderr = "";
				let process: RunEnvironmentProcess;
				try {
					process = runner.start(
						sshPath,
						[
							"-F",
							configPath,
							"-S",
							controlPath,
							"-o",
							"ControlMaster=no",
							"-o",
							"ProxyCommand=none",
							"-o",
							"HostName=127.0.0.1",
							"-o",
							"Port=1",
							"-o",
							"ConnectionAttempts=1",
							"-o",
							"ConnectTimeout=1",
							"-T",
							host,
							remoteCommand,
						],
						processOptions,
					);
				} catch (error) {
					return {
						kind: "transport_lost",
						detail: error instanceof Error ? error.message : String(error),
					};
				}
				activeProcesses.add(process);
				process.onStdout((chunk) => sink.write(chunk, "stdout"));
				process.onStderr((chunk) => {
					stderr = appendDiagnostic(stderr, chunk);
					sink.write(chunk, "stderr");
				});

				let timeout: NodeJS.Timeout | undefined;
				let onAbort: (() => void) | undefined;
				const interrupted = new Promise<InterruptedSettlement>((resolve) => {
					onAbort = () => resolve({ kind: "aborted" });
					signal.addEventListener("abort", onAbort, { once: true });
					if (command.timeoutSeconds !== undefined) {
						const seconds = command.timeoutSeconds;
						timeout = setTimeout(() => resolve({ kind: "timed_out", seconds }), seconds * 1_000);
					}
				});
				const processFinished = process.wait().then((result): ProcessSettlement => ({ kind: "process", result }));
				const lost = masterLost.then((): InterruptedSettlement => ({ kind: "master_lost" }));
				try {
					const settlement: ExecutionSettlement = await Promise.race([processFinished, interrupted, lost]);
					if (settlement.kind === "aborted") {
						process.kill();
						return { kind: "aborted" };
					}
					if (settlement.kind === "timed_out") {
						process.kill();
						return { kind: "timed_out", seconds: settlement.seconds };
					}
					if (settlement.kind === "master_lost" || masterLostDetail !== undefined) {
						process.kill();
						return { kind: "transport_lost", detail: masterLostDetail ?? "SSH control master exited" };
					}
					if (
						settlement.result.error !== undefined ||
						settlement.result.code === null ||
						settlement.result.code === SSH_TRANSPORT_EXIT_CODE
					) {
						return { kind: "transport_lost", detail: transportDetail(settlement.result, stderr) };
					}
					return { kind: "exited", code: settlement.result.code };
				} finally {
					activeProcesses.delete(process);
					if (timeout !== undefined) clearTimeout(timeout);
					if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
				}
			},
			async close() {
				if (closed || closing) return;
				closing = true;
				for (const process of activeProcesses) process.kill();
				const exit = runner.start(
					sshPath,
					["-F", configPath, "-S", controlPath, "-O", "exit", host],
					processOptions,
				);
				const result = await exit.wait();
				if (result.code !== 0 || result.error !== undefined) master.kill();
				closed = true;
				if (ownsRuntimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
			},
		};
	} catch (error) {
		startingMaster?.kill();
		if (ownsRuntimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
		throw error;
	}
}
