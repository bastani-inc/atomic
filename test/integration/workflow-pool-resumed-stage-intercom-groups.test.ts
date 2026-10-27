import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { loadWorkerWorkflow } from "../../packages/workflows/src/workers/definitions.js";
import { POOL_JOIN_GROUP } from "../fixtures/pool-intercom-join-child.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** Structural: a coordinator and two worker processes in turn run the pooled child. */
const WORKER_INTERCOM_TIMEOUT_MS = 180_000;
const BROKER_STARTUP_TIMEOUT_MS = 60_000;
const CONDITION_TIMEOUT_MS = 60_000;

function marker(directory: string, prefix: string): string | undefined {
	return readdirSync(directory).find((name) => name.startsWith(prefix));
}

test.skipIf(process.platform === "win32")(
	"a pooled stage resumed on a replacement worker keeps the group it joined, reachable by path and by name (#4079)",
	async () => {
		const directory = makeTempDirectory("pool-stage-groups-");
		const broker = new IntercomBrokerFixture(join(directory, "agent"));
		broker.overrideAgentDir();
		const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
		const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
		const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
		const intercomPath = fileURLToPath(new URL("../../packages/intercom", import.meta.url));
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const childPath = fileURLToPath(new URL("../fixtures/pool-intercom-join-child.ts", import.meta.url));
		const child = await loadWorkerWorkflow(childPath, "child");
		const store = createStore();
		const root = testRunId("pool-stage-groups");
		const controller = new AbortController();
		const launcher = new IntercomClient();
		const teammate = new IntercomClient();
		for (const client of [launcher, teammate]) client.on("error", () => {});
		let execution: ReturnType<typeof run> | undefined;
		try {
			broker.trackBroker(
				spawn(process.execPath, [getJitiCliPath(intercomPath), join(intercomPath, "broker/broker.ts")], {
					env: process.env,
					stdio: "ignore",
				}),
			);
			await broker.holdSession(getBrokerSocketPath(), BROKER_STARTUP_TIMEOUT_MS);
			const registration = (group: string) => ({
				cwd: directory,
				model: "fixture",
				pid: process.pid,
				startedAt: Date.now(),
				lastActivity: Date.now(),
				group,
				groups: [group],
			});
			await launcher.connect(registration(`workflow:${root}`));
			await teammate.connect({ ...registration(POOL_JOIN_GROUP), name: "pool-stage-teammate" });
			execution = run(
				workflow({
					name: "pool-stage-groups-root",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						await ctx.workflow(child, { inputs: { directory } });
						return {};
					},
				}),
				{},
				{
					runId: root,
					cwd: directory,
					store,
					durableBackend: backend,
					signal: controller.signal,
					localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
				},
			);
			const stageInTeam = async () =>
				(await teammate.listSessions()).find(
					(session) => session.id !== teammate.sessionId && session.groups?.includes(POOL_JOIN_GROUP),
				);
			await untilOrRunEnds(
				async () => marker(directory, "joined-") !== undefined && (await stageInTeam()) !== undefined,
				execution,
				CONDITION_TIMEOUT_MS,
			);
			const before = await stageInTeam();
			assert.ok(before);
			const firstWorker = Number(marker(directory, "joined-")!.slice("joined-".length));
			process.kill(firstWorker, "SIGKILL");

			await untilOrRunEnds(
				async () => marker(directory, "resumed-") !== undefined && (await stageInTeam()) !== undefined,
				execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.equal(marker(directory, "fresh-session"), undefined, "the replacement resumed the stage's own session");
			const after = await stageInTeam();
			assert.ok(after?.name, "the resumed stage is listed by name in the group it joined");
			assert.ok(
				after.groups?.every((group) => group === POOL_JOIN_GROUP || group.startsWith(`workflow:${root}`)),
				`no membership beyond its own: ${after.groups?.join(", ")}`,
			);

			const byName = await teammate.send(after.name, { text: "pool-token-by-name" });
			assert.equal(byName.delivered, true, byName.reason);
			const stage = (await launcher.listDirectory()).workflowStages.find((entry) => entry.stageName === "agent");
			assert.ok(stage, "the launcher still sees the resumed stage");
			const byPath = await launcher.send(`workflow:${root}/${stage.runId}/${stage.stageId}`, {
				text: "pool-token-by-path",
			});
			assert.ok(byPath.delivered === true || byPath.queued === true, byPath.reason);

			await writeFileEnsuringDir(join(directory, "release"), "");
			assert.equal((await execution).status, "completed");
		} finally {
			controller.abort();
			await writeFileEnsuringDir(join(directory, "release"), "");
			await execution?.catch(() => {});
			await teammate.disconnect().catch(() => {});
			await launcher.disconnect().catch(() => {});
			await backend.close();
			await journal.close();
			await database.close();
			await broker.cleanup();
			removeTempDirectory(directory);
		}
	},
	WORKER_INTERCOM_TIMEOUT_MS,
);
