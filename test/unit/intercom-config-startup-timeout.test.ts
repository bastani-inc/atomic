import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, test, vi } from "vitest";
import {
	BROKER_READY_TIMEOUT_MS,
	MIN_BROKER_STARTUP_TIMEOUT_MS,
} from "../../packages/intercom/broker/startup-timeout.js";

/** `brokerStartupTimeoutMs` in the Intercom config.json: how long a spawn attempt waits for a new broker to answer. */

const agentDir = mkdtempSync(join(tmpdir(), "intercom-startup-timeout-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
const configPath = join(agentDir, "intercom", "config.json");

beforeAll(() => {
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_CODING_AGENT_DIR;
	mkdirSync(join(agentDir, "intercom"), { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(configPath, { force: true });
});

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

/** The config module resolves its file path on load, so each case loads it afresh. */
async function loadIntercomConfig(contents?: unknown) {
	if (contents !== undefined) writeFileSync(configPath, JSON.stringify(contents));
	vi.resetModules();
	const { loadConfig } = await import("../../packages/intercom/config.js");
	return loadConfig();
}

describe("brokerStartupTimeoutMs", () => {
	test("defaults to the budget measured for a broker that starts cold on a busy machine", async () => {
		const config = await loadIntercomConfig();

		assert.equal(config.brokerStartupTimeoutMs, BROKER_READY_TIMEOUT_MS);
		// More than the former 5 s, which a loaded host or an empty jiti cache overran.
		assert.ok(config.brokerStartupTimeoutMs >= 30_000);
	});

	test("takes a value from config.json", async () => {
		const config = await loadIntercomConfig({ brokerStartupTimeoutMs: 90_000 });

		assert.equal(config.brokerStartupTimeoutMs, 90_000);
	});

	for (const [label, value] of [
		["below the smallest a broker can start in", MIN_BROKER_STARTUP_TIMEOUT_MS - 1],
		["fractional", 12_500.5],
		["text", "slow"],
		["negative", -1],
	] as const) {
		test(`rejects a value that is ${label} and keeps every default`, async () => {
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});

			const config = await loadIntercomConfig({ brokerStartupTimeoutMs: value, confirmSend: true });

			assert.equal(config.brokerStartupTimeoutMs, BROKER_READY_TIMEOUT_MS);
			assert.equal(config.confirmSend, false, "an invalid config.json is ignored as a whole, as before");
			const reported = errors.mock.calls.flat().map(String).join("\n");
			assert.match(reported, /brokerStartupTimeoutMs/u);
		});
	}
});
