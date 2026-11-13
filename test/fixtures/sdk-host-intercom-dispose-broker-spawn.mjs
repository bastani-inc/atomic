import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { removeFixtureRoot } from "./sdk-host-fixture-support.mjs";

// #4727: a session disposed while the broker it launched is still starting leaves nothing that writes into its agent
// directory once dispose resolves. With `--starts-after-removal` the broker starts only after the directory is
// removed, so a broker the dispose left running recreates it and one the dispose stopped cannot. Without it the broker
// is released as the dispose begins, and the dispose waits for it to finish starting.
const startsAfterRemoval = process.argv.includes("--starts-after-removal");
const BROKER_EXIT_WAIT_MS = 20_000;
const root = mkdtempSync(join(tmpdir(), "sdk-intercom-dispose-"));
const agentDir = join(root, "agent");
const markerPath = join(root, "gated-broker.pid");
const releasePath = join(root, "gated-broker.release");
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.ATOMIC_INTERCOM_SESSION_ID;
mkdirSync(join(agentDir, "intercom"), { recursive: true });
writeFileSync(
	join(agentDir, "intercom", "config.json"),
	JSON.stringify({
		brokerCommand: process.execPath,
		brokerArgs: [fileURLToPath(new URL("./intercom-gated-broker.mjs", import.meta.url)), markerPath, releasePath],
		// A broker that starts only after the removal never starts within this; one released at dispose does.
		brokerStartupTimeoutMs: startsAfterRemoval ? 1_000 : 30_000,
	}),
);

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
		return false;
	}
}

let session;
try {
	const { createAgentSession, ModelRuntime, SessionManager, SettingsManager } = await import("@bastani/atomic");
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth"), modelsPath: null, allowModelNetwork: false });
	const cwd = join(root, "cwd");
	mkdirSync(cwd);
	({ session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		builtins: { workflows: false, subagents: false, mcp: false, "web-access": false },
		settingsManager: SettingsManager.inMemory({ sessionSummary: { enabled: false } }),
		sessionManager: SessionManager.inMemory(cwd),
	}));
	const intercom = session.agent.state.tools.find((tool) => tool.name === "intercom");
	const status = intercom.execute("intercom", { action: "status" }, new AbortController().signal).catch((error) => error);
	while (!existsSync(markerPath)) await delay(10);
	const brokerPid = Number(readFileSync(markerPath, "utf8"));

	const disposed = session.dispose();
	if (!startsAfterRemoval) writeFileSync(releasePath, "");
	await disposed;
	session = undefined;
	await status;
	rmSync(agentDir, { recursive: true });

	const deadline = Date.now() + BROKER_EXIT_WAIT_MS;
	while (isAlive(brokerPid)) {
		assert.ok(Date.now() < deadline, "the broker the disposed session launched is still running");
		await delay(20);
	}
	assert.equal(existsSync(agentDir), false, "the agent directory was written after dispose resolved");
	console.log(JSON.stringify({ verified: true }));
} finally {
	await session?.dispose();
	await removeFixtureRoot(root);
}
