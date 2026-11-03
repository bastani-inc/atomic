import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import {
	committedWorker,
	crashAfterFirstStep,
	observe,
	pidAlive,
	queuedWork,
	ROOT,
	recordedCheckpoints,
	STALE_COORDINATOR_AGE_MS,
	startCoordinator,
	until,
} from "../helpers/public-pool-lifecycle.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

/** Structural: each case starts, crashes and resumes root processes that each fork a pool coordinator and a worker. */
const PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS = 180_000;

/**
 * A crashed public pool root resumes after its workflow's files were edited: an imported helper (with new pool settings)
 * or, only when the resume accepts it, its worker's entry module. Split from workflow-public-pool-lifecycle.test.ts so
 * the two files' root processes run in parallel.
 */
/** A helper module the resumable child imports, as a workflow's gate functions import a library file. */
const helperSource = (version: string) =>
	`export function gate(label: string): string {\n\treturn "${version}:" + label;\n}\n`;
/** The lifecycle child's shape, but each step reports what the helper returned instead of a process instance id. */
const helperChildSource = `import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";
import { gate } from "./lib/gate.ts";

export const child = workflow({
	name: "pool-resume-helper-child",
	description: "Records a step through a helper, then waits for release",
	inputs: { releasePath: Type.String() },
	outputs: { firstPid: Type.Number(), finalPid: Type.Number(), firstInstance: Type.String(), finalInstance: Type.String() },
	async run(ctx) {
		const first = await ctx.tool("checkpoint", {}, async () => ({ pid: process.pid, instance: gate("first") }));
		const final = await ctx.tool("finish", {}, async () => {
			while (!existsSync(ctx.inputs.releasePath)) await delay(20);
			return { pid: process.pid, instance: gate("final") };
		});
		return { firstPid: first.pid, finalPid: final.pid, firstInstance: first.instance, finalInstance: final.instance };
	},
});
`;

test.skipIf(process.platform === "win32")(
	"a crashed root resumes after an imported helper is edited and the pool size and root limits change, keeping its recorded steps (#4196)",
	async () => {
		const directory = makeTempDirectory("public-pool-resume-changes-");
		const definition = join(directory, "workflows", "child.ts");
		const helper = join(directory, "workflows", "lib", "gate.ts");
		await writeFileEnsuringDir(definition, helperChildSource);
		await writeFileEnsuringDir(helper, helperSource("v1"));
		const first = startCoordinator(directory, "fresh", { definition });
		let second: ReturnType<typeof startCoordinator> | undefined;
		try {
			await first.next("ready");
			const recorded = await committedWorker(directory);
			assert.equal(recorded.instance, "v1:first");
			await first.stop();
			await until("the orphaned worker to exit", () => (pidAlive(recorded.pid) ? undefined : true));
			observe(directory, (database) =>
				database.run(
					"UPDATE wf_leases SET renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? WHERE run_id = ?",
					STALE_COORDINATOR_AGE_MS,
					ROOT,
				),
			);
			await writeFileEnsuringDir(helper, helperSource("v2"));
			await writeFileEnsuringDir(join(directory, "release"), "ready");
			// The fresh root saved one worker and limits { session: 2, process: 1 }; the settings have changed since.
			second = startCoordinator(directory, "restart", {
				definition,
				settings: {
					localWorkers: { count: 2, definitions: [{ path: definition, exportName: "child" }] },
					admission: { limits: { session: 3, process: 2 } },
				},
			});
			await second.next("ready");
			const result = await second.next("result");
			assert.equal(result.status, "completed", JSON.stringify(result));
			// The step recorded before the crash is replayed, not run again; the step after it runs the edited helper.
			assert.equal(result.outputs?.firstInstance, "v1:first");
			assert.equal(result.outputs?.finalInstance, "v2:final");
			assert.equal(
				observe(directory, (database) =>
					Number(
						database
							.query(
								"SELECT COUNT(*) AS count FROM wf_events WHERE json_extract(payload, '$.name') = 'checkpoint'",
							)
							.get()!.count,
					),
				),
				1,
			);
			await second.stop();
			// The root records the settings it resumed with, so its next resume starts from them.
			const backend = await JournalDurableBackend.open(
				await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } }),
			);
			try {
				await backend.hydrateWorkflow(ROOT);
				const resources = backend.getWorkflow(ROOT)?.resources;
				assert.equal(resources?.localWorkers?.count, 2);
				assert.deepEqual(resources?.admission?.limits, { session: 3, process: 2 });
			} finally {
				await backend.close();
			}
		} finally {
			await first.stop();
			await second?.stop();
			removeTempDirectory(directory);
		}
	},
	PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS,
);

