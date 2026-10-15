import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { getAgentDir } from "@bastani/atomic";
import { test, vi } from "vitest";
import { JournalDatabase } from "../../packages/workflows/src/durable/journal/node-sqlite.js";
import {
	SqliteRunJournal,
	workflowJournalPath,
} from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	JOURNAL_COLUMNS as c,
	RUN_EVENT_TYPES as e,
	JOURNAL_LEASE,
	JOURNAL_PAYLOAD_ENCODING,
	JOURNAL_SCHEMA_VERSION,
	JournalCasConflictError,
	JournalCounterRangeError,
	type JournalEntry,
	JournalError,
	JournalInvalidTextError,
	JournalMetaCorruptError,
	JournalSchemaVersionError,
	type Lease,
	type RunEvent,
	RunNotFoundError,
	StaleLeaseError,
	StorageUnavailableError,
	JOURNAL_TABLES as t,
} from "../../packages/workflows/src/durable/journal/types.js";
import { makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

const header = { runId: "run", name: "workflow", cwd: " /raw/../cwd ", createdAt: 0, status: "running" };
const illFormedExamples = ["\ud800", "\udfff", "a\ud800b"] as const;

async function withJournal(body: (journal: SqliteRunJournal) => Promise<void>): Promise<void> {
	const directory = makeTempDirectory("journal-unit-");
	const journal = new SqliteRunJournal(join(directory, "nested", "journal.sqlite"));
	try {
		await body(journal);
	} finally {
		await journal.close();
		removeTempDirectory(directory);
	}
}

async function acquire(journal: SqliteRunJournal, runId = header.runId, holderId = "holder"): Promise<Lease> {
	const outcome = await journal.acquire(runId, holderId);
	assert.equal(outcome.status, "acquired");
	if (outcome.status !== "acquired") assert.fail("lease not acquired");
	return outcome.lease;
}

async function read(journal: SqliteRunJournal, runId = header.runId, fromSeq?: number): Promise<JournalEntry[]> {
	const entries: JournalEntry[] = [];
	for await (const entry of journal.read(runId, fromSeq)) entries.push(entry);
	return entries;
}

test("append is durable when it resolves and readable through a fresh connection", async () => {
	await withJournal(async (journal) => {
		assert.equal(await journal.createRun(header), "created");
		const lease = await acquire(journal);
		const event = { type: e.runStarted, payload: { text: "  raw\ntext  ", values: [2, 1, 2] } } as const;
		const appended = await journal.append(lease, event);
		const reader = new SqliteRunJournal(journal.path);
		try {
			assert.deepEqual(await read(reader), [appended.entry]);
			assert.deepEqual(appended.entry.event, event);
			assert.equal(appended.entry.seq, 1);
			assert.equal("key" in appended.entry, false);
		} finally {
			await reader.close();
		}
	});
});

test("createRun rejects a NUL runId with typed fields before writing", async () => {
	await withJournal(async (journal) => {
		const db = new JournalDatabase(journal.path);
		try {
			const before = snapshot(db);
			await assert.rejects(
				() => journal.createRun({ ...header, runId: "prefix\u0000suffix" }),
				(error: Error) => {
					assert.ok(error instanceof JournalInvalidTextError);
					assert.equal(error.field, "runId");
					assert.equal(error.reason, "nul-character");
					return true;
				},
			);
			assert.deepEqual(snapshot(db), before);
		} finally {
			db.close();
		}
	});
});

type MetaSeed = number | bigint | string;
const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

function seedMeta(path: string, versions: readonly MetaSeed[]): void {
	const raw = new DatabaseSync(path);
	try {
		raw.exec(`CREATE TABLE ${t.meta}(${c.schemaVersion} INTEGER NOT NULL)`);
		const insert = raw.prepare(`INSERT INTO ${t.meta} VALUES (?)`);
		for (const version of versions) insert.run(version);
	} finally {
		raw.close();
	}
}

type SqliteRows = Record<string, SQLOutputValue>[];

function rawSnapshot(path: string): { schema: SqliteRows; meta: SqliteRows } {
	const raw = new DatabaseSync(path);
	try {
		const schema = raw.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
		const meta = raw.prepare(`SELECT * FROM ${t.meta} ORDER BY rowid`);
		meta.setReadBigInts(true);
		return { schema, meta: meta.all() };
	} finally {
		raw.close();
	}
}

test.each([
	{ versions: [1, 1] },
	{ versions: [1, 2] },
	{ versions: [1, 1, 1] },
	{ versions: [1, INT64_MAX] },
	{ versions: [INT64_MAX, 1] },
	{ versions: [INT64_MAX, INT64_MIN, 1] },
	{ versions: [1, "x"] },
	{ versions: [1, 2.5] },
	{ versions: [2, "x"] },
] satisfies { versions: MetaSeed[] }[])(
	"meta %s rejects before decoding or creating other tables",
	async ({ versions }) => {
		const directory = makeTempDirectory("journal-meta-corrupt-");
		const path = join(directory, "journal.sqlite");
		let opened: SqliteRunJournal | undefined;
		try {
			seedMeta(path, versions);
			const before = rawSnapshot(path);
			assert.throws(
				() => {
					opened = new SqliteRunJournal(path);
				},
				(error: Error) => {
					assert.equal(error.constructor, JournalMetaCorruptError);
					assert.ok(error instanceof JournalMetaCorruptError);
					assert.ok(error instanceof JournalError);
					assert.equal(error.path, path);
					assert.equal(error.rowCount, versions.length);
					return true;
				},
			);
			assert.deepEqual(rawSnapshot(path), before);
		} finally {
			await opened?.close();
			removeTempDirectory(directory);
		}
	},
);

test.each([
	{ version: INT64_MAX, found: INT64_MAX },
	{ version: INT64_MIN, found: INT64_MIN },
	{ version: "x", found: "x" },
	{ version: 2.5, found: 2.5 },
] satisfies { version: MetaSeed; found: MetaSeed }[])(
	"single meta row $version is an unsupported schema version, not a storage failure",
	async ({ version, found }) => {
		const directory = makeTempDirectory("journal-meta-single-");
		const path = join(directory, "journal.sqlite");
		let opened: SqliteRunJournal | undefined;
		try {
			seedMeta(path, [version]);
			const before = rawSnapshot(path);
			assert.throws(
				() => {
					opened = new SqliteRunJournal(path);
				},
				(error: Error) => {
					assert.equal(error.constructor, JournalSchemaVersionError);
					assert.ok(error instanceof JournalSchemaVersionError);
					assert.equal(error.found, found);
					assert.equal(error.supported, 1);
					return true;
				},
			);
			assert.deepEqual(rawSnapshot(path), before);
		} finally {
			await opened?.close();
			removeTempDirectory(directory);
		}
	},
);

test("empty meta initializes once and a single current version reopens without metadata changes", async () => {
	const directory = makeTempDirectory("journal-meta-empty-");
	const path = join(directory, "journal.sqlite");
	const db = new JournalDatabase(path);
	try {
		db.exec(`CREATE TABLE ${t.meta}(${c.schemaVersion} INTEGER NOT NULL)`);
		for (let attempt = 0; attempt < 2; attempt++) {
			const journal = new SqliteRunJournal(path);
			await journal.close();
			assert.deepEqual(
				db.all<{ [c.schemaVersion]: number }>(`SELECT * FROM ${t.meta}`).map((row) => row[c.schemaVersion]),
				[JOURNAL_SCHEMA_VERSION],
			);
		}
	} finally {
		db.close();
		removeTempDirectory(directory);
	}
});

test("corrupt meta rejects without changing existing runs, events or leases", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		const lease = await acquire(journal);
		await journal.append(lease, { type: e.summaryRecorded, payload: "retained" });
		await journal.close();
		const db = new JournalDatabase(journal.path);
		try {
			db.run(`INSERT INTO ${t.meta} VALUES (?)`, JOURNAL_SCHEMA_VERSION);
			const before = snapshot(db);
			assert.throws(
				() => new SqliteRunJournal(journal.path),
				(error: Error) => {
					assert.equal(error.constructor, JournalMetaCorruptError);
					assert.ok(error instanceof JournalMetaCorruptError);
					assert.equal(error.path, journal.path);
					assert.equal(error.rowCount, 2);
					return true;
				},
			);
			assert.deepEqual(snapshot(db), before);
		} finally {
			db.close();
		}
	});
});

