import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-rpc-timeout-policy-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

// A child that reads the RPC JSONL stream but never emits a response, modelling
// a long-lived prompt/custom-UI picker that stays open awaiting human input.
const HELD_OPEN_CHILD = `
process.stdin.resume();
process.stdin.on("data", () => {});
`;

// A child that exits as soon as it receives its first framed request, modelling
// an engine process crash while a request is in flight.
const EXIT_ON_REQUEST_CHILD = `
process.stdin.once("data", () => { process.exit(37); });
process.stdin.resume();
`;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient request timeout policy", () => {
	test("does not time out a long-lived prompt held open far beyond the bounded deadline", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(HELD_OPEN_CHILD),
			// Tiny bounded deadline: if the long-lived classification were wrong,
			// the prompt would reject within 20ms. We wait many multiples of it.
			requestTimeoutMs: 20,
		});
		await client.start();
		try {
			let settled: "resolved" | "rejected" | "pending" = "pending";
			const pending = client
				.prompt("hold the picker open")
				.then(() => { settled = "resolved"; })
				.catch(() => { settled = "rejected"; });

			await new Promise((resolve) => setTimeout(resolve, 500));

			expect(settled).toBe("pending");
			// Keep the rejection handler attached through teardown to avoid an
			// unhandled rejection when stop() cancels the pending request.
			void pending;
		} finally {
			await client.stop();
		}
	});

	test("still enforces the bounded deadline for metadata/control requests", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(HELD_OPEN_CHILD),
			requestTimeoutMs: 50,
		});
		await client.start();
		try {
			await expect(client.getCommands()).rejects.toThrow(
				/Timeout waiting for response to get_commands/,
			);
		} finally {
			await client.stop();
		}
	});

	test("rejects a pending long-lived request immediately when the child exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(EXIT_ON_REQUEST_CHILD),
			// Deliberately tiny so a timeout, if it fired, would win the race; the
			// exit rejection must arrive first and carry the process-exit message.
			requestTimeoutMs: 5,
		});
		await client.start();
		try {
			await expect(client.prompt("trigger exit")).rejects.toThrow(
				/Agent process exited \(code=37 signal=null\)/,
			);
		} finally {
			await client.stop();
		}
	});
});
