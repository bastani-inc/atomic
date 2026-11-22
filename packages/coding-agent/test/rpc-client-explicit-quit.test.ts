import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, test } from "vitest";
import { QueuedWriter } from "../src/modes/rpc/queued-writer.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

const tempDirs: string[] = [];

/** An engine child that answers an `engine_explicit_quit` frame the way `behavior` says. */
function writeChildScript(behavior: "ack" | "ignore" | "exit"): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-rpc-explicit-quit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(
		path,
		`import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify({ type: "engine_ready", protocolVersion: 4, pid: process.pid }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	if (JSON.parse(line).type !== "engine_explicit_quit") return;
	if (${JSON.stringify(behavior)} === "ack") process.stdout.write(JSON.stringify({ type: "engine_explicit_quit_ack" }) + "\\n");
	if (${JSON.stringify(behavior)} === "exit") process.exit(0);
});
process.stdin.resume();
`,
	);
	return path;
}

async function startClient(behavior: "ack" | "ignore" | "exit"): Promise<RpcClient> {
	const client = new RpcClient({ cliPath: writeChildScript(behavior), interactiveEngine: { onDiagnostic: () => {} } });
	await client.start();
	return client;
}

/** Far longer than any ack round trip, so finishing well inside it proves the wait did not time out. */
const LONG_WAIT_MS = 20_000;
/** Larger than any pipe's buffer: writing it does not complete until the engine child reads it. */
const PIPE_FILLING_TEXT = "x".repeat(4 * 1024 * 1024);
/** An ack wait the busy engine child, which reads nothing yet, always misses. */
const MISSED_ACK_WAIT_MS = 100;

/**
 * An engine child too busy to read its input, as on a loaded machine: it reads nothing until `go` exists, then reads
 * what its host sent until its input ends or stays quiet, and writes to `seen` whether it got the explicit quit. A
 * signal does not end it first: its host's stop asks with SIGTERM on Linux and macOS, and ends its input on Windows.
 */
function writeBusyChildScript(go: string, seen: string): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-rpc-explicit-quit-busy-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(
		path,
		`import { existsSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
process.stdin.pause();
process.stdout.write(JSON.stringify({ type: "engine_ready", protocolVersion: 4, pid: process.pid }) + "\\n");
const finish = (input) => {
	const lines = input.split("\\n").filter((line) => line.length > 0).map((line) => JSON.parse(line).type);
	writeFileSync(${JSON.stringify(seen)}, JSON.stringify(lines));
	process.exit(0);
};
const waitForGo = setInterval(() => {
	if (!existsSync(${JSON.stringify(go)})) return;
	clearInterval(waitForGo);
	let input = "";
	let quiet;
	const done = () => finish(input);
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		input += chunk;
		clearTimeout(quiet);
		quiet = setTimeout(done, 1000);
	});
	process.stdin.on("end", done);
	quiet = setTimeout(done, 1000);
	process.stdin.resume();
}, 20);
`,
	);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RpcClient.announceExplicitQuit", () => {
	test("returns once the engine child acknowledges the quit (#3492)", async () => {
		const client = await startClient("ack");
		try {
			const startedAt = performance.now();
			assert.equal(await client.announceExplicitQuit(LONG_WAIT_MS), true);
			assert.ok(performance.now() - startedAt < LONG_WAIT_MS / 2);
		} finally {
			await client.stop();
		}
	});

	test("stops waiting when the engine child exits instead of acknowledging (#3492)", async () => {
		const client = await startClient("exit");
		try {
			const startedAt = performance.now();
			assert.equal(await client.announceExplicitQuit(LONG_WAIT_MS), false);
			assert.ok(performance.now() - startedAt < LONG_WAIT_MS / 2);
		} finally {
			await client.stop();
		}
	});

	test("gives up after the deadline when the engine child never acknowledges (#3492)", async () => {
		const client = await startClient("ignore");
		try {
			const startedAt = performance.now();
			assert.equal(await client.announceExplicitQuit(100), false);
			assert.ok(performance.now() - startedAt >= 90);
		} finally {
			await client.stop();
		}
	});

	test("an explicit quit whose ack the busy engine child misses still reaches it, ahead of what waits to be written", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-rpc-explicit-quit-files-"));
		tempDirs.push(dir);
		const go = join(dir, "go");
		const seen = join(dir, "seen.json");
		const client = new RpcClient({
			cliPath: writeBusyChildScript(go, seen),
			interactiveEngine: { onDiagnostic: () => {} },
		});
		await client.start();
		// The child reads nothing yet: this prompt's write does not complete, and the next frame waits behind it.
		void client.prompt(PIPE_FILLING_TEXT).catch(() => {});
		void client.prompt("queued behind it").catch(() => {});

		assert.equal(await client.announceExplicitQuit(MISSED_ACK_WAIT_MS), false);
		const stopping = client.stop({ graceful: true });
		writeFileSync(go, "");
		const deadline = Date.now() + LONG_WAIT_MS;
		while (!existsSync(seen) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		await stopping;

		const types = JSON.parse(readFileSync(seen, "utf8")) as string[];
		// The prompt being written when the quit was announced, then the quit; what waited behind them never left.
		assert.deepEqual(types, ["prompt", "engine_explicit_quit"]);
	});

	test("returns immediately when no engine child is running (#3492)", async () => {
		assert.equal(
			await new RpcClient({ interactiveEngine: { onDiagnostic: () => {} } }).announceExplicitQuit(LONG_WAIT_MS),
			false,
		);
	});
});