test("createRun rejects ill-formed runId before SQL", async () => {
	await withJournal(async (journal) => {
		const db = new JournalDatabase(journal.path);
		try {
			const before = snapshot(db);
			await assert.rejects(
				() => journal.createRun({ ...header, runId: "\ud800" }),
				(error: Error) => {
					assert.equal(error.constructor, JournalInvalidTextError);
					assert.ok(error instanceof JournalInvalidTextError);
					assert.ok(error instanceof JournalError);
					assert.equal(error.field, "runId");
					assert.equal(error.reason, "ill-formed-unicode");
					return true;
				},
			);
			assert.deepEqual(snapshot(db), before);
		} finally {
			db.close();
		}
	});
});

const invalidTextCases: readonly {
	name: string;
	field: JournalInvalidTextError["field"];
	call: (journal: SqliteRunJournal, lease: Lease, text: string) => Promise<void>;
}[] = [
	{
		name: "createRun.runId",
		field: "runId",
		call: async (journal, _lease, text) => {
			await journal.createRun({ ...header, runId: text });
		},
	},
	{
		name: "createRun.name",
		field: "name",
		call: async (journal, lease, text) => {
			await journal.createRun({ ...header, runId: lease.runId, name: text });
		},
	},
	{
		name: "createRun.cwd",
		field: "cwd",
		call: async (journal, lease, text) => {
			await journal.createRun({ ...header, runId: lease.runId, cwd: text });
		},
	},
	{
		name: "createRun.status",
		field: "status",
		call: async (journal, lease, text) => {
			await journal.createRun({ ...header, runId: lease.runId, status: text });
		},
	},
	{
		name: "listRuns.cwd",
		field: "cwd",
		call: async (journal, _lease, text) => {
			await journal.listRuns({ cwd: text });
		},
	},
	{
		name: "acquire.runId",
		field: "runId",
		call: async (journal, lease, text) => {
			await journal.acquire(text, lease.holderId);
		},
	},
	{
		name: "acquire.holderId",
		field: "holderId",
		call: async (journal, lease, text) => {
			await journal.acquire(lease.runId, text);
		},
	},
	{
		name: "takeover.runId",
		field: "runId",
		call: async (journal, lease, text) => {
			await journal.takeover(text, "next", lease.holderId);
		},
	},
	{
		name: "takeover.holderId",
		field: "holderId",
		call: async (journal, lease, text) => {
			await journal.takeover(lease.runId, text, lease.holderId);
		},
	},
	{
		name: "takeover.expectedHolder",
		field: "expectedHolder",
		call: async (journal, lease, text) => {
			await journal.takeover(lease.runId, "next", text);
		},
	},
	{
		name: "renew.runId",
		field: "runId",
		call: async (journal, lease, text) => {
			await journal.renew({ ...lease, runId: text });
		},
	},
	{
		name: "renew.holderId",
		field: "holderId",
		call: async (journal, lease, text) => {
			await journal.renew({ ...lease, holderId: text });
		},
	},
	{
		name: "release.runId",
		field: "runId",
		call: async (journal, lease, text) => {
			await journal.release({ ...lease, runId: text });
		},
	},
	{
		name: "release.holderId",
		field: "holderId",
		call: async (journal, lease, text) => {
			await journal.release({ ...lease, holderId: text });
		},
	},
	{
		name: "append.runId",
		field: "runId",
		call: async (journal, lease, text) => {
			await journal.append({ ...lease, runId: text }, { type: e.runStarted, payload: null });
		},
	},
	{
		name: "append.holderId",
		field: "holderId",
		call: async (journal, lease, text) => {
			await journal.append({ ...lease, holderId: text }, { type: e.runStarted, payload: null });
		},
	},
	{
		name: "append.key",
		field: "key",
		call: async (journal, lease, text) => {
			await journal.append(lease, { type: e.runStarted, payload: null }, { key: text });
		},
	},
	{
		name: "append.status",
		field: "status",
		call: async (journal, lease, text) => {
			await journal.append(lease, { type: e.statusChanged, payload: { status: text } }, { key: "prefix" });
		},
	},
	{
		name: "read.runId",
		field: "runId",
		call: async (journal, _lease, text) => {
			await read(journal, text);
		},
	},
	{
		name: "readKey.runId",
		field: "runId",
		call: async (journal, _lease, text) => {
			await journal.readKey(text, "prefix");
		},
	},
	{
		name: "readKey.key",
		field: "key",
		call: async (journal, lease, text) => {
			await journal.readKey(lease.runId, text);
		},
	},
	{
		name: "deleteRun.runId",
		field: "runId",
		call: async (journal, _lease, text) => {
			await journal.deleteRun(text);
		},
	},
];

