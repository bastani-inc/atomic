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

/** How long the event loop went without a turn, as a timer of the fixture's own saw it. */
interface Turns {
	/** The longest gap between two turns: what a block lasted, whether code that ran or the scheduler held the loop. */
	readonly longestGapMs: number;
	/**
	 * The longest two gaps in a row. A timer of the monitor's that runs later in a turn than this one also counts the
	 * work done after this one in that turn, which this one counts in its next gap.
	 */
	readonly longestTwoGapsMs: number;
}

/** Watches the event loop's turns with a timer of its own until `stop`. */
function watchTurns(): { stop(): Turns } {
	let last = performance.now();
	let previousGap = 0;
	let longestGapMs = 0;
	let longestTwoGapsMs = 0;
	const turn = () => {
		const now = performance.now();
		const gap = now - last;
		longestGapMs = Math.max(longestGapMs, gap);
		longestTwoGapsMs = Math.max(longestTwoGapsMs, previousGap + gap);
		previousGap = gap;
		last = now;
	};
	const timer = setInterval(turn, 5);
	return {
		stop: () => {
			clearInterval(timer);
			turn();
			return { longestGapMs, longestTwoGapsMs };
		},
	};
}

const created: string[] = [];
const hook = process.versions.bun ? undefined : createHook({ init: (_id, type) => created.push(type) });
hook?.enable();
const started = startEventLoopMonitor("host");
hook?.disable();

let sessionTurns: { stop(): Turns } | undefined;
/**
 * Ends the startup phase once, and times the session phase's turns from just before: the monitor's own work as the phase
 * changes, such as reading the samples of a block that just ended, holds the loop in the new phase.
 */
function startSession(): void {
	if (sessionTurns) return;
	sessionTurns = watchTurns();
	markEventLoopStartupComplete();
}

await settle(Number(settleMs));
holdTheEventLoopForLong(Number(longBlockMs));
if (mode === "exit-inside-block") process.exit(0);
if (mode === "phase-inside-block") startSession();
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
// Watched from a wait before it: the monitor's own timer can last have run turns before the brief block.
const aroundBriefBlock = watchTurns();
await settle(Number(settleMs));
holdTheEventLoopBriefly(Number(shortBlockMs));
await settle(Number(settleMs));
const briefBlockGapsMs = aroundBriefBlock.stop().longestTwoGapsMs;
startSession();
await settle(Number(settleMs));
const sessionGapsMs = sessionTurns?.stop().longestTwoGapsMs;
markEventLoopShutdown();
await settle(Number(settleMs));
console.log(JSON.stringify({ started, created, briefBlockGapsMs, sessionGapsMs }));
