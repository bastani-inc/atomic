#!/usr/bin/env node
// Redact private text from extracted capture frames.
//
//   node mask-frames.mjs <frame-dir> [--no-statusline]
//
// Two passes, because one is not enough.
//
// PASS 1, structural. The statusline is where the provider and model label
// lives, and it is the single most persistent leak. Finding it by OCR was the
// wrong design: the redaction then depends on the same fallible tokenizer it
// exists to defeat, so one missed token ships a legible label. A fixed
// rectangle was wrong too - the statusline's y position varies between
// captures. So the band is located from pixels: the bottom-most run of rows
// that differ from the terminal background is the statusline, and the whole
// band is painted. No OCR is involved, so nothing can be missed by tokenizing.
// This is skipped for headless lessons, which render no statusline and whose
// bottom rows are real output.
//
// PASS 2, OCR. Private text also appears away from the statusline: the startup
// banner, subagent panels, and workflow graph node labels. Those move with the
// content, so their boxes are found with tesseract in both segmentation modes
// and painted individually. Pass 2 is a supplement to pass 1, never the only
// defence for the statusline.
//
// Everything painted is already on screen. Nothing is added, relabelled, moved,
// or invented. The gate re-OCRs the finished GIF, so a miss here fails there
// rather than shipping.
import { execFile, execFileSync } from "node:child_process";
import { readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPrivate } from "./lib/privacy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
void HERE;

const dir = process.argv[2];
if (!dir) {
	console.error("usage: mask-frames.mjs <frame-dir> [--no-statusline]");
	process.exit(1);
}
const doStatusline = !process.argv.includes("--no-statusline");

const BG = "#1e1e2e";
const BG_GRAY = 32; // #1e1e2e in Rec.601 luma
const DEV = 12; // per-pixel deviation that counts as rendered content
const MIN_PIXELS = 3; // pixels per row before the row counts as text
const PAD = 4;
const W = 960;
const H = 540;
const STRIP_H = 170; // bottom slice searched for the statusline band
const STRIP_Y = H - STRIP_H;
const CONCURRENCY = Number(process.env.FW_MASK_CONCURRENCY ?? 8);

const frames = readdirSync(dir)
	.filter((f) => f.endsWith(".png"))
	.sort();
if (!frames.length) {
	console.log("    no frames to mask");
	process.exit(0);
}

// ---------------------------------------------------------------- pass 1 ---
// One ffmpeg pass produces the bottom strip of every frame as raw grey, so band
// detection costs a single decode for the whole clip rather than one per frame.
const bands = new Map();
if (doStatusline) {
	const raw = execFileSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-i",
			join(dir, "%05d.png"),
			"-vf",
			`crop=${W}:${STRIP_H}:0:${STRIP_Y},format=gray`,
			"-f",
			"rawvideo",
			"-",
		],
		{ maxBuffer: 2 * 1024 * 1024 * 1024, encoding: "buffer" },
	);
	const strip = W * STRIP_H;
	const n = Math.floor(raw.length / strip);
	for (let f = 0; f < n; f += 1) {
		const base = f * strip;
		const rowHasText = new Array(STRIP_H).fill(false);
		for (let r = 0; r < STRIP_H; r += 1) {
			let count = 0;
			const off = base + r * W;
			for (let x = 0; x < W; x += 1) {
				if (Math.abs(raw[off + x] - BG_GRAY) > DEV) {
					count += 1;
					if (count > MIN_PIXELS) break;
				}
			}
			rowHasText[r] = count > MIN_PIXELS;
		}
		let bottom = -1;
		for (let r = STRIP_H - 1; r >= 0; r -= 1) {
			if (rowHasText[r]) {
				bottom = r;
				break;
			}
		}
		if (bottom < 0) continue;
		let top = bottom;
		let gap = 0;
		for (let r = bottom - 1; r >= 0; r -= 1) {
			if (rowHasText[r]) {
				top = r;
				gap = 0;
			} else if (++gap > 4) break;
		}
		bands.set(frames[f], { y: Math.max(0, STRIP_Y + top - PAD), h: bottom - top + 1 + PAD * 2 });
	}
}

// Tesseract's plain-text renderer can reconstruct text that its TSV output
// splits across blocks or even reports as an empty word. Check individual
// tokens, reconstructed visual lines, and the fixed shape of the startup
// identity row. The finished-media gate remains the final oracle.
const box = (left, top, width, height) => ({
	x: Math.max(0, left - PAD),
	y: Math.max(0, top - PAD),
	w: Math.min(W - Math.max(0, left - PAD), width + PAD * 2),
	h: Math.min(H - Math.max(0, top - PAD), height + PAD * 2),
});

