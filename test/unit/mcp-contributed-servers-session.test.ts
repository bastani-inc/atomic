import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.ts";
import mcp from "../../packages/mcp/index.ts";
import { McpServerManager } from "../../packages/mcp/server-manager.js";
import { formatToolName } from "../../packages/mcp/types.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeFileEnsuringDir } from "../helpers/runtime.js";

/** Loading the MCP extension from workspace TypeScript and binding a real session is the structural cost here. */
const REAL_MCP_SESSION_TIMEOUT_MS = 60_000;
const REGISTRATION_SETTLE_TIMEOUT_MS = 10_000;

type McpGatewayTool = {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, string>,
		signal: AbortSignal,
	): Promise<{ details?: { servers?: Array<{ name: string }> } }>;
};

type McpConnection = Awaited<ReturnType<McpServerManager["connect"]>>;

let root = "";
const originalConnect = McpServerManager.prototype.connect;

beforeEach(() => {
	root = makeTempDirectory("mcp-contributed-session-");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("MCP_OAUTH_DIR", join(root, "oauth"));
});

afterEach(() => {
	McpServerManager.prototype.connect = originalConnect;
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + REGISTRATION_SETTLE_TIMEOUT_MS;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await sleep(20);
	}
}

function stubConnect(toolsFor: (name: string) => Array<{ name: string; description: string }> = () => []): string[] {
	const connected: string[] = [];
	McpServerManager.prototype.connect = async function connect(name, definition) {
		connected.push(name);
		const closeable = { close: async () => undefined };
		const connection = {
			client: closeable,
			transport: closeable,
			definition,
			tools: toolsFor(name).map((tool) => ({ ...tool, inputSchema: { type: "object", properties: {} } })),
			resources: [],
			lastUsedAt: Date.now(),
			inFlight: 0,
			status: "connected",
		} as unknown as McpConnection;
		(this as unknown as { connections: Map<string, McpConnection> }).connections.set(name, connection);
		return connection;
	};
	return connected;
}

async function startMcpSession(
	factory: (pi: ExtensionAPI) => void,
): Promise<Awaited<ReturnType<typeof createAgentSession>>["session"]> {
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: [mcp, { name: "contributor", factory }],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	return session;
}

test(
	"a late eager contributed server exposes its direct tools once it connects (#3355)",
	async () => {
		stubConnect((name) => (name === "late-direct" ? [{ name: "ping", description: "Ping the server" }] : []));
		let api: ExtensionAPI | undefined;
		const session = await startMcpSession((pi) => {
			api = pi;
		});
		try {
			const gateway = session.agent.state.tools.find((tool) => tool.name === "mcp") as McpGatewayTool | undefined;
			assert.ok(gateway, "expected the MCP gateway tool");
			await gateway.execute("status", {}, new AbortController().signal);
			assert.ok(api);
			api.registerMcpServer("late-direct", { url: "https://late.test/mcp", lifecycle: "eager", directTools: true });
			const directName = formatToolName("ping", "late-direct", "server");
			await waitFor(
				async () => session.getActiveToolNames().includes(directName),
				"the late eager server's direct tool to become active",
			);
			const definition = session.getToolDefinition(directName);
			assert.ok(definition?.outputSchema, "direct MCP scripts must receive a CallToolResult envelope");
			assert.equal(definition.exposure, "direct");
			assert.equal(definition.namespace?.name, "mcp:late-direct");
			assert.ok(session.getCallableToolNames().includes(directName));
			session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== directName));
			assert.ok(
				!session.getCallableToolNames().includes(directName),
				"inactive direct MCP tools stay unavailable to scripts",
			);
		} finally {
			await session.dispose();
		}
	},
	REAL_MCP_SESSION_TIMEOUT_MS,
);

test(
	"redefining a contributed server without direct tools retires its direct tools (#3355)",
	async () => {
		stubConnect((name) => (name === "direct-server" ? [{ name: "ping", description: "Ping the server" }] : []));
		let api: ExtensionAPI | undefined;
		const session = await startMcpSession((pi) => {
			api = pi;
			pi.registerMcpServer("direct-server", {
				url: "https://direct.test/mcp",
				lifecycle: "eager",
				directTools: true,
			});
		});
		try {
			const directName = formatToolName("ping", "direct-server", "server");
			await waitFor(
				async () => session.getActiveToolNames().includes(directName),
				"the contributed server's direct tool to become active",
			);
			assert.ok(api);
			api.registerMcpServer("direct-server", {
				url: "https://direct.test/mcp",
				lifecycle: "eager",
				directTools: false,
			});
			await waitFor(
				async () => !session.getActiveToolNames().includes(directName),
				"the redefined server's direct tool to be retired",
			);
			api.registerMcpServer("direct-server", {
				url: "https://direct.test/mcp",
				lifecycle: "eager",
				directTools: true,
			});
			await waitFor(
				async () => session.getActiveToolNames().includes(directName),
				"the direct tool to return when the server enables direct tools again",
			);
		} finally {
			await session.dispose();
		}
	},
	REAL_MCP_SESSION_TIMEOUT_MS,
);

