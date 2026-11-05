import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { journalStoreDirectory, journalStoreEnvironment } from "../helpers/journal-store.js";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	readStreamText,
	removeTempDirectory,
	spawnProcess,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/journal-store-campaign.ts");
const CAMPAIGNS = 3;
const CHECKPOINTS = 25;
/** Three Bun processes each load the workflow runtime from source before their first checkpoint. */
const PARALLEL_CAMPAIGNS_TIMEOUT_MS = 120_000;

interface CampaignReport {
	readonly label: string;
	readonly runId: string;
	readonly pid: number;
	readonly shard: string;
	readonly holders: readonly string[];
}

test(
	"three campaigns started in parallel with no journal settings land on different shards and never share a write lock (#4325)",
	async () => {
		const directory = makeTempDirectory("journal-store-campaigns-");
		try {
			const children = Array.from({ length: CAMPAIGNS }, (_, index) =>
				spawnProcess(
					[bunExecutable(), FIXTURE, directory, `campaign-${index}`, String(CAMPAIGNS), String(CHECKPOINTS)],
					{
						cwd: ROOT,
						env: journalStoreEnvironment(directory),
					},
				),
			);
			const outputs = await Promise.all(
				children.map(async (child) => {
					const [stdout, stderr, exitCode] = await Promise.all([
						readStreamText(child.stdout),
						readStreamText(child.stderr),
						child.exited,
					]);
					assert.equal(exitCode, 0, stderr);
					return JSON.parse(stdout.trim().split("\n").at(-1)!) as CampaignReport;
				}),
			);
			const store = journalStoreDirectory(directory);
			const catalogPath = join(store, "catalog.sqlite");
			assert.equal(
				new Set(outputs.map((report) => report.shard)).size,
				CAMPAIGNS,
				"each campaign has its own shard",
			);
			for (const report of outputs) {
				assert.equal(resolve(report.shard, ".."), store);
				assert.ok(report.holders.includes(report.shard.slice(store.length + 1)), "it wrote its own shard");
				assert.deepEqual(
					report.holders.filter((file) => file !== "catalog.sqlite").map((file) => join(store, file)),
					[report.shard],
					`${report.label} took the write lock of no other shard`,
				);
				const shard = new DatabaseSync(report.shard, { readOnly: true });
				try {
					assert.deepEqual(
						shard
							.prepare("SELECT DISTINCT run_id FROM wf_events")
							.all()
							.map((row) => row.run_id),
						[report.runId],
					);
					const tools = shard
						.prepare(
							"SELECT count(*) AS n, count(DISTINCT json_extract(payload, '$.name')) AS names FROM wf_events WHERE type = 'CheckpointRecorded' AND json_extract(payload, '$.kind') = 'tool' AND json_extract(payload, '$.name') LIKE 'checkpoint-%'",
						)
						.get();
					assert.deepEqual(
						[tools?.n, tools?.names],
						[CHECKPOINTS, CHECKPOINTS],
						"every checkpoint is recorded once",
					);
					assert.equal(shard.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
				} finally {
					shard.close();
				}
			}
			const catalog = new DatabaseSync(catalogPath, { readOnly: true });
			try {
				assert.deepEqual(
					catalog
						.prepare("SELECT run_id, status FROM catalog_runs ORDER BY run_id")
						.all()
						.map((row) => [row.run_id, row.status]),
					outputs.map((report) => [report.runId, "completed"]).sort(),
				);
				assert.equal(catalog.prepare("SELECT count(*) AS n FROM catalog_shards").get()?.n, CAMPAIGNS);
			} finally {
				catalog.close();
			}
		} finally {
			removeTempDirectory(directory);
		}
	},
	PARALLEL_CAMPAIGNS_TIMEOUT_MS,
);
