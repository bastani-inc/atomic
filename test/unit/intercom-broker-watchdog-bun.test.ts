import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, test } from "vitest";
import {
	bunExecutable,
	fileExistsSync,
	makeTempDirectory,
	readTextSync,
	removePathSync,
	removeTempDirectory,
	sleep,
	spawnProcess,
	writeTextSync,
} from "../helpers/runtime.js";

const agentDir = makeTempDirectory("ic3862-watch-");
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousStorage = process.env.ATOMIC_STORAGE;
process.env.ATOMIC_STORAGE = JSON.stringify({ memory: true });
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { getBrokerPidPath, getBrokerWatchdogLogPath, getIntercomDirPath } = await import(
	"../../packages/intercom/broker/paths.js"
);
const { BROKER_READY_TIMEOUT_MS, spawnBrokerIfNeeded } = await import("../../packages/intercom/broker/spawn.js");
const clients: InstanceType<typeof IntercomClient>[] = [];
const ownedPids = new Set<number>();
const REAL_STALLED_BROKER_TIMEOUT_MS = 100_000;
const WATCHDOG_EXIT_BUDGET_MS = 80_000;
const STARTUP_BUDGET_MS = 10_000;
const SLOW_PROBE_DELAY_MS = 12_000;
/**
 * How long the replacement broker gets to start listening: `spawnBrokerIfNeeded`'s own default, sized from how long the
 * broker takes to load jiti and its module graph on a busy host with a cold cache (see `startup-timeout.ts`). This only
 * bounds a replacement that never starts; the watchdog's own exit stays bounded by `WATCHDOG_EXIT_BUDGET_MS`.
 */
const REPLACEMENT_STARTUP_BUDGET_MS = BROKER_READY_TIMEOUT_MS;
const extensionDir = join(process.cwd(), "packages/intercom");

function captureOutput(streams: readonly (ReadableStream<Uint8Array> | null)[]): () => string {
	const limit = 8_192;
	let text = "";
	for (const stream of streams) {
		if (stream === null) continue;
		void (async () => {
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
				if (text.length < limit)
					text += decoder.decode(chunk.value, { stream: true }).slice(0, limit - text.length);
			}
		})().catch(() => {});
	}
	return () => text;
}

async function waitUntil(condition: () => boolean, budgetMs: number): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!condition()) {
		assert.ok(Date.now() < deadline, "condition did not become true before its deadline");
		await sleep(25);
	}
}

afterEach(async () => {
	for (const client of clients.splice(0)) await client.disconnect();
	for (const pid of ownedPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
		await waitUntil(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		}, STARTUP_BUDGET_MS);
	}
	ownedPids.clear();
	removePathSync(getIntercomDirPath(), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
	if (previousStorage === undefined) delete process.env.ATOMIC_STORAGE;
	else process.env.ATOMIC_STORAGE = previousStorage;
	removeTempDirectory(agentDir);
});

async function connect(name: string) {
	const client = new IntercomClient();
	clients.push(client);
	client.on("error", () => {});
	await client.connect({
		name,
		group: "workflow:watchdog-run",
		cwd: agentDir,
		model: "test",
		pid: process.pid,
		startedAt: 1,
		lastActivity: 1,
	});
	return client;
}

test.each([{ name: "Bun", command: bunExecutable(), args: ["--preload"], loader: [], preloadAsPath: true }])(
	"a $name broker with a blocked main thread exits and concurrent reconnects share one replacement (#3862)",
	async (runtime) => {
		const gate = join(agentDir, `stall-${runtime.name}`);
		const blocked = join(agentDir, `blocked-${runtime.name}`);
		const recovered = join(agentDir, `recovered-${runtime.name}`);
		const preload = join(agentDir, `stall-main-${runtime.name}.mjs`);
		writeTextSync(
			preload,
			`
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
setInterval(() => {
  if (!existsSync(${JSON.stringify(gate)})) return;
  writeFileSync(${JSON.stringify(blocked)}, "blocked");
  const duration = Number(readFileSync(${JSON.stringify(gate)}, "utf8"));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number.isFinite(duration) ? duration : undefined);
  unlinkSync(${JSON.stringify(gate)});
  writeFileSync(${JSON.stringify(recovered)}, "recovered");
}, 25).unref();
`,
		);
		const child = spawnProcess(
			[
				runtime.command,
				...runtime.args,
				runtime.preloadAsPath ? preload : pathToFileURL(preload).href,
				...runtime.loader,
				join(extensionDir, "broker/broker.ts"),
			],
			{ env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir }, stdout: "pipe", stderr: "pipe" },
		);
		assert.ok(child.pid !== undefined);
		ownedPids.add(child.pid);
		const output = captureOutput([child.stdout, child.stderr]);
		let earlyExit: number | undefined;
		void child.exited.then((code) => {
			earlyExit = code;
		});
		try {
			await waitUntil(() => fileExistsSync(getBrokerPidPath()) || earlyExit !== undefined, STARTUP_BUDGET_MS);
		} catch (error) {
			throw new Error(
				`${runtime.name} broker did not write its pid file within ${STARTUP_BUDGET_MS}ms (exit: ${earlyExit ?? "still running"}); output:\n${output()}`,
				{ cause: error },
			);
		}
		assert.equal(
			earlyExit,
			undefined,
			`${runtime.name} broker exited during startup with ${earlyExit}; output:\n${output()}`,
		);
		const before = await connect("before-stall");
		assert.equal((await before.listSessions()).length, 1);
		await sleep(2_500);
		writeTextSync(gate, String(SLOW_PROBE_DELAY_MS));
		await waitUntil(() => fileExistsSync(recovered), SLOW_PROBE_DELAY_MS + STARTUP_BUDGET_MS);
		await sleep(2_500);
		removePathSync(blocked, { force: true });
		assert.equal((await before.listSessions()).length, 1);
		writeTextSync(gate, "stall");
		await waitUntil(() => fileExistsSync(blocked), STARTUP_BUDGET_MS);
		let exited = false;
		void child.exited.then(() => {
			exited = true;
		});
		await waitUntil(() => exited, WATCHDOG_EXIT_BUDGET_MS);
		await waitUntil(() => !before.isConnected(), STARTUP_BUDGET_MS);
		assert.notEqual(await child.exited, 0);
		const diagnostic = readTextSync(getBrokerWatchdogLogPath(), "utf8");
		assert.match(diagnostic, /stopped answering health requests/u);
		assert.equal((JSON.parse(diagnostic) as { pid: number }).pid, child.pid);
		assert.ok(Buffer.byteLength(diagnostic) < 1024);
		ownedPids.delete(child.pid);
		removePathSync(gate, { force: true });
		await Promise.all(Array.from({ length: 8 }, () => spawnBrokerIfNeeded("npx", ["--no-install", "tsx"])));
		const replacementPid = Number(readTextSync(getBrokerPidPath(), "utf8"));
		ownedPids.add(replacementPid);
		assert.notEqual(replacementPid, child.pid);
		const after = await connect("after-stall");
		await after.registerPendingStageRouteAcknowledged("watchdog-run", "workflow:watchdog-run", "watchdog-capability");
		assert.deepEqual(
			(await after.listSessions()).map(({ name }) => name),
			["after-stall"],
		);
		assert.equal(Number(readTextSync(getBrokerPidPath(), "utf8")), replacementPid);
		assert.equal(readTextSync(getBrokerWatchdogLogPath(), "utf8"), diagnostic);
	},
	REAL_STALLED_BROKER_TIMEOUT_MS + REPLACEMENT_STARTUP_BUDGET_MS,
);
