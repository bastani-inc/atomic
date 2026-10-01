import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// #3105: built public SDK, native background discovery, independent HTTP owners,
// non-TTY Node and natural exit (no process.exit or forced handle cleanup).
const cwd = mkdtempSync(join(tmpdir(), "sdk-native-mcp-"));
const agentDir = join(cwd, "agent");
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
let requests = 0;
let initializations = 0;
const calls = [];
const server = createServer(async (request, response) => {
 requests++;
 if (request.method !== "POST") { response.writeHead(405).end(); return; }
 let body = "";
 for await (const chunk of request) body += chunk;
 const message = JSON.parse(body);
 if (message.id === undefined) { response.writeHead(202).end(); return; }
 if (message.method === "initialize") initializations++;
 if (message.method === "tools/call") calls.push({ name: message.params.name, arguments: message.params.arguments });
 const result = message.method === "initialize"
  ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
  : message.method === "tools/call"
   ? { content: [{ type: "text", text: "owned HTTP result" }] }
   : { tools: [{ name: "echo", description: "Local echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
 response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let first;
let second;
async function nativeEcho(session) {
 const deadline = Date.now() + 10_000;
 while (!session.getActiveToolNames().includes("mcp__fixture__echo")) {
  assert.ok(Date.now() < deadline, `native discovery did not expose echo: ${session.getActiveToolNames().join(", ")}`);
  await delay(25);
 }
 const tool = session.agent.state.tools.find(tool => tool.name === "mcp__fixture__echo");
 assert.ok(tool);
 return tool;
}
try {
 const { createAgentSession, SessionManager, SettingsManager, ModelRuntime } = await import("@bastani/atomic");
 const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null, allowModelNetwork: false });
 const address = server.address();
 assert.ok(address && typeof address === "object");
 for (const name of ["first", "second"]) {
  const project = join(cwd, name);
  mkdirSync(join(project, ".atomic"), { recursive: true });
  writeFileSync(join(project, ".atomic", "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: `http://127.0.0.1:${address.port}/mcp`, exposure: "direct" } } }));
  writeFileSync(join(project, ".atomic", "settings.json"), JSON.stringify({ sessionSummary: { enabled: false } }));
  // Only native MCP is under test; do not initialize unrelated workflow hosts.
  const { session } = await createAgentSession({ cwd: project, agentDir, modelRuntime,
   builtins: { workflows: false, subagents: false, "web-access": false, intercom: false },
   settingsManager: SettingsManager.create(project, agentDir, { projectTrusted: true }), sessionManager: SessionManager.inMemory(project) });
  if (name === "first") first = session; else second = session;
 }
 const [firstEcho, secondEcho] = await Promise.all([nativeEcho(first), nativeEcho(second)]);
 assert.equal(initializations, 2, "each SDK session must own its native MCP connection");
 const secondResult = await secondEcho.execute("second-echo", { text: "second owner" }, new AbortController().signal);
 assert.deepEqual(secondResult.content, [{ type: "text", text: "owned HTTP result" }]);
 await second.dispose();
 const result = await firstEcho.execute("first-echo", { text: "surviving owner" }, new AbortController().signal);
 assert.deepEqual(result.content, [{ type: "text", text: "owned HTTP result" }]);
 assert.deepEqual(calls, [
  { name: "echo", arguments: { text: "second owner" } },
  { name: "echo", arguments: { text: "surviving owner" } }
 ]);
 await first.dispose();
 console.log(JSON.stringify({ verified: true, requests }));
} finally {
 await Promise.all([first?.dispose(), second?.dispose()]);
 await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
 rmSync(cwd, { recursive: true, force: true });
}
