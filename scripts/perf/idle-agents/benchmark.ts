#!/usr/bin/env node
/**
 * Idle-agents benchmark (#4326), on the method of hydro-project/infinity's `agent_scale`: agents run in waves, each
 * through `--turns` turns of a ~1.2 KB scripted completion with a tool round trip and a closing completion, through
 * the real AgentSession runtime with a scripted (faux) model. Each agent's last completion calls a detachable "long
 * tool" whose result arrives later from outside, the way a released subagent waits. After each wave goes idle the
 * process is collected and sampled: RSS, heap, active handles (timers, sockets, processes) and shared event-bus
 * listeners. The report fits KB per idle agent over the samples, measures stored bytes per agent, wakes a sample of
 * agents through the wake dispatcher (rehydrate from storage, hand back the tool result, finish the turn, release
 * again) for the wake latency distribution, and records event-loop delay while creating agents, while every agent is
 * idle, during single wakes and during a burst of wakes.
 *
 *   node --expose-gc --import jiti/register scripts/perf/idle-agents/benchmark.ts --agents 1000 --store sqlite
 *
 * `--mode resident` keeps every agent live instead of releasing it: the behaviour before #4326, for comparison.
 * `--store memory` is the in-memory session store as Atomic opens it for a memory selection (comparable to Infinity's
 * 107 KB), which keeps a released session's history in a file under the agent directory since #4502; `--store sqlite`
 * is the default node:sqlite session store in a temporary file (history on disk). `--workers N` creates the agents on N
 * worker threads of this one process, each with its own store, to reach large counts sooner; every sample adds up the
 * heap, handles and listeners of all threads, and RSS is the whole process. Run under Node: Bun reports no active
 * handles.
 *
 * `--path subagent` runs background subagents instead of SDK sessions: an owner session launches each as a task
 * through the real runner and task host, the child runs its turns, waits on the long tool, is released, and is woken
 * through the real wake binding; the report adds the owner's registries per agent. It needs the source aliases of
 * `@bastani/atomic`: set JITI_ALIAS to {"@bastani/atomic": "<repo>/packages/coding-agent/src/index.ts",
 * "@bastani/atomic/storage": "<repo>/packages/coding-agent/src/core/storage/index.ts"}.
 *
 * Handles are counted with `async_hooks`, so an unref'd timer or socket, which `process.getActiveResourcesInfo()`
 * leaves out, is counted too.
 *
 * The run points the system temp directory (`TMPDIR`) and the agent directory (`ATOMIC_CODING_AGENT_DIR`) at its own
 * temporary directory, so every file Atomic keeps there, such as the history the in-memory store moves out of memory
 * for released sessions under the agent directory's `released-history`, is removed with it. The report says how many
 * bytes and files `released-history` held at the end and the type of filesystem it is on: a tmpfs keeps them in memory
 * that RSS does not show.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { liveAsyncResources, trackAsyncResources } from "./async-resources.js";

/** `statfs` magic numbers of the filesystems a run's temporary directory is likely on. */
const FILESYSTEMS: Readonly<Record<number, string>> = {
	16914836: "tmpfs",
	61267: "ext4",
	1481003842: "xfs",
	2435016766: "btrfs",
	2035054128: "overlayfs",
	26985: "nfs",
};

/** Files and bytes under `directory`, at any depth; none when nothing ever created it. */
function filesUnder(directory: string): { files: number; bytes: number } {
	let files = 0;
	let bytes = 0;
	if (!existsSync(directory)) return { files, bytes };
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			const nested = filesUnder(path);
			files += nested.files;
			bytes += nested.bytes;
		} else if (entry.isFile()) {
			files += 1;
			bytes += statSync(path).size;
		}
	}
	return { files, bytes };
}

interface Options {
	readonly agents: number;
	readonly wave: number;
	readonly turns: number;
	readonly store: "memory" | "sqlite";
	readonly mode: "release" | "resident";
	readonly wakeSamples: number;
	readonly wakeBurst: number;
	readonly wakeConcurrency: number;
	readonly idleWindowMs: number;
	readonly workers: number;
	readonly path: "sdk" | "subagent";
	readonly label: string;
	readonly out?: string;
}

