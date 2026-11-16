import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, test } from "vitest";
import {
	makeTempDirectory,
	moduleDir,
	readTextSync,
	removeTempDirectory,
	type SpawnedProcess,
	spawnProcess,
	writeTextSync,
} from "../helpers/runtime.js";

const tempDir = makeTempDirectory("ic5220-broker-");
afterAll(() => removeTempDirectory(tempDir));
const brokers: SpawnedProcess[] = [];
afterEach(() => {
	for (const broker of brokers.splice(0)) broker.kill();
});

const DEAD_HOLDER = 2147483641;
const DEAD_TAKER = 2147483642;

const SCENARIO_TIMEOUT_MS = 120_000;

const PRELOAD = `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const wait = (name) => {
	const ms = Number(process.env[name] ?? 0);
	if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const lock = process.env.VP_LOCK;
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
	if (/\\.gen\\d+$/.test(String(to)) && String(to).startsWith(lock)) wait("VP_GEN_LINK");
	const kind = String(from).startsWith(lock + ".takeover-") ? "TOK" : String(from) === lock ? "LOCK" : undefined;
	if (kind !== undefined) wait("VP_" + kind + "_PARK");
	rename(from, to);
	if (kind !== undefined) wait("VP_" + kind + "_CMP");
};
syncBuiltinESMExports();
`;

const CURRENT = "../../packages/intercom/broker/socket-replacement-lock.ts";
const PREVIOUS = "../fixtures/intercom-socket-lock-main/socket-replacement-lock.ts";

function brokerScript(lockPath: string, events: string, version: string): string {
	const lockModule = pathToFileURL(join(moduleDir(import.meta.url), version)).href;
	const jiti = pathToFileURL(createRequire(import.meta.url).resolve("jiti")).href;
	return `
import { appendFileSync, readFileSync } from "node:fs";
const log = (event) => appendFileSync(${JSON.stringify(events)}, JSON.stringify({ at: Date.now(), name: process.env.VP_NAME, event }) + "\\n");
const { createJiti } = await import(${JSON.stringify(jiti)});
const { acquireSocketReplacementLock } = await createJiti(import.meta.url).import(${JSON.stringify(lockModule)});
const lock = await acquireSocketReplacementLock(${JSON.stringify(lockPath)});
log("held");
const end = Date.now() + Number(process.env.HOLD_MS);
let lost = false;
const own = () => {
	if (typeof lock.held === "function") return lock.held();
	try { return Number.parseInt(readFileSync(${JSON.stringify(lockPath)}, "utf8"), 10) === process.pid; } catch { return false; }
};
while (Date.now() < end && !lost) {
	if (!own()) { lost = true; log("lost"); }
	await new Promise((resolve) => setTimeout(resolve, 50));
}
log("released");
lock();
`;
}

interface BrokerPlan {
	readonly name: string;
	readonly startAfterMs: number;
	readonly holdMs: number;
	readonly delays?: Readonly<Record<string, number>>;
	readonly version?: string;
}

interface Event {
	readonly at: number;
	readonly name: string;
	readonly event: "held" | "lost" | "released";
}

