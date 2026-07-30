import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { buffer } from "node:stream/consumers";
import JSZip from "jszip";
import { extract as tarExtract, pack as tarPack } from "tar-stream";
import { test } from "vitest";
import { assertExactBuiltinSet, EXPECTED_BUILTIN_DIRECTORY_NAMES } from "../../scripts/assert-builtin-set.js";

const unexpectedName = "retired-provider";
const unexpectedContents = "unexpected builtin payload\n";

function archivePayload(): Record<string, string> {
	const payload: Record<string, string> = {};
	for (const name of EXPECTED_BUILTIN_DIRECTORY_NAMES) {
		payload[`builtin/${name}/package.json`] = JSON.stringify({ name });
	}
	payload[`builtin/${unexpectedName}`] = unexpectedContents;
	return payload;
}

async function withExtraction(label: string, extract: (root: string) => Promise<void>): Promise<void> {
	const workspace = mkdtempSync(join(tmpdir(), `atomic-builtin-${label}-`));
	const extracted = join(workspace, "extracted");
	mkdirSync(extracted);
	try {
		await extract(extracted);
		const builtinRoot = join(extracted, "builtin");
		const unexpectedPath = join(builtinRoot, unexpectedName);
		assert.equal(existsSync(unexpectedPath), true);
		assert.equal(readFileSync(unexpectedPath, "utf8"), unexpectedContents);
		assert.throws(() => assertExactBuiltinSet(builtinRoot), /Builtin entry set mismatch/u);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

/**
 * `Bun.Archive` built and unpacked the TAR in two calls and has no Node
 * equivalent; `tar-stream` is the streaming replacement, and it restores the
 * symmetry with the ZIP half of this file, which has always used JSZip.
 */
async function packTar(payload: Record<string, string>): Promise<Uint8Array> {
	const pack = tarPack();
	for (const [path, contents] of Object.entries(payload)) pack.entry({ name: path }, contents);
	pack.finalize();
	return new Uint8Array(await buffer(pack));
}

async function unpackTar(bytes: Uint8Array, root: string): Promise<void> {
	const extractor = tarExtract();
	const containedRoot = resolve(root) + sep;
	const done = new Promise<void>((resolve, reject) => {
		extractor.on("finish", resolve);
		extractor.on("error", reject);
	});
	extractor.on("entry", (header, stream, next) => {
		// A tar entry name is attacker-controlled and may contain `..`, so
		// resolving it against the root can escape the extraction directory
		// ("Zip Slip"). The guard and the writes deliberately live in the same
		// function: CodeQL's js/zipslip barrier recognition does not follow a
		// guarded variable into a separate callback, which kept the alert open
		// across two earlier revisions of this handler.
		const handleEntry = async (): Promise<void> => {
			const contents = await buffer(stream);
			const target = resolve(root, header.name);
			if (!target.startsWith(containedRoot)) {
				throw new Error(`Refusing archive entry outside the extraction root: ${header.name}`);
			}
			if (header.type === "directory") mkdirSync(target, { recursive: true });
			else {
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, contents);
			}
		};
		handleEntry().then(() => next(), next);
	});
	extractor.end(Buffer.from(bytes));
	await done;
}

test("TAR transport preserves and rejects an unexpected builtin file", async () => {
	const bytes = await packTar(archivePayload());
	await withExtraction("tar", async (root) => {
		await unpackTar(bytes, root);
	});
});

test("ZIP transport preserves and rejects an unexpected builtin file", async () => {
	const zip = new JSZip();
	for (const [path, contents] of Object.entries(archivePayload())) zip.file(path, contents);
	const bytes = await zip.generateAsync({ type: "uint8array" });

	await withExtraction("zip", async (root) => {
		const loaded = await JSZip.loadAsync(bytes);
		for (const [path, entry] of Object.entries(loaded.files)) {
			const target = join(root, path);
			if (entry.dir) {
				mkdirSync(target, { recursive: true });
				continue;
			}
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, await entry.async("uint8array"));
		}
	});
});
