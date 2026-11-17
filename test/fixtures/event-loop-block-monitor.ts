/**
 * Child process of test/unit/event-loop-block-monitor.test.ts, run on Node (through jiti) or on Bun with the
 * diagnostic's variables set or unset by the test. It starts the monitor as the interactive host does, holds the event
 * loop once for long and once briefly in functions the test looks for by name, ends the startup phase and exits on its
 * own. It prints one JSON line: whether the monitor started and, on Node, the async resources starting it created.
 *
 * With `exit-inside-block` as the fourth argument it instead exits at the end of the long block, in the same task, as
 * a quit that ends in a long synchronous step does.
 */
import { createHook } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
	markEventLoopStartupComplete,
	startEventLoopMonitor,
} from "../../packages/coding-agent/src/core/event-loop-monitor.js";

const [longBlockMs = "0", shortBlockMs = "0", settleMs = "0", mode = "blocks"] = process.argv.slice(2).map(String);

/** The long block the log must name. */
function holdTheEventLoopForLong(ms: number): number {
	const until = performance.now() + ms;
	let spins = 0;
	while (performance.now() < until) spins++;
	return spins;
}

/** The brief block the log must not record. */
function holdTheEventLoopBriefly(ms: number): number {
	const until = performance.now() + ms;
	let spins = 0;
	while (performance.now() < until) spins++;
	return spins;
}

const created: string[] = [];
// Bun's async_hooks does not report resources, so only Node says what starting the monitor created.
const hook = process.versions.bun ? undefined : createHook({ init: (_id, type) => created.push(type) });
hook?.enable();
const started = startEventLoopMonitor("host");
hook?.disable();

await delay(Number(settleMs));
holdTheEventLoopForLong(Number(longBlockMs));
if (mode === "exit-inside-block") process.exit(0);
await delay(Number(settleMs));
holdTheEventLoopBriefly(Number(shortBlockMs));
await delay(Number(settleMs));
markEventLoopStartupComplete();
await delay(Number(settleMs));
console.log(JSON.stringify({ started, created }));
