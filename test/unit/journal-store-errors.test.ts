import assert from "node:assert/strict";
import {
	isJournalAdoptError,
	isJournalCatalogError,
	isJournalShardUnavailableError,
	isJournalStoreError,
	JournalAdoptError,
	JournalCatalogError,
	JournalShardUnavailableError,
	JournalStoreError,
	rehydrateJournalStoreError,
	serializeJournalStoreError,
} from "@bastani/atomic/storage";
import { test } from "vitest";

const catalogPath = "/home/u/.atomic/workflows/journal/catalog.sqlite";
const busy = (message = "database is locked") => Object.assign(new Error(message), { errcode: 5 });

test("JournalCatalogError renders each code's message and hint from its fields (UX contract, #4325)", () => {
	const cases: [JournalCatalogError, string, string][] = [
		[
			new JournalCatalogError({ code: "catalog-unavailable", catalogPath }),
			`Journal catalog unavailable: ${catalogPath} (catalog-unavailable).`,
			"Check that the journal directory is readable and writable and the disk has free space, then retry; `atomic storage status` shows the store in use.",
		],
		[
			new JournalCatalogError({ code: "catalog-unavailable", catalogPath, cause: new Error("unable to open") }),
			`Journal catalog unavailable: ${catalogPath} (unable to open) (catalog-unavailable).`,
			"Check that the journal directory is readable and writable and the disk has free space, then retry; `atomic storage status` shows the store in use.",
		],
		[
			new JournalCatalogError({ code: "schema-version", catalogPath, found: 3, supported: 1 }),
			`Journal catalog schema not supported: ${catalogPath} has version 3, this Atomic supports 1 (schema-version).`,
			"Upgrade Atomic to the version that wrote this catalog, or select another journal with workflows.journal.",
		],
		[
			new JournalCatalogError({ code: "corrupt", catalogPath, rule: "catalog_meta has 2 rows" }),
			`Journal catalog is inconsistent: ${catalogPath} (catalog_meta has 2 rows) (corrupt).`,
			`Move ${catalogPath} aside and adopt the shard files again with \`atomic storage adopt <path>\` to rebuild it.`,
		],
		[
			new JournalCatalogError({ code: "corrupt", catalogPath }),
			`Journal catalog is inconsistent: ${catalogPath} (unknown rule) (corrupt).`,
			`Move ${catalogPath} aside and adopt the shard files again with \`atomic storage adopt <path>\` to rebuild it.`,
		],
		[
			new JournalCatalogError({
				code: "write-failed",
				catalogPath,
				phase: "placing-run",
				runId: "r1",
				cause: busy(),
			}),
			`Journal catalog write failed: ${catalogPath} while placing-run run r1 (database is locked) (write-failed).`,
			"Free disk space or release the lock another process holds on the catalog, then retry; checkpoints already written stay on their shard.",
		],
		[
			new JournalCatalogError({ code: "write-failed", catalogPath }),
			`Journal catalog write failed: ${catalogPath} while writing (write-failed).`,
			"Free disk space or release the lock another process holds on the catalog, then retry; checkpoints already written stay on their shard.",
		],
		[
			new JournalCatalogError({ code: "run-conflict", catalogPath, runId: "r2", shardPath: "/s/shard-0002.sqlite" }),
			"Journal run conflict: run r2 already has a different copy in /s/shard-0002.sqlite (run-conflict).",
			"Compare the two copies before moving the run; nothing was changed for this run.",
		],
		[
			new JournalCatalogError({ code: "run-conflict", catalogPath, shardId: 4 }),
			"Journal run conflict: run unknown already has a different copy in shard 4 (run-conflict).",
			"Compare the two copies before moving the run; nothing was changed for this run.",
		],
		[
			new JournalCatalogError({
				code: "run-not-found",
				catalogPath,
				runId: "r3",
				selection: "journal store /s",
				localOnly: true,
			}),
			"Workflow run not found: r3 in journal store /s (run-not-found).",
			"This machine uses local-only storage and is not joined to shared storage. If the run started on another machine, join its storage with `atomic storage join <url> --token-file <path>`; if it is in an older journal file, adopt it with `atomic storage adopt <path>`.",
		],
		[
			new JournalCatalogError({ code: "run-not-found", catalogPath, localOnly: false }),
			`Workflow run not found: unknown in ${catalogPath} (run-not-found).`,
			"The shared storage selected here does not hold this run; check the run ID with `/workflow status`.",
		],
	];
	for (const [error, message, hint] of cases) {
		assert.equal(error.message, message);
		assert.equal(error.hint, hint);
		assert.equal(error.name, "JournalCatalogError");
	}
});