for (const scenario of invalidTextCases) {
	test(`${scenario.name} rejects NUL before SQL without changing prefix ownership or records`, async () => {
		await withJournal(async (journal) => {
			await journal.createRun({ ...header, runId: "prefix" });
			const lease = await acquire(journal, "prefix", "prefix");
			const appended = await journal.append(
				lease,
				{ type: e.summaryRecorded, payload: "original\u0000JSON" },
				{ key: "prefix" },
			);
			const db = new JournalDatabase(journal.path);
			const invalid = (error: Error): boolean => {
				assert.ok(error instanceof JournalInvalidTextError);
				assert.ok(error instanceof JournalError);
				assert.equal(error.constructor, JournalInvalidTextError);
				assert.equal(error.field, scenario.field);
				assert.equal(error.reason, "nul-character");
				return true;
			};
			try {
				const before = snapshot(db);
				for (const text of ["prefix\u0000suffix", "\u0000prefix", "prefix\u0000"]) {
					await assert.rejects(() => scenario.call(journal, lease, text), invalid);
					assert.deepEqual(snapshot(db), before);
					assert.deepEqual(await acquire(journal, "prefix", "prefix"), lease);
					assert.deepEqual(await read(journal, "prefix"), [appended.entry]);
				}
				await journal.close();
				await assert.rejects(() => scenario.call(journal, lease, "prefix\u0000suffix"), invalid);
			} finally {
				db.close();
			}
		});
	});
}

for (const scenario of invalidTextCases) {
	test.each([...illFormedExamples, "\ud800\u0000"])(
		`${scenario.name} rejects invalid Unicode %j before SQL, including on a closed journal`,
		async (text) => {
			await withJournal(async (journal) => {
				await journal.createRun({ ...header, runId: "prefix" });
				const lease = await acquire(journal, "prefix", "prefix");
				await journal.append(lease, { type: e.summaryRecorded, payload: "original" }, { key: "prefix" });
				const db = new JournalDatabase(journal.path);
				const invalid = (error: Error): boolean => {
					assert.equal(error.constructor, JournalInvalidTextError);
					assert.ok(error instanceof JournalInvalidTextError);
					assert.ok(error instanceof JournalError);
					assert.equal(error.field, scenario.field);
					assert.equal(error.reason, text.includes("\u0000") ? "nul-character" : "ill-formed-unicode");
					return true;
				};
				try {
					const before = snapshot(db);
					for (const state of ["open", "closed"]) {
						if (state === "closed") await journal.close();
						const calls = (
							["transaction", "exec", "get", "all", "getCounters", "allCounters", "run"] as const
						).map((method) => vi.spyOn(JournalDatabase.prototype, method));
						try {
							await assert.rejects(() => scenario.call(journal, lease, text), invalid);
							for (const call of calls) assert.equal(call.mock.calls.length, 0);
						} finally {
							for (const call of calls) call.mockRestore();
						}
						assert.deepEqual(snapshot(db), before);
					}
				} finally {
					db.close();
				}
			});
		},
	);
}

test.each(illFormedExamples)(
	"invalid holder %j never acquires a replacement-character holder's authority",
	async (text) => {
		await withJournal(async (journal) => {
			await journal.createRun(header);
			const db = new JournalDatabase(journal.path);
			try {
				const before = snapshot(db);
				await assert.rejects(
					() => journal.acquire(header.runId, text),
					(error: Error) => {
						assert.equal(error.constructor, JournalInvalidTextError);
						assert.ok(error instanceof JournalInvalidTextError);
						assert.equal(error.field, "holderId");
						assert.equal(error.reason, "ill-formed-unicode");
						return true;
					},
				);
				assert.deepEqual(snapshot(db), before);
				const replacement = await acquire(journal, header.runId, text.toWellFormed());
				assert.equal(replacement.epoch, 1);
				const event = { type: e.summaryRecorded, payload: "legitimate" } as const;
				assert.deepEqual((await journal.append(replacement, event)).entry.event, event);
				assert.deepEqual(await acquire(journal, header.runId, replacement.holderId), replacement);
			} finally {
				db.close();
			}
		});
	},
);

test("well-formed identifiers retain controls, noncharacters and distinct Unicode normalization forms", async () => {
	await withJournal(async (journal) => {
		const texts = ["", " \n\t ", "\ufffd", "\u0001\u001f", "é", "e\u0301", "\udbff\udfff", "\ufffe", "\uffff"];
		for (const text of texts) {
			const raw = { runId: text, name: text, cwd: text, status: text, createdAt: 0 };
			assert.equal(await journal.createRun(raw), "created");
			const lease = await acquire(journal, text, text);
			const entry = (
				await journal.append(lease, { type: e.statusChanged, payload: { status: text } }, { key: text })
			).entry;
			assert.equal(entry.key, text);
			assert.deepEqual(await journal.readKey(text, text), entry);
			assert.deepEqual(await journal.listRuns({ cwd: text }), [raw]);
		}
		assert.equal((await journal.listRuns()).length, texts.length);
	});
});

