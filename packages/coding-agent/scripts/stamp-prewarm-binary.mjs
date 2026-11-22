#!/usr/bin/env node
/**
 * Stamps `PREWARM_BUILD_STAMP` into compiled `dist/` before `bun build` produces standalone release app bundles
 * (`scripts/build-binaries.sh` and `packages/coding-agent` `build:binary`), which compile via `build:tsc` without
 * `build:split`. Running this before both plain and `--bytecode` `bun build` calls keeps both bundles aligned with the
 * exact same 30-hex SHA-256 stamp and valid bytecode cache, and is idempotent on repeated `--skip-package-build` runs
 * or on an already-split `dist/`.
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	computePrewarmBuildStamp,
	PREWARM_BUILD_STAMP_MARK,
	stampPrewarmBuildChunk,
} from "./split-dist-names.mjs";

const SKIPPED_TOP_LEVEL_DIRS = new Set(["builtin", "bytecode"]);
const SKIPPED_TOP_LEVEL_FILES = new Set(["app.js", "codemode-worker.js", "image-resize-worker.js"]);
const STAMPED_VALUE_PATTERN = /\bPREWARM_BUILD_STAMP\s*=\s*"([0-9a-f]{30})"/u;

/**
 * @param {string} root
 * @param {string} [prefix]
 * @returns {{ type: "chunk", fileName: string, code: string }[]}
 */
function collectCompiledDistJs(root, prefix = "") {
	/** @type {{ type: "chunk", fileName: string, code: string }[]} */
	const files = [];
	const dir = prefix ? join(root, prefix) : root;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!prefix && entry.isDirectory() && SKIPPED_TOP_LEVEL_DIRS.has(entry.name)) continue;
		if (!prefix && entry.isFile() && SKIPPED_TOP_LEVEL_FILES.has(entry.name)) continue;
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...collectCompiledDistJs(root, rel));
		} else if (entry.isFile() && entry.name.endsWith(".js")) {
			files.push({ type: "chunk", fileName: rel, code: readFileSync(join(root, rel), "utf8") });
		}
	}
	return files;
}

/**
 * Stamps `PREWARM_BUILD_STAMP` in `distDir` before `bun build`.
 *
 * @param {string} distDir
 * @returns {{ stamp: string, mode: "split" | "unsplit", changed: boolean }}
 */
export function stampBinaryDist(distDir) {
	const prewarmPath = join(distDir, "modes/interactive-engine/engine-prewarm.js");
	if (!existsSync(prewarmPath)) {
		throw new Error(`stamp-prewarm-binary: missing ${prewarmPath}; run build:tsc first`);
	}
	const original = readFileSync(prewarmPath, "utf8");
	// A split dist already stamped `_shared/p1a-prewarm-*.js` and replaced `engine-prewarm.js` with a re-export facade.
	const splitRef = /\.\.\/\.\.\/(_shared\/p1a-prewarm-[A-Z2-7]{8}\.js)/u.exec(original);
	if (splitRef) {
		const chunkPath = join(distDir, splitRef[1]);
		if (!existsSync(chunkPath)) {
			throw new Error(`stamp-prewarm-binary: missing split prewarm chunk ${chunkPath}`);
		}
		const chunk = readFileSync(chunkPath, "utf8");
		if (chunk.includes(PREWARM_BUILD_STAMP_MARK)) {
			throw new Error(`stamp-prewarm-binary: split chunk ${chunkPath} retained unstamped ${PREWARM_BUILD_STAMP_MARK}`);
		}
		const match = STAMPED_VALUE_PATTERN.exec(chunk);
		if (!match) {
			throw new Error(`stamp-prewarm-binary: split chunk ${chunkPath} lacks a 30-hex PREWARM_BUILD_STAMP`);
		}
		return { stamp: match[1], mode: "split", changed: false };
	}

	const distJs = collectCompiledDistJs(distDir);
	const stamp = computePrewarmBuildStamp(distJs);
	const { contents, stamped } = stampPrewarmBuildChunk(original, stamp, { allowRestamp: true });
	if (!stamped) {
		throw new Error(`stamp-prewarm-binary: expected ${PREWARM_BUILD_STAMP_MARK} in ${prewarmPath}`);
	}
	const changed = contents !== original;
	if (changed) {
		const tmpPath = `${prewarmPath}.stamp`;
		writeFileSync(tmpPath, contents);
		renameSync(tmpPath, prewarmPath);
	}
	return { stamp, mode: "unsplit", changed };
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(selfPath)) {
	const distDir = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(selfPath), "../dist");
	const result = stampBinaryDist(distDir);
	console.log(`stamp-prewarm-binary: ${result.mode} dist stamp ${result.stamp} (${result.changed ? "updated" : "up to date"})`);
}
