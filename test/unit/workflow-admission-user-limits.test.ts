import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WorkflowRunNotFoundError } from "@bastani/atomic";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, beforeEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { ShardedRunJournal } from "../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { PiEventContext } from "../../packages/workflows/src/extension/public-types.js";
import { createSessionRunControl } from "../../packages/workflows/src/extension/workflow-session-run-control.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import {
	findWorkflowAdmissionError,
	isWorkflowAdmissionConfigError,
	isWorkflowAdmissionError,
	WorkflowAdmissionConfigError,
	WorkflowAdmissionError,
} from "../../packages/workflows/src/workers/admission-errors.js";
import { hostWorkerBindings } from "../../packages/workflows/src/workers/host-options.js";
import { SqlResourceAdmission } from "../../packages/workflows/src/workers/resource-admission.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const definition = workflow({
	name: "user-limits",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.tool("work", {}, async () => true);
		return {};
	},
});

let directory: string;
beforeEach(() => {
	directory = makeTempDirectory("workflow-admission-user-limits-");
});
afterEach(() => removeTempDirectory(directory));

async function onStore() {
	const store = join(directory, "journal");
	const journal = await ShardedRunJournal.open({ directory: store, openShard: (path) => openSqlRunJournal(path) });
	return { store, journal, backend: await JournalDurableBackend.open(journal) };
}

test("user limits on the default journal store fail before the root is placed on a shard, typed, with the fix (#4325)", async () => {
	const { store, journal, backend } = await onStore();
	try {
		const operations: string[] = [];
		for (const method of ["createRun", "getRun", "acquire", "append", "journalFor"] as const) {
			const original = (journal[method] as (...args: never[]) => unknown).bind(journal);
			Reflect.set(journal, method, (...args: never[]) => {
				operations.push(method);
				return original(...args);
			});
		}
		const refused = await run(
			definition,
			{},
			{
				durableBackend: backend,
				store: createStore(),
				runId: "0f1e2d3c-4b5a-4968-8776-655443322110",
				admission: { userLimits: { session: 2 }, userDatabase: join(directory, "user.sqlite") },
			},
		).catch((error: Error) => error);
		assert.ok(isWorkflowAdmissionConfigError(refused));
		assert.deepEqual(
			[refused.code, refused.source, refused.field, refused.retryable, refused.reason],
			["user-limits-need-one-journal", "sdk", "admission.userLimits", false, undefined],
		);
		assert.ok(refused.hint.includes("RunOpts.journal") && refused.hint.includes("admission.userDatabase"));
		assert.equal(refused.message.includes(refused.hint), true);
		assert.deepEqual(operations, [], "no journal operation ran");
		assert.equal(
			readdirSync(store).filter((file) => file.startsWith("shard-")).length,
			0,
			"no shard was created for the refused root",
		);
		assert.equal(existsSync(join(directory, "user.sqlite")), false);
	} finally {
		await backend.close();
	}
});

test("a host launch names the settings key, and a resume that saved user limits is refused the same way (#4325)", async () => {
	const { backend } = await onStore();
	try {
		const launched = await run(
			definition,
			{},
			{
				durableBackend: backend,
				store: createStore(),
				admission: { userLimits: { session: 2 } },
				[hostWorkerBindings]: true,
			},
		).catch((error: Error) => error);
		assert.ok(isWorkflowAdmissionConfigError(launched));
		assert.deepEqual([launched.source, launched.field], ["settings", "workflows.admission.userLimits"]);
		assert.ok(
			launched.hint.includes("workflows.journal.path") && launched.hint.includes("workflows.admission.userDatabase"),
		);
	} finally {
		await backend.close();
	}
});

