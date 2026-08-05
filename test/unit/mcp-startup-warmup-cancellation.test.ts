import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type { McpServerManager } from "../../packages/mcp/server-manager.ts";
import { resolveMcpDirectToolsSelection, scheduleMcpStartupWarmup } from "../../packages/mcp/startup-warmup.ts";
import type { McpExtensionState } from "../../packages/mcp/state.ts";
import type { McpConfig } from "../../packages/mcp/types.ts";

const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
let tmpRoot = "";

type McpConnection = Awaited<ReturnType<McpServerManager["connect"]>>;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "atomic-mcp-warmup-cancel-"));
	process.env.ATOMIC_CODING_AGENT_DIR = join(tmpRoot, "agent");
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	rmSync(tmpRoot, { recursive: true, force: true });
});

test("typed MCP direct-tool policy preserves defaults, explicit tools, and none", () => {
	const base = {
		managementActions: "restricted" as const,
		fanoutAuthorized: false,
		inheritProjectContext: true,
		inheritSkills: true,
	};
	assert.deepEqual(resolveMcpDirectToolsSelection(base), { disabled: false });
	assert.deepEqual(resolveMcpDirectToolsSelection({ ...base, mcpDirectTools: ["github/search_code"] }), {
		disabled: false,
		tools: ["github/search_code"],
	});
	assert.deepEqual(resolveMcpDirectToolsSelection({ ...base, mcpDirectTools: [] }), { disabled: true, tools: [] });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

test("MCP startup warmup discards post-connect metadata after cancellation", async () => {
	const started = deferred<void>();
	const release = deferred<McpConnection>();
	let currentConnection: McpConnection | undefined;
	let closeCalls = 0;
	let directToolCallbacks = 0;
	let settled = false;
	const manager = {
		async connect(): Promise<McpConnection> {
			started.resolve();
			currentConnection = await release.promise;
			return currentConnection;
		},
		getConnection(): McpConnection | undefined {
			return currentConnection;
		},
		async close(): Promise<void> {
			closeCalls += 1;
			currentConnection = undefined;
		},
	} as Pick<McpServerManager, "connect" | "getConnection" | "close"> as McpServerManager;
	const config: McpConfig = {
		mcpServers: {
			lazy: { command: "bun", args: ["--version"], directTools: true },
		},
	};
	const state = {
		manager,
		config,
		toolMetadata: new Map(),
		lifecycle: {},
		failureTracker: new Map(),
		uiResourceHandler: {},
		consentManager: {},
		uiServer: null,
		completedUiSessions: [],
		openBrowser: async () => undefined,
	} as unknown as McpExtensionState;
	const handle = scheduleMcpStartupWarmup(state, {
		onDirectToolsChanged: () => {
			directToolCallbacks += 1;
		},
		onSettled: () => {
			settled = true;
		},
	});
	await started.promise;
	handle.cancel();
	release.resolve({
		client: { close: async () => undefined },
		transport: { close: async () => undefined },
		definition: config.mcpServers.lazy!,
		tools: [{ name: "late_tool", description: "late", inputSchema: { type: "object", properties: {} } }],
		resources: [],
		lastUsedAt: Date.now(),
		inFlight: 0,
		status: "connected",
	} as unknown as McpConnection);
	await handle.promise;
	assert.equal(closeCalls, 1);
	assert.equal(state.toolMetadata.size, 0);
	assert.equal(directToolCallbacks, 0);
	assert.equal(settled, true);
});
