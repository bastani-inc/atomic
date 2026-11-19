import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { stripWorkflowOnlyOptions } from "../../packages/workflows/src/runs/foreground/stage-runner-options.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { appendProseTurn, mockSession, run, workflow } from "./executor-shared.js";
import type { AgentSessionAdapter } from "./stage-runner-helpers.js";

useTemporaryAgentDir();
afterEach(closeMemoryTestBackends);

test.each([
	"memory",
	"jsonl",
	"jsonl second handle",
	"sqlite",
	"per-step source",
	"overridden source",
	"computed source",
	"replaced revision",
])(
	"a parallel captures its fork without locking the source before an earlier replay write finishes (%s, #5630)",
	async (kind) => {
		const backend = await createMemoryTestBackend();
		const runId = randomUUID();
		const directory = makeTempDirectory("fork-before-replay-");
		let locks = 0;
		const mkdir = new Proxy(fs.mkdir, {
			apply(target, self, args) {
				locks++;
				return Reflect.apply(target, self, args);
			},
		});
		const db = kind === "sqlite" ? await openNodeSqliteDatabase(join(directory, "sessions.db")) : undefined;
		const writer = db
			? await SqlSessionStore.open(db)
			: kind.startsWith("jsonl")
				? await JsonlSessionStore.open(directory)
				: new MemorySessionStore();
		const sessionStore =
			kind === "jsonl second handle"
				? await JsonlSessionStore.open(directory, {
						scanExisting: false,
						lockFs: { ...fs, mkdir },
					})
				: writer;
		try {
			const { sessionManager: source } = await stripWorkflowOnlyOptions({ sessionStore: writer }, undefined, {
				runId,
				stageId: "source",
				stageName: "source",
			});
			assert.ok(source);
			await source.appendMessage({ role: "user", content: "before launch", timestamp: 1 });

			let replay = false;
			let captureLocks = 0;
			const writing = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const prefixes: unknown[][] = [];
			const definition = workflow({
				name: "fork-during-replay",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					const cached = ctx.stage("cached");
					if (!replay) {
						await cached.complete("saved");
						return {};
					}
					await writing.promise;
					locks = 0;
					const fork = { context: "fork" as const, forkFromSessionId: source.getSessionId(), sessionStore };
					const steps = [
						{ name: "left", prompt: "left" },
						{ name: "right", prompt: "right" },
					];
					let admission = false;
					const group =
						kind === "per-step source"
							? ctx.parallel(steps.map((step) => ({ ...step, ...fork })))
							: kind === "overridden source"
								? ctx.parallel(
										steps.map((step) => ({ ...step, sessionStore })),
										fork,
									)
								: kind === "computed source"
									? ctx.parallel(steps, {
											...fork,
											get sessionStore() {
												assert.ok(admission, "storage getter ran before admission");
												return sessionStore;
											},
										})
									: ctx.parallel(steps, fork);
					try {
						await source.appendMessage({ role: "user", content: "after launch", timestamp: 2 });
						if (kind === "replaced revision") {
							const snapshot = await writer.load(fork.forkFromSessionId);
							// The replacement deliberately keeps both IDs and the length. Neither identifies this generation.
							await writer.replace(
								fork.forkFromSessionId,
								snapshot.header,
								snapshot.entries.map((entry, i) =>
									entry.type === "message" && entry.message.role === "user"
										? { ...entry, message: { ...entry.message, content: `replacement ${i}` } }
										: entry,
								),
								{ expectSeq: snapshot.lastSeq },
							);
						}
						assert.deepEqual(prefixes, [], "no child opens before the replay write is released");
						captureLocks = locks;
					} finally {
						admission = true;
						release.resolve();
					}
					await group;
					return {};
				},
			});
			const agentSession: AgentSessionAdapter = {
				async create({ sessionManager }, meta) {
					if (meta?.stageName === "left" || meta?.stageName === "right") {
						assert.ok(sessionManager);
						prefixes.push(
							sessionManager.buildSessionContext().messages.map((m) => ("content" in m ? m.content : m.role)),
						);
					}
					const session = mockSession(sessionManager);
					session.prompt = async () => appendProseTurn(session.messages);
					return session;
				},
			};
			const options = {
				runId,
				durableBackend: backend,
				adapters: { complete: { complete: async (text: string) => text }, agentSession },
			};
			const execute = () => run(definition, {}, { ...options, store: createStore() });
			assert.equal((await execute()).status, "completed");
			replay = true;
			const commit = backend.commitCheckpoint.bind(backend);
			backend.commitCheckpoint = async (checkpoint, options) => {
				if (checkpoint.checkpointId.startsWith("stage-replay-meta:")) {
					writing.resolve();
					await release.promise;
				}
				return commit(checkpoint, options);
			};
			const resumed = await execute();
			assert.equal(resumed.status, "completed", resumed.error);
			assert.equal(captureLocks, 0, "capturing the prefix must not take the source writer's lock");
			const expected =
				kind === "replaced revision"
					? ["replacement 0", "replacement 1"]
					: sessionStore === writer && !kind.endsWith("source")
						? ["before launch"]
						: ["before launch", "after launch"];
			assert.deepEqual(prefixes, [expected, expected]);
		} finally {
			if (sessionStore !== writer) await sessionStore.close();
			await writer.close();
			await db?.close();
			removeTempDirectory(directory);
		}
	},
);
