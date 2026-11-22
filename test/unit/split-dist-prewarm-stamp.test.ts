import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import {
	computePrewarmBuildStamp,
	PREWARM_BUILD_STAMP_MARK,
	stampPrewarmBuildChunk,
} from "../../packages/coding-agent/scripts/split-dist-names.mjs";
import { moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = join(moduleDir(import.meta.url), "../..");
const NAMES_MODULE_URL = pathToFileURL(join(ROOT, "packages/coding-agent/scripts/split-dist-names.mjs")).href;
const SHARED_DIR = join(ROOT, "packages/coding-agent/dist/_shared");
const CHILD_TIMEOUT_MS = 30_000;

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

function runStampUnderLocale(
	locale: string,
	chunks: readonly { type: string; fileName: string; code: string }[],
): string {
	const script = `import { computePrewarmBuildStamp } from ${JSON.stringify(NAMES_MODULE_URL)};
const stamp = computePrewarmBuildStamp(${JSON.stringify(chunks)});
process.stdout.write(stamp);
`;
	const result = spawnSyncCollect([process.execPath, "--input-type=module", "-e", script], {
		env: { ...process.env, LANG: locale, LC_ALL: locale, LC_COLLATE: locale, NODE_OPTIONS: "" },
		timeout: CHILD_TIMEOUT_MS,
	});
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
});

test("built split dist embeds a 30-hex PREWARM_BUILD_STAMP literal and leaves no unstamped marker", () => {
	const prewarmChunk = readdirSync(SHARED_DIR).find((name) => name.startsWith("p1a-prewarm-") && name.endsWith(".js"));
	assert.ok(prewarmChunk, "expected p1a-prewarm shared chunk in dist/_shared");
	const contents = readFileSync(join(SHARED_DIR, prewarmChunk), "utf8");
	assert.match(contents, /const PREWARM_BUILD_STAMP = "[0-9a-f]{30}";/);
	assert.ok(!contents.includes(PREWARM_BUILD_STAMP_MARK), "built chunk must not retain the raw build stamp marker");
});
