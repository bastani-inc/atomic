import { setTimeout as sleep } from "node:timers/promises";
import {
	markEventLoopShutdown,
	startEventLoopMonitor,
} from "../../packages/coding-agent/src/core/event-loop-monitor.js";

const [scriptCount, applicationBlockMs, turnGapMs, observeMs] = process.argv.slice(2).map(Number);
for (let index = 0; index < scriptCount!; index++) {
	await import(`data:text/javascript,export const MONITOR_WORKER_EVENT_TAG_${index}=${index}`);
}
const started = startEventLoopMonitor("engine");
let last = performance.now();
let maxDelayMs = 0;
const interval = setInterval(() => {
	const now = performance.now();
	maxDelayMs = Math.max(maxDelayMs, now - last);
	last = now;
}, 10);
// Repeated bounded application work lets the watchdog start even when a loaded host starts its worker slowly.
for (let pulse = 0; pulse < 3; pulse++) {
	await sleep(turnGapMs);
	const until = performance.now() + applicationBlockMs!;
	while (performance.now() < until) {}
}
await sleep(observeMs);
clearInterval(interval);
markEventLoopShutdown();
console.log(JSON.stringify({ started, maxDelayMs }));