test.each([
	{ text: "\ud800", escaped: "\\ud800" },
	{ text: "\udfff", escaped: "\\udfff" },
	{ text: "a\ud800b", escaped: "a\\ud800b" },
	{ text: "a\udfffb", escaped: "a\\udfffb" },
	{ text: "\ud800\udc00", escaped: "\ud800\udc00" },
	{ text: "\udbff\udfff", escaped: "\udbff\udfff" },
	{ text: "\ud800\ud800\udc00\udfff", escaped: "\\ud800\ud800\udc00\\udfff" },
	{ text: "\udfff\ud800\udc00\ud800", escaped: "\\udfff\ud800\udc00\\ud800" },
	{ text: "\ud800\udc00\udbff\udfff", escaped: "\ud800\udc00\udbff\udfff" },
])("native rawJSON preserves $text through header/event JSON TEXT boundaries", async ({ text, escaped }) => {
	const nativeJson = JSON as typeof JSON & { rawJSON(text: string): Readonly<{ rawJSON: string }> };
	const raw = nativeJson.rawJSON(`"${text}"`);
	const payload = Object.freeze({ rawJSON: raw, [text]: Object.freeze([raw, { nested: raw }, "\u0000", raw]) });
	const expected = JSON.parse(JSON.stringify(payload));
	const storedRaw = `"${escaped}"`;
	const storedPayload = `{"rawJSON":${storedRaw},${JSON.stringify(text)}:[${storedRaw},{"nested":${storedRaw}},"\\u0000",${storedRaw}]}`;
	const rawHeader = { ...header, inputs: payload };
	await withJournal(async (journal) => {
		await journal.createRun(rawHeader);
		const lease = await acquire(journal);
		const scalar = await journal.append(lease, { type: e.summaryRecorded, payload: raw }, { key: "scalar" });
		const appended = await journal.append(lease, { type: e.summaryRecorded, payload }, { key: "nested" });
		assert.equal(scalar.entry.event.payload, JSON.parse(JSON.stringify(raw)));
		assert.deepEqual(appended.entry.event.payload, expected);
		const db = new JournalDatabase(journal.path);
		try {
			assert.deepEqual(
				db
					.all<{ json: string; storage: string }>(
						`SELECT ${c.payload} AS json, typeof(${c.payload}) AS storage FROM ${t.events} ORDER BY ${c.seq}`,
					)
					.map(({ json, storage }) => ({ json, storage })),
				[
					{ json: storedRaw, storage: "text" },
					{ json: storedPayload, storage: "text" },
				],
			);
			assert.equal(
				db.get<{ json: string }>(`SELECT ${c.headerJson} AS json FROM ${t.runs}`)?.json,
				`${JSON.stringify(header).slice(0, -1)},"inputs":${storedPayload}}`,
			);
		} finally {
			db.close();
		}
		for (const reopen of [false, true]) {
			if (reopen) await journal.close();
			const reader = new SqliteRunJournal(journal.path);
			try {
				assert.deepEqual(await reader.listRuns(), [{ ...header, inputs: expected }]);
				assert.deepEqual(await read(reader), [scalar.entry, appended.entry]);
				assert.deepEqual(await reader.readKey(header.runId, "nested"), appended.entry);
				assert.deepEqual(await reader.append(lease, { type: e.runFinished, payload: null }, { key: "nested" }), {
					status: "exists",
					entry: appended.entry,
				});
			} finally {
				await reader.close();
			}
		}
		assert.equal(raw.rawJSON, `"${text}"`);
		assert.equal(rawHeader.inputs, payload);
		assert.deepEqual(payload[text], [raw, { nested: raw }, "\u0000", raw]);
	});
});

test("JSON TEXT preserves native raw lexemes and invokes caller toJSON once per write", async () => {
	const nativeJson = JSON as typeof JSON & { rawJSON(text: string): Readonly<{ rawJSON: string }> };
	const values = [
		nativeJson.rawJSON("1.2300e+02"),
		nativeJson.rawJSON("-0"),
		nativeJson.rawJSON('"\\u0061"'),
		nativeJson.rawJSON('"\\uD800"'),
		nativeJson.rawJSON('"💡"'),
		nativeJson.rawJSON('"\udfff"'),
	];
	const payload = { values };
	let calls = 0;
	Object.defineProperty(payload, "toJSON", {
		value: () => {
			calls++;
			return { values };
		},
	});
	Object.freeze(values);
	Object.freeze(payload);
	const expected = JSON.parse(JSON.stringify(payload));
	calls = 0;
	await withJournal(async (journal) => {
		await journal.createRun({ ...header, inputs: payload });
		assert.equal(calls, 1);
		const lease = await acquire(journal);
		const appended = await journal.append(lease, { type: e.summaryRecorded, payload }, { key: "raw" });
		assert.equal(calls, 2);
		assert.deepEqual(appended.entry.event.payload, expected);
		const db = new JournalDatabase(journal.path);
		try {
			const stored = '{"values":[1.2300e+02,-0,"\\u0061","\\uD800","💡","\\udfff"]}';
			assert.equal(db.get<{ json: string }>(`SELECT ${c.payload} AS json FROM ${t.events}`)?.json, stored);
			assert.equal(
				db.get<{ json: string }>(`SELECT ${c.headerJson} AS json FROM ${t.runs}`)?.json,
				`${JSON.stringify(header).slice(0, -1)},"inputs":${stored}}`,
			);
		} finally {
			db.close();
		}
		await journal.close();
		const reader = new SqliteRunJournal(journal.path);
		try {
			assert.deepEqual(await reader.listRuns(), [{ ...header, inputs: expected }]);
			assert.deepEqual(await read(reader), [appended.entry]);
			assert.deepEqual(await reader.append(lease, { type: e.summaryRecorded, payload }, { key: "raw" }), {
				status: "exists",
				entry: appended.entry,
			});
			assert.equal(calls, 2);
		} finally {
			await reader.close();
		}
	});
});

test.each(["\u0000", ...illFormedExamples, "a\udfffb"])(
	"reopened header/event JSON preserves %j as values and property names",
	async (text) => {
		await withJournal(async (journal) => {
			await journal.createRun({ ...header, inputs: { [text]: [text, "JSON\u0000"] } });
			const lease = await acquire(journal);
			for (const payload of [text, { value: [text] }, { [text]: "valid\u0000" }]) {
				assert.equal(JSON.stringify(payload).isWellFormed(), true);
				const event = { type: e.summaryRecorded, payload } as const;
				const appended = await journal.append(lease, event);
				assert.deepEqual(appended.entry.event, event);
			}
			await journal.close();
			const reader = new SqliteRunJournal(journal.path);
			try {
				assert.deepEqual(await reader.listRuns(), [{ ...header, inputs: { [text]: [text, "JSON\u0000"] } }]);
				assert.deepEqual(
					(await read(reader)).map(({ event }) => event.payload),
					[text, { value: [text] }, { [text]: "valid\u0000" }],
				);
			} finally {
				await reader.close();
			}
		});
	},
);

