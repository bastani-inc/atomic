/**
 * Orders and shards test files by their measured duration instead of vitest's defaults.
 *
 * Vitest's own sequencer runs larger files first when it has no local results cache (every CI run), and its `--shard`
 * splits files by a hash of their path. Both ignore duration, so a five-minute pool file could start last, and one
 * shard could draw several of them. This sequencer starts the longest files first and balances shards by their
 * expected wall time, using the per-file durations measured on CI for the current OS and recorded in
 * `test-file-durations.json` (refresh it with `scripts/test-file-durations.ts`; see docs/ci.md). The root suites and
 * the coding-agent suite share it and its record, which is keyed by repository-relative path.
 *
 * Every shard sees the same file list and computes the same assignment, so each file runs in exactly one shard.
 * A file missing from the record (a new one) is weighted `UNKNOWN_FILE_MS`; a stale record only skews the balance,
 * it never drops or repeats a file.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { repositoryRoot } from "../../vitest.base.js";

/** Weight of a file with no recorded duration: above most integration files, so a new heavy file is not started last. */
export const UNKNOWN_FILE_MS = 20_000;

/**
 * What a file costs a worker beyond its tests: collecting it (transform and import). The integration shards of run
 * 40569411594 spent 88 s of worker time importing 44 files, and its Windows unit run 1,879 s on 1,089 files: about
 * 2 s each.
 */
export const FILE_OVERHEAD_MS = 2_000;

/**
 * Files one shard runs at once: vitest's default worker count on the 8-vCPU CI runners. A constant, not the local
 * core count, so every shard computes the same assignment even on a differently sized machine.
 */
export const SHARD_WORKERS = 7;

/** Recorded per-file durations in milliseconds, keyed by repository-relative path with forward slashes. */
export type FileDurations = Readonly<Record<string, number>>;

/** One record per CI OS: file times differ between them, and many pool files do not run on Windows. */
export type DurationRecord = Readonly<Record<"linux" | "win32", FileDurations>>;

const record: DurationRecord = JSON.parse(readFileSync(new URL("./test-file-durations.json", import.meta.url), "utf8"));
const recordedDurations = process.platform === "win32" ? record.win32 : record.linux;

function weightOf(path: string, durations: FileDurations): number {
	return (durations[path] ?? UNKNOWN_FILE_MS) + FILE_OVERHEAD_MS;
}

/**
 * The files of shard `index` (1-based) of `count`. A shard's expected wall time is its longest file or its total
 * spread over `SHARD_WORKERS`, whichever is larger. Each file, heaviest first, goes to the shard whose expected wall
 * time would be lowest with it (the lighter total on a tie, then the lower-numbered shard). Ties between files break
 * by path, so the result depends only on the set of paths, not on the order they arrive in.
 */
export function shardByDuration(
	paths: readonly string[],
	durations: FileDurations,
	index: number,
	count: number,
): string[] {
	const ordered = [...paths].sort(
		(a, b) => weightOf(b, durations) - weightOf(a, durations) || (a < b ? -1 : a > b ? 1 : 0),
	);
	const shards = Array.from({ length: count }, () => ({ paths: [] as string[], total: 0, longest: 0 }));
	const wallTime = (total: number, longest: number) => Math.max(longest, total / SHARD_WORKERS);
	for (const path of ordered) {
		const weight = weightOf(path, durations);
		let best = 0;
		for (let candidate = 1; candidate < count; candidate++) {
			const a = shards[candidate]!;
			const b = shards[best]!;
			const difference =
				wallTime(a.total + weight, Math.max(a.longest, weight)) -
				wallTime(b.total + weight, Math.max(b.longest, weight));
			if (difference < 0 || (difference === 0 && a.total < b.total)) best = candidate;
		}
		const shard = shards[best]!;
		shard.paths.push(path);
		shard.total += weight;
		shard.longest = Math.max(shard.longest, weight);
	}
	return shards[index - 1]?.paths ?? [];
}

export class DurationSequencer extends BaseSequencer {
	private key(spec: TestSpecification): string {
		return relative(repositoryRoot, spec.moduleId).replaceAll("\\", "/");
	}

	override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
		const { index, count } = this.ctx.config.shard!;
		const selected = new Set(
			shardByDuration([...new Set(files.map((spec) => this.key(spec)))], recordedDurations, index, count),
		);
		return files.filter((spec) => selected.has(this.key(spec)));
	}

	/** Vitest's order (projects one after another), then heaviest first within each project. */
	override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
		const base = await super.sort(files);
		const projects = [...new Set(base.map((spec) => spec.project.name))];
		return base.sort(
			(a, b) =>
				projects.indexOf(a.project.name) - projects.indexOf(b.project.name) ||
				weightOf(this.key(b), recordedDurations) - weightOf(this.key(a), recordedDurations),
		);
	}
}
