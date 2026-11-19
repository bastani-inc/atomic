import assert from "node:assert/strict";
import type * as Fs from "node:fs";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";

/** What each rename of a bootstrap record saw, and whether it fails after the temporary file was written. */
const publication = vi.hoisted(() => ({
	fail: false,
	renames: [] as Array<{
		readonly from: string;
		readonly to: string;
		readonly published: boolean;
		readonly written: string;
	}>,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	const renameSync = ((from: Fs.PathLike, to: Fs.PathLike) => {
		publication.renames.push({
			from: String(from),
			to: String(to),
			published: actual.existsSync(to),
			written: actual.readFileSync(from, "utf8"),
		});
		if (publication.fail) throw Object.assign(new Error("EXDEV: injected"), { code: "EXDEV" });
		actual.renameSync(from, to);
	}) as typeof actual.renameSync;
	return { ...actual, renameSync };
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	const rename = (async (from: Fs.PathLike, to: Fs.PathLike) => {
		publication.renames.push({
			from: String(from),
			to: String(to),
			published: existsSync(to),
			written: await actual.readFile(from, "utf8"),
		});
		if (publication.fail) throw Object.assign(new Error("EXDEV: injected"), { code: "EXDEV" });
		await actual.rename(from, to);
	}) as typeof actual.rename;
	return { ...actual, rename, default: { ...actual, rename } };
});

const {
	INTERACTIVE_ENGINE_BOOTSTRAP_VERSION,
	removeOwnedInteractiveEngineBootstrap,
	removeOwnedInteractiveEngineBootstrapAsync,
	writeInteractiveEngineBootstrap,
	writeInteractiveEngineBootstrapAsync,
} = await import("../../packages/coding-agent/src/utils/interactive-engine-bootstrap.js");

const WRITERS = [
	{
		name: "synchronous",
		write: async (record: Parameters<typeof writeInteractiveEngineBootstrap>[0]) =>
			writeInteractiveEngineBootstrap(record),
		remove: async (handle: Parameters<typeof removeOwnedInteractiveEngineBootstrap>[0]) =>
			removeOwnedInteractiveEngineBootstrap(handle),
	},
	{
		name: "asynchronous",
		write: writeInteractiveEngineBootstrapAsync,
		remove: removeOwnedInteractiveEngineBootstrapAsync,
	},
] as const;

let scoped: string;
const savedTemp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };

beforeEach(() => {
	publication.fail = false;
	publication.renames.length = 0;
	// Other test files create their own bootstrap directories in the shared temp directory; observe a private one.
	scoped = mkdtempSync(join(tmpdir(), "atomic-bootstrap-publication-"));
	process.env.TMPDIR = scoped;
	process.env.TMP = scoped;
	process.env.TEMP = scoped;
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedTemp)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(scoped, { recursive: true, force: true });
});

test.each(WRITERS)(
	"a $name publication that fails after its temporary file is written leaves no file, directory or secret",
	async (writer) => {
		publication.fail = true;
		await assert.rejects(writer.write({ hostPid: 1, guardFile: "/tmp/guard", apiKey: "secret-key" }), /EXDEV/);

		assert.equal(publication.renames.length, 1, "the temporary file was written before the failure");
		assert.match(publication.renames[0]!.written, /secret-key/);
		assert.equal(existsSync(publication.renames[0]!.from), false);
		assert.equal(existsSync(publication.renames[0]!.to), false);
		assert.equal(existsSync(dirname(publication.renames[0]!.to)), false);
		assert.deepEqual(readdirSync(scoped), [], "nothing the publication created is left behind");
	},
);

test.each(WRITERS)(
	"a $name publication writes the whole record beside the published path before the path appears",
	async (writer) => {
		const handle = await writer.write({ hostPid: 7, guardFile: "/tmp/guard-7" });

		assert.deepEqual(
			publication.renames.map(({ from, to, published }) => ({ from, to, published })),
			[{ from: `${handle.path}.tmp`, to: handle.path, published: false }],
			"a reader polling the published path finds nothing until the record is complete",
		);
		const expected = { version: INTERACTIVE_ENGINE_BOOTSTRAP_VERSION, hostPid: 7, guardFile: "/tmp/guard-7" };
		assert.deepEqual(JSON.parse(publication.renames[0]!.written), expected);
		assert.deepEqual(JSON.parse(readFileSync(handle.path, "utf8")), expected);
		await writer.remove(handle);
	},
);
