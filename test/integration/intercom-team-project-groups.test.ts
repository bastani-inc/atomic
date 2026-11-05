import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { resolveHomeGroup } from "../../packages/intercom/group.js";
import { projectHomeGroup } from "../../packages/intercom/project-group.js";
import { type BrokerNode, type TwoBrokerClient, TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";
import { removeTempDirectory } from "../helpers/runtime.js";

/** Spawning two real broker processes (and restarting one after SIGKILL) is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
const LISTING_WAIT_MS = 20_000;
const REAL_BROKERS_TEST_TIMEOUT_MS = 90_000;

let harness: TwoBrokerHarness;
let repositories: string;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
	repositories = mkdtempSync(join(tmpdir(), "team-repos-"));
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(async () => {
	await harness?.cleanup();
	removeTempDirectory(repositories);
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => {
	vi.stubEnv("ATOMIC_INTERCOM_GROUP", "");
	vi.stubEnv("PI_INTERCOM_GROUP", "");
	return harness.ensureBrokersRunning();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

function clone(name: string, origin: string): string {
	const directory = join(repositories, unique(name));
	mkdirSync(directory, { recursive: true });
	for (const args of [
		["init", "--quiet"],
		["remote", "add", "origin", origin],
	]) {
		const result = spawnSync("git", ["-C", directory, ...args], { env: createGitEnvironment(), encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
	return directory;
}

/** The home group a session with no explicit group gets on this node, as the Intercom extension resolves it. */
function homeGroup(node: BrokerNode, cwd: string): string {
	return resolveHomeGroup({}, null, () =>
		projectHomeGroup(cwd, harness.agentDir(node), { ATOMIC_STORAGE: "" }, createGitEnvironment()),
	);
}

async function listed(client: TwoBrokerClient): Promise<Set<string>> {
	return new Set((await client.client.listSessions()).map((session) => session.id));
}

async function assertVisibility(
	sameProject: readonly [TwoBrokerClient, TwoBrokerClient],
	otherProject: readonly TwoBrokerClient[],
): Promise<void> {
	const [first, second] = sameProject;
	if (harness.multiNodeRouting) {
		await vi.waitFor(
			async () => {
				if (!(await listed(first)).has(second.sessionId))
					throw new Error(`${first.name} does not list ${second.name}`);
			},
			{ timeout: LISTING_WAIT_MS, interval: 50 },
		);
	}
	for (const client of sameProject) {
		const ids = await listed(client);
		for (const other of otherProject)
			assert.equal(ids.has(other.sessionId), false, `${client.name} lists ${other.name}`);
	}
	for (const client of otherProject) {
		const ids = await listed(client);
		for (const other of sameProject)
			assert.equal(ids.has(other.sessionId), false, `${client.name} lists ${other.name}`);
	}
	const refused = await first.client.send(otherProject[0]!.sessionId, { text: "cross-project" });
	assert.equal(refused.delivered, false);
	assert.deepEqual(otherProject[0]!.received, []);
}

test(
	"two repositories on one shared database cannot see each other in intercom list by default, while one repository's sessions can (#4320)",
	async ({ annotate }) => {
		const alphaOnA = clone("alpha", "git@github.com:acme/alpha.git");
		const alphaOnB = clone("alpha", "https://user:token@github.com/acme/alpha.git");
		const betaOnB = clone("beta", "git@github.com:acme/beta.git");
		const betaOnA = clone("beta", "ssh://git@github.com/acme/beta.git");
		assert.equal(homeGroup("a", alphaOnA), "project:acme/alpha");
		assert.equal(homeGroup("b", alphaOnB), "project:acme/alpha");
		assert.equal(homeGroup("b", betaOnB), "project:acme/beta");

		const alphaA = await harness.connect("a", unique("alpha-a"), { group: homeGroup("a", alphaOnA) });
		const alphaB = await harness.connect("b", unique("alpha-b"), { group: homeGroup("b", alphaOnB) });
		const betaB = await harness.connect("b", unique("beta-b"), { group: homeGroup("b", betaOnB) });
		const betaA = await harness.connect("a", unique("beta-a"), { group: homeGroup("a", betaOnA) });
		if (!harness.multiNodeRouting) await annotate("multi-node routing not advertised: asserted isolation only");
		await assertVisibility([alphaA, alphaB], [betaA, betaB]);
		await assertVisibility([betaB, betaA], [alphaA, alphaB]);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

test(
	"project isolation still holds after a broker is SIGKILLed and its sessions reconnect (#4320)",
	async ({ annotate }) => {
		const alpha = clone("alpha", "git@github.com:acme/alpha.git");
		const beta = clone("beta", "git@github.com:acme/beta.git");
		const alphaA = await harness.connect("a", unique("alpha-a"), { group: homeGroup("a", alpha) });
		const betaA = await harness.connect("a", unique("beta-a"), { group: homeGroup("a", beta) });
		await harness.connect("b", unique("doomed"), { group: homeGroup("b", alpha) });
		await harness.stopBroker("b", "SIGKILL");
		await harness.startBroker("b");
		const alphaB = await harness.connect("b", unique("alpha-b"), { group: homeGroup("b", alpha) });
		const betaB = await harness.connect("b", unique("beta-b"), { group: homeGroup("b", beta) });
		if (!harness.multiNodeRouting) await annotate("multi-node routing not advertised: asserted isolation only");
		await assertVisibility([alphaA, alphaB], [betaA, betaB]);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);
