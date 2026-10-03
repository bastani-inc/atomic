import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.js";
import { truncateMiddle } from "../../src/core/tools/truncate.js";
import {
	type JsonRpcMessage,
	LATEST_PROTOCOL_VERSION,
	McpAuthRequiredError,
	McpHttpError,
	McpSessionExpiredError,
} from "../../src/extensions/mcp/client/index.js";
import { createInMemoryTransportPair, type InMemoryTransport } from "../../src/extensions/mcp/client/testing/index.js";
import {
	getMcpToolExposure,
	loadMcpConfig,
	type McpServerEntry,
	updateMcpServerConfig,
} from "../../src/extensions/mcp/config.js";
import { MAX_SERVERS_SECTION_CHARS, renderServersSection } from "../../src/extensions/mcp/index.js";
import {
	createDefaultTransport,
	McpOAuthCredentialStore,
	McpServerConnection,
	McpServerLog,
} from "../../src/extensions/mcp/runtime.js";
import { convertMcpResult, createMcpToolName } from "../../src/extensions/mcp/tools.js";

// Config values are resolved at connect time, so the literal reference must survive loading.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
const TOKEN_HEADER = "Bearer ${TOKEN}";

describe("MCP config", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function setup(global: unknown, project: unknown) {
		const root = mkdtempSync(join(tmpdir(), "pi-mcp-config-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(global));
		writeFileSync(join(cwd, ".atomic", "mcp.json"), JSON.stringify(project));
		return { agentDir, cwd };
	}

	it("merges global and trusted project servers and validates entries", () => {
		const paths = setup(
			{
				mcpServers: {
					shared: { command: "global-cmd" },
					remote: { url: "https://example.com/mcp", headers: { Authorization: TOKEN_HEADER } },
					off: { command: "x", enabled: false },
					bad: { args: ["no command"] },
					legacy: { type: "sse", url: "https://example.com/sse" },
					badUrl: { url: "example.com/mcp" },
					"bad name": { command: "x" },
				},
			},
			{ mcpServers: { shared: { command: "project-cmd", exposure: "direct" } } },
		);

		const trusted = loadMcpConfig({ ...paths, projectTrusted: true });
		// Disabled servers are kept so /mcp can enable them again.
		assert.deepEqual(
			trusted.servers.map((server) => [server.name, server.scope, server.config]),
			[
				["shared", "project", { command: "project-cmd", exposure: "direct" }],
				["remote", "global", { url: "https://example.com/mcp", headers: { Authorization: TOKEN_HEADER } }],
				["off", "global", { command: "x", enabled: false }],
			],
		);
		assert.equal(trusted.errors.length, 4);
		assert.ok(trusted.errors[0].includes('server "bad" needs either "command"'));
		assert.ok(trusted.errors[1].includes("legacy SSE transport is not supported"));
		assert.ok(trusted.errors[2].includes('server "badUrl": url must be an http or https URL'));
		assert.ok(trusted.errors[3].includes('invalid server name "bad name"'));

		// Untrusted projects cannot add or override servers, since stdio servers run commands.
		const untrusted = loadMcpConfig({ ...paths, projectTrusted: false });
		assert.deepEqual(untrusted.servers.find((server) => server.name === "shared")?.config, { command: "global-cmd" });
	});

	it("lets project entries override enabled and exposure of global servers (upstream #10277)", () => {
		const paths = setup(
			{ mcpServers: { tools: { command: "x", env: { TOKEN: "secret" } } } },
			// An override cannot change the command, which would run with the global env.
			{ mcpServers: { tools: { enabled: false, args: ["y"] }, missing: { enabled: false } } },
		);
		const project = join(paths.cwd, ".atomic", "mcp.json");
		const { servers, errors } = loadMcpConfig({ ...paths, projectTrusted: true });
		assert.deepEqual(
			servers.map((server) => [server.name, server.override, server.config]),
			[["tools", undefined, { command: "x", env: { TOKEN: "secret" } }]],
		);
		assert.equal(errors.length, 2);
		assert.ok(errors[0].includes('server "tools": an override can only set enabled, exposure, toolExposure'));
		assert.ok(errors[1].includes('server "missing" needs "command" or "url", or a global server to override'));

		writeFileSync(project, JSON.stringify({ mcpServers: { tools: { enabled: false } } }));
		const [tools] = loadMcpConfig({ ...paths, projectTrusted: true }).servers;
		assert.deepEqual(
			[tools.override, tools.config],
			[project, { command: "x", env: { TOKEN: "secret" }, enabled: false }],
		);

		// Overrides keep `enabled: true`, since it replaces the global value.
		updateMcpServerConfig(project, "tools", { enabled: true });
		assert.deepEqual(JSON.parse(readFileSync(project, "utf8")).mcpServers.tools, { enabled: true });
	});

	it("refuses reserved server names when writing a project override instead of touching Object.prototype", () => {
		const project = join(setup({}, { mcpServers: {} }).cwd, ".atomic", "mcp.json");
		for (const name of ["__proto__", "constructor", "prototype"]) {
			assert.throws(
				() => updateMcpServerConfig(project, name, { enabled: false }, { override: true }),
				/Invalid MCP server name/,
			);
		}
		assert.equal(Object.hasOwn(Object.prototype, "enabled"), false);
		assert.equal(({} as Record<string, unknown>).enabled, undefined);

		updateMcpServerConfig(project, "toString", { enabled: false }, { override: true });
		assert.deepEqual(JSON.parse(readFileSync(project, "utf8")).mcpServers, { toString: { enabled: false } });
	});

	// Regression: #10239.
	it("rejects server names that differ only in - and _", () => {
		const paths = setup({ mcpServers: { "work-files": { command: "a" }, work_files: { command: "b" } } }, {});
		const { servers, errors } = loadMcpConfig({ ...paths, projectTrusted: false });
		assert.deepEqual(
			servers.map((server) => server.name),
			["work-files"],
		);
		assert.match(errors[0], /server "work_files" conflicts with "work-files"/);
	});

	it("validates exposure and reads autoEnableCodemode with project precedence", () => {
		const paths = setup(
			{
				autoEnableCodemode: false,
				mcpServers: {
					later: { command: "x", exposure: "deferred" },
					// `codemode-deferred` is an alias for `codemode`.
					scripts: { command: "x", exposure: "codemode-deferred", toolExposure: { a: "codemode-deferred" } },
					off: { command: "x", exposure: "hidden" },
					wrong: { command: "x", exposure: "model-only" },
					described: { command: "x", description: "Docs search" },
					badDescription: { command: "x", description: 1 },
				},
			},
			{ autoEnableCodemode: "yes", mcpServers: {} },
		);

		const untrusted = loadMcpConfig({ ...paths, projectTrusted: false });
		assert.equal(untrusted.autoEnableCodemode, false);
		assert.deepEqual(
			untrusted.servers.map((server) => [server.name, server.config.exposure]),
			[
				["later", "deferred"],
				["scripts", "codemode"],
				["off", "hidden"],
				["described", undefined],
			],
		);
		assert.deepEqual(untrusted.servers[1].config.toolExposure, { a: "codemode" });
		assert.equal(untrusted.servers[3].config.description, "Docs search");
		assert.match(untrusted.errors[0], /server "wrong": exposure must be one of/);
		assert.match(untrusted.errors[1], /server "badDescription": description must be a string/);

		const trusted = loadMcpConfig({ ...paths, projectTrusted: true });
		assert.equal(trusted.autoEnableCodemode, false);
		assert.ok(trusted.errors.some((error) => error.includes("autoEnableCodemode must be a boolean")));
	});

	it("validates the OAuth callback URL, scope, and client name", () => {
		const paths = setup(
			{
				mcpServers: {
					ok: {
						url: "https://a.example/mcp",
						oauth: { callbackUrl: "http://localhost:8080/callback", scope: "a b" },
					},
					ipv6: { url: "https://a.example/mcp", oauth: { callbackUrl: "http://[::1]/cb", callbackPort: 9000 } },
					same: { url: "https://a.example/mcp", oauth: { callbackUrl: "http://127.0.0.1:2/cb", callbackPort: 2 } },
					remote: { url: "https://a.example/mcp", oauth: { callbackUrl: "https://example.com/callback" } },
					both: { url: "https://a.example/mcp", oauth: { callbackUrl: "http://127.0.0.1:1/cb", callbackPort: 2 } },
					scope: { url: "https://a.example/mcp", oauth: { scope: ["a"] } },
					named: { url: "https://a.example/mcp", oauth: { clientName: "Claude Code" } },
					unnamed: { url: "https://a.example/mcp", oauth: { clientName: " " } },
					metadata: { url: "https://a.example/mcp", oauth: { authServerMetadataUrl: "https://idp.example/m" } },
					plainMetadata: {
						url: "https://a.example/mcp",
						oauth: { authServerMetadataUrl: "http://idp.example/m" },
					},
				},
			},
			{},
		);
		const { servers, errors } = loadMcpConfig({ ...paths, projectTrusted: false });
		assert.deepEqual(
			servers.map((server) => server.name),
			["ok", "ipv6", "same", "named", "metadata"],
		);
		assert.match(errors[0], /server "remote": oauth\.callbackUrl must be an http URI on localhost/);
		assert.match(errors[1], /server "both": oauth\.callbackUrl and oauth\.callbackPort name different ports/);
		assert.match(errors[2], /server "scope": oauth\.scope must be a string/);
		assert.match(errors[3], /server "unnamed": oauth\.clientName must be a non-empty string/);
		assert.match(errors[4], /server "plainMetadata": oauth\.authServerMetadataUrl must be an https URL/);
	});

	it("resolves per-tool exposure from exact names, then patterns in order", () => {
		const paths = setup(
			{
				mcpServers: {
					gh: {
						command: "x",
						exposure: "deferred",
						toolExposure: { "get_*": "codemode", get_me: "direct", "*delete*": "hidden", "get_file.*": "direct" },
					},
					bad: { command: "x", toolExposure: { a: "visible" } },
				},
			},
			{},
		);
		const { servers, errors } = loadMcpConfig({ ...paths, projectTrusted: false });
		assert.match(errors[0], /server "bad": toolExposure "a" must be one of/);
		const config = servers[0].config;
		assert.equal(getMcpToolExposure(config, "get_me"), "direct");
		assert.equal(getMcpToolExposure(config, "get_issue"), "codemode");
		assert.equal(getMcpToolExposure(config, "get_delete_hint"), "codemode");
		assert.equal(getMcpToolExposure(config, "delete_repo"), "hidden");
		assert.equal(getMcpToolExposure(config, "list_issues"), "deferred");
		// Only `*` is special.
		assert.equal(
			getMcpToolExposure({ command: "x", toolExposure: { "get_file.*": "direct" } }, "get_file_x"),
			"codemode",
		);
	});

	it("validates provider auth and accepts it only in the global mcp.json", () => {
		const paths = setup(
			{
				mcpServers: {
					radius: { url: "https://radius.example/mcp", auth: { provider: "radius" } },
					local: { url: "http://localhost:8788/mcp", auth: { provider: "radius-dev" } },
					plain: { url: "http://radius.example/mcp", auth: { provider: "radius" } },
					empty: { url: "https://radius.example/mcp", auth: { provider: "" } },
				},
			},
			{ mcpServers: { radius: { url: "https://evil.example/mcp", auth: { provider: "radius" } } } },
		);
		const { servers, errors } = loadMcpConfig({ ...paths, projectTrusted: true });
		// The project entry cannot replace the global one: it would send the credential to its own URL.
		assert.deepEqual(
			servers.map((server) => [server.name, server.scope, "url" in server.config && server.config.url]),
			[
				["radius", "global", "https://radius.example/mcp"],
				["local", "global", "http://localhost:8788/mcp"],
			],
		);
		assert.match(errors[0], /server "plain": auth requires an https URL/);
		assert.match(errors[1], /server "empty": auth\.provider must be a provider name/);
		assert.match(errors[2], /server "radius": auth is only allowed in the global mcp\.json/);
	});
});

describe("MCP tools", () => {
	it("creates provider-safe tool names", () => {
		assert.equal(createMcpToolName("docs", "search"), "mcp__docs__search");
		assert.equal(createMcpToolName("my-server", "get.item/v2"), "mcp__my_server__get_item_v2");
		const long = createMcpToolName("server", "x".repeat(100));
		assert.equal(long.length, 64);
		assert.match(long, /^mcp__server__x+_[0-9a-f]{8}$/);
		assert.notEqual(createMcpToolName("server", `${"x".repeat(100)}y`), long);
		// Names that sanitize to one already taken by another tool get a hash suffix.
		const taken = createMcpToolName("s", "a_b");
		const second = createMcpToolName("s", "a-b", (name) => name === taken);
		assert.match(second, /^mcp__s__a_b_[0-9a-f]{8}$/);
	});

	it("converts results, passing the CallToolResult to scripts and flagging errors", async () => {
		const blocks = [
			{ type: "resource_link" as const, uri: "file:///a", name: "a" },
			{ type: "resource" as const, resource: { uri: "file:///b", text: "b text" } },
			{ type: "audio" as const, data: "", mimeType: "audio/wav" },
		];
		assert.deepEqual(
			await convertMcpResult("docs", "t", {
				content: blocks,
				structuredContent: { ok: true },
				_meta: { trace: "x" },
			}),
			{
				content: [
					{ type: "text", text: '[Resource file:///a "a"]' },
					{ type: "text", text: "b text" },
					{ type: "text", text: "[audio audio/wav omitted]" },
				],
				details: { server: "docs", tool: "t" },
				// Scripts get the server's blocks as sent, without `_meta`.
				structuredContent: { content: blocks, structuredContent: { ok: true } },
			},
		);
		assert.deepEqual((await convertMcpResult("docs", "t", { content: [], structuredContent: { n: 1 } })).content, [
			{ type: "text", text: '{\n  "n": 1\n}' },
		]);
		assert.deepEqual(
			await convertMcpResult("docs", "t", { content: [{ type: "text", text: "nope" }], isError: true }),
			{
				content: [{ type: "text", text: "nope" }],
				details: { server: "docs", tool: "t" },
				structuredContent: { content: [{ type: "text", text: "nope" }], isError: true },
				isError: true,
			},
		);
		assert.deepEqual((await convertMcpResult("docs", "t", { content: [], isError: true })).content, [
			{ type: "text", text: "MCP tool docs/t returned an error" },
		]);
	});

	it("points resource links to read_mcp_resource and saves binary resources", async () => {
		const saved: [string | Uint8Array, string][] = [];
		const saveOutput = async (data: string | Uint8Array, extension: string) => {
			saved.push([data, extension]);
			return `/tmp/saved${extension}`;
		};
		const converted = await convertMcpResult(
			"docs",
			"t",
			{
				content: [
					{
						type: "resource_link",
						uri: "docs://guide",
						name: "guide",
						title: "The Guide",
						mimeType: "text/markdown",
						size: 2048,
						description: "How to use it",
					},
					{
						type: "resource",
						resource: { uri: "file:///r/report.pdf", mimeType: "application/pdf", blob: "JVBERg==" },
					},
					{ type: "resource", resource: { uri: "docs://logo", mimeType: "image/png", blob: "AAAA" } },
				],
			},
			{ saveOutput, readableResources: true },
		);
		assert.deepEqual(converted.content, [
			{
				type: "text",
				text: '[Resource docs://guide "The Guide" (text/markdown, 2.0KB): How to use it. Read it with read_mcp_resource (server "docs")]',
			},
			{ type: "text", text: "[Binary resource file:///r/report.pdf (application/pdf, 4B) saved to /tmp/saved.pdf]" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
		assert.deepEqual(saved, [[Buffer.from("%PDF"), ".pdf"]]);
	});

	it("cuts the middle of model-facing text over 20KB and keeps the full result for scripts", async () => {
		const saved: (string | Uint8Array)[] = [];
		const saveOutput = async (data: string | Uint8Array) => {
			saved.push(data);
			return "/tmp/full.txt";
		};
		const lines = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`);
		const full = lines.join("\n");
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const result = { content: [{ type: "text" as const, text: full }, image] };
		const converted = await convertMcpResult("docs", "snapshot", result, { saveOutput });
		assert.equal(converted.content.length, 2);
		const text = (converted.content[0] as { text: string }).text;
		// Codex's format: a header, the start and end of the text, then the file with the full text.
		assert.match(
			text,
			new RegExp(
				`^Warning: truncated output \\(original token count: ${Math.ceil(full.length / 4)}\\)\nTotal output lines: 3000\n\nline 1\nline 2\n`,
			),
		);
		assert.match(text, /…\d+ chars truncated…/);
		assert.ok(text.endsWith("line 3000\n\n[Full output: /tmp/full.txt (read it with offset/limit)]"));
		assert.ok(Buffer.byteLength(text) < 21 * 1024);
		assert.deepEqual(converted.content[1], image);
		assert.deepEqual(converted.details, { server: "docs", tool: "snapshot", fullOutputPath: "/tmp/full.txt" });
		assert.deepEqual(saved, [full]);
		assert.deepEqual(converted.structuredContent, result);

		// Text within the limit is not saved.
		await convertMcpResult("docs", "small", { content: [{ type: "text", text: "ok" }] }, { saveOutput });
		assert.equal(saved.length, 1);
	});

	it("cuts multi-byte text only at character boundaries", () => {
		const text = `${"é".repeat(20_000)}end`;
		const result = truncateMiddle(text, 1001);
		assert.equal(result.truncated, true);
		assert.ok(!result.content.includes("\uFFFD"));
		assert.ok(result.content.endsWith("end"));
		const [head, tail] = result.content.split(/…\d+ chars truncated…/);
		assert.ok(Buffer.byteLength(head) <= 500);
		assert.ok(Buffer.byteLength(tail) <= 501);
		assert.equal(Array.from(head).length + Array.from(tail).length + result.removedChars, Array.from(text).length);
	});
});

describe("MCP connections", () => {
	const servers: InMemoryTransport[] = [];

	/** In-memory server that answers initialize, tools/list, and tools/call with "ok". */
	function createTransport(options: { expireFirstCall?: boolean; methods?: string[]; noTools?: boolean } = {}) {
		const pair = createInMemoryTransportPair();
		servers.push(pair.server);
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			options.methods?.push(message.method);
			const response: JsonRpcMessage =
				message.method === "initialize"
					? {
							jsonrpc: "2.0",
							id: message.id,
							result: {
								protocolVersion: LATEST_PROTOCOL_VERSION,
								capabilities: options.noTools ? { prompts: {} } : { tools: {} },
								serverInfo: { name: "fake", version: "1.0.0" },
							},
						}
					: message.method === "tools/list"
						? options.noTools
							? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
							: { jsonrpc: "2.0", id: message.id, result: { tools: [] } }
						: message.method === "resources/read"
							? { jsonrpc: "2.0", id: message.id, result: { contents: [{ uri: "docs://a", text: "ok" }] } }
							: { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } };
			queueMicrotask(() => void pair.server.send(response));
		});
		void pair.server.start();
		if (options.expireFirstCall) {
			const send = pair.client.send.bind(pair.client);
			// Simulates the HTTP transport's 404 for a session the server no longer knows.
			pair.client.send = async (message: JsonRpcMessage) => {
				if ("method" in message && message.method === "tools/call") throw new McpSessionExpiredError("gone");
				return send(message);
			};
		}
		return pair.client;
	}

	function connect(
		entry: McpServerEntry,
		transports: (() => ReturnType<typeof createTransport>)[],
		log?: McpServerLog,
	) {
		let opened = 0;
		const connection = new McpServerConnection({
			entry,
			cwd: process.cwd(),
			createTransport: () => transports[opened++](),
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			log,
			onTools: () => {},
		});
		return { connection, opened: () => opened };
	}

	it("starts a new session and retries once when the session expired", async () => {
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport({ expireFirstCall: true }),
			() => createTransport(),
		]);
		const results = await Promise.all([connection.callTool("echo", {}, {}), connection.callTool("echo", {}, {})]);
		assert.deepEqual(results, [
			{ content: [{ type: "text", text: "ok" }] },
			{ content: [{ type: "text", text: "ok" }] },
		]);
		assert.equal(opened(), 2);
		await connection.close();
	});

	it("shutdown waits for an expired client's pending transport retirement", async () => {
		let startClose!: () => void;
		let releaseClose!: () => void;
		const closeStarted = new Promise<void>((resolve) => (startClose = resolve));
		const closeGate = new Promise<void>((resolve) => (releaseClose = resolve));
		const transport = createTransport();
		const send = transport.send.bind(transport);
		transport.send = async (message) => {
			if ("method" in message && message.method === "tools/call") throw new McpSessionExpiredError("gone");
			return send(message);
		};
		const close = transport.close.bind(transport);
		transport.close = async () => {
			startClose();
			await closeGate;
			await close();
		};
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => transport,
			() => createTransport(),
		]);
		await connection.getClient();
		const request = connection.callTool("echo", {}, {});
		await closeStarted;
		let shutdownDone = false;
		const shutdown = connection.close().then(() => {
			shutdownDone = true;
		});
		await Promise.resolve();
		assert.equal(shutdownDone, false);
		releaseClose();
		await shutdown;
		await assert.rejects(request, McpSessionExpiredError);
		assert.equal(opened(), 1);
	});

	it("closes every expired session before retrying on a new session", async () => {
		const closed: boolean[] = [];
		let current = 0;
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => {
				const transport = createTransport();
				const send = transport.send.bind(transport);
				transport.send = async (message) => {
					if ("method" in message && message.method === "tools/call") throw new McpSessionExpiredError("gone");
					return send(message);
				};
				const close = transport.close.bind(transport);
				closed.push(false);
				const index = current++;
				transport.close = async () => {
					closed[index] = true;
					await close();
				};
				return transport;
			},
			() => {
				const transport = createTransport();
				const send = transport.send.bind(transport);
				let calls = 0;
				transport.send = async (message) => {
					if ("method" in message && message.method === "tools/call" && ++calls === 2)
						throw new McpSessionExpiredError("gone");
					return send(message);
				};
				const close = transport.close.bind(transport);
				closed.push(false);
				const index = current++;
				transport.close = async () => {
					closed[index] = true;
					await close();
				};
				return transport;
			},
			() => {
				const transport = createTransport();
				const close = transport.close.bind(transport);
				closed.push(false);
				const index = current++;
				transport.close = async () => {
					closed[index] = true;
					await close();
				};
				return transport;
			},
		]);
		await connection.callTool("echo", {}, {});
		await connection.callTool("echo", {}, {});
		assert.deepEqual(closed, [true, true, false]);
		await connection.close();
		assert.deepEqual(closed, [true, true, true]);
	});

	it("expands ~ in the command, arguments, and cwd of stdio servers", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-home-"));
		const previousHome = process.env.HOME;
		const previousProfile = process.env.USERPROFILE;
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		mkdirSync(join(home, "work"));
		// Answers every tool call with its working directory.
		writeFileSync(
			join(home, "server.mjs"),
			`import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
	const message = JSON.parse(line);
	if (!("id" in message)) continue;
	const result = message.method === "initialize"
		? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cwd", version: "1" } }
		: message.method === "tools/list"
			? { tools: [{ name: "cwd", inputSchema: { type: "object" } }] }
			: { content: [{ type: "text", text: process.cwd() }] };
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}`,
		);
		const connection = new McpServerConnection({
			entry: {
				name: "home",
				config: { command: process.execPath, args: ["~/server.mjs"], cwd: "~/work" },
				source: "test",
			},
			cwd: tmpdir(),
			createTransport: createDefaultTransport,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			onTools: () => {},
		});
		try {
			const result = await connection.callTool("cwd", {}, {});
			assert.equal(realpathSync((result.content[0] as { text: string }).text), realpathSync(join(home, "work")));
		} finally {
			await connection.close();
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousProfile;
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("connects to servers without the tools capability without listing tools", async () => {
		const methods: string[] = [];
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport({ noTools: true, methods }),
		]);
		await connection.getClient();
		assert.equal(connection.state, "connected");
		assert.deepEqual(connection.tools, []);
		assert.deepEqual(methods, ["initialize"]);
		await connection.close();
	});

	it("marks a dropped connection and reconnects on the next call", async () => {
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport(),
			() => createTransport(),
		]);
		await connection.getClient();
		await servers.at(-1)?.close();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(connection.state, "disconnected");
		assert.equal(connection.error, "Connection closed");
		assert.deepEqual(await connection.callTool("echo", {}, {}), { content: [{ type: "text", text: "ok" }] });
		assert.equal(connection.state, "connected");
		assert.equal(opened(), 2);
		await connection.close();
	});

	it("retries HTTP connections that fail with a transient error", async () => {
		const { connection, opened } = connect(
			{ name: "fake", config: { url: "http://unused.invalid", headers: { Authorization: "x" } }, source: "test" },
			[
				() => {
					const transport = createTransport();
					transport.send = async () => {
						throw new McpHttpError(503, "MCP HTTP request failed with status 503");
					};
					return transport;
				},
				() => createTransport(),
			],
		);
		await connection.getClient();
		assert.equal(connection.state, "connected");
		assert.equal(opened(), 2);
		await connection.close();

		const failing = connect(
			{ name: "fake", config: { url: "http://unused.invalid", headers: { Authorization: "x" } }, source: "test" },
			[
				() => {
					const transport = createTransport();
					transport.send = async () => {
						throw new McpHttpError(400, "MCP HTTP request failed with status 400: bad");
					};
					return transport;
				},
			],
		);
		await assert.rejects(failing.connection.getClient(), /status 400: bad/);
		assert.equal(failing.connection.state, "failed");
		assert.equal(failing.opened(), 1);
	});

	it("retries resource reads, but not tool calls, after a transient HTTP error", async () => {
		const transport = createTransport();
		const send = transport.send.bind(transport);
		const failed = new Set<string>();
		// The first read and the first call fail with 502.
		transport.send = async (message) => {
			const method = "method" in message ? message.method : "";
			if ((method === "resources/read" || method === "tools/call") && !failed.has(method)) {
				failed.add(method);
				throw new McpHttpError(502, "MCP HTTP request failed with status 502");
			}
			return send(message);
		};
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => transport,
		]);
		assert.deepEqual(await connection.readResource("docs://a", {}), { contents: [{ uri: "docs://a", text: "ok" }] });
		await assert.rejects(connection.callTool("echo", {}, {}), /status 502/);
		await connection.close();
	});

	it("asks OAuth servers that keep rejecting requests for a new sign-in", async () => {
		const { connection } = connect({ name: "fake", config: { url: "http://unused.invalid" }, source: "test" }, [
			() => {
				const transport = createTransport();
				transport.send = async () => {
					throw new McpAuthRequiredError(new Response(null, { status: 401 }));
				};
				return transport;
			},
		]);
		await assert.rejects(connection.getClient(), /MCP server "fake" requires sign-in\. Run \/mcp to sign in\./);
		assert.equal(connection.state, "needs-auth");
		await connection.close();
	});

	it("sends the provider token and asks for the provider login when the server rejects it", async () => {
		const authorizations: (string | undefined)[] = [];
		const server = createServer((request, response) => {
			authorizations.push(request.headers.authorization);
			request.resume();
			response.writeHead(401).end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		const connection = new McpServerConnection({
			entry: {
				name: "radius",
				config: { url: `http://127.0.0.1:${port}/mcp`, auth: { provider: "radius" } },
				source: "test",
			},
			cwd: process.cwd(),
			createTransport: createDefaultTransport,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			providerToken: async (provider) => (provider === "radius" ? "tok" : undefined),
			onTools: () => {},
		});
		try {
			assert.equal(connection.oauthUrl, undefined);
			await assert.rejects(
				connection.getClient(),
				/MCP server "radius" requires sign-in\. Run \/login radius to sign in\./,
			);
			assert.equal(connection.state, "needs-auth");
			assert.deepEqual(authorizations, ["Bearer tok"]);
		} finally {
			await connection.close();
			await new Promise((resolve) => server.close(resolve));
		}
	});

	it("appends server log messages to the log file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-log-"));
		try {
			const path = join(dir, "mcp.log");
			const { connection } = connect(
				{ name: "fake", config: { command: "unused" }, source: "test" },
				[() => createTransport()],
				new McpServerLog(path),
			);
			await connection.getClient();
			const server = servers.at(-1);
			await server?.send({
				jsonrpc: "2.0",
				method: "notifications/message",
				params: { level: "warning", logger: "db", data: "slow\nquery" },
			});
			await server?.send({
				jsonrpc: "2.0",
				method: "notifications/message",
				params: { level: "error", data: { code: 7 } },
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			const lines = readFileSync(path, "utf8").replace(/^\S+ /gm, "");
			assert.equal(lines, '[fake] warning db: slow\n    query\n[fake] error {"code":7}\n');
			await connection.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves the OAuth client secret lazily", async () => {
		const { connection } = connect(
			{
				name: "fake",
				config: { url: "http://unused.invalid", oauth: { clientSecret: "!exit 1" } },
				source: "test",
			},
			[() => createTransport()],
		);
		assert.deepEqual(await connection.callTool("echo", {}, {}), { content: [{ type: "text", text: "ok" }] });
		assert.throws(() => connection.oauthSettings(), /oauth\.clientSecret/);
		await connection.close();
	});
});

