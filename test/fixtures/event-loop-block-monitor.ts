import { createHook } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
	markEventLoopShutdown,
	markEventLoopStartupComplete,
	startEventLoopMonitor,
} from "../../packages/coding-agent/src/core/event-loop-monitor.js";

const [longBlockMs = "0", shortBlockMs = "0", settleMs = "0", mode = "blocks"] = process.argv.slice(2).map(String);

function holdTheEventLoopForLong(ms: number): number {
	const until = performance.now() + ms;
	let spins = 0;
	while (performance.now() < until) spins++;
	return spins;
}

/** Runs `body` and nothing else, so every sample taken while `body` runs has this frame under it. */
function runAnonymousBlock(body: () => number): number {
	return body();
}

function holdTheEventLoopBriefly(ms: number): number {
	const until = performance.now() + ms;
	let spins = 0;
	while (performance.now() < until) spins++;
	return spins;
}

/** Turns of the event loop each wait spans at least, so each phase's delay histogram samples it however busy the machine is. */
const SETTLE_TURNS = 5;
const TURN_MS = 20;

/** Waits `ms`, and for at least {@link SETTLE_TURNS} turns of the event loop. */
async function settle(ms: number): Promise<void> {
	const until = performance.now() + ms;
	for (let turn = 0; turn < SETTLE_TURNS || performance.now() < until; turn++) await delay(TURN_MS);
}

const created: string[] = [];
const hook = process.versions.bun ? undefined : createHook({ init: (_id, type) => created.push(type) });
hook?.enable();
const started = startEventLoopMonitor("host");
hook?.disable();

await settle(Number(settleMs));
holdTheEventLoopForLong(Number(longBlockMs));
if (mode === "exit-inside-block") process.exit(0);
if (mode === "phase-inside-block") markEventLoopStartupComplete();
if (mode === "anonymous") {
	await settle(Number(settleMs));
	// An anonymous function holds the loop across several statements, so its samples land on different lines.
	runAnonymousBlock(() => {
		const until = performance.now() + Number(longBlockMs);
		let spins = 0;
		while (performance.now() < until) {
			spins += Math.sqrt(spins + 1);
			spins -= Math.floor(spins / 3);
			spins += 1;
		}
		return spins;
	});
}
await settle(Number(settleMs));
holdTheEventLoopBriefly(Number(shortBlockMs));
await settle(Number(settleMs));
markEventLoopStartupComplete();
await settle(Number(settleMs));
markEventLoopShutdown();
await settle(Number(settleMs));
console.log(JSON.stringify({ started, created }));
