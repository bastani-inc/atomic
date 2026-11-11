#!/usr/bin/env bun
/**
 * Benchmark for what resuming a long-running session costs before its prompt is usable (#4660).
 *
 * Builds a synthetic session (see `fixtures.ts`): `--entries` history entries across compactions, snapshots of a
 * project and its sibling worktrees recorded throughout, and background subagents recorded as running, with the
 * project changed after its last snapshot. It then measures, `--rounds` times on a fresh copy each round, the steps a
 * resume runs in this process: loading the session, preparing its checkouts, and the reads startup repeats (branch,
 * worktree restores, latest snapshots, snapshot records, name, model context). It reports the median of each step.
 *
 *   bun run scripts/perf/resume-startup/benchmark.ts --entries 200000 --checkouts 6 --rounds 3 --out /tmp/resume.md
 *
 * The time to a usable prompt of the whole interactive start, the isolated engine included, comes from running
 * `ATOMIC_STARTUP_BENCHMARK=1 atomic --session <id>` in a terminal with `ATOMIC_CODING_AGENT_DIR` set to the fixture's
 * agent directory, which `--keep` leaves in place and prints.
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	prepareSessionResume,
	sessionResumeOptions,
} from "../../../packages/coding-agent/src/core/resume/session-resume.ts";
import { SessionManager } from "../../../packages/coding-agent/src/core/session-manager.ts";
import { resolveSessionStore } from "../../../packages/coding-agent/src/core/session-storage.ts";
import { SettingsManager } from "../../../packages/coding-agent/src/core/settings-manager.ts";
import { createLargeSession } from "./fixtures.ts";

interface Options {
	readonly entries: number;
	readonly checkouts: number;
	readonly rounds: number;
	readonly reads: number;
	readonly keep: boolean;
	readonly out?: string;
}

function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	return {
		entries: Number(value("entries") ?? "200000"),
		checkouts: Number(value("checkouts") ?? "6"),
		rounds: Number(value("rounds") ?? "3"),
		reads: Number(value("reads") ?? "20"),
		keep: argv.includes("--keep"),
		...(value("out") === undefined ? {} : { out: value("out") }),
	};
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function timed<T>(samples: number[], run: () => Promise<T> | T): Promise<T> {
	const start = performance.now();
	const result = await run();
	samples.push(performance.now() - start);
	return result;
}

const options = parseOptions(process.argv.slice(2));
const base = mkdtempSync(join(tmpdir(), "atomic-resume-startup-"));
const pristine = join(base, "pristine");
const fixture = await createLargeSession({
	dir: pristine,
	entries: options.entries,
	checkouts: options.checkouts,
	files: 3_000,
	toolResultBytes: 2_000,
	compactionEvery: 40_000,
	snapshotEvery: 200,
	runningChildren: 11,
});
const steps = { load: [] as number[], prepare: [] as number[], reads: [] as number[] };
const { agentDir, project } = fixture;
const sessions = join(pristine, "workflows");
const savedSessions = join(base, "saved-workflows");
cpSync(sessions, savedSessions, { recursive: true });
try {
	for (let round = 0; round < options.rounds; round++) {
		rmSync(sessions, { recursive: true, force: true });
		rmSync(join(agentDir, "worktree-snapshots"), { recursive: true, force: true });
		cpSync(savedSessions, sessions, { recursive: true });
		const store = await resolveSessionStore(project, { agentDir });
		try {
			const manager = await timed(steps.load, () => SessionManager.open(store, fixture.sessionId));
			const prepared = await timed(steps.prepare, () =>
				prepareSessionResume(manager, {
					...sessionResumeOptions("cli", project, agentDir, SettingsManager.inMemory(), () => true),
					blueprints: "skip",
				}),
			);
			const opened = prepared.status === "ready" ? prepared.sessionManager : manager;
			await timed(steps.reads, () => {
				for (let read = 0; read < options.reads; read++) {
					opened.getBranch();
					opened.getWorktreeRootMappings();
					opened.getLatestWorktreeSnapshots();
					opened.getWorktreeSnapshotRecords();
					opened.getSessionName();
					opened.buildSessionContext();
				}
			});
		} finally {
			await store.close();
		}
	}
	const report = [
		`# Resume startup: ${options.entries} entries, ${options.checkouts} checkouts, median of ${options.rounds}`,
		"",
		"| Step | Median ms |",
		"| --- | ---: |",
		`| load the session | ${median(steps.load).toFixed(0)} |`,
		`| prepare its checkouts | ${median(steps.prepare).toFixed(0)} |`,
		`| ${options.reads} rounds of startup reads | ${median(steps.reads).toFixed(0)} |`,
		"",
	].join("\n");
	console.log(report);
	if (options.out) writeFileSync(options.out, report);
	if (options.keep) {
		console.log(`fixture: ATOMIC_CODING_AGENT_DIR=${fixture.agentDir} atomic --session ${fixture.sessionId}`);
	}
} finally {
	if (!options.keep) rmSync(base, { recursive: true, force: true });
}
