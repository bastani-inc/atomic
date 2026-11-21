import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	stillRuns,
	waitUntilGone,
} from "../../../../test/helpers/recorded-process.js";
import { McpClient, StdioTransport } from "../../src/extensions/mcp/client/index.js";

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
const stubborn = fileURLToPath(new URL("./fixtures/stubborn-server.mjs", import.meta.url));
const exitingParent = fileURLToPath(new URL("./fixtures/exiting-parent-server.mjs", import.meta.url));
const escapedChild = fileURLToPath(new URL("./fixtures/escaped-child-server.mjs", import.meta.url));
/** These tests start and kill real process trees, which can take seconds on a loaded runner. */
const PROCESS_TREE_TEST_TIMEOUT_MS = 10_000;
const PROCESS_TREE_EXIT_WAIT_MS = 5_000;

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

	it("connects to a server whose stderr is inherited rather than piped", async () => {
		const transport = new StdioTransport({ command: process.execPath, args: [fixture], stderr: "inherit" });
		const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
		try {
			await client.connect(transport);
			assert.deepEqual(await client.listTools(), [{ name: "echo", inputSchema: { type: "object" } }]);
			assert.equal(transport.stderr, "");
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
			let grandchildPid: number | undefined;
			const discoveryDeadline = Date.now() + PROCESS_TREE_EXIT_WAIT_MS;
			while (grandchildPid === undefined && Date.now() < discoveryDeadline) {
				const match = /grandchild (\d+)/.exec(transport.stderr);
				if (match) grandchildPid = Number(match[1]);
				else await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.ok(grandchildPid !== undefined);
			// #6125: recorded while it runs, so a later process given its pid is never taken for it.
			const grandchild = await recordProcess(grandchildPid);

			const startedAt = Date.now();
			await client.close();
			assert.ok(Date.now() - startedAt < PROCESS_TREE_EXIT_WAIT_MS);
			assert.equal(await waitUntilGone(grandchild, PROCESS_TREE_EXIT_WAIT_MS), true);
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
			// #6125: the server and its helper, recorded while they run, so a later process given one of their pids is
			// never taken for them.
			const server = await recordProcess(transport.pid as number);
			let helperPid: number | undefined;
			await waitFor(() => {
				const match = /helper (\d+)/.exec(transport.stderr);
				if (match) helperPid = Number(match[1]);
				return helperPid !== undefined;
			});
			assert.ok(helperPid !== undefined);
			const helper = await recordProcess(helperPid);
			assert.equal(await waitUntilGone(server, 2_000), true);
			try {
				assert.equal(await stillRuns(helper), true);

				await transport.close();
				assert.equal(await waitUntilGone(helper, 2_000), true);
				assert.equal(closeEvents, 1);
			} finally {
				await signalRecordedProcess(helper);
			}
		},
		PROCESS_TREE_TEST_TIMEOUT_MS,
	);

	it.skipIf(process.platform === "win32")(
		"finishes closing when a child outside the server's process group holds the pipes",
		async () => {
			const transport = new StdioTransport({
				command: process.execPath,
				args: [escapedChild],
				closeTimeoutMs: 100,
			});
			let closeEvents = 0;
			transport.onClose(() => closeEvents++);
			let helper: RecordedProcess | undefined;
			try {
				await transport.start();
				let helperPid: number | undefined;
				await waitFor(() => {
					const match = /helper (\d+)/.exec(transport.stderr);
					if (match) helperPid = Number(match[1]);
					return helperPid !== undefined;
				});
				assert.ok(helperPid !== undefined);
				// #6125: recorded while it runs, so the cleanup never signals a later process given its pid.
				helper = await recordProcess(helperPid);
				const closed = await Promise.race([
					transport.close().then(() => true),
					new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
				]);
				assert.equal(closed, true);
				assert.equal(closeEvents, 1);
			} finally {
				if (helper !== undefined) await signalRecordedProcess(helper);
			}
		},
		PROCESS_TREE_TEST_TIMEOUT_MS,
	);
});
