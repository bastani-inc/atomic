import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { McpClient, StdioTransport } from "../../src/extensions/mcp/client/index.js";

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
const stubborn = fileURLToPath(new URL("./fixtures/stubborn-server.mjs", import.meta.url));
const PROCESS_TREE_EXIT_WAIT_MS = 5_000;

describe("StdioTransport", () => {
	it("connects to a newline-delimited MCP server and captures stderr", async () => {
		const stderr: string[] = [];
		const transport = new StdioTransport({
			command: process.execPath,
			args: [fixture],
			onStderr: (chunk) => stderr.push(chunk),
		});
		const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
		try {
			await client.connect(transport);
			assert.deepEqual(await client.listTools(), [{ name: "echo", inputSchema: { type: "object" } }]);
			assert.deepEqual(await client.callTool("echo", { text: "hello" }), {
				content: [{ type: "text", text: "hello" }],
			});
			assert.equal(typeof transport.pid, "number");
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.ok(stderr.join("").includes("stdio fixture ready"));
			assert.ok(transport.stderr.includes("stdio fixture ready"));
			await client.close();
			assert.equal(client.connectionState, "closed");
		} finally {
			await client.close();
		}
	});

	it("kills a server that ignores shutdown, including its children", async () => {
		const transport = new StdioTransport({
			command: process.execPath,
			args: [stubborn],
			closeTimeoutMs: 100,
		});
		const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
		try {
			await client.connect(transport);
			let grandchild: number | undefined;
			const discoveryDeadline = Date.now() + PROCESS_TREE_EXIT_WAIT_MS;
			while (grandchild === undefined && Date.now() < discoveryDeadline) {
				const match = /grandchild (\d+)/.exec(transport.stderr);
				if (match) grandchild = Number(match[1]);
				else await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.ok(grandchild !== undefined);

			const startedAt = Date.now();
			await client.close();
			assert.ok(Date.now() - startedAt < PROCESS_TREE_EXIT_WAIT_MS);
			let alive = true;
			const exitDeadline = Date.now() + PROCESS_TREE_EXIT_WAIT_MS;
			while (alive && Date.now() < exitDeadline) {
				try {
					process.kill(grandchild, 0);
					await new Promise((resolve) => setTimeout(resolve, 20));
				} catch {
					alive = false;
				}
			}
			assert.equal(alive, false);
		} finally {
			await client.close();
		}
	});
});
