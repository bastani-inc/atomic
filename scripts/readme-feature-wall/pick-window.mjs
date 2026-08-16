#!/usr/bin/env node
// Choose each lesson's trim window by measured motion.
//
//   node pick-window.mjs            report the pick for every captured lesson
//   node pick-window.mjs --write    write the picks into manifest.json
//   node pick-window.mjs --write 6.4 6.6
//
// The first pass of this wall trimmed to a fixed offset from the end of each
// tape. That shipped two GIFs that gifski encoded as a single frame: the window
// had landed on a screen that never changed, so every frame deduplicated into
// one. A still padded to twelve seconds is not an animated capture.
//
// Motion is therefore measured rather than assumed. The capture is decoded once
// to a tiny greyscale stream, per-sample change is summed, and the window with
// the most change wins.
//
// The search is confined to the tail of each capture, because that is where the
// payoff beat of a tape lives - the earlier part is launch and typing. That
// keeps "most motion" from selecting a busy but irrelevant stretch, and the
// visual review still has to confirm each clip shows its named feature.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "manifest.json");
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const FW_BUILD = process.env.FW_BUILD ?? "/private/tmp/atomic-feature-wall";

const TARGET_S = 12; // shipped clip length
const SRC_S = 26; // source seconds consumed, so speed is ~2.17x
const SAMPLE_FPS = 4;
const W = 80;
const H = 45;
const FRAME_BYTES = W * H;
// Search only the tail: the launch and typing at the head are never the payoff.
const SEARCH_FROM = 0.35;

const write = process.argv.includes("--write");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const motionProfile = (raw) => {
	const buf = execFileSync(
		"ffmpeg",
		["-v", "error", "-i", raw, "-vf", `fps=${SAMPLE_FPS},scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"],
		{ maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" },
	);
	const n = Math.floor(buf.length / FRAME_BYTES);
	const change = new Float64Array(Math.max(0, n - 1));
	for (let i = 1; i < n; i += 1) {
		let sum = 0;
		const a = i * FRAME_BYTES;
		const b = (i - 1) * FRAME_BYTES;
		for (let p = 0; p < FRAME_BYTES; p += 1) sum += Math.abs(buf[a + p] - buf[b + p]);
		change[i - 1] = sum / FRAME_BYTES;
	}
	return change;
};

const rows = [];
for (const l of MANIFEST.lessons) {
	if (only.length && !only.includes(l.id)) continue;
	const raw = join(FW_BUILD, "raw", `${l.id}.mp4`);
	if (!existsSync(raw)) {
		rows.push([l.id, "no capture", "", ""]);
		continue;
	}
	const dur = Number(
		execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", raw], {
			encoding: "utf8",
		}).trim(),
	);
	const change = motionProfile(raw);
	const win = Math.round(SRC_S * SAMPLE_FPS);
	const first = Math.floor(change.length * SEARCH_FROM);
	const last = change.length - win;

	let best = first;
	let bestScore = -1;
	if (last <= first) {
		best = Math.max(0, last);
	} else {
		let score = 0;
		for (let i = first; i < first + win && i < change.length; i += 1) score += change[i];
		bestScore = score;
		for (let i = first + 1; i <= last; i += 1) {
			score += change[i + win - 1] - change[i - 1];
			if (score > bestScore) {
				bestScore = score;
				best = i;
			}
		}
	}

	const start = +(best / SAMPLE_FPS).toFixed(2);
	const end = +Math.min(dur, start + SRC_S).toFixed(2);
	const speed = +((end - start) / TARGET_S).toFixed(3);
	rows.push([l.id, `${start}-${end}`, `x${speed}`, bestScore >= 0 ? bestScore.toFixed(0) : "n/a"]);
	if (write) {
		Object.assign(l.render, {
			start,
			end,
			speed,
			fps: 12,
			quality: 80,
			poster_at: +(start + (end - start) * 0.75).toFixed(2),
		});
	}
}

for (const [id, win, speed, score] of rows)
	console.log(`${id.padEnd(5)} ${String(win).padEnd(16)} ${String(speed).padEnd(8)} motion=${score}`);
if (write) {
	writeFileSync(MANIFEST_PATH, `${JSON.stringify(MANIFEST, null, 2)}\n`);
	console.log(`\nwrote windows into manifest.json`);
}
