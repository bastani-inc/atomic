import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { queryIntercomBroker, restartIntercomBroker } from "../../packages/intercom/broker/control.js";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";

/**
 * #4320: one broker serves every session of an agent directory and keeps the storage it started with. A session
 * that joins or rejoins it must take its group from what that broker actually does, not from its own environment.
 */

const REAL_BROKER_TEST_TIMEOUT_MS = 90_000;
const BROKER_WAIT_MS = 20_000;
const BACKGROUND_RECONNECT_SETTLE_MS = 3_000;
const RECURRING_ATTEMPT_WINDOW_MS = 3_500;
const STUCK_STATUS_TEST_TIMEOUT_MS = 30_000;
const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const storageAdapterModule = join(repoRoot, "test/fixtures/storage-adapter.ts");

type LifecycleHandler = (event: { type: string; reason: string }, ctx: ExtensionContext) => unknown;
interface ToolResult {
	isError: boolean;
	content: Array<{ text: string }>;
	details?: { groups?: string[]; code?: string };
}
interface IntercomTool {
	name: string;
	execute(
		id: string,
		params: { action: string },
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult>;
}

let root: string;
let agentDir: string;
const cleanups: Array<() => Promise<void> | void> = [];
const routingQueries = { count: 0 };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "icrg-"));
	agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("ATOMIC_INTERCOM_GROUP", "");
	vi.stubEnv("PI_INTERCOM_GROUP", "");
	vi.stubEnv("ATOMIC_STORAGE", "");
	vi.stubEnv("ATOMIC_PROFILE", "");
	mkdirSync(join(agentDir, "intercom"), { recursive: true });
	writeFileSync(join(agentDir, "intercom", "config.json"), JSON.stringify({ brokerCommand: "bun", brokerArgs: [] }));
	vi.resetModules();
	routingQueries.count = 0;
	vi.doMock("../../packages/intercom/broker/broker-routing.js", async () => {
		const actual = await vi.importActual<typeof import("../../packages/intercom/broker/broker-routing.js")>(
			"../../packages/intercom/broker/broker-routing.js",
		);
		return {
			...actual,
			queryBrokerRouting: (queriedAgentDir: string) => {
				routingQueries.count += 1;
				return actual.queryBrokerRouting(queriedAgentDir);
			},
		};
	});
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	const broker = await queryIntercomBroker(agentDir);
	if (broker.state === "running") {
		try {
			process.kill(broker.report.pid, "SIGTERM");
		} catch {}
	}
	vi.doUnmock("../../packages/intercom/broker/broker-routing.js");
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function sharedSelection(): { adapter: string; options: { path: string }; prefix: string } {
	return { adapter: storageAdapterModule, options: { path: join(root, "shared.sqlite") }, prefix: "team_" };
}

function sharedStorage(): string {
	return JSON.stringify(sharedSelection());
}

/** A broker started the way an Atomic process starts one, by a process launched with `ATOMIC_STORAGE`. */
function startBrokerWithStorage(selection: string): void {
	const broker = spawn("bun", [join(extensionDir, "broker/broker.ts")], {
		stdio: "ignore",
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, ATOMIC_STORAGE: selection },
	});
	cleanups.push(() => {
		broker.kill("SIGKILL");
	});
}

async function brokerRouting(status: "on" | "off"): Promise<void> {
	await vi.waitFor(
		async () => {
			const broker = await queryIntercomBroker(agentDir);
			assert.equal(broker.state, "running");
			if (broker.state === "running")
				assert.equal(broker.report.multiNode.status, status, JSON.stringify(broker.report));
		},
		{ timeout: BROKER_WAIT_MS, interval: 50 },
	);
}

async function sessionsOnBroker(): Promise<number | undefined> {
	const broker = await queryIntercomBroker(agentDir);
	return broker.state === "running" ? broker.report.sessions : undefined;
}

function repository(name: string, origin: string): string {
	const directory = join(root, name);
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

function sessionContext(cwd: string, sessionId: string, notices?: string[]): ExtensionContext {
	return {
		hasUI: notices !== undefined,
		cwd,
		isIdle: () => true,
		ui: { notify: (message: string, level: string) => notices?.push(`${level}: ${message}`), setStatus() {} },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => [] },
	} as unknown as ExtensionContext;
}