function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	const store = value("store") ?? "sqlite";
	const mode = value("mode") ?? "release";
	const path = value("path") ?? "sdk";
	if (path !== "sdk" && path !== "subagent") throw new Error(`--path must be sdk or subagent, not ${path}`);
	if (store !== "memory" && store !== "sqlite") throw new Error(`--store must be memory or sqlite, not ${store}`);
	if (mode !== "release" && mode !== "resident") throw new Error(`--mode must be release or resident, not ${mode}`);
	const count = (name: string, fallback: number) => {
		const parsed = Number(value(name) ?? fallback);
		if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a whole number`);
		return parsed;
	};
	const out = value("out");
	return {
		agents: count("agents", 1000),
		wave: Math.max(1, count("wave", 100)),
		turns: Math.max(1, count("turns", 20)),
		store,
		mode,
		wakeSamples: count("wake-samples", 100),
		wakeBurst: count("wake-burst", 200),
		wakeConcurrency: Math.max(1, count("wake-concurrency", 32)),
		idleWindowMs: count("idle-window-ms", 2000),
		workers: count("workers", 0),
		path,
		label: value("label") ?? `${mode}-${store}`,
		...(out === undefined ? {} : { out: resolve(out) }),
	};
}

type HostModule = typeof import("./agent-host.js");
type AgentHost = Awaited<ReturnType<HostModule["createAgentHost"]>>;
type HostOptions = Parameters<HostModule["createAgentHost"]>[0];

async function createHost(hostOptions: HostOptions): Promise<AgentHost> {
	if (hostOptions.path === "subagent") return (await import("./subagent-host.js")).createSubagentHost(hostOptions);
	return (await import("./agent-host.js")).createAgentHost(hostOptions);
}
type Command = { readonly id: number; readonly method: keyof AgentHost; readonly args: readonly number[] };

/** A worker thread: one agent host, driven by commands from the main thread. */
async function serveWorker(hostOptions: HostOptions): Promise<void> {
	const host = await createHost(hostOptions);
	const port = parentPort;
	if (port === null) throw new Error("serveWorker runs in a worker thread");
	port.on("message", (command: Command) => {
		const method = host[command.method] as (...args: number[]) => unknown;
		void Promise.resolve(method(...command.args)).then(
			(value) => port.postMessage({ id: command.id, value }),
			(error: Error) => port.postMessage({ id: command.id, error: error.stack ?? error.message }),
		);
	});
	port.postMessage({ id: 0, value: "ready" });
}

/** The same host interface over a worker thread. */
function remoteHost(worker: Worker): Promise<AgentHost> {
	let next = 1;
	const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
	const call =
		(method: keyof AgentHost) =>
		(...args: number[]) =>
			new Promise<never>((resolveCall, rejectCall) => {
				const id = next++;
				pending.set(id, { resolve: resolveCall, reject: rejectCall });
				worker.postMessage({ id, method, args });
			});
	return new Promise((ready, failed) => {
		worker.on("error", failed);
		worker.on("message", (reply: { id: number; value?: never; error?: string }) => {
			if (reply.id === 0) {
				ready({
					runWave: call("runWave"),
					snapshot: call("snapshot"),
					measureIdle: call("measureIdle"),
					wakeSequential: call("wakeSequential"),
					wakeBurst: call("wakeBurst"),
					stored: call("stored"),
					stats: call("stats") as never,
					close: call("close"),
				});
				return;
			}
			const settle = pending.get(reply.id);
			pending.delete(reply.id);
			if (reply.error !== undefined) settle?.reject(new Error(reply.error));
			else settle?.resolve(reply.value as never);
		});
	});
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const tempRoot = mkdtempSync(join(tmpdir(), "atomic-idle-agents-"));
	process.env.TMPDIR = tempRoot;
	// Anything this process might start (an Intercom broker, journals, settings) lives under the temporary directory.
	process.env.ATOMIC_CODING_AGENT_DIR = join(tempRoot, "agent");
	// The scripted model keeps each session's whole prompt to simulate a provider cache; that is test-model state,
	// not agent state, so it is off. It also keeps the cache warmer off, which only live sessions run.
	process.env.PI_CACHE_RETENTION = "none";
	mkdirSync(process.env.ATOMIC_CODING_AGENT_DIR, { recursive: true });
	const gc = (globalThis as { gc?: () => void }).gc;
	if (gc === undefined) throw new Error("Run with node --expose-gc so samples are taken after a full collection.");
	trackAsyncResources();
	const summary = await import("./summary.js");
	const hostOptions = (index: number): HostOptions => ({
		path: options.path,
		root: tempRoot,
		index,
		store: options.store,
		mode: options.mode,
		turns: options.turns,
		wakeConcurrency: options.wakeConcurrency,
	});
	const hosts: AgentHost[] = [];
	const workers: Worker[] = [];
	if (options.workers === 0) {
		hosts.push(await createHost(hostOptions(0)));
	} else {
		for (let index = 0; index < options.workers; index++) {
			const worker = new Worker(fileURLToPath(import.meta.url), { workerData: hostOptions(index) });
			workers.push(worker);
			hosts.push(await remoteHost(worker));
		}
	}

	const samples: Parameters<(typeof summary)["perAgentKb"]>[0][number][] = [];
	async function sample(agents: number): Promise<void> {
		const threads = await Promise.all(hosts.map((host) => host.snapshot()));
		gc?.();
		gc?.();
		const main = process.memoryUsage();
		const handles = liveAsyncResources();
		for (const thread of options.workers === 0 ? [] : threads)
			for (const [kind, count] of Object.entries(thread.handles)) handles[kind] = (handles[kind] ?? 0) + count;
		samples.push({
			agents,
			rssBytes: main.rss,
			heapUsedBytes:
				(options.workers === 0 ? 0 : main.heapUsed) +
				threads.reduce((sum, thread) => sum + thread.heapUsedBytes, 0),
			arrayBuffersBytes:
				(options.workers === 0 ? 0 : main.arrayBuffers) +
				threads.reduce((sum, thread) => sum + thread.arrayBuffersBytes, 0),
			handles: options.workers === 0 ? (threads[0]?.handles ?? handles) : handles,
			listeners: threads.reduce((sum, thread) => sum + thread.listeners, 0),
			registries: threads.reduce<Record<string, number>>((total, thread) => {
				for (const [name, size] of Object.entries(thread.registries ?? {})) total[name] = (total[name] ?? 0) + size;
				return total;
			}, {}),
		});
	}

	const startedAt = performance.now();
	await sample(0);
	const createDelay = (await import("node:perf_hooks")).monitorEventLoopDelay({ resolution: 10 });
	createDelay.enable();
	for (let done = 0; done < options.agents; ) {
		const size = Math.min(options.wave, options.agents - done);
		const share = Math.ceil(size / hosts.length);
		await Promise.all(
			hosts.map((host, index) => {
				const count = Math.max(0, Math.min(share, size - index * share));
				return count === 0 ? Promise.resolve() : host.runWave(count, done + index * share);
			}),
		);
		done += size;
		await sample(done);
		const last = samples.at(-1);
		console.error(
			`${options.label}: ${done}/${options.agents} agents idle, rss ${((last?.rssBytes ?? 0) / 2 ** 20).toFixed(0)} MiB, heap ${((last?.heapUsedBytes ?? 0) / 2 ** 20).toFixed(0)} MiB, buffers ${((last?.arrayBuffersBytes ?? 0) / 2 ** 20).toFixed(0)} MiB, ${JSON.stringify(summary.handleTotals(last?.handles ?? {}))}, listeners ${last?.listeners}`,
		);
	}
	createDelay.disable();
	const create = {
		p50Ms: createDelay.percentile(50) / 1e6,
		p99Ms: createDelay.percentile(99) / 1e6,
		maxMs: createDelay.max / 1e6,
	};
	const idle = await Promise.all(hosts.map((host) => host.measureIdle(options.idleWindowMs)));
	if (options.wakeSamples > 0 || options.wakeBurst > 0) await Promise.all(hosts.map((host) => host.wakeSequential(1)));
	const sequential = options.wakeSamples === 0 ? undefined : await hosts[0]?.wakeSequential(options.wakeSamples);
	const burstShare = Math.ceil(options.wakeBurst / hosts.length);
	const burstStarted = performance.now();
	const bursts = options.wakeBurst === 0 ? [] : await Promise.all(hosts.map((host) => host.wakeBurst(burstShare)));
	const burstElapsedMs = performance.now() - burstStarted;
	const stored = await Promise.all(hosts.map((host) => host.stored(Math.ceil(500 / hosts.length))));
	const stats = await Promise.all(hosts.map((host) => host.stats()));
	const { releasedHistoryDirectory } = await import(
		"../../../packages/coding-agent/src/core/storage/session/released-history-files.js"
	);
	const filesystem = statfsSync(tempRoot).type;
	const releasedHistory = {
		...filesUnder(releasedHistoryDirectory(process.env.ATOMIC_CODING_AGENT_DIR as string)),
		filesystem: FILESYSTEMS[filesystem] ?? `0x${filesystem.toString(16)}`,
	};
	const sampled = stored.reduce((sum, part) => sum + part.sampled, 0);
	const agents = Math.max(1, options.agents);
	const burstLatencyMs = bursts.flatMap((burst) => [...burst.latencyMs]);
	const worst = (values: readonly { p50Ms: number; p99Ms: number; maxMs: number }[]) => ({
		p50Ms: Math.max(0, ...values.map((value) => value.p50Ms)),
		p99Ms: Math.max(0, ...values.map((value) => value.p99Ms)),
		maxMs: Math.max(0, ...values.map((value) => value.maxMs)),
	});
	const report = {
		label: options.label,
		path: options.path,
		store: options.store,
		mode: options.mode,
		agents: options.agents,
		turns: options.turns,
		wave: options.wave,
		workers: options.workers,
		storedBytesPerAgent: sampled === 0 ? 0 : stored.reduce((sum, part) => sum + part.jsonBytes, 0) / sampled,
		sqliteFileBytesPerAgent: stored.reduce((sum, part) => sum + part.sqliteFileBytes, 0) / agents,
		ownerEntryBytesPerAgent: stored.reduce((sum, part) => sum + (part.ownerEntryBytes ?? 0), 0) / agents,
		releasedHistory,
		maxRssBytes: process.resourceUsage().maxRSS * 1024,
		samples,
		wakeLatencyMs: [...(sequential?.latencyMs ?? [])],
		eventLoopDelayP99Ms: worst(idle).p99Ms,
		eventLoopDelayMaxMs: worst(idle).maxMs,
		eventLoopDelay: {
			create,
			idle: worst(idle),
			...(sequential === undefined ? {} : { wakes: sequential.delay }),
			...(bursts.length === 0 ? {} : { burst: worst(bursts.map((burst) => burst.delay)) }),
		},
		burst: {
			wakes: burstLatencyMs.length,
			elapsedMs: burstElapsedMs,
			p50Ms: summary.percentile(burstLatencyMs, 50),
			p99Ms: summary.percentile(burstLatencyMs, 99),
			maxMs: Math.max(0, ...burstLatencyMs),
		},
		wakeConcurrency: options.wakeConcurrency,
		elapsedMs: performance.now() - startedAt,
		dispatcher: stats.map((stat) => stat.dispatcher),
		liveRehydratedSessions: stats.reduce((sum, stat) => sum + stat.liveRehydrated, 0),
		unusedResponses: stats.reduce((sum, stat) => sum + stat.unused, 0),
	};
	const { rssKb, heapKb, heapAndBuffersKb } = summary.perAgentKb(samples);
	console.log(summary.REPORT_HEADER);
	console.log(summary.reportRow(report));
	console.log(
		JSON.stringify({
			rssKbPerAgent: rssKb,
			heapKbPerAgent: heapKb,
			heapAndBuffersKbPerAgent: heapAndBuffersKb,
			storedKbPerAgent: report.storedBytesPerAgent / 1024,
			sqliteFileKbPerAgent: report.sqliteFileBytesPerAgent / 1024,
			ownerEntryKbPerAgent: report.ownerEntryBytesPerAgent / 1024,
			endRssGiB: (samples.at(-1)?.rssBytes ?? 0) / 2 ** 30,
			sampledPeakRssGiB: Math.max(0, ...samples.map((sample) => sample.rssBytes)) / 2 ** 30,
			maxRssGiB: report.maxRssBytes / 2 ** 30,
			releasedHistoryKbPerAgent: releasedHistory.bytes / agents / 1024,
			releasedHistory,
			handlesPerAgent: summary.perAgentHandles(samples),
			listenersPerAgent: summary.perAgentListeners(samples),
			registriesPerAgent: summary.perAgentRegistries(samples),
			wakeP50Ms: summary.percentile(report.wakeLatencyMs, 50),
			wakeP99Ms: summary.percentile(report.wakeLatencyMs, 99),
			burst: report.burst,
			eventLoopDelay: report.eventLoopDelay,
			dispatcher: report.dispatcher,
			liveRehydratedSessions: report.liveRehydratedSessions,
			unusedResponses: report.unusedResponses,
			elapsedS: report.elapsedMs / 1000,
		}),
	);
	if (options.out !== undefined) writeFileSync(options.out, `${JSON.stringify(report, null, "\t")}\n`);
	for (const host of hosts) await host.close();
	for (const worker of workers) await worker.terminate();
	rmSync(tempRoot, { recursive: true, force: true });
}

if (isMainThread) await main();
else await serveWorker(workerData as HostOptions);
