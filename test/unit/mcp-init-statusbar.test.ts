import { test } from "bun:test";
import assert from "node:assert/strict";
import { updateStatusBar } from "../../packages/mcp/init.ts";
import type { McpExtensionState } from "../../packages/mcp/state.ts";

function makeState(overrides: {
  servers?: Record<string, object>;
  connections?: Array<[string, { status: "connected" | "closed" | "needs-auth" }]>;
  ui?: { setStatus: (key: string, value: string | undefined) => void; theme?: { fg?: (color: string, text: string) => string } };
}): McpExtensionState {
  return {
    config: { mcpServers: overrides.servers ?? {} },
    manager: {
      getAllConnections: () => new Map(overrides.connections ?? []),
    },
    ui: overrides.ui,
  } as unknown as McpExtensionState;
}

test("updateStatusBar writes unstyled status when UI theme is unavailable", () => {
  const calls: Array<{ key: string; value: string | undefined }> = [];
  const state = makeState({
    servers: { local: {} },
    connections: [],
    ui: {
      setStatus: (key, value) => calls.push({ key, value }),
    },
  });

  assert.doesNotThrow(() => updateStatusBar(state));

  assert.deepEqual(calls, [{ key: "mcp", value: "MCP: 0/1 servers" }]);
});

test("updateStatusBar uses theme accent when available", () => {
  const calls: Array<{ key: string; value: string | undefined }> = [];
  const state = makeState({
    servers: { local: {} },
    connections: [["local", { status: "connected" }]],
    ui: {
      setStatus: (key, value) => calls.push({ key, value }),
      theme: { fg: (color, text) => `<${color}>${text}</${color}>` },
    },
  });

  updateStatusBar(state);

  assert.deepEqual(calls, [{ key: "mcp", value: "<accent>MCP: 1/1 servers</accent>" }]);
});

test("updateStatusBar clears mcp status when no servers are configured", () => {
  const calls: Array<{ key: string; value: string | undefined }> = [];
  const state = makeState({
    servers: {},
    ui: {
      setStatus: (key, value) => calls.push({ key, value }),
    },
  });

  updateStatusBar(state);

  assert.deepEqual(calls, [{ key: "mcp", value: undefined }]);
});

test("updateStatusBar counts only connected MCP connections", () => {
  const calls: Array<{ key: string; value: string | undefined }> = [];
  const state = makeState({
    servers: { a: {}, b: {}, c: {} },
    connections: [
      ["a", { status: "connected" }],
      ["b", { status: "needs-auth" }],
      ["c", { status: "closed" }],
    ],
    ui: {
      setStatus: (key, value) => calls.push({ key, value }),
    },
  });

  updateStatusBar(state);

  assert.deepEqual(calls, [{ key: "mcp", value: "MCP: 1/3 servers" }]);
});
