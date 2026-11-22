import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@bastani/atomic";

// #3105: built public Node exports, independently released callbacks and natural exit.
assert.equal(process.versions.bun, undefined);
assert.ok(import.meta.resolve("@bastani/atomic").endsWith("/dist/index.js"));
const cwd = mkdtempSync(join(tmpdir(), "atomic-review-lifecycle-"));
const mode = process.argv[2];
const settingsManager = SettingsManager.inMemory();
const options = { cwd, agentDir: cwd, settingsManager, sessionManager: SessionManager.inMemory(cwd),
  builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } };
const sessions = [];
try {
  if (mode === "owner") {
    const a = (await createAgentSession(options)).session;
    sessions.push(a);
    const b = (await createAgentSession(options)).session;
    sessions.push(b);
    assert.equal(a.sessionId, b.sessionId);
    const tool = (session, name) => session.agent.state.tools.find((entry) => entry.name === name);
    const command = (session, text) => tool(session, "bash").execute("foreground", { command: text, wait: { kind: "foreground" } });
    await command(a, "printf A");
    const background = await tool(b, "bash").execute("background", { command: "printf READY; sleep 30", wait: { kind: "background" } });
    const id = background.details.observation.taskId;
    await a.dispose();
    const wait = await tool(b, "bash").execute("wait", { action: "wait", id, budgetMs: 0 });
    assert.equal(wait.details.observation.kind, "yielded");
    assert.equal(wait.details.observation.taskId, id);
    await tool(b, "kill").execute("kill", { id });
    const settled = await tool(b, "bash").execute("settle", { action: "wait", id, budgetMs: 10000 });
    assert.notEqual(settled.details.observation?.kind, "yielded");
    assert.match(JSON.stringify(await command(b, "printf SURVIVED")), /SURVIVED/);
    await b.reload();
    assert.match(JSON.stringify(await command(b, "printf RELOADED")), /RELOADED/);
  } else {
    assert.ok(["steer", "followUp"].includes(mode));
    let enter, release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const loader = new DefaultResourceLoader({ ...options, noExtensions: true, noContextFiles: true,
      extensionFactories: [(atomic) => { atomic.on("input", async () => { enter(); await gate; return { action: "transform", text: "retired" }; }); }] });
    await loader.reload();
    const session = (await createAgentSession({ ...options, resourceLoader: loader })).session;
    sessions.push(session);
    const result = session[mode]("  raw  ").catch((error) => error);
    await entered;
    let closed = false;
    const closing = session.dispose().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const prematurelyClosed = closed;
    release();
    assert.equal((await result).code, "SessionClosed");
    await closing;
    assert.equal(prematurelyClosed, false);
    await assert.rejects(session[mode]("late"), { code: "SessionClosed" });
    assert.deepEqual(session.getSteeringMessages(), []);
    assert.deepEqual(session.getFollowUpMessages(), []);
  }
  await Promise.all(sessions.map((session) => session.dispose()));
  console.log(JSON.stringify({ mode, closed: true }));
} finally {
  await Promise.all(sessions.map((session) => session.dispose()));
  rmSync(cwd, { recursive: true, force: true });
}
