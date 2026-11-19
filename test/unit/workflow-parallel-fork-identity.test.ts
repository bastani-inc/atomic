import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { afterEach, test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionEntry, SessionStore } from "../../packages/coding-agent/src/index.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { appendProseTurn, mockSession, run, workflow } from "./executor-shared.js";
import type { AgentSessionAdapter } from "./stage-runner-helpers.js";

useTemporaryAgentDir();
afterEach(closeMemoryTestBackends);
const timestamp = new Date(0).toISOString();
function messages(...contents: string[]): SessionEntry[] {
	return contents.map((content, i) => ({
		id: content,
		parentId: contents[i - 1] ?? null,
		timestamp,
		type: "message",
		message: { role: "user", timestamp: 0, content },
	}));
}

for (const kind of ["separate SQL stores at one address", "replaced session", "strict store adapter"] as const) {
	test(`parallel children copy the selected source: ${kind} (#5630)`, async () => {
		const databases =
			kind === "separate SQL stores at one address"
				? await Promise.all([0, 1].map(() => openNodeSqliteDatabase("file:fork?mode=memory&cache=private")))
				: [];
		const stores = databases.length
			? await Promise.all(databases.map((db) => SqlSessionStore.open(db)))
			: [new MemorySessionStore()];
		const header = { id: randomUUID(), cwd: process.cwd(), createdAt: timestamp, version: 4 as const };
		try {
			const first = stores[0]!;
			await first.create(header, messages("A1"));
			const other = stores[1];
			if (other) await other.create(header, messages("B1", "B2", "B3"));
			const selected: SessionStore =
				kind !== "strict store adapter"
					? first
					: new Proxy(first, {
							get(target, key) {
								if (typeof key === "string" && ["forkSourceKey", "readForkLength"].includes(key))
									throw new TypeError(`unexpected store property ${key}`);
								const value = Reflect.get(target, key, target);
								return typeof value === "function" ? value.bind(target) : value;
							},
						});
			const copies: unknown[][] = [];
			const agentSession: AgentSessionAdapter = {
				async create({ sessionManager }) {
					assert.ok(sessionManager);
					copies.push(sessionManager.buildSessionContext().messages.map((m) => "content" in m && m.content));
					if (kind === "replaced session" && copies.length === 1)
						await first.replace(header.id, header, messages("B1", "B2", "B3"), { expectSeq: 1 });
					const session = mockSession(sessionManager);
					session.prompt = async () => appendProseTurn(session.messages);
					return session;
				},
			};
			const definition = workflow({
				name: "parallel-source",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx.parallel(
						[
							{ name: "left", prompt: "left", sessionStore: selected },
							{ name: "right", prompt: "right", sessionStore: other ?? selected },
						],
						{ context: "fork", forkFromSessionId: header.id, concurrency: 1 },
					);
					return {};
				},
			});
			const result = await run(
				definition,
				{},
				{ store: createStore(), durableBackend: await createMemoryTestBackend(), adapters: { agentSession } },
			);
			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(copies, [["A1"], kind === "strict store adapter" ? ["A1"] : ["B1", "B2", "B3"]]);
		} finally {
			for (const store of stores) await store.close();
			for (const db of databases) await db.close();
		}
	});
}

test("an unstarted fork does not make a stale JSONL writer forget its original file (#5630)", async () => {
	const dir = makeTempDirectory("parallel-stale-file-");
	const store = await JsonlSessionStore.open(dir, { exactDirectory: true });
	const writer = await JsonlSessionStore.open(dir, { exactDirectory: true });
	try {
		const header = { id: randomUUID(), cwd: dir, createdAt: timestamp, version: 4 as const };
		await store.create(header, messages("original"));
		const file = store.locationFor(header);
		await rename(file, `${file}.archive`);
		const opening = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const definition = workflow({
			name: "parallel-writer",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const group = ctx
					.parallel(
						[
							{ name: "first", prompt: "first" },
							{
								name: "queued",
								prompt: "queued",
								context: "fork",
								forkFromSessionId: header.id,
								sessionStore: store,
							},
						],
						{ concurrency: 1 },
					)
					.catch(() => {});
				await opening.promise;
				try {
					await writer.create(header, messages("replacement"));
					await assert.rejects(store.replace(header.id, header, messages("stale"), { expectSeq: 1 }), {
						name: "SessionConflictError",
					});
				} finally {
					release.resolve();
					await group;
				}
				return {};
			},
		});
		const agentSession: AgentSessionAdapter = {
			async create() {
				opening.resolve();
				await release.promise;
				throw new Error("stop first worker");
			},
		};
		const result = await run(
			definition,
			{},
			{ store: createStore(), durableBackend: await createMemoryTestBackend(), adapters: { agentSession } },
		);
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual((await writer.load(header.id)).entries, messages("replacement"));
	} finally {
		await writer.close();
		await store.close();
		removeTempDirectory(dir);
	}
});
