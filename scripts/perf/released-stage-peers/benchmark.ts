#!/usr/bin/env bun
/**
 * What the Intercom peers of released workflow stages cost the host session (#4642).
 *
 * Starts the source Intercom broker in a temporary agent directory, then adopts `--stages` released stages through
 * `ReleasedStagePeers`, the way the workflow host announces each stage whose session it released. It reports, after a
 * full collection, the host process's heap, RSS and socket file descriptors per adopted stage, the broker process's
 * RSS per stage, how many Intercom clients the peers created, and that every stage is listed, answers an ask and
 * relays a plain send. It then adopts every stage again, as a stage that is reopened and released once more is
 * announced again, and checks that nothing grew; finally it disconnects every peer.
 *
 *   bun run scripts/perf/released-stage-peers/benchmark.ts --stages 200 --label after --out /tmp/peers-after.json
 *
 * Socket and broker RSS counts read `/proc`, so they are reported on Linux only.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";

interface Options {
	readonly stages: number;
	readonly label: string;
	readonly out?: string;
}

function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	const stages = Number(value("stages") ?? 200);
	if (!Number.isInteger(stages) || stages < 1) throw new Error(`--stages must be a positive integer, got ${stages}`);
	const out = value("out");
	return { stages, label: value("label") ?? "run", ...(out === undefined ? {} : { out: resolve(out) }) };
}

const BROKER_STARTUP_TIMEOUT_MS = 20_000;
const ASK_TIMEOUT_MS = 10_000;
const RELEASED_STAGE_STATUS = "closed · reply: post-mortem only";

function resolveGc(): () => void {
	const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
	if (bun !== undefined) return () => bun.gc(true);
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		return vm.runInNewContext("gc") as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

const gc = resolveGc();

async function settle(): Promise<void> {
	for (let round = 0; round < 5; round++) await new Promise((resolveTick) => setTimeout(resolveTick, 20));
	gc();
	gc();
}

/** Open socket descriptors of this process; undefined where `/proc` is unavailable. */
function socketDescriptors(): number | undefined {
	try {
		return readdirSync("/proc/self/fd").filter((fd) => {
			try {
				return readlinkSync(`/proc/self/fd/${fd}`).startsWith("socket:");
			} catch {
				return false;
			}
		}).length;
	} catch {
		return undefined;
	}
}

/** Resident set of another process in bytes; undefined where `/proc` is unavailable. */
function processRss(pid: number | undefined): number | undefined {
	if (pid === undefined) return undefined;
	try {
		const line = readFileSync(`/proc/${pid}/status`, "utf8")
			.split("\n")
			.find((entry) => entry.startsWith("VmRSS:"));
		return line === undefined ? undefined : Number(line.replace(/\D+/g, "")) * 1024;
	} catch {
		return undefined;
	}
}

interface Sample {
	readonly heapBytes: number;
	readonly rssBytes: number;
	readonly brokerRssBytes: number | undefined;
	readonly sockets: number | undefined;
}

async function sample(broker: ChildProcess): Promise<Sample> {
	await settle();
	const usage = process.memoryUsage();
	return {
		heapBytes: usage.heapUsed,
		rssBytes: usage.rss,
		brokerRssBytes: processRss(broker.pid),
		sockets: socketDescriptors(),
	};
}

function perStage(after: number | undefined, before: number | undefined, stages: number): number | undefined {
	return after === undefined || before === undefined ? undefined : (after - before) / stages;
}

