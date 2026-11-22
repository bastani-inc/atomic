import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { assertPiRuntimeAssets } from "../../packages/coding-agent/scripts/assert-pi-runtime-assets.ts";
import {
	computePrewarmBuildStamp,
	PREWARM_BUILD_STAMP_MARK,
	stampPrewarmBuildChunk,
} from "../../packages/coding-agent/scripts/split-dist-names.mjs";
import { stampBinaryDist } from "../../packages/coding-agent/scripts/stamp-prewarm-binary.mjs";
import { makeTempDirectory, moduleDir, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = join(moduleDir(import.meta.url), "../..");
const PACKAGE = join(ROOT, "packages/coding-agent");
const NAMES_MODULE_URL = pathToFileURL(join(PACKAGE, "scripts/split-dist-names.mjs")).href;
const SHARED_DIR = join(PACKAGE, "dist/_shared");
const CHILD_TIMEOUT_MS = 30_000;
const BUN_BUNDLE_TIMEOUT_MS = 60_000;

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) removeTempDirectory(dir);
});

/**
 * Chunk names whose sort order differs between `localeCompare` (en-US / tr_TR) and binary UTF-16 code-unit order
 * (`APEv2Parser` vs `AbstractID3Parser`, `Istanbul` vs `istanbul`, `Index` vs `index`), plus the marker chunk.
 */
const SAMPLE_CHUNKS = [
	{ type: "chunk", fileName: "_shared/APEv2Parser-AAAAAAAA.js", code: "export const ape = 1;\n" },
	{ type: "chunk", fileName: "_shared/AbstractID3Parser-BBBBBBBB.js", code: "export const id3 = 2;\n" },
	{ type: "chunk", fileName: "_shared/Istanbul-CCCCCCCC.js", code: "export const upper = 3;\n" },
	{ type: "chunk", fileName: "_shared/istanbul-DDDDDDDD.js", code: "export const lower = 4;\n" },
	{ type: "chunk", fileName: "_shared/Index-EEEEEEEE.js", code: "export const idxU = 5;\n" },
	{ type: "chunk", fileName: "_shared/index-FFFFFFFF.js", code: "export const idxL = 6;\n" },
	{
		type: "chunk",
		fileName: "_shared/p1a-prewarm-GGGGGGGG.js",
		code: `const PREWARM_BUILD_STAMP = "${PREWARM_BUILD_STAMP_MARK}";\nexport const prewarm = 1;\n`,
	},
] as const;

const LOCALE_STAMP_PROBE = `
const { computePrewarmBuildStamp } = await import(process.argv[1]);
const chunks = JSON.parse(process.argv[2]);
process.stdout.write(computePrewarmBuildStamp(chunks));
`;

function runStampUnderLocale(
	locale: string,
	chunks: readonly { type: string; fileName: string; code: string }[],
): string {
	const result = spawnSyncCollect(
		[process.execPath, "--input-type=module", "-e", LOCALE_STAMP_PROBE, NAMES_MODULE_URL, JSON.stringify(chunks)],
		{
			env: { ...process.env, LANG: locale, LC_ALL: locale, LC_COLLATE: locale, NODE_OPTIONS: "" },
			timeout: CHILD_TIMEOUT_MS,
		},
	);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout.toString();
}

test("computePrewarmBuildStamp is byte-identical under LANG=C and LANG=tr_TR and independent of input order", () => {
	const cStamp = runStampUnderLocale("C", SAMPLE_CHUNKS);
	const trStamp = runStampUnderLocale("tr_TR.UTF-8", [...SAMPLE_CHUNKS].reverse());
	const trBareStamp = runStampUnderLocale("tr_TR", SAMPLE_CHUNKS);
	assert.match(cStamp, /^[0-9a-f]{30}$/);
	assert.equal(cStamp.length, PREWARM_BUILD_STAMP_MARK.length);
	assert.equal(trStamp, cStamp, "tr_TR.UTF-8 must match LANG=C");
	assert.equal(trBareStamp, cStamp, "tr_TR must match LANG=C");
});

