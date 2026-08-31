#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LoopbackProviderCollector } from "./collector.js";
import { type ConptyProcess, startConpty } from "./conpty.js";
import { benchmarkEnvironment, createAgentTemplate, environmentHash, prepareRunDirectories } from "./fixtures.js";
import {
	type BenchmarkBuild,
	type BenchmarkLane,
	type BenchmarkSample,
	type CacheProfile,
	elapsedMs,
	persistSample,
} from "./samples.js";
import { type ScreenObservation, type ScreenSnapshot, StartupScreenTracker } from "./screen.js";

export interface ArtifactMetadata {
	readonly artifactHashes?: Readonly<Record<string, string>>;
	readonly runtime?: Readonly<Record<string, string>>;
}

export interface BuildTarget {
	readonly build: BenchmarkBuild;
	readonly executableDirectory: string;
	readonly metadata: ArtifactMetadata;
}

interface BenchmarkOptions {
	readonly outputDirectory: string;
	readonly stateDirectory: string;
	readonly lane: BenchmarkLane;
	readonly profile: CacheProfile;
	readonly version: string;
	readonly repeats: number;
	readonly port: number;
	readonly timeoutMs: number;
	readonly cwd: string;
	readonly targets: readonly BuildTarget[];
	readonly seed: number;
	readonly expectedBaselineSha?: string;
	readonly expectedCandidateSha?: string;
}

function quoteArgument(value: string): string {
	// The command line is quoted once by the native PTY layer (MSVC rules) and then
	// re-parsed by `cmd /d /s /c`, the launcher shim, and the launcher itself, so any
	// quote inserted here survives as a literal character in the argument. Pass the
	// value bare and reject characters that would require quoting.
	if (/["\s]/.test(value)) {
		throw new Error(`argument must not contain quotes or whitespace: ${value}`);
	}
	return value;
}

function timeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		delay(milliseconds).then(() => {
			throw new Error(`${label} timed out after ${milliseconds} ms`);
		}),
	]);
}

async function waitForScreen(
	observe: () => Promise<ScreenObservation>,
	predicate: (observation: ScreenObservation) => boolean,
	timeoutMs: number,
	label: string,
	nudge?: () => void,
): Promise<ScreenObservation> {
	const deadline = Date.now() + timeoutMs;
	let nudgeAt = Date.now() + NUDGE_INTERVAL_MS;
	while (Date.now() < deadline) {
		const observation = await observe();
		if (predicate(observation)) return observation;
		if (nudge && Date.now() >= nudgeAt) {
			nudge();
			nudgeAt = Date.now() + NUDGE_INTERVAL_MS;
		}
		await delay(10);
	}
	throw new Error(`${label} timed out after ${timeoutMs} ms`);
}

// ConPTY on Windows Server 2022 can withhold an already-written frame from the
// output pipe until the next console event (verified: the same frame renders
// immediately in an interactive console). A rows toggle forces conhost to
// re-emit the screen. Only post-measurement waits may nudge: every headline
// metric mark is taken before the first nudged wait, so repaints triggered
// here cannot affect timing.
const NUDGE_INTERVAL_MS = 1_000;

function shuffleBit(seed: number): number {
	let state = seed >>> 0;
	state ^= state << 13;
	state ^= state >>> 17;
	state ^= state << 5;
	return state & 1;
}