describe("QueuedWriter.writeUrgent", () => {
	/**
	 * A stream whose writes complete only when the reader reads, as a pipe's do: each `read()` completes the write in
	 * progress. `written` lists what the stream handed on, frame by frame, in order.
	 */
	function heldStream(): { stream: Writable; written: string[]; read: () => Promise<void> } {
		const written: string[] = [];
		let complete: (() => void) | undefined;
		const stream = new Writable({
			write(chunk: Buffer, _encoding, callback) {
				written.push(chunk.toString("utf8"));
				complete = () => callback();
			},
		});
		const read = async () => {
			for (let turn = 0; turn < 20; turn++) {
				const next = complete;
				complete = undefined;
				next?.();
				await new Promise((resolve) => setImmediate(resolve));
			}
		};
		return { stream, written, read };
	}

	test("hands its frame to the stream whole, behind the frame in flight and ahead of the queued ones", async () => {
		const { stream, written, read } = heldStream();
		const writer = new QueuedWriter(stream);
		const inFlight = `${JSON.stringify({ type: "prompt", message: PIPE_FILLING_TEXT })}\n`;
		const urgent = `${JSON.stringify({ type: "engine_explicit_quit" })}\n`;
		const queued = `${JSON.stringify({ type: "prompt", message: "queued" })}\n`;
		void writer.write(inFlight).catch(() => {});
		void writer.write(queued).catch(() => {});
		const urgentWritten = writer.writeUrgent(urgent);

		// While the reader reads nothing, the stream holds the urgent frame right behind the one in flight.
		assert.deepEqual(written, [inFlight]);
		assert.equal(stream.writableLength, Buffer.byteLength(inFlight) + Buffer.byteLength(urgent));
		await read();
		await urgentWritten;
		assert.deepEqual(written, [inFlight, urgent, queued], "whole frames, the urgent one ahead of the queued one");
	});

	test("a frame handed to the stream is still delivered when the writer closes and the stream ends", async () => {
		const { stream, written, read } = heldStream();
		const writer = new QueuedWriter(stream);
		void writer.write("in flight\n").catch(() => {});
		void writer.write("queued\n").catch(() => {});
		const urgentWritten = writer.writeUrgent("urgent\n");

		writer.close();
		stream.end();
		await assert.rejects(urgentWritten);
		await assert.rejects(writer.writeUrgent("after close\n"));
		await read();

		assert.deepEqual(written, ["in flight\n", "urgent\n"], "only the frame that was still queued is dropped");
	});
});
