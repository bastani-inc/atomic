/**
 * #4327: a main-client connect that finishes after its session ended is reported as an inactive runtime, and is
 * neither kept registered nor retried.
 *
 * This runs the shipped lightweight wrapper, the shipped heavy module and a real broker process. The broker sits
 * behind `IntercomWireProxy`, which forwards bytes untouched and counts frames by type, and can hold a new connection
 * so its handshake is still in flight when the session ends.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { IntercomWireProxy } from "../helpers/intercom-wire-proxy.js";
import { sleep } from "../helpers/runtime.js";
import { removeTestDirectory } from "../helpers/test-directory-removal.js";

vi.mock("../../packages/intercom/broker/broker-routing.js", () => ({
	queryBrokerRouting: async () => ({ acrossMachines: false, hasSharedStorage: false, protocol: { min: 1, max: 4 } }),
}));
vi.mock("../../packages/intercom/broker/spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/intercom/broker/spawn.js")>()),
	spawnBrokerIfNeeded: async () => {},
}));

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const brokerAgentDir = mkdtempSync(join(tmpdir(), "ise-b-"));
const frontAgentDir = mkdtempSync(join(tmpdir(), "ise-f-"));
const brokerSocketPath = getBrokerSocketPath(process.platform, brokerAgentDir);
const frontSocketPath = getBrokerSocketPath(process.platform, frontAgentDir);
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = frontAgentDir;
delete process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(frontAgentDir, "intercom"), { recursive: true });

// The client resolves its socket path on load, so everything that reaches it is imported after the override.
const { getJitiCliPath } = await vi.importActual<typeof import("../../packages/intercom/broker/spawn.js")>(
	"../../packages/intercom/broker/spawn.js",
);
const { default: intercom } = await import("../../packages/intercom/index.js");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");

/** Upper bound for anything the test waits on; a failure, not a pace, so it carries load headroom. */
const WAIT_TIMEOUT_MS = 20_000;
const POLL_MS = 10;

let broker: ChildProcess | undefined;
let brokerOutput = "";
const proxy = new IntercomWireProxy(frontSocketPath, brokerSocketPath);

/**
 * Deadlines are kept on the monotonic clock: a Windows runner's wall clock has been seen to jump ahead mid-test,
 * ending a 20 s `Date.now()` deadline in a test that had run for ten seconds.
 */
async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
	const deadline = performance.now() + WAIT_TIMEOUT_MS;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}\n${brokerOutput}`);
		await sleep(POLL_MS);
	}
}

async function waitForSocket(socketPath: string): Promise<void> {
	await waitFor(
		"the broker socket",
		() =>
			new Promise<true | undefined>((resolveProbe) => {
				const probe = net.createConnection(socketPath);
				probe.once("connect", () => {
					probe.destroy();
					resolveProbe(true);
				});
				probe.once("error", () => resolveProbe(undefined));
			}),
	);
}

beforeAll(async () => {
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerAgentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	broker.stdout?.on("data", (data) => {
		brokerOutput += String(data);
	});
	broker.stderr?.on("data", (data) => {
		brokerOutput += String(data);
	});
	await waitForSocket(brokerSocketPath);
	await proxy.listen();
});

afterEach(() => {
	proxy.release();
	vi.restoreAllMocks();
});

afterAll(async () => {
	await proxy.close();
	if (broker?.exitCode === null) {
		const stopped = new Promise<void>((resolveExit) => broker?.once("exit", () => resolveExit()));
		broker.kill("SIGTERM");
		await stopped;
	}
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	if (originalLegacyAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = originalLegacyAgentDir;
	removeTestDirectory(brokerAgentDir, { retries: 20, retryDelayMs: 50 });
	removeTestDirectory(frontAgentDir, { retries: 20, retryDelayMs: 50 });
});

interface ToolResult {
	readonly isError: boolean;
	readonly content: ReadonlyArray<{ readonly text: string }>;
	readonly details?: unknown;
}

/** The shipped lightweight wrapper over the shipped heavy module, hosted by the smallest host that runs them. */
function createHost() {
	const sessionId = "session-end-host";
	const lifecycleHandlers = new Map<string, Array<(event: object, ctx: object) => unknown>>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<ToolResult> }>();
	let activeTools: string[] = [];
	/** The session id the host's context reports; the extension treats a context whose session changed as ended. */
	let contextSessionId = sessionId;
	const context = {
		hasUI: false,
		cwd: repoRoot,
		isIdle: () => true,
		model: { id: "test-model" },
		sessionManager: { getSessionId: () => contextSessionId, getBranch: () => [] },
		ui: { confirm: async () => true, notify() {} },
	};
	const pi = {
		on(eventName: string, handler: (event: object, ctx: object) => unknown) {
			lifecycleHandlers.set(eventName, [...(lifecycleHandlers.get(eventName) ?? []), handler]);
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<ToolResult> }) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		async sendMessage() {},
		async sendMessages() {},
		getSessionName: () => "session-end-host-name",
		setSessionName() {},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events: { on: () => () => {}, emit() {} },
	};
	intercom(pi as never, {
		importHeavy: async () => ({ default: (heavyPi) => intercomHeavy(heavyPi) }),
	});
	const fire = async (eventName: string, event: object): Promise<void> => {
		for (const handler of lifecycleHandlers.get(eventName) ?? []) await handler(event, context);
	};
	return {
		sessionId,
		start: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
		/** Ends the context's session without shutting the extension down: its in-flight connects are left running. */
		endContextSession() {
			contextSessionId = `${sessionId}-ended`;
		},
		execute(params: { action: string }): Promise<ToolResult> {
			const execute = tools.get("intercom")?.execute;
			assert.ok(execute, "the intercom tool must be registered");
			return execute("call", params, undefined, undefined, context);
		},
	};
}

/** How a call settles. One still pending after the bound is a hang. */
async function settleWithinBound<T>(completion: Promise<T>): Promise<PromiseSettledResult<T>> {
	let timer: NodeJS.Timeout | undefined;
	const hang = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`the call is still pending after ${WAIT_TIMEOUT_MS}ms`)),
			WAIT_TIMEOUT_MS,
		);
	});
	try {
		return await Promise.race([Promise.allSettled([completion]).then(([outcome]) => outcome), hang]);
	} finally {
		clearTimeout(timer);
	}
}

test("a main-client connect that finishes after its session ended is reported as an inactive runtime (#4327)", async () => {
	const host = createHost();
	const mainRegisters = () =>
		proxy.toBroker.filter(
			({ frame }) =>
				(frame.type === "register" || frame.type === "register_verified") && frame.returnAddress === host.sessionId,
		).length;
	proxy.hold(
		(first) =>
			(first.type === "register" || first.type === "register_verified") && first.returnAddress === host.sessionId,
	);
	await host.start();
	try {
		const abandoned = host.execute({ action: "list" });
		await waitFor("the main client's handshake", () => (proxy.heldConnections() >= 1 ? true : undefined));
		// The session ends while the handshake is in flight, and nothing disconnects the client that is connecting.
		host.endContextSession();
		proxy.release();

		const outcome = await settleWithinBound(abandoned);

		assert.ok(outcome.status === "fulfilled", String(outcome.status === "rejected" ? outcome.reason : ""));
		assert.equal(outcome.value.isError, true);
		assert.match(outcome.value.content[0]?.text ?? "", /runtime no longer active.*\(intercom_unavailable\)/);
		assert.deepEqual(outcome.value.details, { error: true, retryable: false });
		assert.equal(mainRegisters(), 1, "the connect that finished was the only one, and it was not retried");
	} finally {
		await host.shutdown();
	}
});
