import { describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { type JsonRpcMessage, LATEST_PROTOCOL_VERSION } from "../../src/extensions/mcp/client/index.js";
import { TransportEvents } from "../../src/extensions/mcp/client/transports/transport.js";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";
import { createHarness } from "../suite/harness.ts";

describe("native MCP contribution retirement", () => {
	it("retires synchronous replacements without leaving a detached transport or publishing obsolete tools", async () => {
		const live = new Set<string>();
		const started: string[] = [];
		class ServerTransport extends TransportEvents {
			constructor(private readonly label: string) {
				super();
			}
			async start() {
				started.push(this.label);
				live.add(this.label);
			}
			async send(message: JsonRpcMessage) {
				if (!("id" in message) || !("method" in message)) return;
				const result =
					message.method === "initialize"
						? {
								protocolVersion: LATEST_PROTOCOL_VERSION,
								capabilities: { tools: {} },
								serverInfo: { name: this.label, version: "1" },
							}
						: { tools: [{ name: this.label, inputSchema: { type: "object" } }] };
				queueMicrotask(() => this.emitMessage({ jsonrpc: "2.0", id: message.id, result }));
			}
			async close() {
				live.delete(this.label);
				this.emitClose();
			}
		}
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({ servers: [], errors: [] }),
					credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
					createTransport: (entry) =>
						new ServerTransport("command" in entry.config ? entry.config.command : "unexpected"),
				}),
				(pi) => {
					pi.registerCommand("replace", {
						description: "Replace an MCP contribution twice in one turn",
						handler: async () => {
							pi.registerMcpServer("race", { command: "retired", exposure: "direct" });
							pi.registerMcpServer("race", { command: "current", exposure: "direct" });
						},
					});
				},
			],
		});
		try {
			await harness.session.bindExtensions({});
			await harness.session.prompt("/replace");
			await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__race__current"));
			expect(harness.session.getActiveToolNames()).not.toContain("mcp__race__retired");
		} finally {
			await harness.cleanup();
		}
		expect(started).toContain("current");
		expect([...live]).toEqual([]);
	});
});