test("JSON NUL strings and property names survive fresh/reopened read, list, readKey and replay", async () => {
	await withJournal(async (journal) => {
		const inputs = {
			"input\u0000key": ["\u0000", "middle\u0000suffix", "tail\u0000", "é💡"],
			status: "JSON\u0000status",
		};
		const raw = {
			...header,
			runId: " é💡 ",
			name: " workflow\n ",
			cwd: " ./raw/../é ",
			status: " arbitrary status ",
			inputs,
		};
		await journal.createRun(raw);
		const lease = await acquire(journal, raw.runId, "");
		const event = { type: e.summaryRecorded, payload: inputs } as const;
		const first = await journal.append(lease, event, { key: "" });
		assert.deepEqual(first.entry.event, event);
		const changedEvent = { type: e.statusChanged, payload: { status: " é paused ", detail: inputs } } as const;
		const changed = await journal.append(lease, changedEvent);
		assert.deepEqual(changed.entry.event, changedEvent);
		assert.equal("key" in changed.entry, false);
		for (const connection of ["fresh", "reopened"]) {
			if (connection === "reopened") await journal.close();
			const reader = new SqliteRunJournal(journal.path);
			try {
				assert.deepEqual(await reader.listRuns({ cwd: raw.cwd }), [
					{ ...raw, status: changedEvent.payload.status },
				]);
				assert.deepEqual(await reader.listRuns(), [{ ...raw, status: changedEvent.payload.status }]);
				assert.deepEqual(await read(reader, raw.runId), [first.entry, changed.entry]);
				assert.deepEqual(await reader.readKey(raw.runId, ""), first.entry);
				assert.deepEqual(
					await reader.append(lease, { type: e.runFinished, payload: "replacement\u0000JSON" }, { key: "" }),
					{ status: "exists", entry: first.entry },
				);
				assert.deepEqual(await read(reader, raw.runId), [first.entry, changed.entry]);
			} finally {
				await reader.close();
			}
		}
	});
});

test("key replay returns the first entry, permits empty keys and keeps dense per-run ordering", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		const lease = await acquire(journal);
		const first = await journal.append(lease, { type: e.summaryRecorded, payload: "first" }, { key: "" });
		const duplicate = await journal.append(lease, { type: e.summaryRecorded, payload: "replacement" }, { key: "" });
		assert.equal(duplicate.status, "exists");
		assert.deepEqual(duplicate.entry, first.entry);
		assert.deepEqual(await journal.readKey(header.runId, ""), first.entry);
		assert.equal(await journal.readKey(header.runId, "absent"), undefined);
		await journal.append(lease, { type: e.timerScheduled, payload: 0 });
		await journal.append(lease, { type: e.timerScheduled, payload: 0 });
		assert.deepEqual(
			(await read(journal)).map((entry) => entry.seq),
			[1, 2, 3],
		);
		assert.deepEqual(
			(await read(journal, header.runId, 2)).map((entry) => entry.seq),
			[2, 3],
		);
		await journal.createRun({ ...header, runId: "other" });
		const other = await journal.append(
			await acquire(journal, "other"),
			{ type: e.runStarted, payload: null },
			{ key: "" },
		);
		assert.equal(other.entry.seq, 1);
	});
});

test("lease transitions fence stale appends, renewals and releases while retaining monotonic epochs", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		const first = await acquire(journal);
		assert.equal(first.epoch, JOURNAL_LEASE.initialEpoch);
		assert.deepEqual(await acquire(journal), first);
		assert.deepEqual(await journal.acquire(header.runId, "second"), {
			status: "held",
			holderId: first.holderId,
			epoch: first.epoch,
		});
		assert.deepEqual(await journal.takeover(header.runId, "second", "wrong"), {
			status: "held",
			holderId: first.holderId,
			epoch: first.epoch,
		});
		await journal.renew(first);
		const outcome = await journal.takeover(header.runId, "second", first.holderId);
		assert.equal(outcome.status, "acquired");
		if (outcome.status !== "acquired") assert.fail("lease not acquired");
		assert.equal(outcome.lease.epoch, first.epoch + 1);
		for (const operation of [
			() => journal.append(first, { type: e.runStarted, payload: null }),
			() => journal.renew(first),
			() => journal.release(first),
		]) {
			await assert.rejects(operation, (error: Error) => {
				assert.ok(error instanceof StaleLeaseError);
				assert.equal(error.runId, header.runId);
				assert.equal(error.heldEpoch, first.epoch);
				assert.equal(error.currentEpoch, outcome.lease.epoch);
				return true;
			});
		}
		assert.deepEqual(await read(journal), []);
		await journal.release(outcome.lease);
		await assert.rejects(
			() => journal.append(outcome.lease, { type: e.runStarted, payload: null }),
			(error: Error) => {
				assert.equal(error.constructor, StaleLeaseError);
				assert.ok(error instanceof StaleLeaseError);
				assert.equal(error.runId, header.runId);
				assert.equal(error.heldEpoch, outcome.lease.epoch);
				assert.equal(error.currentEpoch, outcome.lease.epoch);
				return true;
			},
		);
		assert.deepEqual(await journal.takeover(header.runId, "third", "second"), {
			status: "held",
			holderId: null,
			epoch: outcome.lease.epoch,
		});
		assert.equal((await acquire(journal, header.runId, "second")).epoch, outcome.lease.epoch + 1);
	});
});