test("JournalShardUnavailableError and JournalAdoptError render each code's message and hint (UX contract, #4325)", () => {
	const shard = "/s/shard-0001.sqlite";
	const cases: [JournalStoreError, string, string][] = [
		[
			new JournalShardUnavailableError({ code: "shard-missing", shardId: 1, shardPath: shard, runId: "r" }),
			`Journal shard unavailable: ${shard} for run r (shard-missing).`,
			"Restore the file; if it is an adopted journal that moved, adopt it again at its new path with `atomic storage adopt <path>`.",
		],
		[
			new JournalShardUnavailableError({
				code: "shard-open-failed",
				shardId: 1,
				shardPath: shard,
				cause: new Error("file is not a database"),
			}),
			`Journal shard unavailable: ${shard} (file is not a database) (shard-open-failed).`,
			"Check the file's permissions and the disk's free space, then retry.",
		],
		[
			new JournalAdoptError({ code: "path-not-found", path: "/old/journal.sqlite" }),
			"Cannot adopt journal: /old/journal.sqlite does not exist (path-not-found).",
			"Pass the path of a journal .sqlite file, or of the directory holding its journal.sqlite.",
		],
		[
			new JournalAdoptError({ code: "not-a-journal", path: "/x.sqlite", reason: "not-sqlite" }),
			"Cannot adopt journal: /x.sqlite is not a workflow journal (not-sqlite) (not-a-journal).",
			"Pass a SQLite file that Atomic wrote workflow runs to, such as a journal.sqlite selected with ATOMIC_WORKFLOW_JOURNAL_PATH.",
		],
		[
			new JournalAdoptError({ code: "not-a-journal", path: "/x.sqlite" }),
			"Cannot adopt journal: /x.sqlite is not a workflow journal (no-journal-tables) (not-a-journal).",
			"Pass a SQLite file that Atomic wrote workflow runs to, such as a journal.sqlite selected with ATOMIC_WORKFLOW_JOURNAL_PATH.",
		],
		[
			new JournalAdoptError({ code: "not-a-journal", path: "/s/catalog.sqlite", reason: "store-catalog" }),
			"Cannot adopt journal: /s/catalog.sqlite is not a workflow journal (store-catalog) (not-a-journal).",
			"The journal store's own catalog is never adopted; pass the path of a legacy journal file.",
		],
		[
			new JournalAdoptError({ code: "schema-version", path: "/x.sqlite", found: 2, supported: 1 }),
			"Cannot adopt journal: /x.sqlite has schema version 2, this Atomic supports 1 (schema-version).",
			"Adopt it with the Atomic version that wrote it, or upgrade Atomic.",
		],
		[
			new JournalAdoptError({ code: "run-conflict", path: "/b.sqlite", runId: "r", existingPath: "/a.sqlite" }),
			"Cannot adopt journal: /b.sqlite holds run r, which the store already has in /a.sqlite (run-conflict).",
			"Adopt only one copy of a journal; nothing was registered.",
		],
		[
			new JournalAdoptError({ code: "run-conflict", path: "/b.sqlite" }),
			"Cannot adopt journal: /b.sqlite holds run unknown, which the store already has in another journal (run-conflict).",
			"Adopt only one copy of a journal; nothing was registered.",
		],
	];
	for (const [error, message, hint] of cases) {
		assert.equal(error.message, message);
		assert.equal(error.hint, hint);
	}
});

test("a cause becomes a short detail: its first line, its nested cause, at most 200 characters (#4325)", () => {
	const detailOf = (cause: Error | string | undefined) =>
		new JournalShardUnavailableError({
			code: "shard-open-failed",
			shardId: 1,
			shardPath: "/s",
			cause: cause as Error,
		}).fields.detail;
	assert.equal(detailOf(new Error("outer", { cause: new Error("inner") })), "outer: inner");
	assert.equal(detailOf(new Error("outer: inner", { cause: new Error("inner") })), "outer: inner");
	assert.equal(detailOf(new Error("first line\nsecond line")), "first line");
	assert.equal(detailOf(new Error("  padded  ")), "padded");
	assert.equal(detailOf(new Error("")), undefined);
	assert.equal(detailOf(new Error("   ")), undefined);
	assert.equal(detailOf("not an error"), undefined);
	assert.equal(detailOf(undefined), undefined);
	assert.equal(detailOf(new Error("x".repeat(200))), "x".repeat(200));
	assert.equal(detailOf(new Error("x".repeat(201))), `${"x".repeat(199)}…`);
	const error = new JournalShardUnavailableError({ code: "shard-missing", shardId: 1, shardPath: "/s" });
	assert.equal("cause" in error, false, "an error without a cause carries none");
	assert.deepEqual(error.fields, { shardId: 1, shardPath: "/s" });
	assert.equal(error.runId, undefined);
	assert.ok(Object.isFrozen(error.fields));
});

