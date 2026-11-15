/**
 * A sticky Intercom message a pooled stage received is recorded as delivered however many times the storage refused
 * the root's drain into that stage (#5023): the stage's own receipt counts, and its sender is never told otherwise.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { loadWorkerWorkflow } from "../../packages/workflows/src/workers/definitions.js";
import { PoolStageHandoff } from "../../packages/workflows/src/workers/stage-handoff.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

const TEST_TIMEOUT_MS = 180_000;
const CONDITION_TIMEOUT_MS = 60_000;
/** How long the sender keeps listening for a notice once the message settled. */
const NOTICE_GRACE_MS = 1_000;

test.skipIf(process.platform === "win32").each([0, 1, 2])(
	"a sticky message a pooled stage received is recorded delivered, without a notice to its sender, when the storage refused its handoff %i times (#5023)",
	{ timeout: TEST_TIMEOUT_MS },
	async (refusals) => {
		const directory = makeTempDirectory("pool-refused-delivery-");
		const broker = new IntercomBrokerFixture(join(directory, "agent"));
		broker.overrideAgentDir();
		const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		await database.exec("CREATE TABLE test_pool_gate(released INTEGER); INSERT INTO test_pool_gate VALUES (0)");
		const childPath = fileURLToPath(new URL("../fixtures/pool-refused-delivery-child.ts", import.meta.url));
		const child = await loadWorkerWorkflow(childPath, "child");
		const store = createStore();
		const root = testRunId("pool-refused-delivery");
		const controller = new AbortController();
		const client = new IntercomClient();
		client.on("error", () => {});
		const notices: unknown[] = [];
		client.on("message", (_from: unknown, message: unknown) => notices.push(message));
		// The root's drain into the stage is refused `refusals` times, as by a store that is briefly unavailable.
		let refused = 0;
		const deliver = PoolStageHandoff.prototype.deliver;
		const handoff = vi.spyOn(PoolStageHandoff.prototype, "deliver").mockImplementation(async function (
			this: PoolStageHandoff,
			...args: Parameters<PoolStageHandoff["deliver"]>
		) {
			if (refused < refusals) {
				refused++;
				throw new StorageUnavailableError(
					{ adapter: "node-sqlite", location: "journal.sqlite" },
					new Error("pending-stage delivery refused"),
				);
			}
			return deliver.apply(this, args);
		});
		let text: string | undefined;
		let execution: ReturnType<typeof run> | undefined;
		try {
			await broker.startSourceBroker(CONDITION_TIMEOUT_MS);
			await client.connect({
				name: "sender",
				cwd: directory,
				model: "fixture",
				pid: process.pid,
				startedAt: Date.now(),
				lastActivity: Date.now(),
				group: `workflow:${root}`,
			});
			execution = run(
				workflow({
					name: "pool-refused-delivery-root",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						text = (await ctx.workflow(child, { inputs: { journalPath: path } })).outputs?.text as string;
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
					toolControlRegistry: createToolControlRegistry(),
					localWorkers: { count: 2, definitions: [{ path: childPath, exportName: "child" }] },
				},
			);
			await untilOrRunEnds(
				async () => (await client.listDirectory()).workflowStages.some((stage) => stage.stageName === "agent"),
				execution,
				CONDITION_TIMEOUT_MS,
			);
			const marker = `refused-${refusals}-${Date.now()}`;
			let sent = await client.send(`workflow:${root}/**`, { text: marker });
			const deadline = Date.now() + CONDITION_TIMEOUT_MS;
			while (!sent.queued && !sent.delivered && Date.now() < deadline) {
				await sleep(25);
				sent = await client.send(`workflow:${root}/**`, { text: marker });
			}
			assert.ok(sent.queued, `the message was queued for the stage: ${JSON.stringify(sent)}`);
			await database.run("UPDATE test_pool_gate SET released = 1");
			const outcome = await execution;
			assert.equal(outcome.status, "completed", outcome.error);
			assert.equal(refused, refusals, "the handoff was refused as many times as the scenario asks");
			assert.equal(text?.split(marker).length, 2, "the stage's model saw the message once");
			const entry = () =>
				store.run(root)?.pendingStageMessages?.find((candidate) => candidate.message.id === sent.id);
			await untilOrRunEnds(
				async () => entry()?.status !== "queued",
				Promise.withResolvers<never>().promise,
				CONDITION_TIMEOUT_MS,
			);
			assert.equal(entry()?.status, "delivered", JSON.stringify(entry()));
			assert.equal(entry()?.undeliverableNotificationId, undefined);
			await sleep(NOTICE_GRACE_MS);
			assert.deepEqual(notices, [], "the sender is not told the message was undeliverable");
		} finally {
			handoff.mockRestore();
			controller.abort();
			await database.run("UPDATE test_pool_gate SET released = 1").catch(() => {});
			await execution?.catch(() => {});
			await client.disconnect();
			await backend.close();
			await journal.close();
			await database.close();
			await broker.cleanup();
			removeTempDirectory(directory);
		}
	},
);
