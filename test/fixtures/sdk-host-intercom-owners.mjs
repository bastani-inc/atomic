import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitFixtureBrokerExit, removeFixtureRoot } from "./sdk-host-fixture-support.mjs";

// #3105: the fixture owns the isolated broker; sessions own only their socket leases.
const root = mkdtempSync(join(tmpdir(), "sdk-intercom-owners-"));
const agentDir = join(root, "agent");
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.ATOMIC_INTERCOM_SESSION_ID;
const sessions = [];
const pidPath = join(agentDir, "intercom", "broker.pid");
try {
	const { createAgentSession, ModelRuntime, SessionManager, SettingsManager } = await import("@bastani/atomic");
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth"), modelsPath: null, allowModelNetwork: false });
	for (let index = 0; index < 2; index++) {
		const cwd = join(root, String(index));
		mkdirSync(cwd);
		const { session } = await createAgentSession({ cwd, agentDir, modelRuntime,
			builtins: { workflows: false, subagents: false, mcp: false, "web-access": false },
			settingsManager: SettingsManager.inMemory({ sessionSummary: { enabled: false } }), sessionManager: SessionManager.inMemory(cwd) });
		sessions.push(session);
	}
	assert.equal(existsSync(pidPath), false, "discovery started the broker");
	const call = (index, args, signal = new AbortController().signal) => sessions[index].agent.state.tools.find(tool => tool.name === "intercom").execute("intercom", args, signal);
	const status = await Promise.all([call(0, { action: "status" }), call(1, { action: "status" })]);
	const ids = status.map(result => JSON.stringify(result.content).match(/Session ID: ([a-f0-9-]+)/)?.[1]);
	assert.ok(ids.every(Boolean), JSON.stringify(status));
	assert.notEqual(ids[0], ids[1]);
	assert.equal(existsSync(pidPath), true);
	const pid = Number(readFileSync(pidPath, "utf8").trim());
	assert.ok(Number.isInteger(pid) && pid > 0);
	for (let index = 0; index < 2; index++) {
		await call(index, { action: "join", group: `owner-${index}` });
		await call(index, { action: "leave", group: "default" });
	}
	const refused = await call(0, { action: "send", to: ids[1], message: "cross-group must fail" });
	assert.equal(refused.details.delivered, false, JSON.stringify(refused));
	assert.match(refused.details.reason, /different intercom group/);
	await call(1, { action: "join", group: "owner-0" });
	const delivered = await call(0, { action: "send", to: ids[1], message: "same-group delivery" });
	assert.equal(delivered.details.delivered, true, JSON.stringify(delivered));
	await Promise.all([sessions[0].dispose(), sessions[0].dispose()]);
	process.kill(pid, 0);
	const sibling = await call(1, { action: "status" });
	assert.match(JSON.stringify(sibling.content), new RegExp(ids[1]));
	const list = await call(1, { action: "list" });
	assert.doesNotMatch(JSON.stringify(list), new RegExp(ids[0]));
	assert.equal(Number(readFileSync(pidPath, "utf8").trim()), pid);
	await sessions[1].dispose();
	process.kill(pid, 0);
	console.log(JSON.stringify({ verified: true }));
} finally {
	await Promise.all(sessions.map(session => session.dispose()));
	await awaitFixtureBrokerExit(agentDir);
	await removeFixtureRoot(root);
}