async function runBrokers(
	scenario: string,
	plans: readonly BrokerPlan[],
	{ crashedTaker = true }: { readonly crashedTaker?: boolean } = {},
): Promise<Event[]> {
	const lockPath = join(tempDir, `${scenario}.sock.lock`);
	const events = join(tempDir, `${scenario}.events`);
	const preload = join(tempDir, `${scenario}.preload.cjs`);
	writeTextSync(preload, PRELOAD);
	writeTextSync(lockPath, `${DEAD_HOLDER}\n\n`);
	if (crashedTaker) writeTextSync(`${lockPath}.takeover-${DEAD_HOLDER}`, `${DEAD_TAKER}\n\n`);
	writeTextSync(events, "");
	const running: SpawnedProcess[] = [];
	for (const plan of plans) {
		await new Promise((resolve) => setTimeout(resolve, plan.startAfterMs));
		const script = brokerScript(lockPath, events, plan.version ?? CURRENT);
		const broker = spawnProcess([process.execPath, "--require", preload, "--input-type=module", "-e", script], {
			env: {
				...process.env,
				VP_LOCK: lockPath,
				VP_NAME: plan.name,
				HOLD_MS: String(plan.holdMs),
				...Object.fromEntries(Object.entries(plan.delays ?? {}).map(([key, ms]) => [key, String(ms)])),
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		brokers.push(broker);
		running.push(broker);
	}
	await Promise.all(running.map((broker) => broker.exited));
	return readTextSync(events, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Event)
		.sort((a, b) => a.at - b.at);
}

function violations(events: readonly Event[]): { readonly overlaps: string[]; readonly lost: string[] } {
	const holding = new Set<string>();
	const overlaps: string[] = [];
	for (const { name, event } of events) {
		if (event === "held") {
			if (holding.size > 0) overlaps.push(`${name} took the lock while ${[...holding].join(",")} held it`);
			holding.add(name);
		} else {
			holding.delete(name);
		}
	}
	return { overlaps, lost: events.filter(({ event }) => event === "lost").map(({ name }) => name) };
}

function describeEvents(events: readonly Event[]): string {
	const start = events[0]?.at ?? 0;
	return events.map(({ at, name, event }) => `+${at - start}ms ${name} ${event}`).join("; ");
}

describe("brokers taking over the socket lock of a crashed broker (#5220)", () => {
	test(
		"three brokers, one paused clearing a crashed taker's token and one paused moving the lock, take the lock one at a time and none loses it (#5220)",
		async () => {
			const events = await runBrokers("three-paused", [
				{ name: "B3", startAfterMs: 0, holdMs: 4_000, delays: { VP_TOK_PARK: 1_500, VP_TOK_CMP: 3_000 } },
				{ name: "B1", startAfterMs: 200, holdMs: 3_000, delays: { VP_LOCK_PARK: 4_000, VP_LOCK_CMP: 2_000 } },
				{ name: "B2", startAfterMs: 1_400, holdMs: 8_000 },
			]);
			const { overlaps, lost } = violations(events);
			assert.deepEqual(overlaps, [], describeEvents(events));
			assert.deepEqual(lost, [], describeEvents(events));
			assert.equal(events.filter(({ event }) => event === "held").length, 3, describeEvents(events));
		},
		SCENARIO_TIMEOUT_MS,
	);

	test(
		"a broker of the previous version paused while replacing a crashed broker's lock never shares the lock with a current one (#5220)",
		async () => {
			const events = await runBrokers(
				"mixed-versions",
				[
					{
						name: "O1",
						startAfterMs: 0,
						holdMs: 1_000,
						version: PREVIOUS,
						delays: { VP_LOCK_PARK: 2_000, VP_LOCK_CMP: 1_500 },
					},
					{ name: "N", startAfterMs: 300, holdMs: 3_000 },
					{ name: "O2", startAfterMs: 1_900, holdMs: 1_000, version: PREVIOUS },
				],
				{ crashedTaker: false },
			);
			const { overlaps, lost } = violations(events);
			assert.deepEqual(overlaps, [], describeEvents(events));
			assert.deepEqual(lost, [], describeEvents(events));
			assert.equal(events.filter(({ event }) => event === "held").length, 3, describeEvents(events));
		},
		SCENARIO_TIMEOUT_MS,
	);

	test(
		"three brokers, one paused between judging the lock free and taking it, take the lock one at a time and none loses it (#5220)",
		async () => {
			const events = await runBrokers("judged-then-paused", [
				{ name: "B1", startAfterMs: 0, holdMs: 1_500, delays: { VP_GEN_LINK: 3_000 } },
				{ name: "B2", startAfterMs: 300, holdMs: 1_500 },
				{ name: "B3", startAfterMs: 300, holdMs: 1_500 },
			]);
			const { overlaps, lost } = violations(events);
			assert.deepEqual(overlaps, [], describeEvents(events));
			assert.deepEqual(lost, [], describeEvents(events));
			assert.equal(events.filter(({ event }) => event === "held").length, 3, describeEvents(events));
		},
		SCENARIO_TIMEOUT_MS,
	);
});
