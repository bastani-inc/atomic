/**
 * Preloaded into every Atomic process of a view-latency run (`NODE_OPTIONS=--import <this file>`).
 *
 * Records the event-loop delay of each measurement window and, when `VIEWLAT_PROFILE_DIR` is set, a CPU profile of
 * it. The driver names the current window in `VIEWLAT_WINDOW_FILE`; when the name changes, the finished window's
 * percentiles are appended to `VIEWLAT_LOOP_FILE` and its profile is written.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

const windowFile = process.env.VIEWLAT_WINDOW_FILE;
const loopFile = process.env.VIEWLAT_LOOP_FILE;
const profileDir = process.env.VIEWLAT_PROFILE_DIR;

if (isMainThread && windowFile && loopFile) {
	const entry = process.argv[1] ?? "";
	const role = process.argv.includes("rpc")
		? "engine"
		: /cli\.(?:js|ts)$/.test(entry)
			? "host"
			: `other:${entry.split(/[\\/]/).slice(-2).join("/")}`;
	const histogram = monitorEventLoopDelay({ resolution: 2 });
	histogram.enable();
	let label = "";
	let started = performance.now();
	let profiler;
	if (profileDir) {
		const inspector = await import("node:inspector");
		profiler = new inspector.Session();
		profiler.connect();
		profiler.post("Profiler.enable");
		profiler.post("Profiler.setSamplingInterval", { interval: 200 });
	}
	const post = (method, params) =>
		new Promise((resolve, reject) =>
			profiler.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result))),
		);
	const finishWindow = async (next) => {
		const finished = label;
		label = next;
		const ms = (value) => Math.round((value / 1e6) * 100) / 100;
		if (finished) {
			appendFileSync(
				loopFile,
				`${JSON.stringify({
					pid: process.pid,
					role,
					window: finished,
					durationMs: Math.round(performance.now() - started),
					p50: ms(histogram.percentile(50)),
					p99: ms(histogram.percentile(99)),
					max: ms(histogram.max),
					mean: ms(histogram.mean),
				})}\n`,
			);
		}
		histogram.reset();
		started = performance.now();
		if (!profiler) return;
		if (finished) {
			const { profile } = await post("Profiler.stop");
			writeFileSync(join(profileDir, `${finished}-${role}-${process.pid}.cpuprofile`), JSON.stringify(profile));
		}
		if (next && next !== "end") await post("Profiler.start");
	};
	let busy = false;
	const poll = setInterval(async () => {
		if (busy) return;
		busy = true;
		try {
			const next = (await readFile(windowFile, "utf8")).trim();
			if (next !== label) await finishWindow(next);
		} catch {
			// The window file appears with the first window.
		} finally {
			busy = false;
		}
	}, 100);
	poll.unref();
}
