import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import type { PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import {
	decodeStream,
	fileExistsSync,
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	spawnProcess,
} from "../helpers/runtime.js";

const POOL_CRASH_PROCESS_TIMEOUT_MS = 120_000;
const fixturePath = fileURLToPath(new URL("../fixtures/pool-commit-crash.mjs", import.meta.url));

interface ProcessEvent {
	event: string;
	lease?: Lease;
	attempt?: PoolWork;
	generation?: number;
	epoch?: number;
}

function start(mode: string, path: string, cwd: string) {
	const child = spawnProcess([process.execPath, fixturePath, mode, path], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.ok(child.stdout);
	const reader = decodeStream(child.stdout).getReader();
	const stderr = readStreamText(child.stderr);
	let buffer = "";
	return {
		child,
		stderr,
		send(value: ProcessEvent | { ready: ProcessEvent; committed: ProcessEvent; crashed: string }) {
			child.stdin?.write(`${JSON.stringify(value)}\n`);
		},
		async next(): Promise<ProcessEvent> {
			while (!buffer.includes("\n")) {
				const next = await reader.read();
				if (next.done) assert.fail(`Process exited before its event: ${await stderr}`);
				buffer += next.value;
			}
			const end = buffer.indexOf("\n");
			const event = JSON.parse(buffer.slice(0, end)) as ProcessEvent;
			buffer = buffer.slice(end + 1);
			return event;
		},
		async finished() {
			assert.equal(await child.exited, 0, await stderr);
			assert.equal(buffer, "");
			assert.equal((await reader.read()).done, true);
		},
		async kill() {
			child.kill("SIGKILL");
			assert.notEqual(await child.exited, 0);
			assert.equal(buffer, "");
			assert.equal((await reader.read()).done, true);
		},
	};
}

test.each(["worker", "coordinator"] as const)(
	"%s crash before commit acknowledgement recovers fenced checkpoints and transcripts in a fresh process (#3869)",
	async (crashed) => {
		const directory = makeTempDirectory("pool-crash-database-");
		const scratch = makeTempDirectory("pool-crash-scratch-");
		const replacementScratch = makeTempDirectory("pool-crash-replacement-");
		const path = join(directory, "journal.sqlite");
		const children: ReturnType<typeof start>[] = [];
		try {
			const coordinator = start("coordinator", path, scratch);
			children.push(coordinator);
			const ready = await coordinator.next();
			assert.equal(ready.event, "ready");
			assert.ok(ready.lease);
			assert.ok(ready.attempt);
			const worker = start("worker", path, scratch);
			children.push(worker);
			const request = await worker.next();
			assert.equal(request.event, "request");
			coordinator.send(request);
			const committed = await coordinator.next();
			assert.equal(committed.event, "committed");
			if (crashed === "worker") {
				await worker.kill();
				coordinator.send({ event: "release-ack" });
				assert.equal((await coordinator.next()).event, "acknowledged");
				await coordinator.finished();
			} else {
				await coordinator.kill();
				await worker.kill();
			}
			removeTempDirectory(scratch);
			assert.equal(fileExistsSync(scratch), false);
			const recovery = start("recover", path, replacementScratch);
			children.push(recovery);
			recovery.send({ ready, committed, crashed });
			assert.deepEqual(await recovery.next(), {
				event: "recovered",
				generation: ready.attempt.generation + 1,
				epoch: ready.lease.epoch + (crashed === "coordinator" ? 1 : 0),
			});
			await recovery.finished();
		} finally {
			for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
			await Promise.all(children.map(({ child }) => child.exited));
			removeTempDirectory(directory);
			removeTempDirectory(scratch);
			removeTempDirectory(replacementScratch);
		}
	},
	POOL_CRASH_PROCESS_TIMEOUT_MS,
);