async function startBroker(extensionDir: string, agentDir: string): Promise<ChildProcess> {
	const brokerPath = join(extensionDir, "broker/broker.ts");
	const { getJitiCliPath } = await import("../../../packages/intercom/broker/spawn.js");
	const args =
		(globalThis as { Bun?: object }).Bun === undefined ? [getJitiCliPath(extensionDir), brokerPath] : [brokerPath];
	const child = spawn(process.execPath, args, {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await new Promise<void>((resolveReady, rejectReady) => {
		let stdout = "";
		const timer = setTimeout(
			() => rejectReady(new Error(`Intercom broker did not start within ${BROKER_STARTUP_TIMEOUT_MS} ms`)),
			BROKER_STARTUP_TIMEOUT_MS,
		);
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
			if (!stdout.includes("Intercom broker started")) return;
			clearTimeout(timer);
			resolveReady();
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			rejectReady(new Error(`Intercom broker exited before it started (code ${String(code)})`));
		});
	});
	return child;
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const agentDir = mkdtempSync(join(tmpdir(), "released-stage-peers-"));
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_CODING_AGENT_DIR;
	const extensionDir = resolve(import.meta.dirname, "../../../packages/intercom");
	const { IntercomClient } = await import("../../../packages/intercom/broker/client.js");
	const { ReleasedStagePeers } = await import("../../../packages/intercom/released-stage-peers.js");
	type Message = import("../../../packages/intercom/types.js").Message;
	type SessionInfo = import("../../../packages/intercom/types.js").SessionInfo;

	const broker = await startBroker(extensionDir, agentDir);
	const group = `workflow:${randomUUID()}`;
	const now = Date.now();
	const lister = new IntercomClient();
	const replies = new Map<string, (text: string) => void>();
	lister.on("message", (_from: SessionInfo, message: Message) => {
		if (message.replyTo !== undefined) replies.get(message.replyTo)?.(message.content.text);
	});
	await lister.connect(
		{
			name: "benchmark-asker",
			cwd: agentDir,
			model: "none",
			pid: process.pid,
			startedAt: now,
			lastActivity: now,
			groups: [group],
			group,
		},
		undefined,
		undefined,
		undefined,
		group,
	);
	const listedStages = async (): Promise<number> =>
		(await lister.listSessions(group)).filter(
			(session) => session.name?.startsWith("subagent-chat-") === true && session.status === RELEASED_STAGE_STATUS,
		).length;

	let clientsCreated = 0;
	let relayed = 0;
	const peers = new ReleasedStagePeers({
		prepare: async () => {},
		createClient: (returnAddress) => {
			clientsCreated += 1;
			return new IntercomClient(returnAddress);
		},
		cwd: () => agentDir,
		relay: () => {
			relayed += 1;
		},
	});
	const runId = randomUUID();
	const routes = Array.from({ length: options.stages }, (_, index) => ({
		runId,
		stageId: `stage-${index}`,
		stageName: `reviewer-${index}`,
		sessionId: randomUUID(),
		group,
		model: "faux/model",
		answer: async (content: string) => `stage ${index} answers: ${content.split("\n")[2] ?? content}`,
	}));

	try {
		const baseline = await sample(broker);
		const adoptStarted = performance.now();
		for (const route of routes) await peers.adopt(route);
		const adoptMs = performance.now() - adoptStarted;
		const adopted = await sample(broker);
		const listedAfterAdopt = await listedStages();

		const probe = routes[Math.floor(options.stages / 2)]!;
		const probeName = `subagent-chat-${probe.sessionId}`;
		const answered = new Promise<string>((resolveAnswer, rejectAnswer) => {
			const timer = setTimeout(() => rejectAnswer(new Error("the released stage never answered")), ASK_TIMEOUT_MS);
			replies.set("probe", (text) => {
				clearTimeout(timer);
				resolveAnswer(text);
			});
		});
		const ask = await lister.send(probeName, { text: "which file?", expectsReply: true, messageId: "probe" });
		const answer = ask.delivered ? await answered : `ask not delivered: ${ask.reason}`;
		const sent = await lister.send(probeName, { text: "fyi" });
		while (sent.delivered && relayed === 0) await new Promise((resolveTick) => setTimeout(resolveTick, 10));

		const clientsBeforeReadopt = clientsCreated;
		for (const route of routes) await peers.adopt(route);
		const readopted = await sample(broker);
		const listedAfterReadopt = await listedStages();

		await peers.disconnectAll();
		const disconnected = await sample(broker);
		const listedAfterDisconnect = await listedStages();

		const report = {
			label: options.label,
			runtime:
				(globalThis as { Bun?: { version: string } }).Bun === undefined
					? `node ${process.version}`
					: `bun ${(globalThis as { Bun?: { version: string } }).Bun!.version}`,
			stages: options.stages,
			clientsCreated: clientsBeforeReadopt,
			clientsCreatedByReadopt: clientsCreated - clientsBeforeReadopt,
			listed: {
				afterAdopt: listedAfterAdopt,
				afterReadopt: listedAfterReadopt,
				afterDisconnect: listedAfterDisconnect,
			},
			askAnswer: answer,
			plainSendRelayed: relayed,
			adoptMs: Math.round(adoptMs),
			perStage: {
				heapBytes: perStage(adopted.heapBytes, baseline.heapBytes, options.stages),
				rssBytes: perStage(adopted.rssBytes, baseline.rssBytes, options.stages),
				brokerRssBytes: perStage(adopted.brokerRssBytes, baseline.brokerRssBytes, options.stages),
				sockets: perStage(adopted.sockets, baseline.sockets, options.stages),
			},
			samples: { baseline, adopted, readopted, disconnected },
		};
		const text = JSON.stringify(report, null, 2);
		if (options.out !== undefined) writeFileSync(options.out, `${text}\n`);
		console.log(text);
	} finally {
		await peers.disconnectAll();
		await lister.disconnect();
		broker.kill("SIGTERM");
		rmSync(agentDir, { recursive: true, force: true });
	}
}

await main();
