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

function holdTheEventLoopBriefly(ms: number): number {
	const until = performance.now() + ms;
	let spins = 0;
	while (performance.now() < until) spins++;
	return spins;
}

const created: string[] = [];
const hook = process.versions.bun ? undefined : createHook({ init: (_id, type) => created.push(type) });
hook?.enable();
const started = startEventLoopMonitor("host");
hook?.disable();

await delay(Number(settleMs));
holdTheEventLoopForLong(Number(longBlockMs));
if (mode === "exit-inside-block") process.exit(0);
if (mode === "phase-inside-block") markEventLoopStartupComplete();
if (mode === "anonymous") {
	await delay(Number(settleMs));
	// An anonymous function holds the loop across several statements, so its samples land on different lines.
	(() => {
		const until = performance.now() + Number(longBlockMs);
		let spins = 0;
		while (performance.now() < until) {
			spins += Math.sqrt(spins + 1);
			spins -= Math.floor(spins / 3);
			spins += 1;
		}
		return spins;
	})();
}
await delay(Number(settleMs));
holdTheEventLoopBriefly(Number(shortBlockMs));
await delay(Number(settleMs));
markEventLoopStartupComplete();
await delay(Number(settleMs));
markEventLoopShutdown();
await delay(Number(settleMs));
console.log(JSON.stringify({ started, created }));
