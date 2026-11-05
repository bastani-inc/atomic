import assert from "node:assert/strict";
import {
	findJournalStoreError,
	isJournalAdoptError,
	isJournalCatalogError,
	isJournalShardUnavailableError,
	isJournalStoreError,
	isRetryableJournalStoreError,
	isRetryableStorageError,
	isStorageError,
	JournalAdoptError,
	JournalCatalogError,
	JournalShardUnavailableError,
	JournalStoreError,
	rehydrateJournalStoreError,
	type SqliteValue,
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
			`Move ${catalogPath} aside, then adopt every shard file in its directory again with \`atomic storage adopt /home/u/.atomic/workflows/journal/shard-*.sqlite\` to rebuild it.`,
		],
		[
			new JournalCatalogError({ code: "corrupt", catalogPath }),
			`Journal catalog is inconsistent: ${catalogPath} (unknown rule) (corrupt).`,
			`Move ${catalogPath} aside, then adopt every shard file in its directory again with \`atomic storage adopt /home/u/.atomic/workflows/journal/shard-*.sqlite\` to rebuild it.`,
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
			"Restore the file at this path: the catalog keeps its runs registered there.",
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
		assert.equal(guard(undefined), false);
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

test("rehydration keeps what was sent and drops fields of the wrong type (#4325)", () => {
	const base = new JournalStoreError({ code: "c", message: "m", hint: "kept hint", fields: {}, retryable: false });
	const sent = serializeJournalStoreError(base);
	assert.equal("cause" in sent, false);
	assert.equal(rehydrateJournalStoreError(sent).hint, "kept hint");
	const typed = rehydrateJournalStoreError({
		name: "JournalCatalogError",
		code: "run-not-found",
		message: "sent text",
		retryable: false,
		fields: { catalogPath: 5, runId: 7, shardId: "two", selection: 3, localOnly: "yes", found: true, supported: "1" },
	});
	assert.ok(typed instanceof JournalCatalogError);
	assert.deepEqual(
		[
			typed.catalogPath,
			typed.runId,
			typed.fields.shardId,
			typed.fields.selection,
			typed.fields.localOnly,
			typed.fields.found,
			typed.fields.supported,
		],
		["", undefined, undefined, undefined, undefined, undefined, undefined],
	);
	assert.equal(typed.message, "sent text");
	const shard = rehydrateJournalStoreError({
		name: "JournalShardUnavailableError",
		code: "shard-missing",
		message: "x",
		retryable: false,
		fields: {},
	});
	assert.ok(shard instanceof JournalShardUnavailableError);
	assert.deepEqual([shard.shardId, shard.shardPath], [-1, ""]);
	const adopt = rehydrateJournalStoreError({
		name: "JournalAdoptError",
		code: "path-not-found",
		message: "x",
		retryable: false,
		fields: {},
	});
	assert.ok(adopt instanceof JournalAdoptError);
	assert.equal(adopt.path, "");
	const plain = rehydrateJournalStoreError(
		serializeJournalStoreError(
			new JournalAdoptError({ code: "not-a-journal", path: "/x", cause: new Error("no table") }),
		),
	);
	assert.equal(plain.fields.detail, "no table", "an adoption error keeps its cause's detail");
	const cause = plain.cause as Error;
	assert.deepEqual(["cause" in cause, "code" in cause], [false, false]);
	const coded = rehydrateJournalStoreError(
		serializeJournalStoreError(
			new JournalAdoptError({
				code: "not-a-journal",
				path: "/x",
				cause: Object.assign(new Error("e"), { code: "EACCES" }),
			}),
		),
	);
	assert.ok(Object.keys(coded.cause as object).includes("code"), "a cause's code is enumerable, as Node's are");
	assert.equal((coded.cause as { code?: string }).code, "EACCES");
});

test("the guards match plain objects of every class by name and code, and only store errors count as retryable (#4325)", () => {
	assert.ok(isJournalCatalogError({ name: "JournalCatalogError", code: "write-failed" }));
	assert.ok(isJournalShardUnavailableError({ name: "JournalShardUnavailableError", code: "shard-missing" }));
	assert.equal(isJournalShardUnavailableError({ name: "JournalCatalogError", code: "shard-missing" }), false);
	assert.equal(isRetryableJournalStoreError(new Error("plain")), false);
	assert.equal(
		isRetryableJournalStoreError({ name: "WorkflowInfrastructureError", code: "worker_lost", retryable: true }),
		false,
	);
	assert.equal(
		isRetryableJournalStoreError(new Error("outer", { cause: { name: "Other", code: "x", retryable: true } })),
		false,
	);
});

test("a cause chain is walked through errors only, and a non-retryable store error does not end the search for a retryable one (#4325)", () => {
	const adoption = new JournalAdoptError({ code: "path-not-found", path: "/x" });
	assert.equal(isRetryableJournalStoreError(adoption), false);
	assert.equal(isRetryableJournalStoreError(new Error("outer", { cause: adoption })), false);
	const busyCatalog = new JournalCatalogError({ code: "write-failed", catalogPath, cause: busy() });
	assert.equal(
		isRetryableJournalStoreError(
			new JournalShardUnavailableError({ code: "shard-missing", shardId: 1, shardPath: "/s", cause: busyCatalog }),
		),
		true,
	);
	assert.equal(findJournalStoreError(new Error("plain")), undefined);
	assert.equal(findJournalStoreError("text"), undefined);
	assert.equal(findJournalStoreError(new Error("outer", { cause: "text" })), undefined);
	assert.equal(findJournalStoreError(new Error("outer", { cause: adoption })), adoption);
	const ended = serializeJournalStoreError(
		new JournalCatalogError({ code: "write-failed", catalogPath, cause: new Error("e", { cause: null }) }),
	);
	assert.deepEqual(ended.cause, { name: "Error", message: "e" }, "a null cause ends the chain");
});

test("a schema version is recorded JSON-safe: numbers and null as they are, other SQLite values as text (#4325)", () => {
	const recorded = (found: SqliteValue | undefined) => {
		const catalog = new JournalCatalogError({ code: "schema-version", catalogPath, found, supported: 1 });
		const adoption = new JournalAdoptError({ code: "schema-version", path: "/j", found, supported: 1 });
		assert.deepEqual(adoption.fields.found, catalog.fields.found);
		return [catalog.fields.found, "found" in catalog.fields];
	};
	assert.deepEqual(recorded(7), [7, true]);
	assert.deepEqual(recorded("v7"), ["v7", true]);
	assert.deepEqual(recorded(null), [null, true]);
	assert.deepEqual(recorded(7n), ["7", true]);
	assert.deepEqual(recorded(new Uint8Array([1, 2])), ["1,2", true]);
	assert.deepEqual(recorded(undefined), [undefined, false]);
});

test("run-moved is retryable, renders its fields and crosses a process boundary intact (UX contract, #4325)", () => {
	const error = new JournalCatalogError({
		code: "run-moved",
		catalogPath,
		runId: "r1",
		shardId: 2,
		shardPath: "/s/shard-0002.sqlite",
		lastSeq: 256,
	});
	assert.deepEqual([error.retryable, error.runId, error.fields.lastSeq], [true, "r1", 256]);
	assert.equal(
		error.message,
		"Journal run moved while it was read: run r1 left /s/shard-0002.sqlite after sequence 256 and its new shard did not continue the history (run-moved).",
	);
	assert.equal(error.hint, "A consolidation moved this run while it was read; read it again.");
	const back = rehydrateJournalStoreError(serializeJournalStoreError(error));
	assert.ok(isJournalCatalogError(back) && back.code === "run-moved");
	assert.deepEqual([back.retryable, back.fields], [true, error.fields]);
	assert.ok(isRetryableJournalStoreError(new Error("outer", { cause: error })));
});

test("run-moved names its run and shard by their ids when it has no run ID or path (#4325)", () => {
	assert.equal(
		new JournalCatalogError({ code: "run-moved", catalogPath, shardId: 2, lastSeq: 5 }).message,
		"Journal run moved while it was read: run unknown left shard 2 after sequence 5 and its new shard did not continue the history (run-moved).",
	);
});

test("a retryable journal store error makes a storage failure retryable, a permanent one does not (#4325)", () => {
	const retryable = new JournalCatalogError({ code: "run-moved", catalogPath, runId: "r1", shardId: 2 });
	const permanent = new JournalCatalogError({ code: "corrupt", catalogPath });
	assert.equal(isRetryableStorageError(retryable), true);
	assert.equal(isRetryableStorageError(new Error("outer", { cause: retryable })), true);
	assert.equal(isRetryableStorageError(permanent), false);
	assert.equal(isRetryableStorageError(new Error("plain")), false);
	assert.equal(isStorageError(permanent), true);
	assert.equal(isStorageError({ name: "JournalCatalogError", code: "corrupt", fields: {}, retryable: false }), true);
});
