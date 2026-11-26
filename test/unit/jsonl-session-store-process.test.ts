import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { it } from "vitest";
import { SessionConflictError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";

// Native ESM gives the store and its errors one canonical module identity on every platform.
const storeModule = new URL(
	"../../packages/coding-agent/dist/core/storage/session/jsonl-session-store.js",
	import.meta.url,
).href;
const errorsModule = new URL("./errors.js", storeModule).href;

async function raceWriters(directory: string, operation: "create" | "append"): Promise<string[]> {
	const children = ["/a", "/b"].map((cwd) => {
		const child = spawn(process.execPath, [
			"--input-type=module",
			"--eval",
			`
import assert from "node:assert/strict";
const { JsonlSessionStore } = await import(${JSON.stringify(storeModule)});
const { SessionConflictError, SessionExistsError } = await import(${JSON.stringify(errorsModule)});
const store = await JsonlSessionStore.open(${JSON.stringify(directory)});
console.log("READY");
await new Promise(resolve => process.stdin.once("data", resolve));
try {
  const header = { id: "shared", version: 4, cwd: ${JSON.stringify(cwd)}, createdAt: "2026-10-15T00:00:00Z" };
  if (${JSON.stringify(operation)} === "create") await store.create(header, []);
  else await store.append("shared", [{ type: "session_info", id: "entry", parentId: null, timestamp: header.createdAt, name: "text" }], { expectSeq: 0 });
  console.log("committed");
} catch (error) {
  if (${JSON.stringify(operation)} === "create") {
    assert.equal(error.constructor, SessionExistsError);
    assert.ok(error instanceof SessionExistsError);
    assert.equal(error.sessionId, "shared");
    console.log("exists");
  } else {
    assert.equal(error.constructor, SessionConflictError);
    assert.ok(error instanceof SessionConflictError);
    assert.equal(error.sessionId, "shared");
    assert.equal(error.expectedSeq, 0);
    assert.equal(error.actualSeq, 1);
    console.log("conflict");
  }
} finally { await store.close(); }
`,
		]);
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		return {
			child,
			exited: once(child, "close"),
			stderr: () => stderr,
			lines: createInterface({ input: child.stdout })[Symbol.asyncIterator](),
		};
	});
	try {
		await Promise.all(children.map(async ({ lines }) => assert.equal((await lines.next()).value, "READY")));
		for (const { child } of children) child.stdin.end("go\n");
		const outputs = await Promise.all(children.map(async ({ lines }) => String((await lines.next()).value)));
		for (const { exited, stderr } of children) assert.equal((await exited)[0], 0, stderr());
		return outputs.sort();
	} finally {
		for (const { child } of children) if (child.exitCode === null) child.kill();
		await Promise.all(children.map(({ exited }) => exited));
	}
}

it("detects duplicate creation and stale append across simultaneous writer processes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jsonl-process-"));
	try {
		assert.deepEqual(await raceWriters(directory, "create"), ["committed", "exists"]);
		assert.deepEqual(await raceWriters(directory, "append"), ["committed", "conflict"]);
		const store = await JsonlSessionStore.open(directory);
		try {
			assert.equal((await store.load("shared")).lastSeq, 1);
			const summaries = [];
			for await (const summary of store.list({})) summaries.push(summary);
			assert.equal(summaries.length, 1);
		} finally {
			await store.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

/** Far more than one write of `appendFile`, so the writer dies with part of the line on disk. */
const HUGE_ENTRY_BYTES = 64 * 1024 * 1024;

it("loads, lists and appends after a writer process is killed mid-append (#4993)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jsonl-torn-append-"));
	const header = { id: "torn", version: 4, cwd: "/project", createdAt: "2026-10-15T00:00:00Z" } as const;
	const acknowledged = Array.from({ length: 3 }, (_, index) => ({
		type: "session_info" as const,
		id: `entry-${index}`,
		parentId: null as string | null,
		timestamp: header.createdAt,
		name: `entry ${index}`,
	}));
	const seed = await JsonlSessionStore.open(directory);
	let path: string;
	try {
		await seed.create(header, acknowledged);
		path = (await seed.findFile(header.id))!;
	} finally {
		await seed.close();
	}
	const acknowledgedSize = (await stat(path)).size;
	const child = spawn(process.execPath, [
		"--input-type=module",
		"--eval",
		`
import { statSync } from "node:fs";
const { JsonlSessionStore } = await import(${JSON.stringify(storeModule)});
const store = await JsonlSessionStore.open(${JSON.stringify(directory)});
await store.load("torn");
// The append writes its line in chunks; the process dies between two of them, as a crash or a closed terminal would.
setInterval(() => {
  if (statSync(${JSON.stringify(path)}).size > ${acknowledgedSize}) process.kill(process.pid, "SIGKILL");
}, 0);
await store.append("torn", [{ type: "session_info", id: "huge", parentId: "entry-2", timestamp: ${JSON.stringify(header.createdAt)}, name: "x".repeat(${HUGE_ENTRY_BYTES}) }], { expectSeq: 3 });
console.log("ACKNOWLEDGED");
`,
	]);
	let stdout = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	const exited = once(child, "exit");
	try {
		const [code, signal] = await exited;
		assert.equal(stdout, "", "the append was acknowledged before the writer died");
		// Windows reports a killed process by its exit code rather than a signal.
		assert.ok(signal === "SIGKILL" || (code !== null && code !== 0), `exit ${code} ${signal}`);
		assert.ok((await stat(path)).size > acknowledgedSize, "the killed writer left part of its line");
		const store = await JsonlSessionStore.open(directory);
		try {
			assert.deepEqual((await store.load(header.id)).entries, acknowledged);
			const summaries = [];
			for await (const summary of store.list({})) summaries.push(summary);
			assert.deepEqual(
				summaries.map((summary) => summary.id),
				[header.id],
			);
			const next = { ...acknowledged[0]!, id: "next", parentId: "entry-2" };
			assert.deepEqual(await store.append(header.id, [next], { expectSeq: 3 }), { lastSeq: 4 });
			assert.deepEqual((await store.load(header.id)).entries, [...acknowledged, next]);
		} finally {
			await store.close();
		}
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
		await rm(directory, { recursive: true, force: true, maxRetries: 5 });
	}
});

