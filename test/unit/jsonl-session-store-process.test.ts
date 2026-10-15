import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";

const storeModule = fileURLToPath(
	new URL("../../packages/coding-agent/src/core/storage/session/jsonl-session-store.ts", import.meta.url),
);
const errorsModule = fileURLToPath(
	new URL("../../packages/coding-agent/src/core/storage/session/errors.ts", import.meta.url),
);

async function raceWriters(directory: string, operation: "create" | "append"): Promise<string[]> {
	const children = ["/a", "/b"].map((cwd) => {
		const child = spawn(process.execPath, [
			"--input-type=module",
			"--eval",
			`
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { JsonlSessionStore } = await jiti.import(${JSON.stringify(storeModule)});
const { SessionConflictError, SessionExistsError } = await jiti.import(${JSON.stringify(errorsModule)});
const store = await JsonlSessionStore.open(${JSON.stringify(directory)});
console.log("READY");
await new Promise(resolve => process.stdin.once("data", resolve));
try {
  const header = { id: "shared", version: 4, cwd: ${JSON.stringify(cwd)}, createdAt: "2026-10-15T00:00:00Z" };
  if (${JSON.stringify(operation)} === "create") await store.create(header, []);
  else await store.append("shared", [{ type: "session_info", id: "entry", parentId: null, timestamp: header.createdAt, name: "text" }], { expectSeq: 0 });
  console.log("committed");
} catch (error) {
  if (error instanceof SessionExistsError) console.log("exists");
  else if (error instanceof SessionConflictError && error.expectedSeq === 0 && error.actualSeq === 1) console.log("conflict");
  else throw error;
} finally { await store.close(); }
`,
		]);
		return {
			child,
			exited: once(child, "exit"),
			lines: createInterface({ input: child.stdout })[Symbol.asyncIterator](),
		};
	});
	try {
		await Promise.all(children.map(async ({ lines }) => assert.equal((await lines.next()).value, "READY")));
		for (const { child } of children) child.stdin.end("go\n");
		const outputs = await Promise.all(children.map(async ({ lines }) => String((await lines.next()).value)));
		for (const { exited } of children) assert.equal((await exited)[0], 0);
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
