import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { setCliStorageSelection } from "../../packages/coding-agent/src/core/storage/process-selection.js";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { queryIntercomBroker, restartIntercomBroker } from "../../packages/intercom/broker/control.js";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { type SpawnedProcess, spawnProcess } from "../helpers/runtime.js";

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
	details?: { groups?: string[]; code?: string; retryable?: boolean };
}
interface IntercomTool {
	name: string;
	execute(
		id: string,
		params: { action: string; group?: string },
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult>;
}

let root: string;
let agentDir: string;
const cleanups: Array<() => Promise<void> | void> = [];
const routingQueries: { count: number; afterQuery: (() => Promise<void>) | undefined } = {
	count: 0,
	afterQuery: undefined,
};

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
	routingQueries.afterQuery = undefined;
	vi.doMock("../../packages/intercom/broker/broker-routing.js", async () => {
		const actual = await vi.importActual<typeof import("../../packages/intercom/broker/broker-routing.js")>(
			"../../packages/intercom/broker/broker-routing.js",
		);
		return {
			...actual,
			queryBrokerRouting: async (queriedAgentDir: string) => {
				routingQueries.count += 1;
				const answer = await actual.queryBrokerRouting(queriedAgentDir);
				const hook = routingQueries.afterQuery;
				routingQueries.afterQuery = undefined;
				await hook?.();
				return answer;
			},
		};
	});
});

afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		try {
			await removeTempRootReleasingBroker(root, agentDir);
		} finally {
			vi.doUnmock("../../packages/intercom/broker/broker-routing.js");
			vi.unstubAllEnvs();
		}
	}
});

function sharedSelection(): { adapter: string; options: { path: string }; prefix: string } {
	return { adapter: storageAdapterModule, options: { path: join(root, "shared.sqlite") }, prefix: "team_" };
}

function sharedStorage(): string {
	return JSON.stringify(sharedSelection());
}

/** A broker started the way an Atomic process starts one, by a process launched with `ATOMIC_STORAGE`. */
function startBrokerWithStorage(selection: string): SpawnedProcess {
	const broker = spawnProcess(["bun", join(extensionDir, "broker/broker.ts")], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, ATOMIC_STORAGE: selection },
	});
	cleanups.push(async () => {
		if (broker.exitCode === null) broker.kill("SIGKILL");
		await broker.exited;
	});
	return broker;
}

