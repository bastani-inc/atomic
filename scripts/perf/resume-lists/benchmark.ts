#!/usr/bin/env bun
import { spawn } from "node:child_process";
/**
 * Benchmark for reopening the `/resume` session list and the `/workflow resume` run list.
 *
 * Seeds one SQLite store with many sessions (with search text) and many workflow runs (with checkpoint
 * events), then times the first and repeated opens of both lists from a long-lived reader, idle and while
 * another process writes. Pass `--database <path>` to reuse a seeded fixture so before/after runs compare
 * the same data.
 *
 *   bun run scripts/perf/resume-lists/benchmark.ts --database /tmp/resume-lists/journal.sqlite
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SessionManager } from "../../../packages/coding-agent/src/core/session-manager.js";
import type { SqliteDatabase, SqliteRow } from "../../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { createSessionCwdMatcher } from "../../../packages/coding-agent/src/utils/canonical-path.js";
import { JournalDurableBackend } from "../../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { DurableWorkflowStatus } from "../../../packages/workflows/src/durable/types.js";
import { fastSeeding, sessionCwd, sessionFixture, toolCheckpoint } from "./fixtures.js";

interface Options {
	readonly database: string;
	readonly sessions: number;
	readonly runs: number;
	readonly checkpoints: number;
	readonly repeats: number;
	readonly label: string;
	readonly out?: string;
}

function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	return {
		database: resolve(value("database") ?? join("/tmp", `resume-lists-${randomUUID()}`, "journal.sqlite")),
		sessions: Number(value("sessions") ?? "2000"),
		runs: Number(value("runs") ?? "500"),
		checkpoints: Number(value("checkpoints") ?? "40"),
		repeats: Number(value("repeats") ?? "15"),
		label: value("label") ?? "run",
		...(value("out") === undefined ? {} : { out: value("out") }),
	};
}

const PROJECTS = 20;
const ROOT = "/bench";
const STATUSES: readonly DurableWorkflowStatus[] = ["paused", "failed", "completed", "running"];

async function seed(options: Options): Promise<void> {
	mkdirSync(dirname(options.database), { recursive: true });
	const started = performance.now();
	const database = await openNodeSqliteDatabase(options.database);
	await fastSeeding(database);
	const sessions = await SqlSessionStore.open(database, { cwdMatcher: createSessionCwdMatcher });
	for (let index = 0; index < options.sessions; index++) {
		const { header, entries } = sessionFixture(ROOT, index, {
			projects: PROJECTS,
			messages: 24,
			wordsPerMessage: 60,
		});
		await sessions.create(header, entries);
	}
	const journal = await openSqlRunJournal(options.database);
	await fastSeeding(Reflect.get(journal, "database") as SqliteDatabase);
	const backend = await JournalDurableBackend.open(journal);
	for (let index = 0; index < options.runs; index++) {
		const workflowId = randomUUID();
		await backend.commitWorkflowRegistration({
			workflowId,
			name: `workflow-${index % 7}`,
			inputs: { topic: `topic ${index}` },
			createdAt: Date.UTC(2026, 0, 1) + index,
			status: "running",
			invocationCwd: sessionCwd(ROOT, index, PROJECTS),
		});
		for (let checkpoint = 0; checkpoint < options.checkpoints; checkpoint++)
			await backend.commitCheckpoint(toolCheckpoint(workflowId, checkpoint, 40));
		await backend.commitWorkflowStatus(workflowId, STATUSES[index % STATUSES.length]!);
	}
	await backend.close();
	await sessions.close();
	await database.close();
	console.error(`seeded ${options.sessions} sessions and ${options.runs} runs in ${ms(performance.now() - started)}`);
}

function ms(value: number): string {
	return `${value.toFixed(value < 10 ? 2 : 1)} ms`;
}

async function time<T>(action: () => Promise<T>): Promise<{ ms: number; value: T }> {
	const started = performance.now();
	const value = await action();
	return { ms: performance.now() - started, value };
}

function summarize(samples: readonly number[]): string {
	const sorted = [...samples].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)]!;
	const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
	return `median ${ms(median)}, p95 ${ms(p95)} (n=${sorted.length})`;
}

async function repeat(count: number, action: () => Promise<unknown>, pauseMs = 0): Promise<number[]> {
	const samples: number[] = [];
	for (let index = 0; index < count; index++) {
		if (pauseMs > 0) await Bun.sleep(pauseMs);
		samples.push((await time(action)).ms);
	}
	return samples;
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	if (!existsSync(options.database)) await seed(options);
	const lines: string[] = [`# resume-list benchmark: ${options.label}`, `database: ${options.database}`];
	const report = (line: string) => {
		lines.push(line);
		console.log(line);
	};
	const cwd = sessionCwd(ROOT, 0, PROJECTS);

	// Reader: one long-lived connection, like an interactive Atomic process.
	const openStore = await time(async () => {
		const database = await openNodeSqliteDatabase(options.database);
		return { database, store: await SqlSessionStore.open(database, { cwdMatcher: createSessionCwdMatcher }) };
	});
	const { database, store } = openStore.value;
	report(`\n## /resume (sessions)`);
	report(`store open: ${ms(openStore.ms)}`);
	const firstCwd = await time(() => SessionManager.list(cwd, store));
	report(`first open, current folder (${firstCwd.value.length} rows): ${ms(firstCwd.ms)}`);
	report(
		`reopen, current folder, idle: ${summarize(await repeat(options.repeats, () => SessionManager.list(cwd, store)))}`,
	);
	const firstAll = await time(() => SessionManager.listAll(store));
	report(`first open, all (${firstAll.value.length} rows): ${ms(firstAll.ms)}`);
	report(`reopen, all, idle: ${summarize(await repeat(options.repeats, () => SessionManager.listAll(store)))}`);
	report(
		`first open in a fresh store, all, warm page cache: ${summarize(
			await repeat(options.repeats, async () => {
				const fresh = await SqlSessionStore.open(database, { cwdMatcher: createSessionCwdMatcher });
				await SessionManager.listAll(fresh);
				await fresh.close();
			}),
		)}`,
	);

	// Another connection renames one session between opens.
	const otherDatabase = await openNodeSqliteDatabase(options.database);
	const other = await SqlSessionStore.open(otherDatabase, { cwdMatcher: createSessionCwdMatcher });
	const renamed = firstAll.value.slice(0, options.repeats);
	const renameSamples: number[] = [];
	for (const [index, session] of renamed.entries()) {
		const header = await other.readHeader(session.id);
		const snapshot = await other.load(session.id);
		if (header === undefined) throw new Error(`missing ${session.id}`);
		await other.append(
			session.id,
			[
				{
					type: "session_info",
					id: `rename-${options.label}-${index}-${randomUUID()}`,
					parentId: null,
					timestamp: new Date().toISOString(),
					name: `Renamed ${index}`,
				},
			],
			{ expectSeq: snapshot.lastSeq },
		);
		const reopened = await time(() => SessionManager.listAll(store));
		if (!reopened.value.some((row) => row.id === session.id && row.name === `Renamed ${index}`))
			throw new Error("rename not reflected");
		renameSamples.push(reopened.ms);
	}
	report(`reopen, all, after another connection renamed 1 session: ${summarize(renameSamples)}`);

	// Breakdown of the uncached list path.
	const fullSql = await time(() =>
		database.all(
			`SELECT s.*, (SELECT COALESCE('[' || group_concat(text_json, ',') || ']', '[]') FROM (SELECT text_json FROM session_search_texts WHERE session_id = s.id ORDER BY seq)) AS search_texts_json FROM session_sessions AS s WHERE internal = 0`,
		),
	);
	const lightSql = await time(() => database.all(`SELECT s.* FROM session_sessions AS s WHERE internal = 0`));
	const parse = await time(async () => {
		for (const row of fullSql.value as (SqliteRow & { header_json: string; search_texts_json: string })[]) {
			JSON.parse(row.header_json);
			(JSON.parse(row.search_texts_json) as string[]).join(" ");
		}
	});
	report(
		`breakdown (uncached, all): SQL with search text ${ms(fullSql.ms)}, SQL without search text ${ms(lightSql.ms)}, JSON parse/join ${ms(parse.ms)}`,
	);

	// Workflows.
	report(`\n## /workflow resume (runs)`);
	const openBackend = await time(async () => JournalDurableBackend.open(await openSqlRunJournal(options.database)));
	const backend = openBackend.value;
	report(`backend open (initial fold): ${ms(openBackend.ms)}`);
	const firstCatalog = await time(() => backend.prepareWorkflowCatalog());
	report(
		`first open (${firstCatalog.value.resumable.length} resumable, ${firstCatalog.value.completed.length} completed): ${ms(firstCatalog.ms)}`,
	);
	report(`reopen, idle: ${summarize(await repeat(options.repeats, () => backend.prepareWorkflowCatalog()))}`);
	const journal = backend.journal;
	const listRuns = await time(() => journal.listRuns());
	const readAll = await time(async () => {
		let events = 0;
		for (const run of listRuns.value) for await (const _entry of journal.read(run.runId)) events++;
		return events;
	});
	report(
		`breakdown: listRuns ${ms(listRuns.ms)}, read all ${readAll.value} events ${ms(readAll.ms)}, projection catalog ${ms((await time(async () => backend.listResumableWorkflows())).ms)}`,
	);

	const otherBackend = await JournalDurableBackend.open(await openSqlRunJournal(options.database));
	const changed = firstCatalog.value.resumable.filter((entry) => entry.status === "paused").slice(0, options.repeats);
	const statusSamples: number[] = [];
	for (const entry of changed) {
		await otherBackend.commitWorkflowStatus(entry.workflowId, "failed");
		await otherBackend.releaseWorkflow(entry.workflowId);
		const reopened = await time(() => backend.prepareWorkflowCatalog());
		if (!reopened.value.resumable.some((row) => row.workflowId === entry.workflowId && row.status === "failed"))
			throw new Error("status change not reflected");
		statusSamples.push(reopened.ms);
	}
	report(`reopen after another connection changed 1 run's status: ${summarize(statusSamples)}`);

	// Concurrent writer process.
	report(`\n## concurrent writer (another process appending to sessions and workflow checkpoints)`);
	const writer = spawn(process.execPath, [join(import.meta.dir, "writer.ts"), options.database, ROOT], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	await new Promise<void>((ready, failed) => {
		writer.once("error", failed);
		writer.stdout.once("data", () => ready());
	});
	report(`/resume reopen, all: ${summarize(await repeat(options.repeats, () => SessionManager.listAll(store), 100))}`);
	report(
		`/workflow resume reopen: ${summarize(await repeat(options.repeats, () => backend.prepareWorkflowCatalog(), 100))}`,
	);
	writer.kill("SIGTERM");
	await new Promise((done) => writer.once("exit", done));

	await otherBackend.close();
	await backend.close();
	await other.close();
	await otherDatabase.close();
	await store.close();
	await database.close();
	if (options.out !== undefined) writeFileSync(options.out, `${lines.join("\n")}\n`);
}

await main();
