#!/usr/bin/env bun
/**
 * Benchmark for the latency of session saves and search-index writes on PostgreSQL while the search index's pending
 * list fills and empties.
 *
 * Several agent processes each write a few sessions at once. Each session has an appender, which saves entries a few at
 * a time, and an indexer, which adds the new entries' text to the search index whenever 8 or more are not indexed yet,
 * as a history search does. Both take the session's write lock. Every few index writes an agent also runs a search of
 * one of its sessions. The script reports the p50, p95, p99 and maximum of each kind of call, the run's wall time, the
 * largest the index's pending list grew, how many merges emptied it, and what it held at the end. It reads the list
 * with the `pgstattuple` extension, which it creates, so the role needs to be a superuser.
 *
 *   bun run scripts/perf/search-index-writes/benchmark.ts --url postgresql://postgres@127.0.0.1:5432/postgres \
 *     --password pw --root . --label after --out /tmp/search-index-after.json
 *
 * `--url` names a server where the role may create databases; each run creates its own database and drops it after.
 * `--root` is the checkout whose code runs, so a checkout of the base branch measures the code before a change.
 * Options: `--agents 12`, `--sessions 4` (per agent), `--entries 160` (per session), `--chars 6000` (largest entry;
 * entries are 500 characters up to this), `--think 5` (milliseconds an appender waits between saves, at most).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Options {
	readonly url: string;
	readonly password?: string;
	readonly root: string;
	readonly label: string;
	readonly agents: number;
	readonly sessions: number;
	readonly entries: number;
	readonly chars: number;
	readonly think: number;
	readonly index: boolean;
	readonly out?: string;
}

function parseOptions(argv: readonly string[]): Options & { readonly worker?: string; readonly agent: number } {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	const url = value("url");
	if (url === undefined) throw new Error("--url is required");
	const password = value("password");
	const out = value("out");
	const worker = value("worker");
	return {
		url,
		...(password === undefined ? {} : { password }),
		root: resolve(value("root") ?? "."),
		label: value("label") ?? "run",
		agents: Number(value("agents") ?? "12"),
		sessions: Number(value("sessions") ?? "4"),
		entries: Number(value("entries") ?? "160"),
		chars: Number(value("chars") ?? "6000"),
		think: Number(value("think") ?? "5"),
		index: value("index") !== "0",
		agent: Number(value("agent") ?? "0"),
		...(out === undefined ? {} : { out }),
		...(worker === undefined ? {} : { worker }),
	};
}

const WORDS =
	"const let function return await async import export class interface type string number boolean undefined null error warning info debug session entry message assistant user tool result output input file path directory build test lint format commit branch merge rebase status diff patch index search query database table column row lock transaction pending list vacuum analyze".split(
		" ",
	);

/** Text like a tool result: words, paths and hexadecimal identifiers, so it has many distinct trigrams. */
function entryText(chars: number): string {
	const parts: string[] = [];
	let length = 0;
	while (length < chars) {
		const roll = Math.random();
		const part =
			roll < 0.15
				? randomBytes(6).toString("hex")
				: roll < 0.25
					? `src/${WORDS[Math.floor(Math.random() * WORDS.length)]}/${randomBytes(3).toString("hex")}.ts:${Math.floor(Math.random() * 2000)}`
					: WORDS[Math.floor(Math.random() * WORDS.length)]!;
		parts.push(part);
		length += part.length + 1;
	}
	return parts.join(" ").slice(0, chars);
}

function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function summary(samples: readonly number[]) {
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		count: sorted.length,
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		p99: percentile(sorted, 99),
		max: sorted.at(-1) ?? Number.NaN,
	};
}

async function openDatabase(options: Options, url: string) {
	const { openPostgresDatabase } = await import(resolve(options.root, "packages/storage-postgres/postgres.js"));
	return openPostgresDatabase({
		url,
		...(options.password === undefined ? {} : { password: options.password }),
		maxConnections: options.sessions * 2 + 2,
	});
}

async function openStore(options: Options, database: unknown) {
	const { SqlSessionStore } = await import(
		resolve(options.root, "packages/coding-agent/src/core/storage/session/sql-session-store.ts")
	);
	return SqlSessionStore.open(database, {});
}

