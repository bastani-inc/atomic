import assert from "node:assert/strict";
import { linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJournalCatalogError, JournalCatalog } from "@bastani/atomic/storage";
import { afterEach, beforeEach, test } from "vitest";
import { fileIdentity, isSameFile } from "../../packages/coding-agent/src/core/storage/file-identity.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

let root: string;
let store: string;
beforeEach(() => {
	root = makeTempDirectory("journal-store-shard-identity-");
	store = join(root, "journal");
});
afterEach(() => removeTempDirectory(root));

test("a file's identity is shared by its hard links and absent for a file that does not exist (#4325)", () => {
	const file = join(root, "a.sqlite");
	const other = join(root, "b.sqlite");
	const link = join(root, "link.sqlite");
	writeFileSync(file, "a");
	writeFileSync(other, "a");
	linkSync(file, link);
	assert.equal(fileIdentity(join(root, "missing.sqlite")), undefined);
	assert.equal(typeof fileIdentity(file), "string");
	assert.equal(fileIdentity(file), fileIdentity(link));
	assert.notEqual(fileIdentity(file), fileIdentity(other));
	assert.equal(isSameFile(file, link), true);
	assert.equal(isSameFile(file, other), false);
	assert.equal(isSameFile(join(root, "missing-1.sqlite"), join(root, "missing-2.sqlite")), false);
	assert.equal(isSameFile(file, join(root, "missing-1.sqlite")), false);
});

test("registering a journal file that does not exist is told apart by path, never by identity (#4325)", async () => {
	const catalog = await JournalCatalog.open(store);
	try {
		const first = await catalog.registerAdopted(join(root, "gone-1.sqlite"), []);
		const second = await catalog.registerAdopted(join(root, "gone-2.sqlite"), []);
		const again = await catalog.registerAdopted(join(root, "gone-1.sqlite"), []);
		assert.deepEqual([first.status, second.status, again.status], ["adopted", "adopted", "already-registered"]);
		assert.notEqual(first.shard.id, second.shard.id);
		assert.equal(again.shard.id, first.shard.id);
	} finally {
		await catalog.close();
	}
});

test.skipIf(process.platform === "win32")(
	"a new shard whose file cannot be created fails with the cause instead of trying another name (#4325)",
	async () => {
		const catalog = await JournalCatalog.open(store);
		try {
			rmSync(store, { recursive: true, force: true });
			const failure = await catalog.place({ runId: "r", status: "running" }).catch((error: Error) => error);
			assert.ok(isJournalCatalogError(failure));
			assert.equal(failure.code, "write-failed");
			assert.equal((failure.cause as NodeJS.ErrnoException).code, "ENOENT");
		} finally {
			mkdirSync(store, { recursive: true });
			await catalog.close().catch(() => undefined);
		}
	},
);
