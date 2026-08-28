import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIAGNOSTIC_LIMIT_BYTES = 16_384;
const DEFAULT_MASTER_READY_TIMEOUT_MS = 15_000;
const MASTER_CHECK_INTERVAL_MS = 25;
const MASTER_PROBE_TIMEOUT_MS = 5_000;
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
	readonly controlPlatform?: NodeJS.Platform;
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

interface MasterProbeProcessSettlement {
	readonly kind: "probe_process";
	readonly result: RunEnvironmentProcessResult;
}

type MasterProbeSettlement = MasterProbeProcessSettlement | InterruptedSettlement | { readonly kind: "probe_timeout" };

type MasterProbeOutcome =
	| { readonly kind: "alive" }
	| { readonly kind: "dead"; readonly detail: string }
	| InterruptedSettlement;

type MasterReadinessSettlement =
	| MasterProbeProcessSettlement
	| { readonly kind: "ready_timeout" }
	| { readonly kind: "aborted" }
	| { readonly kind: "master_lost" };

async function waitForMasterReadinessCheck(
	check: RunEnvironmentProcess,
	readyDeadline: number,
	signal: AbortSignal | undefined,
	masterLost: Promise<void>,
): Promise<MasterReadinessSettlement> {
	let timeout: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	const timedOut = new Promise<MasterReadinessSettlement>((resolve) => {
		timeout = setTimeout(() => resolve({ kind: "ready_timeout" }), Math.max(0, readyDeadline - Date.now()));
	});
	const aborted = new Promise<MasterReadinessSettlement>((resolve) => {
		onAbort = () => resolve({ kind: "aborted" });
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
	const processFinished = check
		.wait()
		.then((result): MasterProbeProcessSettlement => ({ kind: "probe_process", result }));
	try {
		const settlement = await Promise.race([
			processFinished,
			timedOut,
			aborted,
			masterLost.then((): MasterReadinessSettlement => ({ kind: "master_lost" })),
		]);
		if (settlement.kind !== "probe_process") check.kill();
		return settlement;
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
	}
}

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

class RemoteExitProof {
	private pending: Buffer = Buffer.alloc(0);
	private readonly marker: Buffer;
	private markerFound = false;
	private remoteCode: number | undefined;
	private finalized = false;

	constructor(marker: string) {
		this.marker = Buffer.from(marker);
	}

	get exitCode(): number | undefined {
		return this.remoteCode;
	}

	write(chunk: Buffer, emit: (output: Buffer) => void): void {
		if (this.finalized) return;
		if (this.remoteCode !== undefined) {
			emit(chunk);
			return;
		}
		const combined = Buffer.concat([this.pending, chunk]);
		if (this.markerFound) {
			this.consumeExitCode(combined, emit);
			return;
		}
		const markerIndex = combined.indexOf(this.marker);
		if (markerIndex >= 0) {
			this.markerFound = true;
			if (markerIndex > 0) emit(combined.subarray(0, markerIndex));
			this.consumeExitCode(combined.subarray(markerIndex + this.marker.length), emit);
			return;
		}
		const retainedBytes = Math.min(combined.length, this.marker.length - 1);
		const emittedBytes = combined.length - retainedBytes;
		if (emittedBytes > 0) emit(combined.subarray(0, emittedBytes));
		this.pending = combined.subarray(emittedBytes);
	}

	finish(emit: (output: Buffer) => void): void {
		if (this.pending.length > 0) {
			if (this.markerFound) emit(Buffer.concat([this.marker, this.pending]));
			else emit(this.pending);
		}
		this.pending = Buffer.alloc(0);
		this.finalized = true;
	}

	interrupt(emit: (output: Buffer) => void): void {
		if (!this.markerFound && this.pending.length > 0) emit(this.pending);
		this.pending = Buffer.alloc(0);
		this.finalized = true;
	}

	private consumeExitCode(value: Buffer, emit: (output: Buffer) => void): void {
		const terminatorIndex = value.indexOf(0x3b);
		if (terminatorIndex < 0) {
			this.pending = value;
			return;
		}
		const encodedCode = value.subarray(0, terminatorIndex).toString();
		if (!/^-?\d+$/u.test(encodedCode)) {
			emit(Buffer.concat([this.marker, value]));
			this.markerFound = false;
			this.pending = Buffer.alloc(0);
			return;
		}
		this.remoteCode = Number(encodedCode);
		const remainder = value.subarray(terminatorIndex + 1);
		if (remainder.length > 0) emit(remainder);
		this.pending = Buffer.alloc(0);
	}
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

function renderPosixCommand(command: RemoteCommand, exitMarker: string): string {
	const environment = Object.entries(command.environment ?? {}).map(([name, value]) => `${name}=${value}`);
	const invocation = ["env", "--", ...environment, ...command.argv].map(quotePosix).join(" ");
	const execution = command.cwd === undefined ? invocation : `cd -- ${quotePosix(command.cwd)} && ${invocation}`;
	return `${execution}; exit_code=$?; printf '%s%s;' ${quotePosix(exitMarker)} "$exit_code" >&2; exit 0`;
}

function powershellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function quoteWindowsNativeArgument(value: string): string {
	if (value.length > 0 && !/[\s"]/u.test(value)) return value;
	let quoted = '"';
	let backslashes = 0;
	for (const character of value) {
		if (character === "\\") {
			backslashes += 1;
			continue;
		}
		if (character === '"') {
			quoted += `${"\\".repeat(backslashes * 2 + 1)}"`;
			backslashes = 0;
			continue;
		}
		quoted += "\\".repeat(backslashes) + character;
		backslashes = 0;
	}
	return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

function renderWindowsCommand(command: RemoteCommand, exitMarker: string): string {
	const lines = [
		"$ErrorActionPreference = 'Stop'",
		"$exitCode = 127",
		"try {",
		...(command.cwd === undefined ? [] : [`Set-Location -LiteralPath ${powershellLiteral(command.cwd)}`]),
		"$process = New-Object System.Diagnostics.Process",
		`$process.StartInfo.FileName = ${powershellLiteral(command.argv[0] ?? "")}`,
		`$process.StartInfo.Arguments = ${powershellLiteral(command.argv.slice(1).map(quoteWindowsNativeArgument).join(" "))}`,
		...(command.cwd === undefined ? [] : [`$process.StartInfo.WorkingDirectory = ${powershellLiteral(command.cwd)}`]),
		"$process.StartInfo.UseShellExecute = $false",
		...Object.entries(command.environment ?? {}).map(
			([name, value]) =>
				`$process.StartInfo.EnvironmentVariables[${powershellLiteral(name)}] = ${powershellLiteral(value)}`,
		),
		"$null = $process.Start()",
		"$process.WaitForExit()",
		"$exitCode = $process.ExitCode",
		"} catch {",
		"[Console]::Error.WriteLine($_.Exception.Message)",
		"}",
		`[Console]::Error.Write(${powershellLiteral(exitMarker)} + $exitCode + ';')`,
		"exit 0",
	];
	const encoded = Buffer.from(lines.join("\r\n"), "utf16le").toString("base64");
	return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function renderRemoteCommand(
	command: RemoteCommand,
	operatingSystem: RemoteOperatingSystem,
	exitMarker: string,
): string {
	if (command.argv.length === 0) throw new TypeError("Remote command argv must not be empty");
	for (const name of Object.keys(command.environment ?? {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
			throw new TypeError(`Invalid remote environment variable name: ${name}`);
	}
	return operatingSystem === "windows"
		? renderWindowsCommand(command, exitMarker)
		: renderPosixCommand(command, exitMarker);
}

function validateTimeoutSeconds(seconds: number | undefined): void {
	if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
		throw new TypeError("Remote command timeout must be a positive finite number");
	}
}

function quoteProxyCommandArgument(value: string, controlPlatform: NodeJS.Platform): string {
	const normalized = controlPlatform === "win32" ? value.replaceAll("\\", "/") : value;
	const escaped = normalized.replaceAll("%", "%%");
	return quotePosix(escaped);
}

function escapeControlPath(value: string, controlPlatform: NodeJS.Platform): string {
	const normalized = controlPlatform === "win32" ? value.replaceAll("\\", "/") : value;
	return normalized.replaceAll("%", "%%");
}

function executionArguments(
	sshPath: string,
	configPath: string,
	controlPath: string,
	host: string,
	remoteCommand: string,
	controlPlatform: NodeJS.Platform,
): readonly string[] {
	const common = ["-F", configPath, "-o", "ControlMaster=no"];
	const escapedControlPath = escapeControlPath(controlPath, controlPlatform);
	if (controlPlatform !== "win32") {
		return [
			...common,
			"-S",
			escapedControlPath,
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
		];
	}

	const proxyCommand = [sshPath, "-F", configPath, "-S", escapedControlPath, "-O", "proxy", host]
		.map((value) => quoteProxyCommandArgument(value, controlPlatform))
		.join(" ");
	return [...common, "-o", "ControlPath=none", "-o", `ProxyCommand=${proxyCommand}`, "-T", host, remoteCommand];
}

async function resolveSshPath(
	configuredPath: string | undefined,
	controlPlatform: NodeJS.Platform,
	environment: NodeJS.ProcessEnv,
): Promise<string> {
	if (configuredPath !== undefined) return configuredPath;
	if (controlPlatform !== "win32") return "ssh";

	const candidates = [
		...(environment.ProgramW6432 === undefined
			? []
			: [join(environment.ProgramW6432, "Git", "usr", "bin", "ssh.exe")]),
		...(environment.ProgramFiles === undefined
			? []
			: [join(environment.ProgramFiles, "Git", "usr", "bin", "ssh.exe")]),
		...(environment.LOCALAPPDATA === undefined
			? []
			: [join(environment.LOCALAPPDATA, "Programs", "Git", "usr", "bin", "ssh.exe")]),
	].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
	for (const candidate of new Set(candidates)) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Try the next ControlMaster-capable Git for Windows SSH installation.
		}
	}
	throw new Error("Windows run-environment execution requires Git for Windows SSH or an explicit sshPath");
}

async function probeControlMaster(
	runner: RunEnvironmentProcessRunner,
	sshPath: string,
	configPath: string,
	controlPath: string,
	host: string,
	controlPlatform: NodeJS.Platform,
	processOptions: RunEnvironmentProcessOptions,
	interrupted: Promise<InterruptedSettlement>,
	masterLost: Promise<InterruptedSettlement>,
): Promise<MasterProbeOutcome> {
	const check = runner.start(
		sshPath,
		["-F", configPath, "-S", escapeControlPath(controlPath, controlPlatform), "-O", "check", host],
		processOptions,
	);
	let stderr = "";
	check.onStderr((chunk) => {
		stderr = appendDiagnostic(stderr, chunk);
	});
	let probeTimeout: NodeJS.Timeout | undefined;
	const probeTimedOut = new Promise<MasterProbeSettlement>((resolve) => {
		probeTimeout = setTimeout(() => resolve({ kind: "probe_timeout" }), MASTER_PROBE_TIMEOUT_MS);
	});
	try {
		const processFinished = check
			.wait()
			.then((result): MasterProbeProcessSettlement => ({ kind: "probe_process", result }));
		const settlement = await Promise.race([processFinished, interrupted, masterLost, probeTimedOut]);
		if (settlement.kind === "aborted" || settlement.kind === "timed_out" || settlement.kind === "master_lost") {
			check.kill();
			return settlement;
		}
		if (settlement.kind === "probe_timeout") {
			check.kill();
			return { kind: "dead", detail: "SSH transport lost: control master check timed out" };
		}
		return settlement.result.code === 0 && settlement.result.error === undefined
			? { kind: "alive" }
			: { kind: "dead", detail: processFailureDetail("SSH transport lost", settlement.result, stderr) };
	} finally {
		if (probeTimeout !== undefined) clearTimeout(probeTimeout);
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
	const controlPlatform = options.controlPlatform ?? process.platform;
	const sshPath = await resolveSshPath(options.sshPath, controlPlatform, options.environment ?? process.env);
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
				...(controlPlatform === "win32" ? ["--force-unix-filepaths"] : []),
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
			[
				"-F",
				configPath,
				"-M",
				"-N",
				"-S",
				escapeControlPath(controlPath, controlPlatform),
				"-o",
				"ControlMaster=yes",
				"-o",
				"ControlPersist=no",
				host,
			],
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
				["-F", configPath, "-S", escapeControlPath(controlPath, controlPlatform), "-O", "check", host],
				processOptions,
			);
			const settlement = await waitForMasterReadinessCheck(check, readyDeadline, options.signal, masterLost);
			if (settlement.kind === "aborted") throw new Error("aborted");
			if (settlement.kind === "master_lost") {
				throw new Error(masterLostDetail ?? "SSH control master exited");
			}
			if (settlement.kind === "ready_timeout") {
				master.kill();
				throw new Error("SSH control master did not become ready: readiness check timed out");
			}
			if (settlement.result.code === 0 && settlement.result.error === undefined) break;
			if (Date.now() >= readyDeadline) {
				master.kill();
				throw new Error(processFailureDetail("SSH control master did not become ready", settlement.result, ""));
			}
			await new Promise((resolve) =>
				setTimeout(resolve, Math.min(MASTER_CHECK_INTERVAL_MS, Math.max(0, readyDeadline - Date.now()))),
			);
		}

		return {
			async execute(command, sink, signal) {
				if (closed || closing) return { kind: "transport_lost", detail: "SSH transport is closed" };
				if (masterLostDetail !== undefined) return { kind: "transport_lost", detail: masterLostDetail };
				validateTimeoutSeconds(command.timeoutSeconds);
				if (signal.aborted) return { kind: "aborted" };
				const exitMarker = `atomic-exec-result-${randomUUID()}:`;
				const remoteCommand = renderRemoteCommand(command, options.operatingSystem, exitMarker);
				const exitProof = new RemoteExitProof(exitMarker);
				let stderr = "";
				let process: RunEnvironmentProcess;
				try {
					process = runner.start(
						sshPath,
						executionArguments(sshPath, configPath, controlPath, host, remoteCommand, controlPlatform),
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
				const emitStderr = (output: Buffer): void => {
					stderr = appendDiagnostic(stderr, output);
					sink.write(output, "stderr");
				};
				process.onStderr((chunk) => exitProof.write(chunk, emitStderr));

				let timeout: NodeJS.Timeout | undefined;
				let onAbort: (() => void) | undefined;
				const aborted = new Promise<InterruptedSettlement>((resolve) => {
					onAbort = () => resolve({ kind: "aborted" });
					signal.addEventListener("abort", onAbort, { once: true });
				});
				const timedOut = new Promise<InterruptedSettlement>((resolve) => {
					if (command.timeoutSeconds !== undefined) {
						const seconds = command.timeoutSeconds;
						timeout = setTimeout(() => resolve({ kind: "timed_out", seconds }), seconds * 1_000);
					}
				});
				const processFinished = process.wait().then((result): ProcessSettlement => ({ kind: "process", result }));
				const lost = masterLost.then((): InterruptedSettlement => ({ kind: "master_lost" }));
				try {
					const settlement: ExecutionSettlement = await Promise.race([processFinished, aborted, timedOut, lost]);
					if (settlement.kind === "aborted") {
						process.kill();
						await processFinished;
						exitProof.interrupt(emitStderr);
						return { kind: "aborted" };
					}
					if (settlement.kind === "timed_out") {
						process.kill();
						await processFinished;
						exitProof.interrupt(emitStderr);
						return { kind: "timed_out", seconds: settlement.seconds };
					}
					if (settlement.kind === "master_lost" || masterLostDetail !== undefined) {
						process.kill();
						await processFinished;
						exitProof.interrupt(emitStderr);
						return { kind: "transport_lost", detail: masterLostDetail ?? "SSH control master exited" };
					}
					exitProof.finish(emitStderr);
					if (settlement.result.error !== undefined || settlement.result.code === null) {
						return { kind: "transport_lost", detail: transportDetail(settlement.result, stderr) };
					}
					if (timeout !== undefined) {
						clearTimeout(timeout);
						timeout = undefined;
					}
					const masterStatus = await probeControlMaster(
						runner,
						sshPath,
						configPath,
						controlPath,
						host,
						controlPlatform,
						processOptions,
						aborted,
						lost,
					);
					if (masterStatus.kind === "aborted") return { kind: "aborted" };
					if (masterStatus.kind === "timed_out") return { kind: "timed_out", seconds: masterStatus.seconds };
					if (masterStatus.kind === "master_lost" || masterLostDetail !== undefined) {
						return { kind: "transport_lost", detail: masterLostDetail ?? "SSH control master exited" };
					}
					if (masterStatus.kind === "dead") return { kind: "transport_lost", detail: masterStatus.detail };
					if (exitProof.exitCode === undefined) {
						return { kind: "transport_lost", detail: transportDetail(settlement.result, stderr) };
					}
					return { kind: "exited", code: exitProof.exitCode };
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
					["-F", configPath, "-S", escapeControlPath(controlPath, controlPlatform), "-O", "exit", host],
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