export function createBalancedOrder(
	targets: readonly BenchmarkBuild[],
	repeats: number,
	seed: number,
): BenchmarkBuild[] {
	if (targets.length === 0) throw new Error("at least one benchmark target is required");
	if (targets.length === 1) return Array.from({ length: repeats }, () => targets[0]!);
	if (targets.length === 2) {
		const [first, second] = shuffleBit(seed) === 0 ? targets : [targets[1]!, targets[0]!];
		const order: BenchmarkBuild[] = [];
		for (let pair = 0; pair < repeats; pair += 1) {
			if (pair % 2 === 0) order.push(first!, second!);
			else order.push(second!, first!);
		}
		return order;
	}
	const order: BenchmarkBuild[] = [];
	const initialOffset = (seed >>> 0) % targets.length;
	for (let round = 0; round < repeats; round += 1) {
		const block = targets.map((_, index) => targets[(initialOffset + round + index) % targets.length]!);
		if (Math.floor(round / targets.length) % 2 === 1) block.reverse();
		order.push(...block);
	}
	return order;
}
export function createBenchmarkMetrics(marks: {
	readonly processLaunch: bigint;
	readonly startupComplete: bigint;
	readonly enter: bigint;
	readonly providerFirstByte: bigint;
}): BenchmarkSample["metricsMs"] {
	const startupCompleteMs = elapsedMs(marks.processLaunch, marks.startupComplete);
	const dispatchMs = elapsedMs(marks.enter, marks.providerFirstByte);
	return {
		startupCompleteMs,
		dispatchMs,
		spawnToDispatchMs: startupCompleteMs + dispatchMs,
		launchToProviderFirstByteMs: elapsedMs(marks.processLaunch, marks.providerFirstByte),
	};
}

async function loadMetadata(path: string, build: BenchmarkBuild): Promise<ArtifactMetadata> {
	const metadata = JSON.parse(await readFile(path, "utf8")) as ArtifactMetadata;
	if (!metadata.artifactHashes || Object.keys(metadata.artifactHashes).length === 0) {
		throw new Error(`${build} metadata must contain artifactHashes`);
	}
	if (!metadata.runtime || Object.keys(metadata.runtime).length === 0) {
		throw new Error(`${build} metadata must contain runtime identity`);
	}
	return metadata;
}

export function validateComparisonIdentity(
	targets: readonly BuildTarget[],
	expectedBaselineSha: string | undefined,
	expectedCandidateSha: string | undefined,
): void {
	const byBuild = new Map(targets.map((target) => [target.build, target]));
	const bytecode = byBuild.get("candidate-bytecode");
	if (bytecode && (!expectedBaselineSha || !expectedCandidateSha)) {
		throw new Error("three-arm runs require --baseline-sha and --candidate-sha");
	}
	if (expectedBaselineSha) {
		const actual = byBuild.get("baseline")?.metadata.runtime?.productSha;
		if (actual !== expectedBaselineSha)
			throw new Error(`baseline product SHA mismatch: expected ${expectedBaselineSha}, got ${actual ?? "missing"}`);
	}
	if (expectedCandidateSha) {
		for (const build of ["candidate", ...(bytecode ? (["candidate-bytecode"] as const) : [])] as const) {
			const actual = byBuild.get(build)?.metadata.runtime?.productSha;
			if (actual !== expectedCandidateSha)
				throw new Error(
					`${build} product SHA mismatch: expected ${expectedCandidateSha}, got ${actual ?? "missing"}`,
				);
		}
	}
	if (!bytecode) return;
	const baseline = byBuild.get("baseline");
	const candidate = byBuild.get("candidate");
	if (!baseline || !candidate || targets.length !== 3) {
		throw new Error("bytecode evidence requires exactly baseline, candidate, and candidate-bytecode arms");
	}
	if (baseline.metadata.runtime?.launcherMode !== "non-bytecode")
		throw new Error("baseline launcherMode must be non-bytecode");
	if (candidate.metadata.runtime?.launcherMode !== "non-bytecode")
		throw new Error("candidate launcherMode must be non-bytecode");
	if (bytecode.metadata.runtime?.launcherMode !== "bytecode")
		throw new Error("candidate-bytecode launcherMode must be bytecode");
	if (bytecode.metadata.runtime?.bun !== "1.4.0") throw new Error("candidate-bytecode must use Bun 1.4.0");
	const candidateApp = candidate.metadata.artifactHashes?.["app.js"];
	const bytecodeApp = bytecode.metadata.artifactHashes?.["app.js"];
	if (!candidateApp || candidateApp !== bytecodeApp) {
		throw new Error("optimized non-bytecode and bytecode arms must share the exact app.js hash");
	}
}

