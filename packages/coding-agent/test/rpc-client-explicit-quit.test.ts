import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
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

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RpcClient.announceExplicitQuit", () => {
	test("returns once the engine child acknowledges the quit (#3492)", async () => {
		const client = await startClient("ack");
		try {
			const startedAt = performance.now();
			await client.announceExplicitQuit(LONG_WAIT_MS);
			assert.ok(performance.now() - startedAt < LONG_WAIT_MS / 2);
		} finally {
			await client.stop();
		}
	});

	test("stops waiting when the engine child exits instead of acknowledging (#3492)", async () => {
		const client = await startClient("exit");
		try {
			const startedAt = performance.now();
			await client.announceExplicitQuit(LONG_WAIT_MS);
			assert.ok(performance.now() - startedAt < LONG_WAIT_MS / 2);
		} finally {
			await client.stop();
		}
	});

	test("gives up after the deadline when the engine child never acknowledges (#3492)", async () => {
		const client = await startClient("ignore");
		try {
			const startedAt = performance.now();
			await client.announceExplicitQuit(100);
			assert.ok(performance.now() - startedAt >= 90);
		} finally {
			await client.stop();
		}
	});

	test("returns immediately when no engine child is running (#3492)", async () => {
		await new RpcClient({ interactiveEngine: { onDiagnostic: () => {} } }).announceExplicitQuit(LONG_WAIT_MS);
	});
});
