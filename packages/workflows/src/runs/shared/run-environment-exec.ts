import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIAGNOSTIC_LIMIT_BYTES = 16_384;
const DEFAULT_MASTER_READY_TIMEOUT_MS = 15_000;
const MASTER_CHECK_INTERVAL_MS = 25;
const MASTER_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_PROCESS_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_CONTROL_OPERATION_TIMEOUT_MS = 5_000;
const SSH_TRANSPORT_EXIT_CODE = 255;
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
	kill(signal?: NodeJS.Signals): void;
}

export interface RunEnvironmentProcessOptions {
	readonly environment?: NodeJS.ProcessEnv;
}

export interface RunEnvironmentProcessRunner {
	start(command: string, args: readonly string[], options?: RunEnvironmentProcessOptions): RunEnvironmentProcess;
}
export interface RunEnvironmentExecFileOperations {
	readText(path: string): Promise<string>;
	remove(path: string, options: { readonly recursive: boolean; readonly force: true }): Promise<void>;
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
	readonly fileOperations?: RunEnvironmentExecFileOperations;
	readonly masterReadyTimeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly processStopTimeoutMs?: number;
	readonly controlOperationTimeoutMs?: number;
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
	stopTimeoutMs: number,
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
	const rawProcessFinished = check.wait();
	const processFinished = rawProcessFinished.then(
		(result): MasterProbeProcessSettlement => ({ kind: "probe_process", result }),
	);
	try {
		const settlement = await Promise.race([
			processFinished,
			timedOut,
			aborted,
			masterLost.then((): MasterReadinessSettlement => ({ kind: "master_lost" })),
		]);
		if (settlement.kind !== "probe_process") await stopProcess(check, rawProcessFinished, stopTimeoutMs);
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
				kill: (signal = "SIGTERM") => {
					child.kill(signal);
				},
			};
		},
	};
}

function appendDiagnostic(current: string, chunk: Buffer): string {
	const next = current + chunk.toString();
	return Buffer.byteLength(next) <= DIAGNOSTIC_LIMIT_BYTES ? next : next.slice(-DIAGNOSTIC_LIMIT_BYTES);
}

type BoundedSettlement<T> = { readonly completed: true; readonly value: T } | { readonly completed: false };

