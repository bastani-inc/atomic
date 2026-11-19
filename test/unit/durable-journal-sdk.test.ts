import assert from "node:assert/strict";
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
type OptionalRunJournalMember = "changeToken" | "runVersions" | "snapshotTail" | "appendMany" | "snapshotBlobs";
const memoryPublicShape: Equal<keyof MemoryRunJournal, Exclude<keyof RunJournal, OptionalRunJournalMember>> = true;
const sqlitePublicShape: Equal<Exclude<keyof SqlRunJournal, "path" | "descriptor">, keyof RunJournal> = true;
const runLookupIdentity: Equal<ReturnType<RunJournal["getRun"]>, Promise<RunSummary | undefined>> = true;
const leaseLookupIdentity: Equal<ReturnType<RunJournal["leaseState"]>, Promise<LeaseState | undefined>> = true;
const leaseStateIdentity: Equal<LeaseState, Lease & { readonly renewedAt: number; readonly ageMs: number }> = true;

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
