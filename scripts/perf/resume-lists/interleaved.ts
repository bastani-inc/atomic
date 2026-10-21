#!/usr/bin/env bun
/**
 * Interleaved A/B comparison of the `/resume` and `/workflow resume` list paths: a base commit's session store
 * and durable backend against the working tree's, alternating per iteration over one fixture database.
 *
 *   bun run scripts/perf/resume-lists/interleaved.ts --database <seeded journal.sqlite> --base debf9d9db [--n 20]
 *
 * In-process iterations open a fresh connection per sample, so SQLite's page cache is cold and the OS cache
 * warm, as on the first open after starting Atomic. `--processes` also starts a fresh Bun process per sample.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SessionManager } from "../../../packages/coding-agent/src/core/session-manager.js";
import type { SqliteDatabase } from "../../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { SessionStore } from "../../../packages/coding-agent/src/core/storage/session/types.js";
import { createSessionCwdMatcher } from "../../../packages/coding-agent/src/utils/canonical-path.js";
import type { DurableWorkflowCatalogEntries } from "../../../packages/workflows/src/durable/backend.js";
import { openSqlRunJournal } from "../../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { RunJournal } from "../../../packages/workflows/src/durable/journal/types.js";
import { sessionCwd } from "./fixtures.js";

const REPO = resolve(import.meta.dir, "../../..");
const STORE = "packages/coding-agent/src/core/storage/session/sql-session-store.ts";
const BACKEND = "packages/workflows/src/durable/journal/journal-backend.ts";

interface StoreModule {
	SqlSessionStore: {
		open(database: SqliteDatabase, options: { cwdMatcher: typeof createSessionCwdMatcher }): Promise<SessionStore>;
	};
}
interface Backend {
	prepareWorkflowCatalog(): Promise<DurableWorkflowCatalogEntries>;
	close(): Promise<void>;
}
interface BackendModule {
	JournalDurableBackend: { open(journal: RunJournal): Promise<Backend> };
}
interface Implementation {
	readonly store: StoreModule;
	readonly backend: BackendModule;
}
type Sample = Record<string, number>;

function option(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

/** Copies the base commit's two modules beside nothing else, with every import pointing back into this checkout. */
function materializeBase(commit: string): string {
	const directory = join("/tmp", `resume-lists-base-${commit}`);
	mkdirSync(directory, { recursive: true });
	for (const path of [STORE, BACKEND]) {
		const source = execFileSync("git", ["show", `${commit}:${path}`], { cwd: REPO, encoding: "utf8" });
		const from = join(REPO, dirname(path));
		const rewritten = source
			.replaceAll(/from "(\.{1,2}\/[^"]+)"/g, (_match, specifier: string) => `from "${resolve(from, specifier)}"`)
			.replaceAll(
				'from "@bastani/atomic/storage"',
				`from "${join(REPO, "packages/coding-agent/src/core/storage/index.ts")}"`,
			);
		writeFileSync(join(directory, path.split("/").at(-1)!), rewritten);
	}
	return directory;
}

async function load(kind: "base" | "after", baseDirectory: string): Promise<Implementation> {
	const root = kind === "base" ? baseDirectory : undefined;
	return {
		store: (await import(root ? join(root, "sql-session-store.ts") : join(REPO, STORE))) as StoreModule,
		backend: (await import(root ? join(root, "journal-backend.ts") : join(REPO, BACKEND))) as BackendModule,
	};
}

async function timed(action: () => Promise<unknown>): Promise<number> {
	const started = performance.now();
	await action();
	return performance.now() - started;
}

async function sample(implementation: Implementation, database: string): Promise<Sample> {
	const cwd = sessionCwd("/bench", 0, 20);
	const result: Sample = {};
	for (const scope of ["all", "folder"] as const) {
		const connection = await openNodeSqliteDatabase(database);
		const store = await implementation.store.SqlSessionStore.open(connection, {
			cwdMatcher: createSessionCwdMatcher,
		});
		const list = () => (scope === "all" ? SessionManager.listAll(store) : SessionManager.list(cwd, store));
		result[`/resume first open, ${scope}`] = await timed(list);
		result[`/resume reopen, ${scope}`] = await timed(list);
		await store.close();
		await connection.close();
	}
	let backend: Backend | undefined;
	result["/workflow resume backend open (startup fold)"] = await timed(async () => {
		backend = await implementation.backend.JournalDurableBackend.open(await openSqlRunJournal(database));
	});
	if (backend === undefined) throw new Error("backend did not open");
	result["/workflow resume first open"] = await timed(() => backend.prepareWorkflowCatalog());
	result["/workflow resume reopen"] = await timed(() => backend.prepareWorkflowCatalog());
	await backend.close();
	return result;
}

function stats(values: readonly number[]): { median: number; p95: number } {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		median: sorted[Math.floor(sorted.length / 2)]!,
		p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
	};
}

function table(title: string, samples: Record<"base" | "after", Sample[]>): string {
	const format = (value: number) => `${value.toFixed(2)} ms`;
	const lines = [
		`### ${title} (n=${samples.base.length} each, interleaved)`,
		"",
		"| metric | base median | base p95 | after median | after p95 |",
		"| --- | ---: | ---: | ---: | ---: |",
	];
	for (const metric of Object.keys(samples.base[0] ?? {})) {
		const base = stats(samples.base.map((entry) => entry[metric]!));
		const after = stats(samples.after.map((entry) => entry[metric]!));
		lines.push(
			`| ${metric} | ${format(base.median)} | ${format(base.p95)} | ${format(after.median)} | ${format(after.p95)} |`,
		);
	}
	return lines.join("\n");
}

async function main(): Promise<void> {
	const database = resolve(option("database") ?? "");
	const commit = option("base") ?? "debf9d9db";
	const count = Number(option("n") ?? "20");
	const baseDirectory = materializeBase(commit);
	const child = option("child") as "base" | "after" | undefined;
	if (child !== undefined) {
		process.stdout.write(JSON.stringify(await sample(await load(child, baseDirectory), database)));
		return;
	}
	const implementations = { base: await load("base", baseDirectory), after: await load("after", baseDirectory) };
	const inProcess: Record<"base" | "after", Sample[]> = { base: [], after: [] };
	// One untimed warm-up per implementation so neither pays the module JIT inside a sample.
	await sample(implementations.base, database);
	await sample(implementations.after, database);
	for (let index = 0; index < count; index++) {
		const order: ("base" | "after")[] = index % 2 === 0 ? ["base", "after"] : ["after", "base"];
		for (const kind of order) inProcess[kind].push(await sample(implementations[kind], database));
	}
	const output = [
		`base ${commit} vs working tree, fixture ${database}`,
		"",
		table("fresh connection per sample", inProcess),
	];
	if (process.argv.includes("--processes")) {
		const processes: Record<"base" | "after", Sample[]> = { base: [], after: [] };
		for (let index = 0; index < count; index++) {
			const order: ("base" | "after")[] = index % 2 === 0 ? ["base", "after"] : ["after", "base"];
			for (const kind of order) {
				const run = spawnSync(
					process.execPath,
					[import.meta.path, "--database", database, "--base", commit, "--child", kind],
					{ encoding: "utf8" },
				);
				if (run.status !== 0) throw new Error(run.stderr);
				processes[kind].push(JSON.parse(run.stdout) as Sample);
			}
		}
		output.push("", table("fresh Bun process per sample", processes));
	}
	const report = output.join("\n");
	console.log(report);
	const out = option("out");
	if (out !== undefined) writeFileSync(out, `${report}\n`);
}

await main();