function parseInteger(value: string | undefined, name: string, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
	return parsed;
}

async function parseOptions(argv: readonly string[]): Promise<BenchmarkOptions> {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${flag ?? "<end>"}`);
		values.set(flag.slice(2), value);
	}
	const outputDirectory = values.get("output");
	const lane = values.get("lane");
	const profile = values.get("profile");
	const version = values.get("version");
	if (
		!outputDirectory ||
		(lane !== "release" && lane !== "node") ||
		(profile !== "warm" && profile !== "atomic-state-cold") ||
		!version
	) {
		throw new Error("required: --output DIR --lane release|node --profile warm|atomic-state-cold --version VERSION");
	}
	if (lane === "node" && profile !== "warm") throw new Error("the Node lane supports the warm profile only");
	const targets: BuildTarget[] = [];
	for (const build of ["baseline", "candidate", "candidate-bytecode"] as const) {
		const executableDirectory = values.get(`${build}-bin`);
		if (!executableDirectory) continue;
		const metadataPath = values.get(`${build}-metadata`);
		if (!metadataPath) throw new Error(`--${build}-metadata is required with --${build}-bin`);
		targets.push({
			build,
			executableDirectory: resolve(executableDirectory),
			metadata: await loadMetadata(metadataPath, build),
		});
	}
	if (targets.length === 0) throw new Error("provide --baseline-bin and optionally candidate artifact bins");
	const expectedBaselineSha = values.get("baseline-sha");
	const expectedCandidateSha = values.get("candidate-sha");
	validateComparisonIdentity(targets, expectedBaselineSha, expectedCandidateSha);
	return {
		outputDirectory: resolve(outputDirectory),
		stateDirectory: resolve(values.get("state-root") ?? join(outputDirectory, "state")),
		lane,
		profile,
		version,
		repeats: parseInteger(values.get("repeats"), "repeats", 30),
		port: parseInteger(values.get("port"), "port", 43_171),
		timeoutMs: parseInteger(values.get("timeout-ms"), "timeout-ms", 60_000),
		cwd: resolve(values.get("cwd") ?? process.cwd()),
		targets,
		seed: parseInteger(values.get("seed"), "seed", 0x41544f4d),
		...(expectedBaselineSha ? { expectedBaselineSha } : {}),
		...(expectedCandidateSha ? { expectedCandidateSha } : {}),
	};
}

async function settleProcess(process: ConptyProcess | undefined): Promise<void> {
	if (!process) return;
	try {
		await timeout(process.exited, 5_000, "atomic exit");
	} catch {
		process.kill();
		await process.exited.catch(() => undefined);
	}
}

async function runSample(options: BenchmarkOptions, target: BuildTarget, ordinal: number): Promise<BenchmarkSample> {
	const id = `${String(ordinal).padStart(3, "0")}-${target.build}-${randomUUID()}`;
	const nonce = `atomic-startup-${randomUUID()}`;
	const stateRoot = join(options.stateDirectory, `${options.lane}-${target.build}-${options.profile}`);
	const templateDirectory = join(options.stateDirectory, "agent-template");
	const collector = new LoopbackProviderCollector(nonce, { port: options.port });
	const tracker = new StartupScreenTracker(options.version, { cols: 120, rows: 40 });
	const chunks: Array<{ atNs: string; data: string }> = [];
	let ptyOutput = "";
	let coherentSnapshot: ScreenSnapshot | undefined;
	let completeSnapshot: ScreenSnapshot | undefined;
	let screenQueue = Promise.resolve();
	let child: ConptyProcess | undefined;
	let chunkError: Error | undefined;
	let launchStarted = false;
	let state: BenchmarkSample["state"] = "success";
	const failures: string[] = [];
	const marks: Record<string, string> = {};
	let workflowListSucceeded = false;
	let environmentDigest: string | undefined;
	let commandLine = "";
	const startedAt = new Date().toISOString();
	const rawArtifactDirectory = join("raw", options.lane, target.build, options.profile, id);
	try {
		await collector.start();
		await createAgentTemplate(templateDirectory, collector.port);
		const directories = await prepareRunDirectories(stateRoot, templateDirectory, id, options.profile);
		const environment = benchmarkEnvironment(directories.agentDir, target.executableDirectory);
		environmentDigest = environmentHash(environment);
		commandLine = `atomic --session-dir ${quoteArgument(directories.sessionDir)} --provider benchmark-loopback --model benchmark-model`;
		marks.processLaunch = process.hrtime.bigint().toString();
		child = startConpty({
			command: commandLine,
			cwd: options.cwd,
			env: environment,
			timeoutMs: options.timeoutMs * 3,
			onChunk: (chunk, atNs) => {
				marks.firstTerminalOutput ??= atNs.toString();
				chunks.push({ atNs: atNs.toString(), data: chunk });
				ptyOutput += chunk;
				screenQueue = screenQueue.then(async () => {
					const observation = await tracker.write(chunk, atNs);
					if (!coherentSnapshot && observation.coherent) {
						coherentSnapshot = observation;
						marks.startupCoherent = observation.atNs;
					}
				});
			},
			onChunkError: (error) => {
				chunkError = error;
			},
		});
		launchStarted = true;
		// Serialize explicit observations behind pending chunk writes. The timestamp
		// is captured synchronously before enqueueing, so every write already queued
		// carries an earlier callback timestamp and later callbacks enqueue after the
		// observation, keeping the tracker's clock monotonic.
		const observeQueued = (): Promise<ScreenObservation> => {
			const atNs = process.hrtime.bigint();
			const pending = screenQueue.then(() => tracker.observe(atNs));
			screenQueue = pending.then(
				() => undefined,
				() => undefined,
			);
			return pending;
		};
		const completed = await waitForScreen(
			observeQueued,
			(observation) => observation.complete,
			options.timeoutMs,
			"strict startup paint",
		);
		completeSnapshot = completed;
		marks.startupComplete = completed.atNs;
		child.write(nonce);
		await waitForScreen(observeQueued, (observation) => observation.text.includes(nonce), 5_000, "nonce echo");
		const enterAt = process.hrtime.bigint();
		marks.enter = enterAt.toString();
		child.write("\r");
		const request = await timeout(collector.waitForRequest(), options.timeoutMs, "provider dispatch");
		marks.providerFirstByte = request.firstByteNs;
		const live = child;
		const nudgeRepaint = (): void => {
			live.resize(120, 41);
			live.resize(120, 40);
		};
		await waitForScreen(
			observeQueued,
			(observation) => observation.text.includes("benchmark-ok") && observation.coherent,
			options.timeoutMs,
			"provider response",
			nudgeRepaint,
		);
		child.write("/workflow list\r");
		// The bundled workflow list is taller than the 40-row viewport, so its
		// earliest (alphabetical) entries scroll off the visible screen. Assert
		// on markers that remain in the settled viewport: a bundled workflow
		// name near the end of the list and the command help footer.
		await waitForScreen(
			observeQueued,
			(observation) =>
				observation.text.includes("loop-until-done") && observation.text.includes("inspect input schema"),
			options.timeoutMs,
			"/workflow list",
			nudgeRepaint,
		);
		workflowListSucceeded = true;
		if (chunkError) throw new Error(`ConPTY output callback failed: ${chunkError.message}`);
		child.write("/quit\r");
		const exit = await timeout(child.exited, 5_000, "atomic exit");
		if (exit.timedOut || exit.cancelled || exit.exitCode !== 0) {
			throw new Error(
				`atomic did not exit cleanly: exit=${exit.exitCode ?? "null"}, timedOut=${exit.timedOut}, cancelled=${exit.cancelled}`,
			);
		}
		await collector.stop();
		collector.assertSingleValidRequest();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		failures.push(message);
		state = launchStarted ? "product-failure" : "invalid";
		try {
			child?.write("/quit\r");
		} catch {}
		await settleProcess(child);
	} finally {
		await screenQueue.catch((error) => failures.push(error instanceof Error ? error.message : String(error)));
		await collector.stop().catch((error) => failures.push(error instanceof Error ? error.message : String(error)));
		tracker.dispose();
	}
	marks.providerFirstByte ??= collector.attempts[0]?.firstByteNs ?? "";
	if (marks.providerFirstByte === "") delete marks.providerFirstByte;
	if (state === "success" && failures.length > 0) state = "invalid";
	const processLaunch = marks.processLaunch ? BigInt(marks.processLaunch) : undefined;
	const startupComplete = marks.startupComplete ? BigInt(marks.startupComplete) : undefined;
	const enter = marks.enter ? BigInt(marks.enter) : undefined;
	const providerFirstByte = marks.providerFirstByte ? BigInt(marks.providerFirstByte) : undefined;
	const metricsMs =
		state === "success" && processLaunch && startupComplete && enter && providerFirstByte
			? createBenchmarkMetrics({ processLaunch, startupComplete, enter, providerFirstByte })
			: undefined;
	const command =
		commandLine || "atomic --session-dir <uncreated> --provider benchmark-loopback --model benchmark-model";
	const sample: BenchmarkSample = {
		schemaVersion: 1,
		id,
		lane: options.lane,
		build: target.build,
		profile: options.profile,
		state,
		command,
		startedAt,
		marksNs: marks,
		...(metricsMs ? { metricsMs } : {}),
		artifactHashes: target.metadata.artifactHashes ?? {},
		...(environmentDigest ? { environmentHash: environmentDigest } : {}),
		...(target.metadata.runtime ? { runtime: target.metadata.runtime } : {}),
		rawArtifactDirectory,
		failures,
		providerValidation: {
			nonceFound: collector.requests[0]?.nonceFound ?? false,
			toolNames: collector.requests[0]?.toolNames ?? [],
			requestCount: collector.attempts.length,
		},
		workflowListSucceeded,
	};
	await persistSample(options.outputDirectory, sample, {
		ptyOutput,
		receivedChunks: chunks,
		coherentSnapshot,
		completeSnapshot,
		providerAttempts: collector.attempts,
		providerRequests: collector.requests,
	});
	return sample;
}

export async function runBenchmark(options: BenchmarkOptions): Promise<readonly BenchmarkSample[]> {
	await mkdir(options.outputDirectory, { recursive: true });
	const order = createBalancedOrder(
		options.targets.map((target) => target.build),
		options.repeats,
		options.seed,
	);
	await writeFile(
		join(options.outputDirectory, "order.json"),
		`${JSON.stringify({ seed: options.seed, order }, null, 2)}\n`,
		"utf8",
	);
	const targets = new Map(options.targets.map((target) => [target.build, target]));
	const samples: BenchmarkSample[] = [];
	for (const [index, build] of order.entries()) {
		const target = targets.get(build);
		if (!target) throw new Error(`execution order references missing build: ${build}`);
		const sample = await runSample(options, target, index + 1);
		samples.push(sample);
		process.stdout.write(
			`${sample.id} ${sample.state}${sample.metricsMs ? ` startup=${sample.metricsMs.startupCompleteMs.toFixed(1)}ms dispatch=${sample.metricsMs.dispatchMs.toFixed(1)}ms` : ""}\n`,
		);
	}
	return samples;
}

if (import.meta.main) {
	const options = await parseOptions(process.argv.slice(2));
	const samples = await runBenchmark(options);
	if (samples.some((sample) => sample.state !== "success")) process.exitCode = 1;
}
