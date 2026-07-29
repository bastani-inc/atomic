/**
 * TEMPORARY diagnostic. Runs in vitest's main process after the whole suite.
 *
 * The Windows job passes every test, then sits until the job timeout kills it.
 * vitest's hanging-process reporter prints nothing (the suite runs under
 * `bun --bun`, where that detection does not apply), so this dumps the live
 * process tree instead to name whatever is still holding the event loop open.
 */
import { spawnSync } from "node:child_process";

export function setup(): void {}

export function teardown(): void {
	if (process.platform !== "win32") return;
	const result = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
	const interesting = (result.stdout ?? "")
		.split(/\r?\n/)
		.filter((line) => /bash|sleep|sh\.exe|node|bun|conhost|taskkill|git/i.test(line));
	console.log(`\n[teardown-diagnostic] survivors (${interesting.length}):`);
	for (const line of interesting) console.log(`[teardown-diagnostic] ${line}`);
	console.log("[teardown-diagnostic] end\n");
}