test("stale expectSeq writes nothing, including on a keyed duplicate", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		const lease = await acquire(journal);
		await journal.append(
			lease,
			{ type: e.statusChanged, payload: { status: "paused" } },
			{ expectSeq: 0, key: "status" },
		);
		for (const key of ["new", "status"]) {
			await assert.rejects(
				() =>
					journal.append(lease, { type: e.statusChanged, payload: { status: "failed" } }, { expectSeq: 0, key }),
				(error: Error) => {
					assert.ok(error instanceof JournalCasConflictError);
					assert.equal(error.runId, header.runId);
					assert.equal(error.expectedSeq, 0);
					assert.equal(error.actualSeq, 1);
					return true;
				},
			);
		}
		assert.equal((await read(journal)).length, 1);
		assert.equal((await journal.listRuns())[0]?.status, "paused");
		assert.equal(await journal.readKey(header.runId, "new"), undefined);
		assert.equal(
			(await journal.append(lease, { type: e.runFinished, payload: null }, { expectSeq: 1 })).entry.seq,
			2,
		);
	});
});

test("create/list/delete preserve headers and exact cwd filters and remove all run-owned records", async () => {
	await withJournal(async (journal) => {
		assert.equal(await journal.createRun(header), "created");
		assert.equal(await journal.createRun({ ...header, name: "replacement" }), "exists");
		await journal.createRun({ ...header, runId: "other", cwd: "" });
		const lease = await acquire(journal);
		await journal.append(lease, { type: e.runStarted, payload: null }, { key: "key" });
		assert.deepEqual(await journal.listRuns({ cwd: header.cwd }), [header]);
		assert.deepEqual(await journal.listRuns({ cwd: "/cwd" }), []);
		assert.deepEqual(
			(await journal.listRuns({ cwd: "" })).map((run) => run.runId),
			["other"],
		);
		assert.equal((await journal.listRuns()).length, 2);
		await journal.deleteRun(header.runId);
		await journal.deleteRun("missing");
		assert.deepEqual(await read(journal), []);
		assert.equal(await journal.readKey(header.runId, "key"), undefined);
		assert.equal((await journal.listRuns()).length, 1);
		await assert.rejects(
			() => journal.append(lease, { type: e.runStarted, payload: null }),
			(error: Error) => {
				assert.equal(error.constructor, StaleLeaseError);
				assert.ok(error instanceof StaleLeaseError);
				assert.equal(error.runId, header.runId);
				assert.equal(error.heldEpoch, lease.epoch);
				assert.equal(error.currentEpoch, lease.epoch);
				return true;
			},
		);
		for (const operation of [
			() => journal.acquire(header.runId, "holder"),
			() => journal.takeover(header.runId, "holder", "old"),
		]) {
			await assert.rejects(operation, (error: Error) => {
				assert.ok(error instanceof RunNotFoundError);
				assert.equal(error.runId, header.runId);
				return true;
			});
		}
	});
});

test("delete/recreate cycles durably fence every old handle without affecting other runs", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		await journal.createRun({ ...header, runId: "other" });
		const other = await acquire(journal, "other");
		const old: Lease[] = [];
		for (let cycle = 0; cycle < 3; cycle++) {
			old.push(await acquire(journal));
			await journal.deleteRun(header.runId);
			const reopened = new SqliteRunJournal(journal.path);
			try {
				assert.equal(await reopened.createRun(header), "created");
				const current = await acquire(reopened);
				assert.equal(current.epoch, cycle + 2);
				for (const stale of old) {
					for (const operation of [
						() => reopened.append(stale, { type: e.runStarted, payload: null }),
						() => reopened.renew(stale),
						() => reopened.release(stale),
					])
						await assert.rejects(operation, (error: Error) => {
							assert.ok(error instanceof StaleLeaseError);
							assert.equal(error.runId, header.runId);
							assert.equal(error.heldEpoch, stale.epoch);
							assert.equal(error.currentEpoch, current.epoch);
							return true;
						});
				}
				await reopened.renew(current);
				assert.equal((await reopened.append(current, { type: e.runStarted, payload: null })).entry.seq, 1);
				if (cycle === 2) await reopened.release(current);
			} finally {
				await reopened.close();
			}
		}
		assert.deepEqual(await acquire(journal, "other"), other);
		assert.equal((await journal.append(other, { type: e.runStarted, payload: null })).entry.seq, 1);
	});
});

test("schema v1 exports stable names and stores event payloads as JSON text with required SQLite pragmas", async () => {
	assert.equal(JOURNAL_SCHEMA_VERSION, 1);
	assert.equal(JOURNAL_PAYLOAD_ENCODING, "json-text");
	assert.deepEqual(Object.values(t), ["meta", "runs", "events", "leases"]);
	assert.deepEqual(Object.values(c), [
		"schema_version",
		"run_id",
		"name",
		"cwd",
		"created_at",
		"status",
		"header_json",
		"seq",
		"epoch",
		"key",
		"type",
		"payload",
		"at",
		"holder_id",
		"renewed_at",
	]);
	assert.deepEqual(Object.values(e), [
		"RunStarted",
		"RunFinished",
		"StatusChanged",
		"CheckpointRecorded",
		"PromptAsked",
		"PromptReleased",
		"ControlRequested",
		"MessageQueued",
		"MessageDelivered",
		"MessageSettled",
		"TimerScheduled",
		"SummaryRecorded",
	]);
	await withJournal(async (journal) => {
		await journal.createRun(header);
		const lease = await acquire(journal);
		const events: RunEvent[] = Object.values(e)
			.filter((type) => type !== e.checkpointRecorded && type !== e.statusChanged)
			.map((type) => ({ type, payload: "  verbatim\ntext " }));
		events.push({ type: e.statusChanged, payload: { status: "unusual status" } });
		for (const kind of ["tool", "ui", "stage", "task", "boundary"] as const)
			events.push({ type: e.checkpointRecorded, payload: { kind, values: [2, 1, 2], zero: 0, empty: "" } });
		for (const event of events) await journal.append(lease, event);
		assert.deepEqual(
			(await read(journal)).map((entry) => entry.event),
			events,
		);
		const db = new JournalDatabase(journal.path);
		try {
			for (const [pragma, value] of [
				["journal_mode", "wal"],
				["synchronous", 2],
				["busy_timeout", 5000],
				["foreign_keys", 1],
			] as const)
				assert.equal(Object.values(db.get<Record<string, string | number>>(`PRAGMA ${pragma}`) ?? {})[0], value);
			assert.equal(db.get<{ [c.schemaVersion]: number }>(`SELECT * FROM ${t.meta}`)?.[c.schemaVersion], 1);
			assert.equal(
				db.get<{ [c.payload]: string }>(`SELECT ${c.payload} FROM ${t.events} WHERE ${c.seq} = 1`)?.[c.payload],
				JSON.stringify(events[0]?.payload),
			);
			for (const [table, columns] of [
				[t.meta, [c.schemaVersion]],
				[t.runs, [c.runId, c.name, c.cwd, c.createdAt, c.status, c.headerJson]],
				[t.events, [c.runId, c.seq, c.epoch, c.key, c.type, c.payload, c.at]],
				[t.leases, [c.runId, c.holderId, c.epoch, c.renewedAt]],
			] as const)
				assert.deepEqual(
					db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name),
					columns,
				);
		} finally {
			db.close();
		}
	});
});