/** A child whose entry module itself names the version of it that ran each step. */
const versionedChildSource = (version: string) => `import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";

export const child = workflow({
	name: "pool-resume-entry-child",
	description: "Records a step, then waits for release",
	inputs: { releasePath: Type.String() },
	outputs: { firstPid: Type.Number(), finalPid: Type.Number(), firstInstance: Type.String(), finalInstance: Type.String() },
	async run(ctx) {
		const first = await ctx.tool("checkpoint", {}, async () => ({ pid: process.pid, instance: "${version}:first" }));
		const final = await ctx.tool("finish", {}, async () => {
			while (!existsSync(ctx.inputs.releasePath)) await delay(20);
			return { pid: process.pid, instance: "${version}:final" };
		});
		return { firstPid: first.pid, finalPid: final.pid, firstInstance: first.instance, finalInstance: final.instance };
	},
});
`;

test.skipIf(process.platform === "win32")(
	"a crashed root resumes after its worker's entry module is edited only when the resume accepts the edit, and its queued child runs the edited module (#4200)",
	async () => {
		const directory = makeTempDirectory("public-pool-resume-entry-");
		const definition = join(directory, "workflows", "child.ts");
		await writeFileEnsuringDir(definition, versionedChildSource("v1"));
		const first = startCoordinator(directory, "fresh", { definition });
		let refused: ReturnType<typeof startCoordinator> | undefined;
		let accepted: ReturnType<typeof startCoordinator> | undefined;
		try {
			await first.next("ready");
			const recorded = await crashAfterFirstStep(directory, first);
			assert.equal(recorded.instance, "v1:first");
			const queued = queuedWork(directory);
			await writeFileEnsuringDir(definition, versionedChildSource("v2"));
			const edited = createHash("sha256").update(readFileSync(definition)).digest("hex");
			await writeFileEnsuringDir(join(directory, "release"), "ready");
			// Without the opt-in the resume is refused before it starts; the refusal names the module and the opt-in.
			refused = startCoordinator(directory, "restart", { definition });
			const refusal = (await refused.next("error")).message ?? "";
			assert.ok(
				refusal.includes(
					`the entry module of worker definition ${definition}#child was edited (sha256 ${queued.digest.slice(0, 12)} to ${edited.slice(0, 12)})`,
				),
				refusal,
			);
			assert.match(refusal, /--accept-entry-changes/);
			assert.match(refusal, /acceptEntryChanges/);
			await refused.stop();
			assert.equal(recordedCheckpoints(directory), 1);

			accepted = startCoordinator(directory, "restart", { definition, settings: { acceptEntryChanges: true } });
			await accepted.next("ready");
			const result = await accepted.next("result");
			assert.equal(result.status, "completed", JSON.stringify(result));
			// The step recorded before the crash is replayed, not run again; the step after it runs the edited module.
			assert.equal(result.outputs?.firstInstance, "v1:first");
			assert.equal(result.outputs?.finalInstance, "v2:final");
			assert.equal(recordedCheckpoints(directory), 1);
			const rebound = queuedWork(directory);
			assert.equal(rebound.id, queued.id, "the queued child is the same work, not a second one");
			assert.equal(rebound.digest, edited);
			await accepted.stop();
			// The root records the module it resumed with, so a later resume of it needs no opt-in again.
			const backend = await JournalDurableBackend.open(
				await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } }),
			);
			try {
				await backend.hydrateWorkflow(ROOT);
				assert.deepEqual(
					backend.getWorkflow(ROOT)?.resources?.definitions?.map((source) => source.digest),
					[edited],
				);
			} finally {
				await backend.close();
			}
		} finally {
			await first.stop();
			await refused?.stop();
			await accepted?.stop();
			removeTempDirectory(directory);
		}
	},
	PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS,
);