test("computePrewarmBuildStamp changes whenever any chunk body changes and stays independent of the placeholder literal", () => {
	const base = computePrewarmBuildStamp(SAMPLE_CHUNKS);
	for (let index = 0; index < SAMPLE_CHUNKS.length; index++) {
		const mutated = SAMPLE_CHUNKS.map((chunk, i) =>
			i === index ? { ...chunk, code: `${chunk.code}// edit ${i}\n` } : chunk,
		);
		assert.notEqual(
			computePrewarmBuildStamp(mutated),
			base,
			`editing chunk ${SAMPLE_CHUNKS[index]!.fileName} must change the build stamp`,
		);
	}
	// Replacing the quoted placeholder inside the marker chunk must not self-reference or shift column length.
	const markerChunk = SAMPLE_CHUNKS.at(-1)!;
	const { contents, stamped } = stampPrewarmBuildChunk(markerChunk.code, base);
	assert.equal(stamped, true);
	assert.equal(contents.length, markerChunk.code.length, "exact length replacement keeps source-map columns aligned");
	assert.ok(contents.includes(`const PREWARM_BUILD_STAMP = "${base}";`));
	assert.ok(!contents.includes(PREWARM_BUILD_STAMP_MARK));
	// Restamping an already-stamped chunk stays idempotent (same digest, exact length).
	const alreadyStampedChunks = SAMPLE_CHUNKS.map((chunk, i) =>
		i === SAMPLE_CHUNKS.length - 1 ? { ...chunk, code: contents } : chunk,
	);
	assert.equal(computePrewarmBuildStamp(alreadyStampedChunks), base);
	const restamped = stampPrewarmBuildChunk(contents, base, { allowRestamp: true });
	assert.equal(restamped.stamped, true);
	assert.equal(restamped.contents, contents);
});

test("built split dist embeds a 30-hex PREWARM_BUILD_STAMP literal and leaves no unstamped marker", () => {
	const prewarmChunk = readdirSync(SHARED_DIR).find((name) => name.startsWith("p1a-prewarm-") && name.endsWith(".js"));
	assert.ok(prewarmChunk, "expected p1a-prewarm shared chunk in dist/_shared");
	const contents = readFileSync(join(SHARED_DIR, prewarmChunk), "utf8");
	assert.match(contents, /const PREWARM_BUILD_STAMP = "[0-9a-f]{30}";/);
	assert.ok(!contents.includes(PREWARM_BUILD_STAMP_MARK), "built chunk must not retain the raw build stamp marker");
});

test("stampBinaryDist stamps unsplit tsc output idempotently and updates when any dist module changes", () => {
	const dir = makeTempDirectory("atomic-binary-stamp-");
	tempDirs.push(dir);
	const dist = join(dir, "dist");
	const prewarmPath = join(dist, "modes/interactive-engine/engine-prewarm.js");
	const mainPath = join(dist, "main.js");
	mkdirSync(join(dist, "modes/interactive-engine"), { recursive: true });
	const initialPrewarm = `const PREWARM_BUILD_STAMP = "${PREWARM_BUILD_STAMP_MARK}";\nexport const ok = 1;\n`;
	writeFileSync(prewarmPath, initialPrewarm);
	writeFileSync(mainPath, "export const main = 1;\n");

	const first = stampBinaryDist(dist);
	assert.equal(first.mode, "unsplit");
	assert.equal(first.changed, true);
	assert.match(first.stamp, /^[0-9a-f]{30}$/);
	const afterFirst = readFileSync(prewarmPath, "utf8");
	assert.equal(afterFirst.length, initialPrewarm.length, "exact-length replacement keeps source maps aligned");
	assert.ok(afterFirst.includes(`const PREWARM_BUILD_STAMP = "${first.stamp}";`));
	assert.ok(!afterFirst.includes(PREWARM_BUILD_STAMP_MARK));

	// Re-running (e.g. build-binaries.sh --skip-package-build on a second arch) is a deterministic no-op.
	const second = stampBinaryDist(dist);
	assert.equal(second.stamp, first.stamp);
	assert.equal(second.changed, false);

	// Editing another dist file changes the stamp.
	writeFileSync(mainPath, "export const main = 2;\n");
	const afterMainEdit = stampBinaryDist(dist);
	assert.notEqual(afterMainEdit.stamp, first.stamp);
	assert.equal(afterMainEdit.changed, true);

	// Editing the body of engine-prewarm.js itself also changes the stamp.
	writeFileSync(prewarmPath, readFileSync(prewarmPath, "utf8").replace("ok = 1", "ok = 2"));
	const afterPrewarmEdit = stampBinaryDist(dist);
	assert.notEqual(afterPrewarmEdit.stamp, afterMainEdit.stamp);
	assert.equal(afterPrewarmEdit.changed, true);

	// Split dist (already stamped by split-dist.mjs) is verified cleanly as a no-op.
	const splitResult = stampBinaryDist(join(PACKAGE, "dist"));
	assert.equal(splitResult.mode, "split");
	assert.equal(splitResult.changed, false);
	assert.match(splitResult.stamp, /^[0-9a-f]{30}$/);
});