test("unknown schema versions fail with typed fields and are not migrated", async () => {
	await withJournal(async (journal) => {
		await journal.close();
		const db = new JournalDatabase(journal.path);
		try {
			for (const version of [0, 2, 999]) {
				db.run(`UPDATE ${t.meta} SET ${c.schemaVersion} = ?`, version);
				assert.throws(
					() => new SqliteRunJournal(journal.path),
					(error: Error) => {
						assert.ok(error instanceof JournalSchemaVersionError);
						assert.equal(error.found, version);
						assert.equal(error.supported, 1);
						return true;
					},
				);
				assert.equal(db.get<{ [c.schemaVersion]: number }>(`SELECT * FROM ${t.meta}`)?.[c.schemaVersion], version);
			}
		} finally {
			db.close();
		}
	});
});

test("storage failures and access after idempotent close retain typed path and cause", async () => {
	await withJournal(async (journal) => {
		await journal.close();
		await journal.close();
		await assert.rejects(
			() => journal.listRuns(),
			(error: Error) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal(error.path, journal.path);
				assert.ok(error.cause instanceof Error);
				return true;
			},
		);
		const invalid = join(dirname(journal.path), "file");
		writeTextSync(invalid, "not a directory");
		assert.throws(
			() => new SqliteRunJournal(join(invalid, "journal.sqlite")),
			(error: Error) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal(error.path, join(invalid, "journal.sqlite"));
				assert.ok(error.cause instanceof Error);
				return true;
			},
		);
	});
});

test("seq at MAX_SAFE_INTEGER rejects its successor before changing any rows", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		const lease = await acquire(journal);
		const db = new JournalDatabase(journal.path);
		try {
			db.run(
				`INSERT INTO ${t.events} VALUES (?, ?, ?, ?, ?, ?, ?)`,
				header.runId,
				Number.MAX_SAFE_INTEGER,
				1,
				"seed",
				e.summaryRecorded,
				"null",
				0,
			);
			const before = snapshot(db);
			await assert.rejects(
				() => journal.append(lease, { type: e.statusChanged, payload: { status: "failed" } }),
				(error: Error) => {
					assert.ok(error instanceof JournalCounterRangeError);
					assert.equal(error.runId, header.runId);
					assert.equal(error.field, "seq");
					assert.equal(error.value, Number.MAX_SAFE_INTEGER + 1);
					assert.equal(error.reason, "overflow");
					return true;
				},
			);
			assert.deepEqual(snapshot(db), before);
		} finally {
			db.close();
		}
	});
});

test.each(["takeover", "reacquire"] as const)(
	"epoch at MAX_SAFE_INTEGER rejects %s before changing any rows",
	async (operation) => {
		await withJournal(async (journal) => {
			await journal.createRun(header);
			await acquire(journal);
			const db = new JournalDatabase(journal.path);
			try {
				db.run(
					`UPDATE ${t.leases} SET ${c.epoch} = ?, ${c.holderId} = ?, ${c.renewedAt} = 0`,
					Number.MAX_SAFE_INTEGER,
					operation === "reacquire" ? null : "holder",
				);
				const before = snapshot(db);
				await assert.rejects(
					() =>
						operation === "takeover"
							? journal.takeover(header.runId, "next", "holder")
							: journal.acquire(header.runId, "next"),
					(error: Error) => {
						assert.ok(error instanceof JournalCounterRangeError);
						assert.equal(error.runId, header.runId);
						assert.equal(error.field, "epoch");
						assert.equal(error.value, Number.MAX_SAFE_INTEGER + 1);
						assert.equal(error.reason, "overflow");
						return true;
					},
				);
				assert.deepEqual(snapshot(db), before);
			} finally {
				db.close();
			}
		});
	},
);

test.each([-1, 1.5, 2 ** 53 + 2])(
	"out-of-range lease epoch %s rejects every lease access without writes",
	async (seed) => {
		await withJournal(async (journal) => {
			await journal.createRun(header);
			const lease = await acquire(journal);
			const db = new JournalDatabase(journal.path);
			try {
				db.run(`UPDATE ${t.leases} SET ${c.epoch} = ?, ${c.renewedAt} = 0`, seed);
				const before = snapshot(db);
				for (const operation of [
					() => journal.acquire(header.runId, "holder"),
					() => journal.acquire(header.runId, "other"),
					() => journal.takeover(header.runId, "next", "holder"),
					() => journal.takeover(header.runId, "next", "wrong"),
					() => journal.renew({ ...lease, epoch: seed }),
					() => journal.release({ ...lease, epoch: seed }),
					() =>
						journal.append({ ...lease, epoch: seed }, { type: e.statusChanged, payload: { status: "failed" } }),
					() => journal.deleteRun(header.runId),
				]) {
					await assert.rejects(operation, (error: Error) => {
						assert.ok(error instanceof JournalCounterRangeError);
						assert.equal(error.runId, header.runId);
						assert.equal(error.field, "epoch");
						assert.equal(error.value, seed);
						assert.equal(error.reason, seed < 0 ? "negative" : "unsafe-integer");
						return true;
					});
					assert.deepEqual(snapshot(db), before);
				}
			} finally {
				db.close();
			}
		});
	},
);