it("recovers the filesystem lock after a writer process is killed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jsonl-killed-writer-"));
	const child = spawn(process.execPath, [
		"--input-type=module",
		"--eval",
		`
import lockfile from "proper-lockfile";
await lockfile.lock(${JSON.stringify(directory)}, { lockfilePath: ${JSON.stringify(join(directory, ".session.lock"))} });
console.log("LOCKED");
setInterval(() => {}, 1000);
`,
	]);
	const exited = once(child, "exit");
	try {
		const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
		assert.equal((await lines.next()).value, "LOCKED");
		child.kill("SIGKILL");
		await exited;
		assert.equal((await stat(join(directory, ".session.lock"))).isDirectory(), true);
		const store = await JsonlSessionStore.open(directory);
		try {
			await store.create({ id: "recovered", version: 4, cwd: "/project", createdAt: "2026-10-15T00:00:00Z" }, []);
			assert.equal((await store.load("recovered")).lastSeq, 0);
			await assert.rejects(
				stat(join(directory, ".session.lock")),
				(error: NodeJS.ErrnoException) => error.code === "ENOENT",
			);
		} finally {
			await store.close();
		}
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await exited;
		await rm(directory, { recursive: true, force: true });
	}
});

/** Writer processes, each making this many rounds of appends together, so their groups race one another. */
const RACING_WRITERS = 4;
const RACING_ROUNDS = 6;
const APPENDS_TOGETHER = 5;

it("keeps every acknowledged append of writer processes racing groups of appends at its own sequence (#6560)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jsonl-racing-groups-"));
	const header = { id: "raced", version: 4, cwd: "/project", createdAt: "2026-11-25T00:00:00Z" } as const;
	const seed = await JsonlSessionStore.open(directory);
	try {
		await seed.create(header, []);
	} finally {
		await seed.close();
	}
	const children = Array.from({ length: RACING_WRITERS }, (_, writer) => {
		const child = spawn(process.execPath, [
			"--input-type=module",
			"--eval",
			`
const { JsonlSessionStore } = await import(${JSON.stringify(storeModule)});
const { SessionConflictError } = await import(${JSON.stringify(errorsModule)});
const store = await JsonlSessionStore.open(${JSON.stringify(directory)});
let next = (await store.load("raced")).lastSeq;
console.log("READY");
await new Promise(resolve => process.stdin.once("data", resolve));
const acknowledged = [];
for (let round = 0; round < ${RACING_ROUNDS}; round++) {
  let pending = Array.from({ length: ${APPENDS_TOGETHER} }, (_, index) => ({
    type: "session_info", id: "w${writer}-r" + round + "-" + index, parentId: null, timestamp: "2026-11-25T00:00:00Z", name: "x".repeat(64),
  }));
  while (pending.length > 0) {
    const results = await Promise.allSettled(pending.map((entry, index) => store.append("raced", [entry], { expectSeq: next + index })));
    const retry = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        acknowledged.push([pending[index].id, result.value.lastSeq]);
        next = Math.max(next, result.value.lastSeq);
      } else if (result.reason instanceof SessionConflictError) {
        retry.push(pending[index]);
        next = Math.max(next, result.reason.actualSeq);
      } else throw result.reason;
    }
    pending = retry;
  }
}
await store.close();
console.log(JSON.stringify(acknowledged));
`,
		]);
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		return {
			child,
			exited: once(child, "close"),
			stderr: () => stderr,
			lines: createInterface({ input: child.stdout })[Symbol.asyncIterator](),
		};
	});
	try {
		await Promise.all(children.map(async ({ lines }) => assert.equal((await lines.next()).value, "READY")));
		for (const { child } of children) child.stdin.end("go\n");
		const acknowledged = (
			await Promise.all(
				children.map(async ({ lines }) => JSON.parse(String((await lines.next()).value)) as [string, number][]),
			)
		).flat();
		for (const { exited, stderr } of children) assert.equal((await exited)[0], 0, stderr());
		const store = await JsonlSessionStore.open(directory);
		try {
			const { entries, lastSeq } = await store.load(header.id);
			const total = RACING_WRITERS * RACING_ROUNDS * APPENDS_TOGETHER;
			assert.equal(lastSeq, total);
			assert.equal(acknowledged.length, total);
			assert.equal(new Set(entries.map((entry) => entry.id)).size, total, "no entry is lost or written twice");
			for (const [id, seq] of acknowledged) assert.equal(entries[seq - 1]?.id, id, `${id} at ${seq}`);
		} finally {
			await store.close();
		}
	} finally {
		for (const { child } of children) if (child.exitCode === null) child.kill();
		await Promise.all(children.map(({ exited }) => exited));
		await rm(directory, { recursive: true, force: true });
	}
});

