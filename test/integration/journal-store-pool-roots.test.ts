import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "vitest";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	readStreamText,
	removeTempDirectory,
	spawnProcess,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const WRITER = join(ROOT, "scripts/perf/journal-store/writer.ts");
const ROOTS = 3;
const WORKERS = 3;
const APPENDS = 30;
const PAYLOAD_BYTES = 64;
/** Nine Bun processes each load the workflow runtime from source before their first append. */
const POOL_ROOTS_TIMEOUT_MS = 180_000;

interface WriterReport {
	readonly root: string;
	readonly worker: string;
	readonly pid: number;
	readonly holders: readonly string[];
}

test(
	"three heavy pooled roots write at once and each shard's write lock has only its own root's processes as contenders (#4325)",
	async () => {
		const directory = makeTempDirectory("journal-store-pool-roots-");
		try {
			const store = join(directory, "journal");
			const ready = join(directory, "ready");
			const children = Array.from({ length: ROOTS }, (_, root) =>
				Array.from({ length: WORKERS }, (_, worker) =>
					spawnProcess(
						[
							bunExecutable(),
							WRITER,
							"store",
							store,
							`root-${root}`,
							String(worker),
							String(APPENDS),
							String(PAYLOAD_BYTES),
							ready,
							String(ROOTS * WORKERS),
						],
						{ cwd: ROOT },
					),
				),
			).flat();
			const reports = await Promise.all(
				children.map(async (child) => {
					const [stdout, stderr, exitCode] = await Promise.all([
						readStreamText(child.stdout),
						readStreamText(child.stderr),
						child.exited,
					]);
					assert.equal(exitCode, 0, stderr);
					return JSON.parse(stdout.trim().split("\n").at(-1)!) as WriterReport;
				}),
			);
			const shardOf = new Map<string, string>();
			for (const report of reports) {
				const shards = report.holders.filter((file) => file !== "catalog.sqlite");
				assert.equal(shards.length, 1, `${report.root} worker ${report.worker} took the lock of exactly one shard`);
				const known = shardOf.get(report.root);
				assert.ok(known === undefined || known === shards[0], `${report.root} stays on one shard`);
				shardOf.set(report.root, shards[0]!);
			}
			assert.equal(new Set(shardOf.values()).size, ROOTS, "every root has a shard of its own");
			for (const [root, shard] of shardOf) {
				const contenders = reports.filter((report) => report.holders.includes(shard));
				assert.deepEqual(
					contenders.map((report) => report.root),
					Array.from({ length: WORKERS }, () => root),
					`only ${root}'s ${WORKERS} processes contend for ${shard}`,
				);
			}
		} finally {
			removeTempDirectory(directory);
		}
	},
	POOL_ROOTS_TIMEOUT_MS,
);
