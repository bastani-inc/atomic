import { setTimeout as delay } from "node:timers/promises";
import {
	markEventLoopShutdown,
	startEventLoopMonitor,
	waitForEventLoopMonitorReady,
} from "../../packages/coding-agent/src/core/event-loop-monitor.js";

startEventLoopMonitor("engine");
await waitForEventLoopMonitorReady();
console.log("before debugger statement");
// biome-ignore lint/suspicious/noDebugger: Exercise an application breakpoint while diagnostics are active.
debugger;
console.log("after debugger statement");
markEventLoopShutdown();
await delay(100);