async function loadExtension() {
	const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
	const handlers = new Map<string, LifecycleHandler[]>();
	let intercomTool: IntercomTool | undefined;
	const pi = {
		on(name: string, handler: LifecycleHandler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool(tool: IntercomTool) {
			if (tool.name === "intercom") intercomTool = tool;
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		getSessionName: () => undefined,
		events: createEventBus(),
	};
	intercomHeavy(pi as never);
	const extension = {
		async start(ctx: ExtensionContext) {
			for (const handler of handlers.get("session_start") ?? [])
				await handler({ type: "session_start", reason: "startup" }, ctx);
		},
		status(ctx: ExtensionContext): Promise<ToolResult> {
			assert.ok(intercomTool, "the intercom tool is registered");
			return intercomTool.execute("status", { action: "status" }, undefined, undefined, ctx);
		},
		async stop(ctx: ExtensionContext) {
			for (const handler of handlers.get("session_shutdown") ?? [])
				await handler({ type: "session_shutdown", reason: "quit" }, ctx);
		},
	};
	return extension;
}

test(
	"sessions of two repositories that reuse a broker started with ATOMIC_STORAGE take project groups although their own environment selects no storage (#4320)",
	async () => {
		startBrokerWithStorage(sharedStorage());
		await brokerRouting("on");
		const alphaContext = sessionContext(repository("alpha", "git@github.com:acme/alpha.git"), "reuse-alpha");
		const betaContext = sessionContext(repository("beta", "git@github.com:acme/beta.git"), "reuse-beta");
		const alpha = await loadExtension();
		const beta = await loadExtension();
		cleanups.push(async () => {
			await alpha.stop(alphaContext);
			await beta.stop(betaContext);
		});
		await alpha.start(alphaContext);
		await beta.start(betaContext);

		const alphaStatus = await alpha.status(alphaContext);
		const betaStatus = await beta.status(betaContext);
		assert.equal(alphaStatus.isError, false, alphaStatus.content[0]?.text);
		assert.equal(betaStatus.isError, false, betaStatus.content[0]?.text);
		assert.deepEqual(alphaStatus.details?.groups, ["project:acme/alpha"]);
		assert.deepEqual(betaStatus.details?.groups, ["project:acme/beta"]);
		assert.match(alphaStatus.content[0]?.text ?? "", /Active visible sessions: 1\b/);
		assert.match(betaStatus.content[0]?.text ?? "", /Active visible sessions: 1\b/);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a session that joined a single-machine broker is refused when the broker comes back routing across machines, rather than registering in default (#4320)",
	async () => {
		const alphaContext = sessionContext(repository("alpha", "git@github.com:acme/alpha.git"), "rejoin-alpha");
		const alpha = await loadExtension();
		cleanups.push(() => alpha.stop(alphaContext));
		await alpha.start(alphaContext);
		const joined = await alpha.status(alphaContext);
		assert.equal(joined.isError, false, joined.content[0]?.text);
		assert.deepEqual(joined.details?.groups, ["default"]);
		await brokerRouting("off");

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ storage: sharedSelection() }));
		const restarted = await restartIntercomBroker(agentDir);
		assert.notEqual(restarted.status, "not-running");
		await new Promise((settle) => setTimeout(settle, BACKGROUND_RECONNECT_SETTLE_MS));
		await brokerRouting("on");

		const refused = await alpha.status(alphaContext);
		assert.equal(refused.isError, true, refused.content[0]?.text);
		assert.equal(refused.details?.code, "broker-routing-mismatch");
		assert.equal(await sessionsOnBroker(), 0);

		const queriesAtRefusal = routingQueries.count;
		await new Promise((settle) => setTimeout(settle, RECURRING_ATTEMPT_WINDOW_MS));
		const stillRefused = await alpha.status(alphaContext);
		assert.equal(stillRefused.details?.code, "broker-routing-mismatch");
		assert.equal(routingQueries.count, queriesAtRefusal);
		assert.equal(await sessionsOnBroker(), 0);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"an explicit group still wins on a reused broker that routes across machines, and an explicit default warns (#4320)",
	async () => {
		startBrokerWithStorage(sharedStorage());
		await brokerRouting("on");
		const repositoryPath = repository("alpha", "git@github.com:acme/alpha.git");

		vi.stubEnv("ATOMIC_INTERCOM_GROUP", "reviewers");
		const namedNotices: string[] = [];
		const namedContext = sessionContext(repositoryPath, "explicit-named", namedNotices);
		const named = await loadExtension();
		cleanups.push(() => named.stop(namedContext));
		await named.start(namedContext);
		assert.deepEqual((await named.status(namedContext)).details?.groups, ["reviewers"]);
		assert.deepEqual(namedNotices, []);

		vi.stubEnv("ATOMIC_INTERCOM_GROUP", "default");
		const sharedNotices: string[] = [];
		const sharedContext = sessionContext(repositoryPath, "explicit-default", sharedNotices);
		const shared = await loadExtension();
		cleanups.push(() => shared.stop(sharedContext));
		await shared.start(sharedContext);
		assert.deepEqual((await shared.status(sharedContext)).details?.groups, ["default"]);
		assert.equal(sharedNotices.length, 1, sharedNotices.join("\n"));
		assert.match(sharedNotices[0] ?? "", /^warning: Multi-node routing is on/);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

type StatusFault = "silent" | "unsupported" | "malformed";

interface FaultyBroker {
	statusRequests: number;
	registrations: number;
}

async function startFaultyBroker(fault: StatusFault): Promise<FaultyBroker> {
	const broker: FaultyBroker = { statusRequests: 0, registrations: 0 };
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		socket.on(
			"data",
			createMessageReader(
				(message) => {
					if (typeof message !== "object" || message === null || Array.isArray(message)) return;
					if (message.type === "register") broker.registrations += 1;
					if (message.type !== "broker_status") return;
					broker.statusRequests += 1;
					if (fault === "unsupported") socket.destroy();
					if (fault === "malformed") {
						writeMessage(socket, {
							type: "broker_status",
							requestId: message.requestId,
							report: { pid: "unknown" },
						});
					}
				},
				() => {},
			),
		);
	});
	await new Promise<void>((listening) => server.listen(getBrokerSocketPath(process.platform, agentDir), listening));
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((closed) => server.close(() => closed()));
	});
	return broker;
}