describe("MCP servers section", () => {
	const server = (name: string, description?: string, exposure?: "codemode" | "deferred" | "direct") => ({
		entry: {
			name,
			config: { command: "x", ...(description ? { description } : {}), ...(exposure ? { exposure } : {}) },
			source: "test",
		},
	});

	it("lists servers with how their tools are reached and the first line of their description", () => {
		const section = renderServersSection([
			server("docs", "Docs search.\nMore."),
			server("later", undefined, "deferred"),
			server("direct", "Declared.", "direct"),
			{ entry: server("plain").entry, connection: { instructions: "From instructions." } },
		]);
		assert.deepEqual(section?.split("\n").slice(1), [
			"- mcp__docs (codemode): Docs search.",
			"- mcp__later (tool_search)",
			"- mcp__plain (codemode): From instructions.",
		]);
		assert.equal(renderServersSection([server("direct", "Declared.", "direct")]), undefined);
	});

	it("introduces only the ways of reaching tools that the listed servers use", () => {
		const intro = (...servers: Parameters<typeof renderServersSection>[0]) =>
			renderServersSection(servers)?.split("\n")[0] ?? "";

		assert.equal(
			intro(server("docs")),
			"MCP servers whose tools are not declared to you. Call the tools of `codemode` servers from codemode scripts.",
		);
		assert.equal(
			intro(server("later", undefined, "deferred")),
			"MCP servers whose tools are not declared to you. Load the tools of `tool_search` servers with `tool_search`.",
		);
		const both = intro(server("docs"), server("later", undefined, "deferred"));
		assert.match(both, /codemode scripts\. Load the tools of `tool_search` servers/);
	});

	it("shortens descriptions to fit the size limit", () => {
		const servers = Array.from({ length: 40 }, (_, index) => server(`server${index}`, "x".repeat(400)));
		const section = renderServersSection(servers) ?? "";
		assert.ok(section.length <= MAX_SERVERS_SECTION_CHARS);
		assert.equal(section.split("\n").length, 41);
		assert.ok(section.includes("- mcp__server39 (codemode): x"));
	});

	it("leaves out the last servers when their names alone do not fit", () => {
		const servers = Array.from({ length: 200 }, (_, index) => server(`server-with-a-long-name-${index}`, "desc"));
		const section = renderServersSection(servers) ?? "";
		assert.ok(section.length <= MAX_SERVERS_SECTION_CHARS);
		const lines = section.split("\n");
		assert.match(lines.at(-1) ?? "", /^- … \d+ more servers; find their tools with searchTools\(\)$/);
		const omitted = Number(/(\d+) more/.exec(lines.at(-1) ?? "")?.[1]);
		assert.equal(lines.length - 2 + omitted, 200);
	});
});