const wordsFromTsv = (tsv) => {
	const words = [];
	for (const row of tsv.split("\n").slice(1)) {
		const c = row.split("\t");
		if (c.length < 12) continue;
		const [left, top, width, height] = [c[6], c[7], c[8], c[9]].map(Number);
		const text = c.slice(11).join("\t").trim();
		if (!text || !Number.isFinite(left) || !Number.isFinite(top) || width <= 0 || height <= 0) continue;
		words.push({ left, top, width, height, text });
	}
	return words;
};

const visualLines = (words) => {
	const lines = [];
	for (const word of [...words].sort((a, b) => a.top - b.top || a.left - b.left)) {
		const bottom = word.top + word.height;
		let line = lines.find((candidate) => word.top <= candidate.bottom + 2 && bottom >= candidate.top - 2);
		if (!line) {
			line = { top: word.top, bottom, words: [] };
			lines.push(line);
		}
		line.top = Math.min(line.top, word.top);
		line.bottom = Math.max(line.bottom, bottom);
		line.words.push(word);
	}
	return lines;
};

const ocrBoxes = (png) => {
	const boxes = [];
	for (const psm of ["6", "11"]) {
		let tsv;
		try {
			tsv = execFileSync("tesseract", [png, "stdout", "tsv", "--psm", psm], {
				encoding: "utf8",
				maxBuffer: 32 * 1024 * 1024,
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			continue;
		}
		const words = wordsFromTsv(tsv);
		for (const word of words) {
			if (isPrivate(word.text)) boxes.push(box(word.left, word.top, word.width, word.height));
			// The startup provider/model row sits directly below the Atomic
			// version. On low-contrast frames tesseract sees the row in plain text
			// but returns an empty TSV token, so locate it from the stable header.
			if (doStatusline && /^Atomic$/i.test(word.text) && word.top < 120 && word.left > W / 4) {
				boxes.push(box(word.left, word.top + word.height + 2, 280, 22));
			}
		}
		// Paint by reconstructed line, and by each adjacent pair of lines: a
		// terminal wrap splits a forbidden string across two lines, so neither
		// line matches on its own. Painting both is what removes it.
		const lines = visualLines(words);
		for (const line of lines) line.words.sort((a, b) => a.left - b.left);
		const paint = (group) => {
			const ordered = group.flatMap((line) => line.words);
			if (!ordered.length) return;
			const left = Math.min(...ordered.map((word) => word.left));
			const right = Math.max(...ordered.map((word) => word.left + word.width));
			const top = Math.min(...group.map((line) => line.top));
			const bottom = Math.max(...group.map((line) => line.bottom));
			boxes.push(box(left, top, right - left, bottom - top));
		};
		const groupText = (group) => group.map((line) => line.words.map((word) => word.text).join(" ")).join(" ");
		for (let i = 0; i < lines.length; i += 1) {
			if (isPrivate(groupText([lines[i]]))) {
				paint([lines[i]]);
			} else if (i + 1 < lines.length && isPrivate(groupText([lines[i], lines[i + 1]]))) {
				paint([lines[i]]);
				paint([lines[i + 1]]);
			}
		}
	}
	return boxes;
};

const maskOne = (name) =>
	new Promise((resolve) => {
		const png = join(dir, name);
		const boxes = ocrBoxes(png);
		const band = bands.get(name);
		if (band) boxes.push({ x: 0, y: band.y, w: W, h: band.h });
		if (!boxes.length) return resolve(0);
		const vf = boxes.map((b) => `drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=${BG}@1.0:t=fill`).join(",");
		// Never let ffmpeg read and write the same path: it silently produces an
		// unchanged or truncated frame, which looks exactly like a masking miss.
		const tmp = `${png}.masked.png`;
		execFile("ffmpeg", ["-y", "-v", "error", "-i", png, "-vf", vf, "-update", "1", tmp], (err) => {
			if (err) return resolve(0);
			try {
				renameSync(tmp, png);
			} catch {
				return resolve(0);
			}
			resolve(boxes.length);
		});
	});

let painted = 0;
let touched = 0;
let cursor = 0;
const worker = async () => {
	while (cursor < frames.length) {
		const name = frames[cursor++];
		const n = await maskOne(name);
		if (n > 0) {
			painted += n;
			touched += 1;
		}
	}
};
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, frames.length) }, worker));
console.log(
	`    masked ${painted} region(s) across ${touched}/${frames.length} frames (statusline band on ${bands.size})`,
);