/** Entries this large make one group's write many slices long, so the writer dies partway through it. */
const GROUP_ENTRY_BYTES = 2 * 1024 * 1024;
const GROUP_APPENDS = 8;
/** The writer dies once this much of its group is on disk: two whole lines and part of the third. */
const KILL_AFTER_BYTES = 2.5 * GROUP_ENTRY_BYTES;

it("recovers from a writer process killed while it writes a group of appends, through a handle kept meanwhile (#6560)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jsonl-killed-group-"));
	const header = { id: "group", version: 4, cwd: "/project", createdAt: "2026-11-25T00:00:00Z" } as const;
	const first = {
		type: "session_info" as const,
		id: "first",
		parentId: null,
		timestamp: header.createdAt,
		name: "first",
	};
	// This store keeps its handle on the file open while the other process writes and dies.
	const store = await JsonlSessionStore.open(directory);
	try {
		await store.create(header, []);
		await store.append(header.id, [first], { expectSeq: 0 });
		const path = (await store.findFile(header.id))!;
		const acknowledgedSize = (await stat(path)).size;
		const child = spawn(process.execPath, [
			"--input-type=module",
			"--eval",
			`
import { statSync } from "node:fs";
const { JsonlSessionStore } = await import(${JSON.stringify(storeModule)});
const store = await JsonlSessionStore.open(${JSON.stringify(directory)});
await store.load("group");
setInterval(() => {
  if (statSync(${JSON.stringify(path)}).size > ${acknowledgedSize + KILL_AFTER_BYTES}) process.kill(process.pid, "SIGKILL");
}, 0);
await Promise.all(Array.from({ length: ${GROUP_APPENDS} }, (_, index) =>
  store.append("group", [{ type: "session_info", id: "lost-" + index, parentId: null, timestamp: ${JSON.stringify(header.createdAt)}, name: "x".repeat(${GROUP_ENTRY_BYTES}) }], { expectSeq: 1 + index })));
console.log("ACKNOWLEDGED");
`,
		]);
		let stdout = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		const [code, signal] = await once(child, "exit");
		assert.equal(stdout, "", "the group was acknowledged before the writer died");
		assert.ok(signal === "SIGKILL" || (code !== null && code !== 0), `exit ${code} ${signal}`);
		const size = (await stat(path)).size;
		assert.ok(size > acknowledgedSize, "the killed writer left part of its group");
		// Whole lines it wrote before it died were never acknowledged; whatever it wrote of the next is torn.
		const reopened = await JsonlSessionStore.open(directory);
		let survivors: number;
		try {
			const { entries } = await reopened.load(header.id);
			survivors = entries.length - 1;
			assert.deepEqual(entries[0], first);
			assert.deepEqual(
				entries.slice(1).map((entry) => entry.id),
				Array.from({ length: survivors }, (_, index) => `lost-${index}`),
			);
			assert.ok(survivors < GROUP_APPENDS);
		} finally {
			await reopened.close();
		}
		const next = { ...first, id: "next" };
		if (survivors > 0)
			await assert.rejects(store.append(header.id, [next], { expectSeq: 1 }), (error: Error) => {
				assert.ok(error instanceof SessionConflictError);
				assert.equal(error.actualSeq, 1 + survivors);
				return true;
			});
		assert.deepEqual(await store.append(header.id, [next], { expectSeq: 1 + survivors }), { lastSeq: 2 + survivors });
		const { entries } = await store.load(header.id);
		assert.deepEqual(entries.at(-1), next);
		assert.equal(entries.length, 2 + survivors);
		const text = await readFile(path, "utf8");
		assert.ok(text.endsWith(`${JSON.stringify(next)}\n`), "the torn line is gone and the append ends the file");
		assert.ok(text.length < size + 1024, "the torn line was cut off before the append");
	} finally {
		await store.close();
		await rm(directory, { recursive: true, force: true, maxRetries: 5 });
	}
});
