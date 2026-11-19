import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { SessionManager } from "../../packages/coding-agent/src/core/session-manager-core.js";
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

/** Hold only the return from a real file append to its existing post-write stat. No storage operation is replaced. */
async function editJsonlDuringAppend(writer: JsonlSessionStore, source: SessionManager, raw: boolean): Promise<void> {
	const path = source.getSessionFile();
	assert.ok(path);
	const peer = await JsonlSessionStore.open(dirname(path), { exactDirectory: true, scanExisting: false });
	const saved = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const fileState = writer as unknown as { remember(...args: unknown[]): Promise<unknown> };
	const remember = fileState.remember.bind(writer);
	const barrier = vi.spyOn(fileState, "remember").mockImplementationOnce(async (...args) => {
		saved.resolve();
		await release.promise;
		return remember(...args);
	});
	const append = source.appendMessage({ role: "user", content: "after launch", timestamp: 2 });
	try {
		await Promise.race([
			saved.promise,
			append.then(() => {
				throw new Error("append did not reach its post-write stat");
			}),
		]);
		if (raw) {
			const original = await readFile(path, "utf8");
			const edited = original.replace('"content":"before launch"', '"content":"edited launch"');
			assert.notEqual(edited, original);
			assert.equal(edited.length, original.length);
			await writeFile(path, edited);
		} else {
			const current = await peer.load(source.getSessionId());
			const edited = current.entries.map((entry, i) =>
				i === 0 && entry.type === "message" && entry.message.role === "user"
					? { ...entry, message: { ...entry.message, content: "edited launch" } }
					: entry,
			);
			await peer.replace(current.header.id, current.header, edited, { expectSeq: current.lastSeq });
		}
	} finally {
		release.resolve();
		try {
			await append;
		} finally {
			barrier.mockRestore();
			await peer.close();
		}
	}
}

test.each([
	"memory",
	"jsonl",
	"jsonl second handle",
	"jsonl peer replacement",
	"jsonl in-place edit",
	"jsonl no append during replay",
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
					const fork = {
						context: "fork" as const,
						forkFromSessionId: source.getSessionId(),
						sessionStore,
						...(kind === "jsonl no append during replay" ? { concurrency: 1 } : {}),
					};
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
						if (kind === "jsonl peer replacement" || kind === "jsonl in-place edit") {
							assert.ok(writer instanceof JsonlSessionStore);
							await editJsonlDuringAppend(writer, source, kind === "jsonl in-place edit");
						} else if (kind !== "jsonl no append during replay")
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
						if (kind === "jsonl no append during replay" && meta.stageName === "left")
							await source.appendMessage({ role: "user", content: "after admission", timestamp: 2 });
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
				kind === "jsonl peer replacement" || kind === "jsonl in-place edit"
					? ["edited launch", "after launch"]
					: kind === "replaced revision"
						? ["replacement 0", "replacement 1"]
						: sessionStore === writer && !kind.endsWith("source")
							? ["before launch"]
							: ["before launch", "after launch"];
			assert.deepEqual(
				prefixes,
				kind === "jsonl no append during replay"
					? [["before launch"], ["before launch", "after admission"]]
					: [expected, expected],
			);
		} finally {
			if (sessionStore !== writer) await sessionStore.close();
			await writer.close();
			await db?.close();
			removeTempDirectory(directory);
		}
	},
);
