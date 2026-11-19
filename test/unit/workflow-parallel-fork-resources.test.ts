import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readlinkSync } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { collectGarbage } from "../helpers/collect-garbage.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { run, workflow } from "./executor-shared.js";

useTemporaryAgentDir();
afterEach(closeMemoryTestBackends);
const timestamp = new Date(0).toISOString();
const header = (id: string, cwd: string) => ({ id, cwd, createdAt: timestamp, version: 4 as const });
const entry = {
	type: "message",
	id: "one",
	parentId: null,
	timestamp,
	message: { role: "user", timestamp: 0, content: "original" },
} as const;

/** Lower only this isolated test worker's soft limit, never its hard limit. */
function limitDescriptors(): () => void {
	if (process.platform !== "linux") return () => {};
	const args = ["--pid", String(process.pid)];
	const [soft, hard] = execFileSync(
		"prlimit",
		[...args, "--nofile", "--output", "SOFT,HARD", "--noheadings", "--raw"],
		{ encoding: "utf8" },
	)
		.trim()
		.split(/\s+/);
	if (Number(soft) <= 256) return () => {};
	const set = (limit: string) => execFileSync("prlimit", [...args, `--nofile=${limit}:${hard}`]);
	set("256");
	return () => {
		set(soft!);
	};
}

test("a single-slot parallel leaves descriptors for the workflow's own file reads (#5630)", async () => {
	const directory = makeTempDirectory("single-slot-io-");
	const ids = Array.from({ length: 768 }, () => randomUUID());
	const file = join(directory, "input.txt");
	const writer = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
	try {
		await writeFile(file, "input from disk");
		for (let i = 0; i < ids.length; i += 16)
			await Promise.all(
				ids.slice(i, i + 16).map((id) => {
					const source = header(id, directory);
					return writeFile(
						writer.locationFor(source),
						`${JSON.stringify({ type: "session", ...source })}\n${JSON.stringify(entry)}\n`,
					);
				}),
			);
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const backend = await createMemoryTestBackend();
		try {
			let opens = 0;
			let input: string | undefined;
			const definition = workflow({
				name: "serial-forks",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					const group = ctx.parallel(
						ids.map((id, i) => ({ name: `worker-${i}`, prompt: "work", forkFromSessionId: id })),
						{ context: "fork", sessionStore: store, concurrency: 1 },
					);
					const stopped = assert.rejects(group, /stop first worker/);
					input = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => error.code);
					await stopped;
					return {};
				},
			});
			const restore = limitDescriptors();
			try {
				const result = await run(
					definition,
					{},
					{
						store: createStore(),
						durableBackend: backend,
						adapters: {
							agentSession: {
								async create() {
									++opens;
									throw new Error("stop first worker");
								},
							},
						},
					},
				);
				assert.equal(input, "input from disk");
				assert.equal(result.status, "completed", result.error);
				assert.equal(opens, 1);
			} finally {
				restore();
			}
		} finally {
			await store.close();
		}
	} finally {
		await writer.close();
		removeTempDirectory(directory);
	}
});

test.skipIf(process.platform !== "linux")(
	"closing a source after fail-fast leaves no open transcript for an unstarted worker (#5630)",
	async () => {
		const directory = makeTempDirectory("unstarted-transcript-");
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		let closed = false;
		try {
			const source = header(randomUUID(), directory),
				path = store.locationFor(source);
			const file = await open(path, "wx");
			try {
				await file.writeFile(`${JSON.stringify({ type: "session", ...source })}\n`);
				const content = "a".repeat(192);
				for (let start = 0; start < 200_000; start += 1000) {
					await file.writeFile(
						Array.from({ length: 1000 }, (_, j) => {
							const i = start + j;
							return `${JSON.stringify({ ...entry, id: `e${i}`, parentId: i ? `e${i - 1}` : null, message: { ...entry.message, content } })}\n`;
						}).join(""),
					);
				}
			} finally {
				await file.close();
			}
			const definition = workflow({
				name: "unstarted",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await assert.rejects(
						ctx.parallel(
							[
								{ name: "first", prompt: "first" },
								{
									name: "queued",
									prompt: "queued",
									context: "fork",
									forkFromSessionId: source.id,
									sessionStore: store,
								},
							],
							{ concurrency: 1 },
						),
						/stop first worker/,
					);
					return {};
				},
			});
			const result = await run(
				definition,
				{},
				{
					store: createStore(),
					durableBackend: await createMemoryTestBackend(),
					adapters: {
						agentSession: {
							async create() {
								throw new Error("stop first worker");
							},
						},
					},
				},
			);
			assert.equal(result.status, "completed", result.error);
			await store.close();
			closed = true;
			const targets = readdirSync("/proc/self/fd").map((fd) => {
				try {
					return readlinkSync(`/proc/self/fd/${fd}`);
				} catch {
					return undefined;
				}
			});
			assert.ok(!targets.includes(path), "store.close() left a queued fork reading the transcript");
		} finally {
			if (!closed) await store.close();
			removeTempDirectory(directory);
		}
	},
);

test("retaining one adapter's stage options does not keep its unstarted siblings' stores alive (#5630)", async () => {
	let kept: unknown;
	const refs: WeakRef<MemorySessionStore>[] = [];
	async function execute() {
		const id = randomUUID();
		const stores = Array.from({ length: 32 }, () => new MemorySessionStore());
		try {
			for (const [i, store] of stores.entries()) {
				await store.create(header(id, process.cwd()), [entry]);
				if (i) refs.push(new WeakRef(store));
			}
			const definition = workflow({
				name: "closed-stores",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await assert.rejects(
						ctx.parallel(
							stores.map((sessionStore, i) => ({ name: `worker-${i}`, prompt: "work", sessionStore })),
							{ context: "fork", forkFromSessionId: id, concurrency: 1 },
						),
						/stop first worker/,
					);
					return {};
				},
			});
			const result = await run(
				definition,
				{},
				{
					store: createStore(),
					durableBackend: await createMemoryTestBackend(),
					adapters: {
						agentSession: {
							async create(_opts, meta) {
								kept = meta?.stageOptions;
								throw new Error("stop first worker");
							},
						},
					},
				},
			);
			assert.equal(result.status, "completed", result.error);
		} finally {
			for (const store of stores) await store.close();
		}
	}
	await execute();
	await collectGarbage();
	assert.ok(kept);
	assert.equal(refs.filter((ref) => ref.deref() !== undefined).length, 0);
});