async function replaceBrokerWithSharedStorage(old: SpawnedProcess): Promise<void> {
	if (old.exitCode === null) old.kill("SIGKILL");
	await old.exited;
	await vi.waitFor(async () => assert.equal((await queryIntercomBroker(agentDir)).state, "stopped"), {
		timeout: BROKER_WAIT_MS,
		interval: 25,
	});
	startBrokerWithStorage(sharedStorage());
	await brokerRouting("on");
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

function sessionContext(cwd: string, sessionId: string, notices?: string[], entries: unknown[] = []): ExtensionContext {
	return {
		hasUI: notices !== undefined,
		cwd,
		isIdle: () => true,
		ui: { notify: (message: string, level: string) => notices?.push(`${level}: ${message}`), setStatus() {} },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => entries },
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
	const run = (ctx: ExtensionContext, params: { action: string; group?: string }): Promise<ToolResult> => {
		assert.ok(intercomTool, "the intercom tool is registered");
		return intercomTool.execute(params.action, params, undefined, undefined, ctx);
	};
	const extension = {
		async start(ctx: ExtensionContext, reason = "startup") {
			for (const handler of handlers.get("session_start") ?? [])
				await handler({ type: "session_start", reason }, ctx);
		},
		status: (ctx: ExtensionContext): Promise<ToolResult> => run(ctx, { action: "status" }),
		run,
		async stop(ctx: ExtensionContext, reason = "quit") {
			for (const handler of handlers.get("session_shutdown") ?? [])
				await handler({ type: "session_shutdown", reason }, ctx);
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

type StatusFault = "silent" | "unsupported" | "malformed" | "multi-node" | "register-unsupported";

interface FaultyBroker {
	statusRequests: number;
	registrations: number;
	verifiedRegistrations: number;
}

async function startFaultyBroker(fault: StatusFault): Promise<FaultyBroker> {
	const broker: FaultyBroker = { statusRequests: 0, registrations: 0, verifiedRegistrations: 0 };
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
					if (message.type === "register_verified") {
						broker.verifiedRegistrations += 1;
						if (fault === "register-unsupported") socket.destroy();
					}
					if (message.type !== "broker_status") return;
					broker.statusRequests += 1;
					if (fault === "unsupported") socket.destroy();
					if (fault === "multi-node" || fault === "register-unsupported") {
						writeMessage(socket, {
							type: "broker_status",
							requestId: message.requestId,
							report: {
								pid: 1,
								sessions: 0,
								...(fault === "multi-node" ? { storage: { digest: "d", source: "env" } } : {}),
								multiNode: { status: fault === "multi-node" ? "on" : "off" },
							},
						});
					}
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
			assert.equal(denied.details?.retryable, true);
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

test(
	"a broker that turns multi-node between the routing check and the registration refuses the verified registration, so no default member is ever registered (#4320)",
	async () => {
		const local = startBrokerWithStorage("");
		await brokerRouting("off");
		const alphaContext = sessionContext(repository("alpha", "git@github.com:acme/alpha.git"), "flip-alpha");
		const alpha = await loadExtension();
		cleanups.push(() => alpha.stop(alphaContext));
		await alpha.start(alphaContext);
		routingQueries.afterQuery = () => replaceBrokerWithSharedStorage(local);

		const refused = await alpha.status(alphaContext);
		assert.equal(refused.isError, true, refused.content[0]?.text);
		assert.equal(refused.details?.code, "broker-routing-mismatch");
		assert.equal(await sessionsOnBroker(), 0);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a broker that cannot verify the routing a registration expects is never given the default group by a silent unverified register (#4320)",
	async () => {
		const faulty = await startFaultyBroker("register-unsupported");
		const alphaContext = sessionContext(repository("alpha", "git@github.com:acme/alpha.git"), "old-broker");
		const alpha = await loadExtension();
		cleanups.push(() => alpha.stop(alphaContext));
		await alpha.start(alphaContext);

		const denied = await alpha.status(alphaContext);
		assert.equal(denied.isError, true, denied.content[0]?.text);
		assert.equal(denied.details?.code, "broker-routing-unavailable");
		assert.equal(faulty.verifiedRegistrations, 1);
		assert.equal(faulty.registrations, 0);
		await new Promise((settle) => setTimeout(settle, BACKGROUND_RECONNECT_SETTLE_MS));
		assert.equal(faulty.registrations, 0);
	},
	STUCK_STATUS_TEST_TIMEOUT_MS,
);

test(
	"an attempt whose session was replaced while it checked the broker registers nothing (#4320)",
	async () => {
		const faulty = await startFaultyBroker("multi-node");
		const alphaContext = sessionContext(repository("alpha", "git@github.com:acme/alpha.git"), "stale-alpha");
		const alpha = await loadExtension();
		cleanups.push(() => alpha.stop(alphaContext, "reload"));
		await alpha.start(alphaContext);
		const queried = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		routingQueries.afterQuery = async () => {
			queried.resolve();
			await released.promise;
		};

		const stale = alpha.status(alphaContext);
		await queried.promise;
		await alpha.stop(alphaContext, "reload");
		await alpha.start(alphaContext, "reload");
		released.resolve();
		await new Promise((settle) => setTimeout(settle, 1_000));
		assert.equal(faulty.registrations + faulty.verifiedRegistrations, 0);
		await stale.catch(() => {});
	},
	STUCK_STATUS_TEST_TIMEOUT_MS,
);

test(
	"a resumed session whose saved memberships were held under the single-machine home does not rejoin default when its broker routes across machines (#4320)",
	async () => {
		startBrokerWithStorage(sharedStorage());
		await brokerRouting("on");
		const saved = {
			type: "custom",
			customType: "intercom_session_memberships",
			data: { sessionId: "resumed-alpha", homeGroup: "default", groups: ["default", "reviewers"] },
		};
		const alphaContext = sessionContext(
			repository("alpha", "git@github.com:acme/alpha.git"),
			"resumed-alpha",
			undefined,
			[saved],
		);
		const alpha = await loadExtension();
		cleanups.push(() => alpha.stop(alphaContext));
		await alpha.start(alphaContext, "resume");

		const status = await alpha.status(alphaContext);
		assert.equal(status.isError, false, status.content[0]?.text);
		assert.deepEqual(status.details?.groups, ["project:acme/alpha"]);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a reloaded session that only joined reviewers does not keep the implicit default when its broker now routes across machines (#4320)",
	async () => {
		const local = startBrokerWithStorage("");
		await brokerRouting("off");
		const alphaContext = sessionContext(repository("alpha", "git@github.com:acme/alpha.git"), "reload-alpha");
		const alpha = await loadExtension();
		cleanups.push(() => alpha.stop(alphaContext));
		await alpha.start(alphaContext);
		const joined = await alpha.run(alphaContext, { action: "join", group: "reviewers" });
		assert.equal(joined.isError, false, joined.content[0]?.text);
		assert.deepEqual((await alpha.status(alphaContext)).details?.groups, ["default", "reviewers"]);

		await alpha.stop(alphaContext, "reload");
		await replaceBrokerWithSharedStorage(local);
		await alpha.start(alphaContext, "reload");

		const status = await alpha.status(alphaContext);
		assert.equal(status.isError, false, status.content[0]?.text);
		assert.deepEqual(status.details?.groups, ["project:acme/alpha"]);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

for (const [override, select] of [
	[
		"ATOMIC_STORAGE",
		() => {
			vi.stubEnv("ATOMIC_STORAGE", JSON.stringify({ memory: true }));
		},
	],
	[
		"--storage",
		() => {
			setCliStorageSelection({ flag: "--storage", value: JSON.stringify({ memory: true }) });
			cleanups.push(() => setCliStorageSelection(undefined));
		},
	],
] as const) {
	test(
		`a CI-profile session whose ${override} selects memory storage registers with a single-machine broker instead of being refused (#4320)`,
		async () => {
			startBrokerWithStorage("");
			await brokerRouting("off");
			vi.stubEnv("ATOMIC_PROFILE", "ci");
			vi.stubEnv("ATOMIC_TEAM_URL", `file://${join(root, "team.db")}`);
			select();
			const alphaContext = sessionContext(repository("alpha", "git@github.com:acme/alpha.git"), "ci-memory");
			const alpha = await loadExtension();
			cleanups.push(() => alpha.stop(alphaContext));
			await alpha.start(alphaContext);

			const status = await alpha.status(alphaContext);
			assert.equal(status.isError, false, status.content[0]?.text);
			assert.deepEqual(status.details?.groups, ["default"]);
			assert.equal(await sessionsOnBroker(), 1);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
}
