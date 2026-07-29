/**
 * TEMPORARY diagnostic. Runs in vitest's main process after the whole suite.
 *
 * The Windows job passes every test, then sits until the job timeout kills it.
 * vitest's hanging-process reporter prints nothing (the suite runs under
 * `bun --bun`), and a teardown process-tree dump showed no surviving child
 * processes — so the handle lives inside vitest's own process.
 *
 * Schedule unref'd probes: they fire only while the event loop is still alive,
 * which is exactly the stuck case. A healthy run exits before they fire and
 * pays nothing.
 */
import { spawnSync } from "node:child_process";

export function setup(): void {}

interface ResourceProbe {
	getActiveResourcesInfo?: () => string[];
}

function dump(label: string): void {
	const probe = process as unknown as ResourceProbe;
	const resources = probe.getActiveResourcesInfo?.() ?? ["<getActiveResourcesInfo unavailable>"];
	const counts = new Map<string, number>();
	for (const entry of resources) counts.set(entry, (counts.get(entry) ?? 0) + 1);
	const summary = [...counts.entries()].map(([name, count]) => `${name}x${count}`).join(", ");
	console.log(`[exit-probe ${label}] active resources: ${summary}`);
	if (process.platform === "win32") {
		const result = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
		const survivors = (result.stdout ?? "").split(/\r?\n/).filter((line) => /bash|sleep|bun|node|conhost/i.test(line));
		console.log(`[exit-probe ${label}] processes: ${survivors.length}`);
		for (const line of survivors) console.log(`[exit-probe ${label}] ${line}`);
	}
}

export function teardown(): void {
	dump("teardown");
	for (const delaySeconds of [15, 45]) {
		const timer = setTimeout(() => dump(`+${delaySeconds}s`), delaySeconds * 1000);
		timer.unref?.();
	}
}
