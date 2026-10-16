import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { moduleDir } from "../helpers/runtime.js";

const repoRoot = resolve(moduleDir(import.meta.url), "../..");
/** A real `tsc` child process type-checks the probe against the built package declarations. */
const TSC_PROBE_TIMEOUT_MS = 60_000;
const TSC_CHILD_TIMEOUT_MS = TSC_PROBE_TIMEOUT_MS - 5_000;

test(
	"built public workflow types match the runtime store, stage snapshots, and createAgentSession adapters (#3473)",
	() => {
		const root = mkdtempSync(join(tmpdir(), "atomic-built-runtime-surface-types-"));
		try {
			mkdirSync(join(root, "node_modules", "@bastani"), { recursive: true });
			symlinkSync(
				join(repoRoot, "packages", "coding-agent"),
				join(root, "node_modules", "@bastani", "atomic"),
				"dir",
			);
			writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
			writeFileSync(
				join(root, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						strict: true,
						noEmit: true,
						skipLibCheck: true,
						target: "ES2022",
						module: "NodeNext",
						moduleResolution: "NodeNext",
					},
					include: ["probe.ts"],
				}),
			);
			writeFileSync(
				join(root, "probe.ts"),
				`
import { createAgentSession, type SqliteDatabase, type StorageDescriptor } from "@bastani/atomic";
import {
	createStore,
	MemoryRunJournal,
	SqlRunJournal,
	StorageUnavailableError,
	type RunJournal,
	type Lease,
	type LeaseState,
	type RunSummary,
	type RunOpts,
	type StageContext,
	type StageAdapters,
	type StageSnapshot,
	type StoreSnapshot,
} from "@bastani/atomic/workflows";

const adapters: StageAdapters = {
	agentSession: {
		create: (opts) => createAgentSession({ cwd: opts.cwd }),
	},
};
const opts: RunOpts = { adapters };
const journal: RunJournal = new MemoryRunJournal();
const runLookup: Promise<RunSummary | undefined> = journal.getRun("run");
const leaseLookup: Promise<LeaseState | undefined> = journal.leaseState("run");
const takeover: ReturnType<RunJournal["acquire"]> = journal.takeoverExpired("run", "holder", 100);
type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
const memoryShape: Equal<keyof MemoryRunJournal, keyof RunJournal> = true;
const sqliteShape: Equal<Exclude<keyof SqlRunJournal, "path" | "descriptor">, keyof RunJournal> = true;
const descriptorShape: Equal<SqlRunJournal["descriptor"], StorageDescriptor> = true;
declare const database: SqliteDatabase;
const opened: Promise<SqlRunJournal> = SqlRunJournal.open(database, { prefix: "example_" });
const leaseShape: Equal<LeaseState, Lease & { readonly renewedAt: number; readonly ageMs: number }> = true;
void [runLookup, leaseLookup, takeover, memoryShape, sqliteShape, leaseShape, descriptorShape, opened];
const journalOptions: readonly RunOpts[] = [
	{ journal }, { journal: { memory: true } }, { journal: { path: "runs.sqlite" } },
];
void [journalOptions, SqlRunJournal, StorageUnavailableError];

const store = createStore();
const unsubscribe: () => void = store.subscribe((snap: StoreSnapshot) => {
	void snap.version;
});
unsubscribe();
const snapshot: StoreSnapshot = store.snapshot();
const graph: StoreSnapshot = store.graphSnapshot();

declare const stage: StageSnapshot;
const parentIds: readonly string[] = stage.parentIds;
const executionOrder: number | undefined = stage.executionOrder;
const model: string | undefined = stage.model;
const startedAt: number | undefined = stage.startedAt;
const endedAt: number | undefined = stage.endedAt;
const graphStage: StageSnapshot | undefined = graph.runs[0]?.stages[0];

declare const ctx: StageContext;
ctx.subscribe((event) => {
	if (event.type === "agent_end") void event.messages;
});

void opts; void snapshot; void parentIds; void executionOrder; void model; void startedAt; void endedAt; void graphStage;
`,
			);
			try {
				execFileSync("bun", [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", root], {
					encoding: "utf8",
					stdio: "pipe",
					timeout: TSC_CHILD_TIMEOUT_MS,
				});
			} catch (error) {
				const failure = error as { stdout?: string; stderr?: string };
				assert.fail([failure.stdout, failure.stderr].join("\n"));
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	TSC_PROBE_TIMEOUT_MS,
);
