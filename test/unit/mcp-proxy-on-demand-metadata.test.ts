import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDescribe, executeList, executeSearch } from "../../packages/mcp/proxy-info-modes.ts";
import type { McpExtensionState } from "../../packages/mcp/state.ts";
import type { McpTool, ServerDefinition } from "../../packages/mcp/types.ts";
import type { McpServerManager } from "../../packages/mcp/server-manager.ts";

const originalEnv = process.env.ATOMIC_CODING_AGENT_DIR;
let tmpRoot = "";

interface FakeConnection {
  client: { close: () => Promise<void> };
  transport: { close: () => Promise<void> };
  definition: ServerDefinition;
  tools: McpTool[];
  resources: [];
  lastUsedAt: number;
  inFlight: number;
  status: "connected";
}

function tool(name: string, description: string): McpTool {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string", description: "Search value" } },
      required: ["value"],
    },
  };
}

function createState(serverTools: Record<string, McpTool[]>): {
  state: McpExtensionState;
  connected: string[];
} {
  const connections = new Map<string, FakeConnection>();
  const connected: string[] = [];
  const definitions = Object.fromEntries(
    Object.keys(serverTools).map((name) => [name, { command: "bun", args: ["--version"] } satisfies ServerDefinition]),
  );
  const manager = {
    async connect(name: string, definition: ServerDefinition): Promise<FakeConnection> {
      connected.push(name);
      const connection: FakeConnection = {
        client: { close: async () => undefined },
        transport: { close: async () => undefined },
        definition,
        tools: serverTools[name] ?? [],
        resources: [],
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: "connected",
      };
      connections.set(name, connection);
      return connection;
    },
    getConnection(name: string): FakeConnection | undefined {
      return connections.get(name);
    },
    getAllConnections(): Map<string, FakeConnection> {
      return new Map(connections);
    },
  };

  return {
    connected,
    state: {
      manager: manager as unknown as McpServerManager,
      lifecycle: {} as McpExtensionState["lifecycle"],
      toolMetadata: new Map(),
      config: { mcpServers: definitions },
      failureTracker: new Map(),
      uiResourceHandler: {} as McpExtensionState["uiResourceHandler"],
      consentManager: {} as McpExtensionState["consentManager"],
      uiServer: null,
      completedUiSessions: [],
      openBrowser: async () => undefined,
    },
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "atomic-mcp-proxy-hydration-"));
  process.env.ATOMIC_CODING_AGENT_DIR = join(tmpRoot, "agent");
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
  else process.env.ATOMIC_CODING_AGENT_DIR = originalEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});
function resultText(result: Awaited<ReturnType<typeof executeSearch>>): string {
  const first = result.content[0];
  return first.type === "text" ? first.text : "";
}


describe("MCP proxy on-demand metadata hydration", () => {
  test("cold-cache search hydrates lazy servers without direct tools", async () => {
    const { state, connected } = createState({ lazy: [tool("cold_tool", "cold searchable tool")] });

    const result = await executeSearch(state, "cold");

    assert.deepEqual(connected, ["lazy"]);
    assert.equal(result.details.count, 1);
    assert.equal(state.toolMetadata.get("lazy")?.[0]?.name, "lazy_cold_tool");
  });

  test("cold-cache describe hydrates metadata and returns schema", async () => {
    const { state, connected } = createState({ lazy: [tool("cold_tool", "cold describable tool")] });

    const result = await executeDescribe(state, "lazy_cold_tool");

    assert.deepEqual(connected, ["lazy"]);
    assert.equal(result.details.server, "lazy");
    assert.match(resultText(result), /Parameters:/);
    assert.match(resultText(result), /value/);
  });

  test("cold-cache describe hydrates only the prefix-matched server first", async () => {
    const { state, connected } = createState({
      github: [tool("create_issue", "create issue")],
      unrelated: [tool("create_issue", "unrelated issue")],
    });

    const result = await executeDescribe(state, "github_create_issue");

    assert.deepEqual(connected, ["github"]);
    assert.equal(result.details.server, "github");
    assert.equal(state.toolMetadata.has("unrelated"), false);
  });

  test("cold-cache server list hydrates requested server", async () => {
    const { state, connected } = createState({ lazy: [tool("cold_tool", "cold listed tool")] });

    const result = await executeList(state, "lazy");

    assert.deepEqual(connected, ["lazy"]);
    assert.equal(result.details.count, 1);
    assert.match(resultText(result), /lazy_cold_tool/);
  });

  test("targeted search hydrates only the requested server", async () => {
    const { state, connected } = createState({
      target: [tool("cold_tool", "target cold tool")],
      other: [tool("cold_tool", "other cold tool")],
    });

    const result = await executeSearch(state, "cold", false, "target");

    assert.deepEqual(connected, ["target"]);
    assert.equal(result.details.count, 1);
    assert.deepEqual(result.details.matches, [{ server: "target", tool: "target_cold_tool" }]);
    assert.equal(state.toolMetadata.has("other"), false);
  });
});
