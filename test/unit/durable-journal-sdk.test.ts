import assert from "node:assert/strict";
import { join } from "node:path";
import type {
	AdapterOptions,
	SecretRef,
	SessionStore,
	SqliteDatabase,
	StorageOpenContext,
	StorageProvider,
	RunJournal as StorageRunJournal,
	StorageSelection,
} from "@bastani/atomic/storage";
import type {
	Lease,
	LeaseState,
	MemoryRunJournal,
	RunJournal,
	RunOpts,
	RunSummary,
	SqlRunJournal,
} from "@bastani/workflows";
import { test } from "vitest";
import type { RunJournal as KernelRunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
const journalIdentity: Equal<RunJournal, KernelRunJournal> = true;
const storageJournalIdentity: Equal<RunJournal, StorageRunJournal> = true;
const providerIdentity: Equal<
	StorageProvider,
	{
		openSessionStore(selection: StorageSelection, context: StorageOpenContext): Promise<SessionStore>;
		openRunJournal(selection: StorageSelection, context: StorageOpenContext): Promise<RunJournal>;
	}
> = true;
const optionIdentity: Equal<
	NonNullable<RunOpts["journal"]>,
	| { path: string; prefix?: string }
	| { database: SqliteDatabase; prefix?: string }
	| { memory: true }
	| { adapter: string; options?: AdapterOptions; secrets?: Readonly<Record<string, SecretRef>>; prefix?: string }
	| RunJournal
> = true;
const memoryPublicShape: Equal<keyof MemoryRunJournal, keyof RunJournal> = true;
const sqlitePublicShape: Equal<Exclude<keyof SqlRunJournal, "path" | "descriptor">, keyof RunJournal> = true;
const runLookupIdentity: Equal<ReturnType<RunJournal["getRun"]>, Promise<RunSummary | undefined>> = true;
const leaseLookupIdentity: Equal<ReturnType<RunJournal["leaseState"]>, Promise<LeaseState | undefined>> = true;
const leaseStateIdentity: Equal<LeaseState, Lease & { readonly renewedAt: number; readonly ageMs: number }> = true;
const SDK_PROCESS_TIMEOUT_MS = 120_000;

test("public storage and journal types retain exact provider, option and journal identities", () => {
	assert.equal(journalIdentity, true);
	assert.equal(storageJournalIdentity, true);
	assert.equal(providerIdentity, true);
	assert.equal(optionIdentity, true);
	assert.equal(memoryPublicShape, true);
	assert.equal(sqlitePublicShape, true);
	assert.equal(runLookupIdentity, true);
	assert.equal(leaseLookupIdentity, true);
	assert.equal(leaseStateIdentity, true);
});

test("public workflow SDK import does not load node:sqlite", () => {
	const result = spawnSyncCollect([
		process.execPath,
		"--input-type=module",
		"-e",
		`import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	assert.notEqual(specifier, "node:sqlite");
	return nextResolve(specifier, context);
} });
const sdk = await import("@bastani/atomic/workflows");
assert.equal(typeof sdk.MemoryRunJournal, "function");
assert.equal(typeof sdk.SqlRunJournal, "function");
assert.equal("synchronousJournal" in sdk, false);
assert.equal("registerSynchronousJournal" in sdk, false);`,
	]);
	assert.equal(result.exitCode, 0, result.stderr.toString());
});
for (const runtime of ["node", "bun"] as const) {
	test(
		`public journal SDK executes selection, fencing, persistence and conformance under ${runtime}`,
		() => {
			const directory = makeTempDirectory(`journal-sdk-${runtime}-`);
			try {
				const executable = runtime === "bun" ? bunExecutable() : process.execPath;
				const result = spawnSyncCollect([
					executable,
					join(moduleDir(import.meta.url), "../fixtures/journal-configuration-sdk.mjs"),
					directory,
				]);
				assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
				assert.deepEqual(JSON.parse(result.stdout.toString()), {
					runtime,
					publicConformance: 22,
					status: "passed",
				});
			} finally {
				removeTempDirectory(directory);
			}
		},
		SDK_PROCESS_TIMEOUT_MS,
	);
}
