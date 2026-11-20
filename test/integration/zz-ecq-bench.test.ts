import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, test, vi } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

// Private benchmark (not committed): broker send latency and queued-send throughput, default and shared storage.
const repoRoot = resolve(import.meta.dirname, "../..");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { queryIntercomBroker } = await import("../../packages/intercom/broker/control.js");
const OUT = process.env.ECQ_BENCH_OUT ?? "/fast/home/lemma-audit/r0989/intercom-durable-queue/bench/results.jsonl";
const LABEL = process.env.ECQ_BENCH_LABEL ?? "unknown";
const fixtures: IntercomBrokerFixture[] = [];
afterAll(async () => {
	for (const fixture of fixtures) await fixture.cleanup();
});

async function startBroker(shared: boolean) {
	const fixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "ecqb-")));
	fixtures.push(fixture);
	if (shared)
		writeFileSync(
			join(fixture.agentDir, "settings.json"),
			JSON.stringify({
				storage: {
					adapter: join(repoRoot, "test/fixtures/storage-adapter.ts"),
					options: { path: join(mkdtempSync(join(tmpdir(), "ecqb-shared-")), "shared.sqlite") },
					prefix: "b_",
				},
			}),
		);
	const extensionDir = join(repoRoot, "packages/intercom");
	const broker: ChildProcess = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: fixture.agentDir },
		stdio: "ignore",
	});
	fixture.trackBroker(broker);
	await fixture.holdSession(getBrokerSocketPath(process.platform, fixture.agentDir), 60_000);
	if (shared)
		await vi.waitFor(
			async () => {
				const status = await queryIntercomBroker(fixture.agentDir);
				assert.ok(status.state === "running" && status.report.multiNode.status === "on");
			},
			{ timeout: 60_000, interval: 25 },
		);
	return fixture;
}

async function connect(fixture: IntercomBrokerFixture, name: string, options: { supervisor?: { capability: string; supervisorSessionId: string }; ownerToken?: string } = {}) {
	const client = new IntercomClient(randomUUID(), {
		brokerSocketPath: getBrokerSocketPath(process.platform, fixture.agentDir),
		acknowledgesReceipt: true,
	});
	client.on("error", () => {});
	client.on("message", (_from: unknown, message: { id: string }) => client.acknowledgeReceived(message.id));
	await client.connect(
		{ name, model: "m", cwd: repoRoot, pid: process.pid, status: "idle", startedAt: Date.now(), lastActivity: Date.now(), group: "default", groups: ["default"] },
		options.supervisor,
		options.ownerToken,
		undefined,
		"default",
	);
	fixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return client;
}

function stats(samples: number[]) {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
	return { n: sorted.length, p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), p99: +at(0.99).toFixed(2), max: +sorted.at(-1)!.toFixed(2) };
}

for (const shared of [false, true]) {
	test(`bench ${shared ? "shared" : "default"}`, async () => {
		const fixture = await startBroker(shared);
		const owner = await connect(fixture, "bench-owner", { ownerToken: randomUUID() });
		const live = await connect(fixture, "bench-live");
		const sender = await connect(fixture, "bench-sender");
		const children: string[] = [];
		for (let index = 0; index < 4; index++) {
			const name = `subagent-worker-bench-${index}`;
			const child = await connect(fixture, name, { supervisor: await owner.authorizeSupervisorChild(name) });
			const id = child.sessionId;
			await child.disconnect();
			await vi.waitFor(async () => assert.equal((await owner.listSessions()).some((s) => s.id === id), false), { timeout: 10_000 });
			await owner.markEndedChildren([{ childName: name, childId: `${name}:0`, outcome: "stopped", aliases: [], messages: "hold" }]);
			children.push(name);
		}
		// Warm-up (the first queued send opens the store on the new broker).
		await sender.send(children[0]!, { text: "warm", wakeEndedRecipient: true });
		await sender.send("bench-live", { text: "warm" });
		const liveLatency: number[] = [];
		for (let index = 0; index < 200; index++) {
			const started = performance.now();
			const result = await sender.send("bench-live", { text: `live ${index}` });
			liveLatency.push(performance.now() - started);
			assert.equal(result.delivered, true, result.reason);
		}
		const queuedLatency: number[] = [];
		for (let index = 0; index < 200; index++) {
			const started = performance.now();
			const result = await sender.send(children[index % 4]!, { text: `queued ${index}`, wakeEndedRecipient: true });
			queuedLatency.push(performance.now() - started);
			assert.equal(result.queued, true, result.reason);
		}
		// Throughput: 4 x 50 queued sends at once, while live sends measure the broker's responsiveness.
		const burstStarted = performance.now();
		const liveDuringBurst: number[] = [];
		let bursting = true;
		const prober = (async () => {
			while (bursting) {
				const started = performance.now();
				await sender.send("bench-live", { text: "probe" });
				liveDuringBurst.push(performance.now() - started);
			}
		})();
		const burst = await Promise.all(
			Array.from({ length: 200 }, (_, index) =>
				sender.send(children[index % 4]!, { text: `burst ${index} ${"x".repeat(512)}`, wakeEndedRecipient: true }),
			),
		);
		const burstMs = performance.now() - burstStarted;
		bursting = false;
		await prober;
		assert.ok(burst.every((result) => result.queued === true), burst.find((result) => result.queued !== true)?.reason);
		const record = {
			label: LABEL,
			mode: shared ? "shared-sqlite" : "default",
			liveSendMs: stats(liveLatency),
			queuedSendMs: stats(queuedLatency),
			burst: { messages: 200, ms: +burstMs.toFixed(1), perSecond: +(200 / (burstMs / 1000)).toFixed(0) },
			liveDuringBurstMs: stats(liveDuringBurst),
		};
		appendFileSync(OUT, `${JSON.stringify(record)}\n`);
		void live;
	}, 300_000);
}
