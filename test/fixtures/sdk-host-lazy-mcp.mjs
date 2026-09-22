import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// #3105: built public SDK, real local HTTP MCP, non-TTY Node and natural exit.
const cwd = mkdtempSync(join(tmpdir(), "sdk-lazy-mcp-"));
process.env.ATOMIC_CODING_AGENT_DIR = join(cwd, "agent");
let requests = 0;
const server = createServer(async (request, response) => {
 requests++;
 if (request.method !== "POST") { response.writeHead(405).end(); return; }
 let body = "";
 for await (const chunk of request) body += chunk;
 const message = JSON.parse(body);
 if (message.id === undefined) { response.writeHead(202).end(); return; }
 const result = message.method === "initialize"
  ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
  : message.method === "tools/call"
   ? { content: [{ type: "text", text: "owned HTTP result" }] }
   : { tools: [{ name: "echo", description: "Local echo", inputSchema: { type: "object", properties: {} } }] };
 response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let first;
let second;
try {
 const { createAgentSession, SessionManager, SettingsManager, ModelRuntime } = await import("@bastani/atomic");
 const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null, allowModelNetwork: false });
 const address = server.address();
 for (const name of ["first", "second"]) {
  const project = join(cwd, name);
  mkdirSync(project);
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: `http://127.0.0.1:${address.port}/mcp`, directTools: true } } }));
  // Only the MCP builtin is under test. In a source checkout the other four
  // shipped packages load from workspace TypeScript through jiti, which costs
  // ~20 s per session and proves nothing about lazy HTTP ownership.
  const { session } = await createAgentSession({ cwd: project, agentDir: join(cwd, "agent"), modelRuntime,
   builtins: { workflows: false, subagents: false, "web-access": false, intercom: false },
   settingsManager: SettingsManager.inMemory({ sessionSummary: { enabled: false } }), sessionManager: SessionManager.inMemory(project) });
  if (name === "first") first = session; else second = session;
 }
 await delay(2_000);
 assert.equal(requests, 0, "discovery connected an uncached lazy server");
 const gateway = first.agent.state.tools.find(tool => tool.name === "mcp");
 const connected = await gateway.execute("connect", { connect: "fixture" }, new AbortController().signal);
 assert.equal(connected.details?.error, undefined, JSON.stringify(connected));
 assert.ok(requests > 0);
 await second.dispose();
 const result = await gateway.execute("echo", { tool: "fixture_echo", args: "{}" }, new AbortController().signal);
 assert.equal(result.details?.error, undefined, JSON.stringify(result));
 assert.match(JSON.stringify(result.content), /owned HTTP result/);
 await first.dispose();
 console.log(JSON.stringify({ verified: true, requests }));
} finally {
 await Promise.all([first?.dispose(), second?.dispose()]);
 await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
 rmSync(cwd, { recursive: true, force: true });
}