test.each([
	["seq", -1],
	["seq", 1.5],
	["seq", 2 ** 53 + 2],
	["epoch", -1],
	["epoch", 1.5],
	["epoch", 2 ** 53 + 2],
] as const)("out-of-range event %s %s rejects reads and keyed replay without writes", async (field, seed) => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		const lease = await acquire(journal);
		const db = new JournalDatabase(journal.path);
		try {
			db.run(
				`INSERT INTO ${t.events} VALUES (?, ?, ?, ?, ?, ?, ?)`,
				header.runId,
				field === "seq" ? seed : 1,
				field === "epoch" ? seed : 1,
				"seed",
				e.summaryRecorded,
				"null",
				0,
			);
			const before = snapshot(db);
			for (const operation of [
				() => read(journal, header.runId, field === "seq" ? Math.min(seed, 1) : 1),
				() => journal.readKey(header.runId, "seed"),
				() => journal.append(lease, { type: e.statusChanged, payload: { status: "failed" } }, { key: "seed" }),
				...(field === "seq"
					? [() => journal.append(lease, { type: e.statusChanged, payload: { status: "failed" } })]
					: []),
			]) {
				await assert.rejects(operation, (error: Error) => {
					assert.ok(error instanceof JournalCounterRangeError);
					assert.equal(error.runId, header.runId);
					assert.equal(error.field, field);
					assert.equal(error.value, seed);
					assert.equal(error.reason, seed < 0 ? "negative" : "unsafe-integer");
					return true;
				});
				assert.deepEqual(snapshot(db), before);
			}
		} finally {
			db.close();
		}
	});
});

test("safe integer boundary counters remain usable without an overflowing successor", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		await acquire(journal);
		const db = new JournalDatabase(journal.path);
		try {
			db.run(`UPDATE ${t.leases} SET ${c.epoch} = ?`, Number.MAX_SAFE_INTEGER - 1);
			db.run(
				`INSERT INTO ${t.events} VALUES (?, ?, ?, ?, ?, ?, ?)`,
				header.runId,
				Number.MAX_SAFE_INTEGER - 1,
				Number.MAX_SAFE_INTEGER - 1,
				"seed",
				e.summaryRecorded,
				"null",
				0,
			);
			const outcome = await journal.takeover(header.runId, "next", "holder");
			assert.equal(outcome.status, "acquired");
			if (outcome.status !== "acquired") assert.fail("lease not acquired");
			assert.equal(outcome.lease.epoch, Number.MAX_SAFE_INTEGER);
			assert.deepEqual(await acquire(journal, header.runId, "next"), outcome.lease);
			const appended = await journal.append(
				outcome.lease,
				{ type: e.summaryRecorded, payload: null },
				{ key: "max" },
			);
			assert.equal(appended.entry.seq, Number.MAX_SAFE_INTEGER);
			assert.equal(appended.entry.epoch, Number.MAX_SAFE_INTEGER);
			assert.deepEqual(
				(await read(journal)).map(({ seq }) => seq),
				[Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER],
			);
			assert.deepEqual(await journal.readKey(header.runId, "max"), appended.entry);
			assert.deepEqual(await journal.append(outcome.lease, { type: e.runStarted, payload: null }, { key: "max" }), {
				status: "exists",
				entry: appended.entry,
			});
			await journal.renew(outcome.lease);
			await journal.release(outcome.lease);
		} finally {
			db.close();
		}
	});
});

test("zero database counters are valid for reads, replay and lease operations", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		await acquire(journal);
		const db = new JournalDatabase(journal.path);
		try {
			db.run(`UPDATE ${t.leases} SET ${c.epoch} = 0`);
			db.run(
				`INSERT INTO ${t.events} VALUES (?, 0, 0, ?, ?, ?, 0)`,
				header.runId,
				"zero",
				e.summaryRecorded,
				"null",
			);
			const lease = await acquire(journal);
			assert.equal(lease.epoch, 0);
			await journal.renew(lease);
			const entries = await read(journal, header.runId, 0);
			assert.equal(entries[0]?.seq, 0);
			assert.equal(entries[0]?.epoch, 0);
			assert.deepEqual(await journal.readKey(header.runId, "zero"), entries[0]);
			assert.deepEqual(await journal.append(lease, { type: e.runStarted, payload: null }, { key: "zero" }), {
				status: "exists",
				entry: entries[0],
			});
			assert.equal((await journal.append(lease, { type: e.runStarted, payload: null })).entry.seq, 1);
			await journal.release(lease);
			assert.equal((await acquire(journal)).epoch, 1);
		} finally {
			db.close();
		}
	});
});

function snapshot(db: JournalDatabase): Record<string, string>[][] {
	return Object.values(t).map((table) => {
		const columns = db.all<{ name: string }>(`PRAGMA table_info(${table})`);
		return db.all<Record<string, string>>(
			`SELECT ${columns.map(({ name }) => `quote(${name}) AS ${name}`).join(", ")} FROM ${table} ORDER BY rowid`,
		);
	});
}

test("journal path defaults to the user workflow root and preserves an explicit environment override", () => {
	const previousPi = process.env.PI_WORKFLOW_JOURNAL_PATH;
	const previous = process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
	try {
		delete process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
		delete process.env.PI_WORKFLOW_JOURNAL_PATH;
		assert.equal(workflowJournalPath(), join(dirname(getAgentDir()), "workflows", "journal.sqlite"));
		process.env.PI_WORKFLOW_JOURNAL_PATH = "/tmp/ignored-journal.sqlite";
		assert.equal(workflowJournalPath(), join(dirname(getAgentDir()), "workflows", "journal.sqlite"));
		for (const value of [" ./verbatim/../journal.sqlite ", "relative.sqlite"]) {
			process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = value;
			assert.equal(workflowJournalPath(), value);
		}
		process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = "";
		assert.equal(workflowJournalPath(), join(dirname(getAgentDir()), "workflows", "journal.sqlite"));
	} finally {
		if (previous === undefined) delete process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
		else process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = previous;
		if (previousPi === undefined) delete process.env.PI_WORKFLOW_JOURNAL_PATH;
		else process.env.PI_WORKFLOW_JOURNAL_PATH = previousPi;
	}
});