test("userDatabase that is not the run's journal file is refused with the reason (#4325)", async () => {
	const path = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const database = await openNodeSqliteDatabase(join(directory, "prefixed.sqlite"));
	const prefixed = await SqlRunJournal.open(database, { prefix: "other_" });
	const inMemory = await openNodeSqliteDatabase(":memory:");
	const memory = await SqlRunJournal.open(inMemory);
	try {
		const refusal = async (open: () => Promise<unknown>) => {
			const error = await open().catch((caught: Error) => caught);
			assert.ok(isWorkflowAdmissionConfigError(error), String(error));
			return [error.code, error.reason, error.userDatabase, error.journalPath, error.source];
		};
		const direct = (target: SqlRunJournal, userDatabase: string | undefined) => () =>
			SqlResourceAdmission.open(target, {
				root: "root",
				holder: "holder",
				userLimits: { session: 2 },
				...(userDatabase === undefined ? {} : { userDatabase }),
			});
		const elsewhere = join(directory, "elsewhere.sqlite");
		assert.deepEqual(await refusal(direct(backend.journal as SqlRunJournal, elsewhere)), [
			"user-database-mismatch",
			"other-file",
			elsewhere,
			path,
			"sdk",
		]);
		assert.deepEqual(await refusal(direct(backend.journal as SqlRunJournal, undefined)), [
			"user-database-mismatch",
			"missing",
			undefined,
			path,
			"sdk",
		]);
		assert.deepEqual(
			await refusal(() =>
				SqlResourceAdmission.open(memory, {
					root: "root",
					holder: "holder",
					userLimits: { session: 2 },
					userDatabase: ":memory:",
				}),
			),
			["user-database-mismatch", "unsupported-journal", ":memory:", ":memory:", "sdk"],
		);
		assert.deepEqual(
			await refusal(() =>
				SqlResourceAdmission.open(prefixed, {
					root: "root",
					holder: "holder",
					userLimits: { session: 2 },
					userDatabase: join(directory, "prefixed.sqlite"),
				}),
			),
			[
				"user-database-mismatch",
				"unsupported-journal",
				join(directory, "prefixed.sqlite"),
				join(directory, "prefixed.sqlite"),
				"sdk",
			],
		);
	} finally {
		await memory.close();
		await inMemory.close();
		await prefixed.close();
		await database.close();
		await backend.close();
	}
});

test("admission errors are guarded across realms and found in a cause chain (#4325)", () => {
	const refused = new WorkflowAdmissionConfigError({ code: "user-limits-need-one-journal", source: "sdk" });
	assert.ok(refused instanceof WorkflowAdmissionError);
	assert.ok(isWorkflowAdmissionError(refused) && isWorkflowAdmissionConfigError(refused));
	const plain = { name: "WorkflowAdmissionConfigError", code: "user-database-mismatch" };
	assert.ok(isWorkflowAdmissionConfigError(plain) && isWorkflowAdmissionError(plain));
	for (const value of [
		undefined,
		null,
		"x",
		{ name: "WorkflowAdmissionConfigError", code: "unknown" },
		{ name: "Other", code: "user-database-mismatch" },
	])
		assert.equal(isWorkflowAdmissionConfigError(value), false, JSON.stringify(value));
	assert.equal(
		findWorkflowAdmissionError(new Error("outer", { cause: new Error("mid", { cause: refused }) })),
		refused,
	);
	assert.equal(findWorkflowAdmissionError(new Error("plain")), undefined);
	let deep: Error = refused;
	for (let depth = 0; depth < 8; depth++) deep = new Error(`level ${depth}`, { cause: deep });
	assert.equal(findWorkflowAdmissionError(deep), undefined, "the walk stops after eight causes");
});

test("the refusal message is built from its fields, with the hint last (UX contract, #4325)", () => {
	assert.equal(
		new WorkflowAdmissionConfigError({ code: "user-limits-need-one-journal", source: "sdk" }).message,
		"Cannot enforce admission.userLimits: the default journal store keeps each root on its own shard (user-limits-need-one-journal). Set RunOpts.journal to one SQLite file and admission.userDatabase to the same absolute path, or remove admission.userLimits.",
	);
	assert.equal(
		new WorkflowAdmissionConfigError({
			code: "user-database-mismatch",
			source: "settings",
			reason: "other-file",
			userDatabase: "/x.sqlite",
		}).message,
		"Cannot enforce workflows.admission.userLimits: workflows.admission.userDatabase is refused: it is not the run's journal file (user-database-mismatch). Set workflows.journal.path to one SQLite file and workflows.admission.userDatabase to the same absolute path, or remove workflows.admission.userLimits.",
	);
});

