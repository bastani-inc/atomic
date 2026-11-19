import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

const appends = vi.hoisted(() => ({ count: 0, flushing: false, failListingOf: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
			// A flush writes appends already counted when they were queued for the writer thread.
			if (!appends.flushing) appends.count += 1;
			return actual.appendFileSync(...args);
		},
		readdirSync: ((path: import("node:fs").PathLike, ...rest: unknown[]) => {
			if (String(path) === appends.failListingOf)
				throw Object.assign(new Error("EMFILE: injected"), { code: "EMFILE" });
			return (actual.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
		}) as typeof actual.readdirSync,
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const appendFile = ((...args: Parameters<typeof actual.appendFile>) => {
		appends.count += 1;
		return actual.appendFile(...args);
	}) as typeof actual.appendFile;
	const readdir = ((path: import("node:fs").PathLike, ...rest: unknown[]) => {
		if (String(path) === appends.failListingOf)
			return Promise.reject(Object.assign(new Error("EMFILE: injected"), { code: "EMFILE" }));
		return (actual.readdir as (...args: unknown[]) => unknown)(path, ...rest);
	}) as typeof actual.readdir;
	return { ...actual, appendFile, readdir, default: { ...actual, appendFile, readdir } };
});

// The setup files loaded the storage adapter with the real node:fs. Load every module this test drives afresh, in one
// module graph, so the adapter sees the mocked node:fs and every area shares one debug setting.
vi.resetModules();
const { reportDebug } = await import("../../packages/coding-agent/src/core/debug.js");
const { openNodeSqliteDatabase } = await import("../../packages/coding-agent/src/core/storage/node-sqlite.js");
const { withDebugLog } = await import("../helpers/debug-mode.js");
// Debug records written without waiting go through the diagnostic writer thread, where this test's node:fs mock does
// not reach, so each append queued for that thread counts as one write.
const { DiagnosticWriter } = await import("../../packages/coding-agent/src/core/diagnostic-writer.js");

const { append, flushSync } = DiagnosticWriter.prototype;

function countWriterAppends(): void {
	vi.spyOn(DiagnosticWriter.prototype, "append").mockImplementation(function (
		this: InstanceType<typeof DiagnosticWriter>,
		...args: Parameters<typeof append>
	) {
		appends.count += 1;
		return append.apply(this, args);
	});
	vi.spyOn(DiagnosticWriter.prototype, "flushSync").mockImplementation(function (
		this: InstanceType<typeof DiagnosticWriter>,
	) {
		appends.flushing = true;
		try {
			flushSync.call(this);
		} finally {
			appends.flushing = false;
		}
	});
}

type DebugModeSource = "setting" | "ATOMIC_DEBUG";

afterEach(() => {
	vi.restoreAllMocks();
	appends.failListingOf = undefined;
});

async function triggerEvents(agentDir: string): Promise<void> {
	reportDebug("decision", "classifier-fallback", { message: "classifier fallback" });
	vi.spyOn(process, "emitWarning").mockImplementation(() => {});
	const path = join(agentDir, "queue.sqlite");
	const database = await openNodeSqliteDatabase(path);
	try {
		await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
		await database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('degraded')");
			mkdirSync(`${path}-writers`, { recursive: true });
			appends.failListingOf = `${path}-writers`;
		});
		appends.failListingOf = undefined;
		for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
	} finally {
		await database.close();
	}
}

async function count(source: DebugModeSource | "off") {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	countWriterAppends();
	return withDebugLog(source, async (log) => {
		appends.count = 0;
		await triggerEvents(log.agentDir);
		const records = await log.records();
		return {
			appends: appends.count,
			records: records.length,
			areas: records.reduce<Record<string, number>>((counts, { area }) => {
				counts[area] = (counts[area] ?? 0) + 1;
				return counts;
			}, {}),
			warnings: warn.mock.calls.length,
		};
	});
}

test("with debug off, neither decision nor storage events write a debug sink (#4360)", async () => {
	const off = await count("off");
	assert.deepEqual(
		{ appends: off.appends, records: off.records, warnings: off.warnings },
		{ appends: 0, records: 0, warnings: 0 },
	);
});

test("with debug on, each area's event is one append to the debug log and nothing else (#4360)", async () => {
	for (const source of ["setting", "ATOMIC_DEBUG"] as const) {
		const on = await count(source);
		assert.deepEqual(on.areas, { decision: 1, storage: 1 });
		assert.equal(on.appends, 2, `${source}: one append per event`);
		assert.equal(on.records, 2, `${source}: every append is a debug log record`);
		assert.equal(on.warnings, 0, `${source}: debug mode prints nothing`);
	}
});