async function waitWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<BoundedSettlement<T>> {
	let timeout: NodeJS.Timeout | undefined;
	const expired = new Promise<BoundedSettlement<T>>((resolve) => {
		timeout = setTimeout(() => resolve({ completed: false }), timeoutMs);
	});
	try {
		return await Promise.race([promise.then((value): BoundedSettlement<T> => ({ completed: true, value })), expired]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

async function stopProcess(
	process: RunEnvironmentProcess,
	finished: Promise<RunEnvironmentProcessResult>,
	timeoutMs: number,
): Promise<void> {
	process.kill("SIGTERM");
	if ((await waitWithin(finished, timeoutMs)).completed) return;
	process.kill("SIGKILL");
	await waitWithin(finished, timeoutMs);
}

function validateBound(name: string, milliseconds: number): void {
	if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new TypeError(`${name} must be positive`);
}

function sshLogPath(value: string, controlPlatform: NodeJS.Platform): string {
	return controlPlatform === "win32" ? value.replaceAll("\\", "/") : value;
}

async function hasRemoteExit255Evidence(
	fileOperations: RunEnvironmentExecFileOperations,
	path: string,
	timeoutMs: number,
): Promise<boolean> {
	const read = Promise.resolve()
		.then(() => fileOperations.readText(path))
		.then(
			(log) => ({ kind: "read" as const, log }),
			() => ({ kind: "unavailable" as const }),
		);
	const settlement = await waitWithin(read, timeoutMs);
	return (
		settlement.completed &&
		settlement.value.kind === "read" &&
		/^(?:debug1: Exit status 255|debug2: Received exit status from master 255)\r?$/mu.test(settlement.value.log)
	);
}

async function removeWithin(
	fileOperations: RunEnvironmentExecFileOperations,
	path: string,
	recursive: boolean,
	timeoutMs: number,
): Promise<void> {
	const removal = Promise.resolve()
		.then(() => fileOperations.remove(path, { recursive, force: true }))
		.catch(() => undefined);
	await waitWithin(removal, timeoutMs);
}
function processFailureDetail(label: string, result: RunEnvironmentProcessResult, stderr: string): string {
	const diagnostic = stderr.trim();
	if (result.error !== undefined) return `${label}: ${result.error.message}`;
	if (diagnostic.length > 0) return `${label}: ${diagnostic}`;
	if (result.signal !== null) return `${label}: signal ${result.signal}`;
	return `${label}: exit ${String(result.code)}`;
}

async function waitForSetupProcess(
	process: RunEnvironmentProcess,
	label: string,
	timeoutMs: number,
	stopTimeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	let stderr = "";
	process.onStderr((chunk) => {
		stderr = appendDiagnostic(stderr, chunk);
	});
	const finished = process.wait();
	if (signal?.aborted) {
		await stopProcess(process, finished, stopTimeoutMs);
		throw new Error("aborted");
	}
	let onAbort: (() => void) | undefined;
	let timeout: NodeJS.Timeout | undefined;
	const interrupted = new Promise<"aborted" | "timed_out">((resolve) => {
		onAbort = () => resolve("aborted");
		signal?.addEventListener("abort", onAbort, { once: true });
		timeout = setTimeout(() => resolve("timed_out"), timeoutMs);
	});
	try {
		const settlement = await Promise.race([
			finished.then((result) => ({ kind: "process" as const, result })),
			interrupted.then((kind) =>
				kind === "aborted" ? { kind: "aborted" as const } : { kind: "timed_out" as const },
			),
		]);
		if (settlement.kind === "aborted" || settlement.kind === "timed_out") {
			await stopProcess(process, finished, stopTimeoutMs);
			if (settlement.kind === "aborted") throw new Error("aborted");
			throw new Error(`${label}: timed out`);
		}
		if (settlement.result.code !== 0 || settlement.result.error !== undefined) {
			throw new Error(processFailureDetail(label, settlement.result, stderr));
		}
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
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

function renderWindowsCommand(command: RemoteCommand): string {
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
		"exit $exitCode",
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
	logPath: string,
): readonly string[] {
	const common = ["-vv", "-E", sshLogPath(logPath, controlPlatform), "-F", configPath, "-o", "ControlMaster=no"];
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
	stopTimeoutMs: number,
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
		const rawProcessFinished = check.wait();
		const processFinished = rawProcessFinished.then(
			(result): MasterProbeProcessSettlement => ({ kind: "probe_process", result }),
		);
		const settlement = await Promise.race([processFinished, interrupted, masterLost, probeTimedOut]);
		if (settlement.kind === "aborted" || settlement.kind === "timed_out" || settlement.kind === "master_lost") {
			await stopProcess(check, rawProcessFinished, stopTimeoutMs);
			return settlement;
		}
		if (settlement.kind === "probe_timeout") {
			await stopProcess(check, rawProcessFinished, stopTimeoutMs);
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
	const fileOperations = options.fileOperations ?? {
		readText: (path: string) => readFile(path, "utf8"),
		remove: (path: string, removeOptions: { readonly recursive: boolean; readonly force: true }) =>
			rm(path, removeOptions),
	};
	const controlPlatform = options.controlPlatform ?? process.platform;
	const sshPath = await resolveSshPath(options.sshPath, controlPlatform, options.environment ?? process.env);
	const ownsRuntimeDirectory = options.runtimeDirectory === undefined;
	const runtimeDirectory = options.runtimeDirectory ?? (await mkdtemp(join(tmpdir(), "atomic-ssh-")));
	await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
	const configPath = join(runtimeDirectory, "config");
	const controlPath = join(runtimeDirectory, "master.sock");
	const host = `${SSH_HOST_PREFIX}${options.workspaceName}`;
	const processOptions = { environment: options.environment };
	const processStopTimeoutMs = options.processStopTimeoutMs ?? DEFAULT_PROCESS_STOP_TIMEOUT_MS;
	const controlOperationTimeoutMs = options.controlOperationTimeoutMs ?? DEFAULT_CONTROL_OPERATION_TIMEOUT_MS;
	validateBound("SSH process stop timeout", processStopTimeoutMs);
	validateBound("SSH control operation timeout", controlOperationTimeoutMs);
	let closed = false;
	let closing = false;
	let masterLostDetail: string | undefined;
	let resolveMasterLost!: () => void;
	const masterLost = new Promise<void>((resolve) => {
		resolveMasterLost = resolve;
	});
	let masterLostSignaled = false;
	const signalMasterLost = (detail: string): void => {
		if (masterLostSignaled) return;
		masterLostSignaled = true;
		masterLostDetail = detail;
		resolveMasterLost();
	};
	const activeProcesses = new Set<RunEnvironmentProcess>();
	let startingMaster: RunEnvironmentProcess | undefined;
	let startingMasterFinished: Promise<RunEnvironmentProcessResult> | undefined;

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
		await waitForSetupProcess(
			configure,
			"coder config-ssh failed",
			controlOperationTimeoutMs,
			processStopTimeoutMs,
			options.signal,
		);

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
		const masterFinished = master.wait();
		startingMasterFinished = masterFinished;
		let masterStderr = "";
		master.onStderr((chunk) => {
			masterStderr = appendDiagnostic(masterStderr, chunk);
		});
		void masterFinished.then((result) => {
			signalMasterLost(processFailureDetail("SSH control master exited", result, masterStderr));
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
			const settlement = await waitForMasterReadinessCheck(
				check,
				readyDeadline,
				options.signal,
				masterLost,
				processStopTimeoutMs,
			);
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

		let closePromise: Promise<void> | undefined;
		return {
			async execute(command, sink, signal) {
				if (closed || closing) return { kind: "transport_lost", detail: "SSH transport is closed" };
				if (masterLostDetail !== undefined) return { kind: "transport_lost", detail: masterLostDetail };
				validateTimeoutSeconds(command.timeoutSeconds);
				if (signal.aborted) return { kind: "aborted" };
				const exitStatusLog = join(runtimeDirectory, `exec-${randomUUID()}.log`);
				const remoteCommand = renderRemoteCommand(command, options.operatingSystem);
				let stderr = "";
				let process: RunEnvironmentProcess;
				try {
					process = runner.start(
						sshPath,
						executionArguments(
							sshPath,
							configPath,
							controlPath,
							host,
							remoteCommand,
							controlPlatform,
							exitStatusLog,
						),
						processOptions,
					);
				} catch (error) {
					return {
						kind: "transport_lost",
						detail: error instanceof Error ? error.message : String(error),
					};
				}
				activeProcesses.add(process);
				let acceptingOutput = true;
				process.onStdout((chunk) => {
					if (acceptingOutput) sink.write(chunk, "stdout");
				});
				process.onStderr((chunk) => {
					if (!acceptingOutput) return;
					stderr = appendDiagnostic(stderr, chunk);
					sink.write(chunk, "stderr");
				});

				let timeout: NodeJS.Timeout | undefined;
				let onAbort: (() => void) | undefined;
				const aborted = new Promise<InterruptedSettlement>((resolve) => {
					onAbort = () => resolve({ kind: "aborted" });
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) onAbort();
				});
				const timedOut = new Promise<InterruptedSettlement>((resolve) => {
					if (command.timeoutSeconds !== undefined) {
						const seconds = command.timeoutSeconds;
						timeout = setTimeout(() => resolve({ kind: "timed_out", seconds }), seconds * 1_000);
					}
				});
				const rawProcessFinished = process.wait();
				const processFinished = rawProcessFinished.then(
					(result): ProcessSettlement => ({ kind: "process", result }),
				);
				const lost = masterLost.then((): InterruptedSettlement => ({ kind: "master_lost" }));
				try {
					const settlement: ExecutionSettlement = await Promise.race([processFinished, aborted, timedOut, lost]);
					if (settlement.kind === "aborted") {
						await stopProcess(process, rawProcessFinished, processStopTimeoutMs);
						return { kind: "aborted" };
					}
					if (settlement.kind === "timed_out") {
						await stopProcess(process, rawProcessFinished, processStopTimeoutMs);
						return { kind: "timed_out", seconds: settlement.seconds };
					}
					if (settlement.kind === "master_lost") {
						await stopProcess(process, rawProcessFinished, processStopTimeoutMs);
						return { kind: "transport_lost", detail: masterLostDetail ?? "SSH control master exited" };
					}
					if (timeout !== undefined) {
						clearTimeout(timeout);
						timeout = undefined;
					}
					if (settlement.result.error !== undefined || settlement.result.code === null) {
						return { kind: "transport_lost", detail: transportDetail(settlement.result, stderr) };
					}
					if (settlement.result.code !== SSH_TRANSPORT_EXIT_CODE) {
						return { kind: "exited", code: settlement.result.code };
					}
					if (await hasRemoteExit255Evidence(fileOperations, exitStatusLog, controlOperationTimeoutMs)) {
						return { kind: "exited", code: 255 };
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
						processStopTimeoutMs,
					);
					if (masterStatus.kind === "aborted") return { kind: "aborted" };
					if (masterStatus.kind === "master_lost" || masterLostDetail !== undefined) {
						return { kind: "transport_lost", detail: masterLostDetail ?? "SSH control master exited" };
					}
					if (masterStatus.kind === "dead") return { kind: "transport_lost", detail: masterStatus.detail };
					return { kind: "transport_lost", detail: transportDetail(settlement.result, stderr) };
				} finally {
					acceptingOutput = false;
					activeProcesses.delete(process);
					if (timeout !== undefined) clearTimeout(timeout);
					if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
					await removeWithin(fileOperations, exitStatusLog, false, controlOperationTimeoutMs);
				}
			},
			close() {
				if (closePromise !== undefined) return closePromise;
				closePromise = (async () => {
					if (closed) return;
					closing = true;
					signalMasterLost("SSH transport is closed");
					try {
						await Promise.all(
							[...activeProcesses].map((process) => stopProcess(process, process.wait(), processStopTimeoutMs)),
						);
						let exitResult: RunEnvironmentProcessResult | undefined;
						try {
							const exit = runner.start(
								sshPath,
								["-F", configPath, "-S", escapeControlPath(controlPath, controlPlatform), "-O", "exit", host],
								processOptions,
							);
							const exitFinished = exit.wait();
							const settlement = await waitWithin(exitFinished, controlOperationTimeoutMs);
							if (settlement.completed) exitResult = settlement.value;
							else await stopProcess(exit, exitFinished, processStopTimeoutMs);
						} catch {
							// The control master is terminated below when the control operation cannot run.
						}
						const masterStopped = await waitWithin(masterFinished, controlOperationTimeoutMs);
						if (
							!masterStopped.completed ||
							exitResult === undefined ||
							exitResult.code !== 0 ||
							exitResult.error !== undefined
						) {
							await stopProcess(master, masterFinished, processStopTimeoutMs);
						}
					} finally {
						closed = true;
						if (ownsRuntimeDirectory) {
							await removeWithin(fileOperations, runtimeDirectory, true, controlOperationTimeoutMs);
						}
					}
				})();
				return closePromise;
			},
		};
	} catch (error) {
		if (startingMaster !== undefined && startingMasterFinished !== undefined) {
			await stopProcess(startingMaster, startingMasterFinished, processStopTimeoutMs);
		}
		if (ownsRuntimeDirectory) await removeWithin(fileOperations, runtimeDirectory, true, controlOperationTimeoutMs);
		throw error;
	}
}
