/**
 * Orders and shards test files by their measured duration instead of vitest's defaults.
 *
 * Vitest's own sequencer runs larger files first when it has no local results cache (every CI run), and its `--shard`
 * splits files by a hash of their path. Both ignore duration, so a five-minute pool file could start last, and one
 * shard could draw several of them. This sequencer starts the longest files first and assigns files to shards by
 * longest-processing-time-first, using the per-file durations recorded in `integration-file-durations.json`
 * (refresh it with `bun run scripts/integration-file-durations.ts <vitest JSON reports...>`).
 *
 * Every shard sees the same file list and computes the same assignment, so each file runs in exactly one shard.
 * A file missing from the record (a new one) is weighted `UNKNOWN_FILE_MS`; a stale record only skews the balance,
 * it never drops or repeats a file.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/** Weight of a file with no recorded duration: above most integration files, so a new heavy file is not started last. */
export const UNKNOWN_FILE_MS = 20_000;

/** Recorded per-file durations in milliseconds, keyed by repository-relative path with forward slashes. */
export type FileDurations = Readonly<Record<string, number>>;

const recordedDurations: FileDurations = JSON.parse(
	readFileSync(new URL("./integration-file-durations.json", import.meta.url), "utf8"),
);

function weightOf(path: string, durations: FileDurations): number {
	return durations[path] ?? UNKNOWN_FILE_MS;
}

/**
 * The files of shard `index` (1-based) of `count`: each file, heaviest first, goes to the shard with the least total
 * weight so far, the lowest-numbered shard on a tie. Ties between files break by path, so the result depends only on
 * the set of paths, not on the order they arrive in.
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
	const totals = new Array<number>(count).fill(0);
	const shards = Array.from({ length: count }, (): string[] => []);
	for (const path of ordered) {
		const lightest = totals.indexOf(Math.min(...totals));
		totals[lightest] = (totals[lightest] ?? 0) + weightOf(path, durations);
		shards[lightest]?.push(path);
	}
	return shards[index - 1] ?? [];
}

export class DurationSequencer extends BaseSequencer {
	private key(spec: TestSpecification): string {
		return relative(this.ctx.config.root, spec.moduleId).replaceAll("\\", "/");
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
