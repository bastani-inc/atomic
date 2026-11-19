import { setTimeout as sleep } from "node:timers/promises";
import {
	markEventLoopShutdown,
	markEventLoopStartupComplete,
	startEventLoopMonitor,
	waitForEventLoopMonitorReady,
} from "../../packages/coding-agent/src/core/event-loop-monitor.js";

function holdStartupPhase(ms: number): void {
	const until = performance.now() + ms;
	while (performance.now() < until) {}
}

function holdSessionPhase(ms: number): void {
	const until = performance.now() + ms;
	while (performance.now() < until) {}
}

class StartupRenderer {
	render(): void {
		const until = performance.now() + 380;
		while (performance.now() < until) {}
	}
}

class ConsoleRenderer {
	render(): void {
		const until = performance.now() + 380;
		while (performance.now() < until) {}
	}
}

startEventLoopMonitor("engine");
await waitForEventLoopMonitorReady();
await sleep(300);
if (process.argv[2] === "rotation") {
	markEventLoopStartupComplete();
	const rotation = Object.assign(globalThis, {
		profileRotationObserved: false,
		runOnProfileRotation: () => holdSessionPhase(3_000),
	});
	const deadline = performance.now() + 10_000;
	while (!rotation.profileRotationObserved && performance.now() < deadline) await sleep(20);
	if (!rotation.profileRotationObserved) throw new Error("the automatic profile rotation never ran");
} else if (process.argv[2] === "names") {
	markEventLoopStartupComplete();
	await sleep(100);
	new StartupRenderer().render();
	new ConsoleRenderer().render();
} else {
	holdStartupPhase(600);
	markEventLoopStartupComplete();
	if (process.argv[2] === "microtask" || process.argv[2] === "microtask-shutdown") {
		queueMicrotask(() => {
			holdSessionPhase(600);
			if (process.argv[2] === "microtask-shutdown") markEventLoopShutdown();
		});
	} else holdSessionPhase(600);
	if (process.argv[2] === "coalesced") markEventLoopShutdown();
}
await sleep(300);
markEventLoopShutdown();
await sleep(200);
