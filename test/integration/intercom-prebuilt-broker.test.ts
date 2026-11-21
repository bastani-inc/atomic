import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import { ENDED_QUEUE_OPEN_WAIT_ENV } from "../../packages/intercom/broker/durable-ended-queue.js";
import { createMessageReader, type JsonWireValue, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { resolveBrokerEntrypoint, spawnBrokerIfNeeded } from "../../packages/intercom/broker/spawn.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { makeTempDirectory, moduleDir, removePath } from "../helpers/runtime.js";
import { replaceEnvironmentVariable } from "../helpers/temporary-agent-dir.js";

/**
 * An installed Atomic starts its Intercom broker from the prebuilt `broker/broker.bundle.mjs` the build writes beside
 * the broker's source: no TypeScript loader runs, and the broker reads one file of its own.
 *
 * The installed intercom package is a copy of the built one in a directory where no TypeScript loader resolves, beside
 * Atomic's own packages (the built `@bastani/atomic` its broker loads the storage layer from, and its native module).
 */

const repoRoot = resolve(moduleDir(import.meta.url), "../..");
const builtIntercom = join(repoRoot, "packages/coding-agent/dist/builtin/intercom");
const runTest = existsSync(join(builtIntercom, "package.json")) ? test : test.skip;

/** A real detached broker process started, registered with, and stopped. */
const PREBUILT_BROKER_TEST_TIMEOUT_MS = 60_000;
const BROKER_READY_TIMEOUT_MS = 30_000;
const REGISTER_TIMEOUT_MS = 20_000;
/** The first registration waits this long for the store, not 2 s: loading it takes longer on a loaded machine. */
const STORE_OPEN_WAIT_MS = 15_000;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface InstalledLayout {
	readonly intercomDir: string;
	readonly agentDir: string;
}

function installedLayout(): InstalledLayout {
	const root = makeTempDirectory("intercom-prebuilt-broker-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const restoreAgentDir = replaceEnvironmentVariable("ATOMIC_CODING_AGENT_DIR", agentDir);
	const restoreOpenWait = replaceEnvironmentVariable(ENDED_QUEUE_OPEN_WAIT_ENV, String(STORE_OPEN_WAIT_MS));
	cleanups.push(async () => {
		restoreOpenWait();
		restoreAgentDir();
		await removeTempRootReleasingBroker(root, agentDir);
	});
	mkdirSync(join(root, "node_modules"), { recursive: true });
	symlinkSync(
		join(repoRoot, "node_modules", "@bastani"),
		join(root, "node_modules", "@bastani"),
		process.platform === "win32" ? "junction" : "dir",
	);
	const intercomDir = join(root, "app", "builtin", "intercom");
	cpSync(builtIntercom, intercomDir, { recursive: true });
	return { intercomDir, agentDir };
}

/** Register a session over the broker's socket and return its `registered` frame. */
function register(agentDir: string): Promise<Record<string, JsonWireValue>> {
	const socket = net.connect(getBrokerSocketPath(process.platform, agentDir));
	return new Promise<Record<string, JsonWireValue>>((resolveRegistered, reject) => {
		const timer = setTimeout(() => reject(new Error("no registered frame")), REGISTER_TIMEOUT_MS);
		const finish = (settle: () => void) => {
			clearTimeout(timer);
			socket.destroy();
			settle();
		};
		socket.once("error", (error) => finish(() => reject(error)));
		socket.on(
			"data",
			createMessageReader(
				(message) => {
					if (typeof message !== "object" || message === null || Array.isArray(message)) return;
					if (message.type === "registered") finish(() => resolveRegistered(message));
				},
				(error) => finish(() => reject(error)),
			),
		);
		socket.once("connect", () => {
			const now = Date.now();
			writeMessage(socket, {
				type: "register",
				session: { cwd: agentDir, model: "fixture", pid: process.pid, startedAt: now, lastActivity: now },
			});
		});
	});
}

runTest(
	"an installed Intercom broker starts from prebuilt JavaScript, without a TypeScript loader",
	async () => {
		const { intercomDir, agentDir } = installedLayout();
		assert.equal(resolveBrokerEntrypoint(intercomDir), join(intercomDir, "broker", "broker.bundle.mjs"));

		await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"], BROKER_READY_TIMEOUT_MS, intercomDir);
		const registered = await register(agentDir);

		// The durable wake queue opened: the storage layer loaded from the installed Atomic once a store needed it.
		assert.equal(registered.dropsEndedQueued, true);
	},
	PREBUILT_BROKER_TEST_TIMEOUT_MS,
);

runTest(
	"a listening broker keeps its durable wake queue when its package is replaced in place",
	async () => {
		const { intercomDir, agentDir } = installedLayout();
		await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"], BROKER_READY_TIMEOUT_MS, intercomDir);

		// An upgrade replaces the package before any session registers: none of the files this broker started from remain.
		// (The directory itself stays: it is the broker's working directory, which Windows does not let anything remove.)
		for (const entry of readdirSync(intercomDir)) {
			await removePath(join(intercomDir, entry), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
		}

		const registered = await register(agentDir);
		assert.equal(registered.dropsEndedQueued, true);
	},
	PREBUILT_BROKER_TEST_TIMEOUT_MS,
);
