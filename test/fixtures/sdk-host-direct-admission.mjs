import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime } from "../../packages/coding-agent/dist/index.js";

// #3105: natural Node exit after refusal of new work and drain of admitted work.
const mode = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), "sdk-direct-admission-"));
const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null, allowModelNetwork: false });
let api, enter, release, shutdown = false;
const entered = new Promise(resolve => { enter = resolve; });
const gate = new Promise(resolve => { release = resolve; });
const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true,
  extensionFactories: [pi => {
    pi.on("session_start", () => { api = pi; });
    pi.on("session_shutdown", async () => {
      if (mode === "close") { enter(); await gate; await pi.appendEntry("cleanup", { complete: true }); }
      shutdown = true;
    });
  }] });
let session, operation, close, child;
try {
  ({ session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd), tools: [], builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } }));
  const exec = () => api.exec(process.execPath, ["-e", 'process.stdout.write("allowed")']);
  assert.equal((await exec()).stdout, "allowed");
  await session.abort(); assert.equal((await exec()).stdout, "allowed");
  if (mode === "drain") {
    child = api.exec(process.execPath, ["-e", 'const fs=require("node:fs"); fs.writeFileSync("started", ""); const timer=setInterval(()=>{if(fs.existsSync("release")){clearInterval(timer);process.stdout.write("completed");}},10);']);
    while (!existsSync(join(cwd, "started"))) await new Promise(resolve => setTimeout(resolve, 10));
    close = session.dispose();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(shutdown, false);
    writeFileSync(join(cwd, "release"), "");
    assert.equal((await child).stdout, "completed");
    await close; assert.equal(shutdown, true);
  } else {
    const retired = api;
    operation = mode === "close" ? session.dispose() : session.reload({ beforeSessionStart: async () => {
      enter(); await gate; if (mode === "rollback") throw new Error("reject candidate");
    } });
    void operation.catch(() => {});
    const refuses = async () => {
      assert.throws(() => retired.exec(process.execPath, ["-e", 'throw Error("must not launch")']), /closed|stale|no longer active/i);
      await assert.rejects(() => retired.setSessionName("unadmitted"), /closed|stale|no longer active/i);
      assert.throws(() => retired.registerCommand("unadmitted", { description: "forbidden", handler: async () => {} }), /closed|stale|no longer active/i);
      assert.throws(() => retired.events.on("unadmitted", () => {}), /closed|stale|no longer active/i);
    };
    await refuses(); await entered; await refuses();
    if (mode === "cancel") { close = session.dispose(); void close.catch(() => {}); }
    release();
    if (mode === "rollback") await assert.rejects(operation, /reject candidate/);
    else if (mode === "cancel") await assert.rejects(operation, { code: "SessionClosed" });
    else await operation;
    if (mode === "reload" || mode === "rollback") assert.equal((await exec()).stdout, "allowed");
    if (mode === "close") assert.equal(shutdown, true);
  }
} finally {
  release(); writeFileSync(join(cwd, "release"), "");
  await child; await operation?.catch(() => {}); await (close ?? session?.dispose());
  rmSync(cwd, { recursive: true, force: true });
}
console.log(JSON.stringify({ mode, verified: true }));
