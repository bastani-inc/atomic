import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { McpClient, StdioTransport } from "../../src/extensions/mcp/client/index.js";

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
const stubborn = fileURLToPath(new URL("./fixtures/stubborn-server.mjs", import.meta.url));
const exitingParent = fileURLToPath(new URL("./fixtures/exiting-parent-server.mjs", import.meta.url));
const PROCESS_TREE_EXIT_WAIT_MS = 5_000;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return true;
}

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

	it.skipIf(process.platform === "win32")(
		"kills children still holding the pipes after the server process exited (upstream #11724)",
		async () => {
			const transport = new StdioTransport({
				command: process.execPath,
				args: [exitingParent],
				closeTimeoutMs: 100,
			});
			let closeEvents = 0;
			transport.onClose(() => closeEvents++);
			await transport.start();
			const serverPid = transport.pid as number;
			let helper: number | undefined;
			await waitFor(() => {
				const match = /helper (\d+)/.exec(transport.stderr);
				if (match) helper = Number(match[1]);
				return helper !== undefined;
			});
			assert.equal(typeof helper, "number");
			assert.equal(await waitFor(() => !isAlive(serverPid)), true);
			try {
				assert.equal(isAlive(helper as number), true);

				await transport.close();
				assert.equal(await waitFor(() => !isAlive(helper as number)), true);
				assert.equal(closeEvents, 1);
			} finally {
				try {
					process.kill(helper as number, "SIGKILL");
				} catch {}
			}
		},
		10_000,
	);
});