test(
	"a direct tool the user deactivated stays inactive when its contributed server is removed and restored (#3355)",
	async () => {
		stubConnect((name) =>
			name === "direct-server"
				? [
						{ name: "ping", description: "Ping the server" },
						{ name: "pong", description: "Pong the server" },
					]
				: [],
		);
		let api: ExtensionAPI | undefined;
		const session = await startMcpSession((pi) => {
			api = pi;
			pi.registerMcpServer("direct-server", {
				url: "https://direct.test/mcp",
				lifecycle: "eager",
				directTools: true,
			});
		});
		try {
			const deactivatedName = formatToolName("ping", "direct-server", "server");
			const activeName = formatToolName("pong", "direct-server", "server");
			await waitFor(
				async () =>
					session.getActiveToolNames().includes(deactivatedName) &&
					session.getActiveToolNames().includes(activeName),
				"the contributed server's direct tools to become active",
			);
			session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== deactivatedName));
			assert.ok(api);
			api.registerMcpServer("direct-server", {
				url: "https://direct.test/mcp",
				lifecycle: "eager",
				directTools: false,
			});
			await waitFor(
				async () => !session.getActiveToolNames().includes(activeName),
				"the redefined server's direct tools to be retired",
			);
			api.registerMcpServer("direct-server", {
				url: "https://direct.test/mcp",
				lifecycle: "eager",
				directTools: true,
			});
			await waitFor(
				async () => session.getActiveToolNames().includes(activeName),
				"the active direct tool to return when the server enables direct tools again",
			);
			assert.ok(!session.getActiveToolNames().includes(deactivatedName));
		} finally {
			await session.dispose();
		}
	},
	REAL_MCP_SESSION_TIMEOUT_MS,
);

test(
	"MCP sees package servers and registrations from any extension order, including after initialization (#3355)",
	async () => {
		const connected = stubConnect();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const pkgDir = join(root, "acme-tools");
		await writeFileEnsuringDir(
			join(pkgDir, "package.json"),
			JSON.stringify({
				name: "acme-tools",
				atomic: { mcpServers: { "package-server": { url: "https://package.test/mcp" } } },
			}),
		);
		let lateApi: ExtensionAPI | undefined;
		const settingsManager = SettingsManager.inMemory({ packages: [pkgDir], sessionSummary: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				{
					name: "before-mcp",
					factory: (pi) => {
						pi.on("session_start", () => {
							pi.registerMcpServer("early-start", { url: "https://early.test/mcp" });
						});
					},
				},
				mcp,
				{
					name: "after-mcp",
					factory: (pi) => {
						lateApi = pi;
						pi.registerMcpServer("factory-server", { url: "https://factory.test/mcp", lifecycle: "eager" });
						pi.on("session_start", () => {
							pi.registerMcpServer("late-start", { url: "https://late.test/mcp" });
						});
					},
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		});
		try {
			const gateway = session.agent.state.tools.find((tool) => tool.name === "mcp") as McpGatewayTool | undefined;
			assert.ok(gateway, "expected the MCP gateway tool");
			// The machine's ~/.config/mcp/mcp.json may add servers, so assert only on the contributed names.
			const serverNames = async (): Promise<string[]> => {
				const result = await gateway.execute("status", {}, new AbortController().signal);
				return (result.details?.servers ?? []).map((server) => server.name);
			};
			const hasServers = async (...names: string[]): Promise<boolean> => {
				const configured = await serverNames();
				return names.every((name) => configured.includes(name));
			};

			await waitFor(
				() => hasServers("package-server", "factory-server", "early-start", "late-start"),
				"package, factory and session_start contributions to reach the MCP config",
			);
			assert.ok(connected.includes("factory-server"));

			assert.ok(lateApi);
			lateApi.registerMcpServer("after-init", { url: "https://after.test/mcp", lifecycle: "eager" });
			await waitFor(() => hasServers("after-init"), "a registration after MCP initialization");
			await waitFor(async () => connected.includes("after-init"), "the late eager server to connect");
		} finally {
			await session.dispose();
		}
	},
	REAL_MCP_SESSION_TIMEOUT_MS,
);