async function runAgent(options: Options & { readonly agent: number }, url: string): Promise<void> {
	const database = await openDatabase(options, url);
	const store = await openStore(options, database);
	const index = store.searchIndex;
	if (index === undefined) throw new Error("the store has no search index");
	const saves: number[] = [];
	const indexWrites: number[] = [];
	const searches: number[] = [];
	const lastSeqs = new Map<string, number>();
	const runSession = async (session: number) => {
		const id = `a${options.agent}-s${session}`;
		const texts: string[] = [];
		await store.create({ id, version: 3, createdAt: new Date().toISOString(), cwd: "/bench" }, []);
		let lastSeq = 0;
		let indexedSeq = 0;
		let appending = true;
		const appender = async () => {
			let parent: string | null = null;
			while (texts.length < options.entries) {
				const batch = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () =>
					entryText(500 + Math.floor(Math.random() * (options.chars - 500))),
				).slice(0, options.entries - texts.length);
				const entries = batch.map((text) => {
					const entryId = randomBytes(4).toString("hex");
					const entry = {
						type: "message",
						id: entryId,
						parentId: parent,
						timestamp: new Date().toISOString(),
						message: { role: "user", content: text, timestamp: Date.now() },
					};
					parent = entryId;
					return entry;
				});
				const started = performance.now();
				const written = await store.append(id, entries, { expectSeq: lastSeq });
				saves.push(performance.now() - started);
				texts.push(...batch);
				lastSeq = written.lastSeq;
				lastSeqs.set(id, lastSeq);
				await new Promise((done) => setTimeout(done, Math.random() * options.think));
			}
			appending = false;
		};
		const indexer = async () => {
			while (appending || indexedSeq < lastSeq) {
				const through = lastSeq;
				if (through - indexedSeq < 8 && appending) {
					await new Promise((done) => setTimeout(done, 2));
					continue;
				}
				const pending = texts
					.slice(indexedSeq, through)
					.map((text, offset) => ({ seq: indexedSeq + offset + 1, text }));
				const started = performance.now();
				const extended = await index.extend(id, 1, indexedSeq, through, pending);
				indexWrites.push(performance.now() - started);
				if (!extended) throw new Error(`index write of ${id} through ${through} was refused`);
				indexedSeq = through;
				if (indexWrites.length % 4 === 0) {
					const word = WORDS[Math.floor(Math.random() * WORDS.length)]!;
					const searchStarted = performance.now();
					await index.candidates(id, [[`${word} ${randomBytes(1).toString("hex")}`]], 1, indexedSeq, 50);
					searches.push(performance.now() - searchStarted);
				}
			}
		};
		await Promise.all(options.index ? [appender(), indexer()] : [appender()]);
	};
	await Promise.all(Array.from({ length: options.sessions }, (_, session) => runSession(session)));
	await store.close();
	await database.close();
	process.stdout.write(`${JSON.stringify({ saves, indexWrites, searches })}\n`);
}

function runWorker(options: Options, url: string, agent: number) {
	const args = [
		process.argv[1]!,
		"--worker",
		url,
		"--agent",
		String(agent),
		"--url",
		options.url,
		"--root",
		options.root,
		"--sessions",
		String(options.sessions),
		"--entries",
		String(options.entries),
		"--chars",
		String(options.chars),
		"--think",
		String(options.think),
		"--index",
		options.index ? "1" : "0",
		...(options.password === undefined ? [] : ["--password", options.password]),
	];
	return new Promise<{ saves: number[]; indexWrites: number[]; searches: number[] }>((done, fail) => {
		const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.on("exit", (code) => {
			if (code !== 0) fail(new Error(`agent ${agent} exited with ${code}`));
			else done(JSON.parse(output.trim().split("\n").at(-1)!));
		});
	});
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	if (options.worker !== undefined) {
		await runAgent(options, options.worker);
		return;
	}
	const admin = await openDatabase(options, options.url);
	const name = `search_bench_${randomBytes(4).toString("hex")}`;
	await admin.exec(`CREATE DATABASE ${name}`);
	const url = new URL(options.url);
	url.pathname = `/${name}`;
	try {
		const setup = await openDatabase(options, url.href);
		await (await openStore(options, setup)).close();
		await setup.exec("CREATE EXTENSION IF NOT EXISTS pgstattuple");
		// The pending list's size every 25 ms: a merge shows as a drop. Before the change every merge ran inside a write.
		let sampling = true;
		let largestPages = 0;
		let merges = 0;
		const sampler = (async () => {
			let previous = 0;
			while (sampling) {
				const row = await setup.get(
					"SELECT pending_pages FROM pgstatginindex('atomic.session_search_trgm'::regclass)",
				);
				const pages = Number(row?.pending_pages);
				if (pages < previous / 2) merges++;
				largestPages = Math.max(largestPages, pages);
				previous = pages;
				await new Promise((done) => setTimeout(done, 25));
			}
		})();
		const started = performance.now();
		const results = await Promise.all(
			Array.from({ length: options.agents }, (_, agent) => runWorker(options, url.href, agent)),
		);
		const wallMs = performance.now() - started;
		sampling = false;
		await sampler;
		const gin = await setup.get(
			"SELECT pending_pages, pending_tuples FROM pgstatginindex('atomic.session_search_trgm'::regclass)",
		);
		const reloptions = await setup.get(
			"SELECT array_to_string(reloptions, ',') AS options FROM pg_class WHERE oid = 'atomic.session_search_trgm'::regclass",
		);
		const version = await setup.get("SHOW server_version");
		await setup.close();
		const report = {
			label: options.label,
			server: version?.server_version,
			indexOptions: reloptions?.options ?? "",
			agents: options.agents,
			sessionsPerAgent: options.sessions,
			entriesPerSession: options.entries,
			wallMs: Math.round(wallMs),
			saves: summary(results.flatMap((result) => result.saves)),
			indexWrites: summary(results.flatMap((result) => result.indexWrites)),
			searches: summary(results.flatMap((result) => result.searches)),
			pendingAtEnd: gin,
			largestPendingMb: Math.round((largestPages * 8) / 1024),
			merges,
		};
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		if (options.out !== undefined) writeFileSync(options.out, JSON.stringify(report, null, 2));
	} finally {
		await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
		await admin.close();
	}
}

await main();
