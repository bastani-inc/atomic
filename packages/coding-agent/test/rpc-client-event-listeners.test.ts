import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

const tempDirs: string[] = [];
const clients: RpcClient[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-rpc-client-listeners-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(async () => {
	for (const client of clients.splice(0)) await client.stop();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RpcClient event listeners", () => {
	test("delivers an event to every listener when one unsubscribes during dispatch (#9990)", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	process.stdout.write(JSON.stringify({ type: "agent_end", messages: [] }) + "\\n");
	process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true }) + "\\n");
});
`),
		});
		clients.push(client);
		await client.start();

		const collected = client.collectEvents(5000);
		const idle = client.waitForIdle(5000);
		await client.abort();

		assert.deepEqual(await collected, [{ type: "agent_end", messages: [] }]);
		assert.equal(await idle, undefined);
	});
});
