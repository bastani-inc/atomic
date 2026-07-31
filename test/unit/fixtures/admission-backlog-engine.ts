/**
 * Engine child that reproduces the worst ordering for request ownership.
 *
 * On its first generation it accepts a command, buries the admission frame
 * behind several reader turns of valid frames, performs a real side effect,
 * hands stdout to a descendant that keeps the pipe open, and exits. The host
 * therefore sees the child die while the frame that says "I started this work"
 * is still unparsed — and its automatic recovery begins in that same turn.
 *
 * The replacement generation just reports ready and stays alive, so the test can
 * see that recovery finished without waiting for the descendant.
 */
import { spawn } from "node:child_process";
import { writeFileSync, writeSync } from "node:fs";

import { INTERACTIVE_ENGINE_PROTOCOL_VERSION } from "../../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";

const marker = process.env.ATOMIC_ADMISSION_MARKER;
const generationFile = process.env.ATOMIC_ADMISSION_GENERATION;

function write(value: object): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Write a whole payload to fd 1 synchronously, retrying EAGAIN.
 *
 * A Node parent hands this child a non-blocking stdout pipe, so a synchronous
 * burst larger than the pipe buffer fails with EAGAIN instead of blocking the
 * way it does under a Bun parent. The host's reader is always draining, so a
 * brief synchronous pause and retry always makes progress.
 */
function writeAllSync(text: string): void {
	const bytes = Buffer.from(text, "utf8");
	let offset = 0;
	while (offset < bytes.length) {
		try {
			offset += writeSync(1, bytes, offset, bytes.length - offset);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	}
}

const replacement = process.env.ATOMIC_ADMISSION_REPLACEMENT === "1";
// Recorded before readiness is announced, never after. The host treats
// engine_ready as the point a generation exists, so a generation that appended
// its pid afterwards could be counted by the host and still be missing from this
// file when the test reads it.
if (generationFile) writeFileSync(generationFile, `${process.pid}\n`, { flag: "a" });
write({ type: "engine_ready", protocolVersion: INTERACTIVE_ENGINE_PROTOCOL_VERSION, pid: process.pid });
write({ type: "engine_bound" });
const heartbeat = setInterval(() => write({ type: "engine_heartbeat", at: Date.now() }), 50);
heartbeat.unref?.();

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
	buffer += chunk.toString("utf8");
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		let parsed: { id?: unknown; type?: unknown } | undefined;
		try {
			parsed = JSON.parse(line) as { id?: unknown; type?: unknown };
		} catch {
			continue;
		}
		if (typeof parsed?.id !== "string" || replacement) continue;

		// Several reader turns of valid frames ahead of the admission: the host
		// parses at most 256 KiB per turn, so this cannot be consumed in one.
		// Written synchronously to fd 1, because process.exit() below would drop
		// anything still buffered. When a Node host spawns this child, fd 1 is a
		// non-blocking pipe, so a burst larger than the pipe buffer raises EAGAIN
		// instead of blocking; writeAllSync retries until the host drains it.
		const filler = `${JSON.stringify({ type: "engine_heartbeat", at: Date.now() })}\n`.repeat(200);
		for (let turn = 0; turn < 40; turn += 1) writeAllSync(filler);
		writeAllSync(`${JSON.stringify({ type: "engine_request_accepted", requestId: parsed.id, command: String(parsed.type) })}\n`);
		// The work really happened.
		if (marker) writeFileSync(marker, "ran\n");
		// A descendant inherits stdout and holds the pipe open past our exit.
		spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: ["ignore", "inherit", "ignore"], detached: true }).unref();
		process.exit(0);
	}
});