test(
	"binary builds stamp before bun build so plain and bytecode app.js share the exact 30-hex stamp and pass asset verification",
	() => {
		const buildScript = readFileSync(join(ROOT, "scripts/build-binaries.sh"), "utf8");
		const packageManifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		const buildBinary = packageManifest.scripts["build:binary"] ?? "";
		const stampStep = "node scripts/stamp-prewarm-binary.mjs";
		const releaseStampIdx = buildScript.indexOf(stampStep);
		const releaseBunIdx = buildScript.indexOf("./dist/bun/cli.js --outfile");
		assert.ok(
			releaseStampIdx > 0 && releaseStampIdx < releaseBunIdx,
			"build-binaries.sh must stamp before bun build",
		);
		const localStampIdx = buildBinary.indexOf(stampStep);
		const localBunIdx = buildBinary.indexOf("./dist/bun/cli.js --outfile");
		assert.ok(localStampIdx > 0 && localStampIdx < localBunIdx, "build:binary must stamp before bun build");

		// Prove assertPiRuntimeAssets rejects an unstamped app.js and accepts a stamped one, and plain + bytecode match.
		const dir = makeTempDirectory("atomic-binary-app-stamp-");
		tempDirs.push(dir);
		const appDir = join(dir, "app");
		const bcDir = join(dir, "bytecode");
		mkdirSync(appDir, { recursive: true });
		mkdirSync(bcDir, { recursive: true });
		// Build plain and bytecode app.js from the current dist and verify both carry the exact same 30-hex stamp.
		const plainApp = join(appDir, "app.js");
		const plainBuild = spawnSyncCollect(
			[
				"bun",
				"build",
				"--target=bun",
				"--format=cjs",
				"--minify-syntax",
				"--external",
				"mupdf",
				"--external=*native-modifiers.js",
				"./dist/bun/cli.js",
				"--outfile",
				plainApp,
			],
			{ cwd: PACKAGE, timeout: BUN_BUNDLE_TIMEOUT_MS },
		);
		assert.equal(plainBuild.exitCode, 0, plainBuild.stderr.toString());
		const bcBuild = spawnSyncCollect(
			[
				"bun",
				"build",
				"--target=bun",
				"--format=cjs",
				"--bytecode",
				"--minify-syntax",
				"--external",
				"mupdf",
				"--external=*native-modifiers.js",
				"./dist/bun/cli.js",
				"--outdir",
				bcDir,
			],
			{ cwd: PACKAGE, timeout: BUN_BUNDLE_TIMEOUT_MS },
		);
		assert.equal(bcBuild.exitCode, 0, bcBuild.stderr.toString());
		const plainText = readFileSync(plainApp, "utf8");
		const bcText = readFileSync(join(bcDir, "cli.js"), "utf8");
		const plainMatch = /\bPREWARM_BUILD_STAMP\s*=\s*"([0-9a-f]{30})"/u.exec(plainText);
		const bcMatch = /\bPREWARM_BUILD_STAMP\s*=\s*"([0-9a-f]{30})"/u.exec(bcText);
		assert.ok(plainMatch, "plain app.js must embed a 30-hex PREWARM_BUILD_STAMP");
		assert.ok(bcMatch, "bytecode app.js must embed a 30-hex PREWARM_BUILD_STAMP");
		assert.equal(bcMatch[1], plainMatch[1], "plain and bytecode app.js must embed the exact same stamp");
		assert.ok(!plainText.includes(PREWARM_BUILD_STAMP_MARK));
		assert.ok(!bcText.includes(PREWARM_BUILD_STAMP_MARK));

		// Stage minimal sibling files next to app.js to test assertPiRuntimeAssets accept vs unstamped reject.
		cpSync(join(PACKAGE, "dist/codemode-worker.js"), join(appDir, "codemode-worker.js"));
		cpSync(join(ROOT, "node_modules/quickjs-wasi/quickjs.wasm"), join(appDir, "quickjs.wasm"));
		for (const file of ["native-modifiers.js", "native-module-path.js", "native-platform.js"]) {
			cpSync(join(ROOT, "node_modules/@bastani/atomic-tui/dist", file), join(appDir, file));
		}
		assertPiRuntimeAssets({ nodeModulesRoot: join(ROOT, "node_modules"), appBundlePath: plainApp });
		// Mutate app.js back to unstamped marker: assertPiRuntimeAssets must reject it.
		writeFileSync(plainApp, plainText.replace(plainMatch[0], `PREWARM_BUILD_STAMP="${PREWARM_BUILD_STAMP_MARK}"`));
		assert.throws(
			() => assertPiRuntimeAssets({ nodeModulesRoot: join(ROOT, "node_modules"), appBundlePath: plainApp }),
			/PREWARM_BUILD_STAMP/u,
		);
		rmSync(dir, { recursive: true, force: true });
	},
	BUN_BUNDLE_TIMEOUT_MS,
);