test("retryable is explicit: only a busy lock is worth retrying, and never a missing file or an adoption (#4325)", () => {
	assert.equal(new JournalCatalogError({ code: "write-failed", catalogPath, cause: busy() }).retryable, true);
	assert.equal(
		new JournalCatalogError({ code: "write-failed", catalogPath, cause: new Error("disk full") }).retryable,
		false,
	);
	assert.equal(
		new JournalCatalogError({ code: "write-failed", catalogPath, cause: busy(), retryable: false }).retryable,
		false,
	);
	assert.equal(
		new JournalShardUnavailableError({ code: "shard-open-failed", shardId: 1, shardPath: "/s", cause: busy() })
			.retryable,
		true,
	);
	assert.equal(
		new JournalShardUnavailableError({ code: "shard-missing", shardId: 1, shardPath: "/s", cause: busy() }).retryable,
		false,
	);
	assert.equal(
		new JournalShardUnavailableError({ code: "shard-missing", shardId: 1, shardPath: "/s", retryable: true })
			.retryable,
		true,
	);
	assert.equal(new JournalAdoptError({ code: "path-not-found", path: "/x", cause: busy() }).retryable, false);
});

test("the family base keeps a given name and defaults to JournalStoreError; guards reject what is not a store error (#4325)", () => {
	const base = new JournalStoreError({ code: "c", message: "m", fields: {}, retryable: false });
	assert.deepEqual([base.name, base.hint, "cause" in base], ["JournalStoreError", undefined, false]);
	const named = new JournalStoreError({
		name: "OtherJournalError",
		code: "c",
		message: "m",
		hint: "h",
		fields: { a: 1 },
		retryable: true,
	});
	assert.deepEqual(
		[named.name, named.hint, named.fields, named.retryable],
		["OtherJournalError", "h", { a: 1 }, true],
	);
	for (const value of [
		undefined,
		null,
		"JournalCatalogError",
		5,
		{},
		{ name: "x", code: "c", retryable: false },
		{ name: "x", code: "c", fields: {} },
		{ name: 1, code: "c", fields: {}, retryable: true },
		{ name: "x", code: 1, fields: {}, retryable: true },
		{ name: "x", code: "c", fields: null, retryable: true },
	])
		assert.equal(isJournalStoreError(value), false, JSON.stringify(value));
	assert.ok(isJournalStoreError({ name: "x", code: "c", fields: {}, retryable: false }));
	for (const guard of [isJournalCatalogError, isJournalShardUnavailableError, isJournalAdoptError]) {
		assert.equal(guard(null), false);
		assert.equal(guard("text"), false);
		assert.equal(guard({ name: "JournalCatalogError", code: 7 }), false);
	}
});

test("serialization bounds the cause chain, keeps string codes, and stringifies a cause that is not an error (#4325)", () => {
	let cause: Error = new Error("depth 0");
	for (let depth = 1; depth < 12; depth++) cause = new Error(`depth ${depth}`, { cause });
	const deep = serializeJournalStoreError(
		new JournalCatalogError({ code: "write-failed", catalogPath, cause: Object.assign(cause, { code: 42 }) }),
	);
	let links = 0;
	for (let link = deep.cause; link !== undefined; link = link.cause) links++;
	assert.equal(links, 8);
	assert.equal(deep.cause?.code, undefined, "a numeric code is not a string code");
	const coded = serializeJournalStoreError(
		new JournalCatalogError({
			code: "write-failed",
			catalogPath,
			cause: Object.assign(new Error("e"), { code: "ENOSPC" }),
		}),
	);
	assert.deepEqual(coded.cause, { name: "Error", message: "e", code: "ENOSPC" });
	const textual = serializeJournalStoreError(
		new JournalStoreError({
			code: "c",
			message: "m",
			fields: {},
			retryable: false,
			cause: "plain text" as unknown as Error,
		}),
	);
	assert.deepEqual(textual.cause, { name: "Error", message: "plain text" });
	assert.equal(
		"hint" in
			serializeJournalStoreError(new JournalStoreError({ code: "c", message: "m", fields: {}, retryable: false })),
		false,
	);
	const back = rehydrateJournalStoreError({ ...coded, message: "changed by the sender" });
	assert.equal(back.message, "changed by the sender", "the sender's text is kept exactly");
	assert.equal((back.cause as { code?: string }).code, "ENOSPC");
});
