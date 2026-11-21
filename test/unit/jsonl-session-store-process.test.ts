import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { it } from "vitest";
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