test("the family base and every guard branch are pinned by name, code and code type (#4325)", () => {
	const base = new WorkflowAdmissionError("user-database-mismatch", "message", "hint");
	assert.deepEqual([base.name, base.retryable, base.hint], ["WorkflowAdmissionError", false, "hint"]);
	assert.ok(isWorkflowAdmissionError({ name: "WorkflowAdmissionError", code: "user-database-mismatch" }));
	assert.equal(isWorkflowAdmissionError({ name: "WorkflowAdmissionError", code: 7 }), false);
	assert.equal(isWorkflowAdmissionConfigError({ name: "WorkflowAdmissionConfigError", code: 7 }), false);
	assert.ok(
		isWorkflowAdmissionConfigError({ name: "WorkflowAdmissionConfigError", code: "user-limits-need-one-journal" }),
	);
	assert.equal(findWorkflowAdmissionError(new Error("outer", { cause: null })), undefined);
	assert.equal(findWorkflowAdmissionError(null), undefined);
});

test("each refusal reason says what is wrong, and a refusal without a reason says the file is not the run's (#4325)", () => {
	const message = (reason?: "unsupported-journal" | "missing" | "other-file") =>
		new WorkflowAdmissionConfigError({ code: "user-database-mismatch", source: "sdk", reason }).message;
	assert.ok(message("unsupported-journal").includes("the run's journal is not a default-prefix local SQLite file"));
	assert.ok(message("missing").includes("is refused: it is not set"));
	assert.ok(message("other-file").includes("is refused: it is not the run's journal file"));
	assert.ok(message().includes("is refused: it is not the run's journal file"));
	const refused = new WorkflowAdmissionConfigError({ code: "user-limits-need-one-journal", source: "sdk" });
	assert.deepEqual(
		[refused.code, refused.reason, refused.userDatabase, refused.journalPath],
		["user-limits-need-one-journal", undefined, undefined, undefined],
	);
});

test("a run_not_found result without a typed error is rethrown without a cause (#4325)", async () => {
	const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
	const control = createSessionRunControl({
		execute: async () => ({
			action: "pause",
			runId: id,
			status: "noop",
			message: "not found",
			code: "run_not_found",
		}),
		context: (): PiEventContext => ({
			sessionManager: { getSessionId: () => "session" },
			cwd: directory,
			ui: { notify: () => undefined },
			hasUI: false,
		}),
		store: createStore(),
	});
	const rejected = await control.pause(id).catch((error: Error) => error);
	assert.ok(rejected instanceof WorkflowRunNotFoundError);
	assert.equal(rejected.cause, undefined);
});

test.skipIf(process.platform === "win32")(
	"a run whose userDatabase is not its journal file is refused before it starts, naming the source (#4325)",
	async () => {
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		try {
			const refused = async (host: boolean) => {
				const error = await run(
					definition,
					{},
					{
						durableBackend: backend,
						store: createStore(),
						admission: { userLimits: { session: 2 }, userDatabase: join(directory, "elsewhere.sqlite") },
						...(host ? { [hostWorkerBindings]: true } : {}),
					},
				).catch((caught: Error) => caught);
				assert.ok(isWorkflowAdmissionConfigError(error), String(error));
				return [error.code, error.reason, error.source, error.field];
			};
			assert.deepEqual(await refused(false), [
				"user-database-mismatch",
				"other-file",
				"sdk",
				"admission.userLimits",
			]);
			assert.deepEqual(await refused(true), [
				"user-database-mismatch",
				"other-file",
				"settings",
				"workflows.admission.userLimits",
			]);
		} finally {
			await backend.close();
		}
	},
);