const FAULT_CODES: ReadonlyArray<readonly [StatusFault, string]> = [
	["silent", "broker-routing-timeout"],
	["unsupported", "broker-routing-unavailable"],
	["malformed", "broker-routing-unavailable"],
];

for (const [fault, code] of FAULT_CODES) {
	test(
		`a broker whose routing state cannot be verified (${fault}) denies registration with ${code} instead of using the default group (#4320)`,
		async () => {
			const faulty = await startFaultyBroker(fault);
			const alphaContext = sessionContext(
				repository("alpha", "git@github.com:acme/alpha.git"),
				`unverified-${fault}`,
			);
			const alpha = await loadExtension();
			cleanups.push(() => alpha.stop(alphaContext));
			await alpha.start(alphaContext);

			const denied = await alpha.status(alphaContext);
			assert.equal(denied.isError, true, denied.content[0]?.text);
			assert.equal(denied.details?.code, code);
			assert.equal(faulty.statusRequests, 1);
			assert.equal(faulty.registrations, 0);

			await new Promise((settle) => setTimeout(settle, BACKGROUND_RECONNECT_SETTLE_MS));
			assert.equal(faulty.registrations, 0);
		},
		STUCK_STATUS_TEST_TIMEOUT_MS,
	);
}

test(
	"a session that selects shared storage is refused by a reused broker that started without it, rather than registering in default (#4320)",
	async () => {
		startBrokerWithStorage("");
		await brokerRouting("off");
		vi.stubEnv("ATOMIC_STORAGE", sharedStorage());
		const alphaContext = sessionContext(repository("alpha", "git@github.com:acme/alpha.git"), "selects-shared");
		const alpha = await loadExtension();
		cleanups.push(() => alpha.stop(alphaContext));
		await alpha.start(alphaContext);

		const refused = await alpha.status(alphaContext);
		assert.equal(refused.isError, true, refused.content[0]?.text);
		assert.equal(refused.details?.code, "broker-routing-mismatch");
		assert.equal(await sessionsOnBroker(), 0);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a session whose project group cannot be named because Git is missing is denied with the typed Git error and is not retried in the background (#4320)",
	async () => {
		startBrokerWithStorage(sharedStorage());
		await brokerRouting("on");
		const alphaContext = sessionContext(repository("alpha", "git@github.com:acme/alpha.git"), "no-git");
		const alpha = await loadExtension();
		cleanups.push(() => alpha.stop(alphaContext));
		await alpha.start(alphaContext);
		const emptyPath = join(root, "empty-path");
		mkdirSync(emptyPath);
		vi.stubEnv("PATH", emptyPath);

		const denied = await alpha.status(alphaContext);
		assert.equal(denied.isError, true, denied.content[0]?.text);
		assert.equal(denied.details?.code, "git-unavailable");
		assert.equal(await sessionsOnBroker(), 0);

		const queriesAtDenial = routingQueries.count;
		await new Promise((settle) => setTimeout(settle, RECURRING_ATTEMPT_WINDOW_MS));
		assert.equal((await alpha.status(alphaContext)).details?.code, "git-unavailable");
		assert.equal(routingQueries.count, queriesAtDenial);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a CI-profile session is refused by a reused broker that has a storage selection but does not route across machines (#4320)",
	async () => {
		startBrokerWithStorage(JSON.stringify({ adapter: "@example/adapter-that-is-not-installed" }));
		await vi.waitFor(
			async () => {
				const broker = await queryIntercomBroker(agentDir);
				assert.equal(broker.state, "running");
				if (broker.state === "running") {
					assert.equal(broker.report.multiNode.status, "off");
					assert.notEqual(broker.report.storage, undefined);
				}
			},
			{ timeout: BROKER_WAIT_MS, interval: 50 },
		);
		vi.stubEnv("ATOMIC_PROFILE", "ci");
		vi.stubEnv("ATOMIC_TEAM_URL", `file://${join(root, "team.db")}`);
		const alphaContext = sessionContext(repository("alpha", "git@github.com:acme/alpha.git"), "ci-profile");
		const alpha = await loadExtension();
		cleanups.push(() => alpha.stop(alphaContext));
		await alpha.start(alphaContext);

		const refused = await alpha.status(alphaContext);
		assert.equal(refused.isError, true, refused.content[0]?.text);
		assert.equal(refused.details?.code, "broker-routing-mismatch");
		assert.equal(await sessionsOnBroker(), 0);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
