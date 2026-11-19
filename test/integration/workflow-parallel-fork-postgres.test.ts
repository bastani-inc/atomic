import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { afterEach, test } from "vitest";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { postgresSkipReason, postgresTestPassword, withPostgresDatabase } from "../helpers/postgres-database.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { appendProseTurn, mockSession, run, workflow } from "../unit/executor-shared.js";
import type { AgentSessionAdapter } from "../unit/stage-runner-helpers.js";

useTemporaryAgentDir();
afterEach(closeMemoryTestBackends);

test.skipIf(postgresSkipReason !== undefined)(
	"a fork waiting for replay does not queue a locked source table ahead of unrelated writes (#5630)",
	async () => {
		await withPostgresDatabase(async (scope) => {
			const database = await scope.open({ schema: "forks" });
			const source = await SqlSessionStore.open(database, { prefix: "a_" }),
				other = await SqlSessionStore.open(database, { prefix: "b_" });
			// External maintenance locks only this table, not a workflow transaction domain.
			const url = new URL(scope.url);
			url.password = postgresTestPassword ?? "";
			const maintenance = new pg.Client({ connectionString: url.href });
			const timestamp = new Date(0).toISOString(),
				id = randomUUID();
			const header = { id, cwd: process.cwd(), createdAt: timestamp, version: 4 as const };
			const entry = {
				type: "message",
				id: "one",
				parentId: null,
				timestamp,
				message: { role: "user", timestamp: 0, content: "one" },
			} as const;
			const backend = await createMemoryTestBackend(),
				runId = randomUUID();
			const earlier = Promise.withResolvers<void>(),
				release = Promise.withResolvers<void>();
			let replay = false,
				opens = 0,
				wroteWhileLocked = false;
			try {
				await maintenance.connect();
				await source.create(header, [entry]);
				await other.create(header, [entry]);
				const definition = workflow({
					name: "independent-table",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						const saved = ctx.stage("saved");
						if (!replay) {
							await saved.complete("ready");
							return {};
						}
						await earlier.promise;
						const group = ctx.parallel([{ name: "worker", prompt: "hello" }], {
							context: "fork",
							sessionStore: source,
							forkFromSessionId: id,
						});
						const write = other
							.append(id, [{ ...entry, id: "two", parentId: "one" }], { expectSeq: 1 })
							.then(() => {
								wroteWhileLocked = true;
							});
						let waiting = false;
						try {
							const deadline = AbortSignal.timeout(15000);
							while (!wroteWhileLocked) {
								deadline.throwIfAborted();
								const result = await maintenance.query(
									"SELECT 1 FROM pg_locks WHERE relation=to_regclass('forks.a_session_sessions') AND NOT granted LIMIT 1",
								);
								if (result.rows.length) {
									waiting = true;
									break;
								}
								await delay(5);
							}
							assert.equal(opens, 0);
						} finally {
							await maintenance.query("ROLLBACK");
							release.resolve();
							await Promise.all([group, write]);
						}
						assert.equal(waiting, false, "a read of the held table blocked an independent append");
						return {};
					},
				});
				const agentSession: AgentSessionAdapter = {
					async create({ sessionManager }) {
						opens++;
						const session = mockSession(sessionManager);
						session.prompt = async () => appendProseTurn(session.messages);
						return session;
					},
				};
				const execute = () =>
					run(
						definition,
						{},
						{
							runId,
							store: createStore(),
							durableBackend: backend,
							adapters: { complete: { complete: async (text) => text }, agentSession },
						},
					);
				assert.equal((await execute()).status, "completed");
				replay = true;
				const commit = backend.commitCheckpoint.bind(backend);
				backend.commitCheckpoint = async (checkpoint, options) => {
					if (checkpoint.checkpointId.startsWith("stage-replay-meta:")) {
						earlier.resolve();
						await release.promise;
					}
					return commit(checkpoint, options);
				};
				await maintenance.query("BEGIN");
				await maintenance.query("LOCK TABLE forks.a_session_sessions IN ACCESS EXCLUSIVE MODE");
				const result = await execute();
				assert.equal(result.status, "completed", result.error);
				assert.equal(opens, 1);
			} finally {
				release.resolve();
				await maintenance.end();
				await source.close();
				await other.close();
			}
		});
	},
);
