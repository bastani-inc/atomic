import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.js";
import {
	createDefaultTransport,
	McpOAuthCredentialStore,
	McpServerConnection,
} from "../../src/extensions/mcp/runtime.js";

const fixture = fileURLToPath(new URL("./fixtures/stderr-server.mjs", import.meta.url));

describe("the stderr of an MCP stdio server in its connection status", () => {
	const connections: McpServerConnection[] = [];

	afterEach(async () => {
		await Promise.all(connections.splice(0).map((connection) => connection.close()));
	});

	function connectTo(mode: "fail" | "die", stderr: string): McpServerConnection {
		const connection = new McpServerConnection({
			entry: {
				name: "stderr-server",
				config: { command: process.execPath, args: [fixture, mode, JSON.stringify(stderr)] },
				source: "test",
			},
			cwd: tmpdir(),
			createTransport: createDefaultTransport,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			onTools: () => {},
		});
		connections.push(connection);
		return connection;
	}

	it("appends the trimmed stderr of a server that failed to start", async () => {
		const connection = connectTo("fail", "\n  boom reason  \n\n");
		await assert.rejects(connection.getClient(), /failed to connect/);
		assert.equal(connection.state, "failed");
		assert.match(connection.error ?? "", /^[^\n]+\nboom reason$/);
	});

	it("appends nothing for a server that failed to start with only whitespace on stderr", async () => {
		const connection = connectTo("fail", "  \n\n");
		await assert.rejects(connection.getClient(), /failed to connect/);
		assert.equal(connection.state, "failed");
		assert.doesNotMatch(connection.error ?? "", /\n/);
	});

	it("appends the trimmed stderr of a server that exited after connecting", async () => {
		const connection = connectTo("die", "\n  bye bye  \n\n");
		await connection.getClient();
		await assert.rejects(connection.callTool("die", {}, {}));
		await vi.waitFor(() => assert.equal(connection.state, "disconnected"));
		assert.equal(connection.error, "Connection closed\nbye bye");
	});

	it("appends nothing for a server that exited after connecting with only whitespace on stderr", async () => {
		const connection = connectTo("die", "  \n\n");
		await connection.getClient();
		await assert.rejects(connection.callTool("die", {}, {}));
		await vi.waitFor(() => assert.equal(connection.state, "disconnected"));
		assert.equal(connection.error, "Connection closed");
	});
});
