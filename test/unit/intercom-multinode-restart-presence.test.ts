import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
	brokerHostIdentity,
	HOST_COMMAND_ATTEMPTS,
	type HostIdentitySources,
	isProcessAlive,
	osMachineId,
	persistedMachineId,
	systemSources,
	WINDOWS_BOOT_TIME_COMMAND,
} from "../../packages/intercom/broker/broker-instance.js";
import { MultiNodeRouter, type MultiNodeRouterOptions } from "../../packages/intercom/broker/multinode-router.js";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	type BrokerLeaseStore,
	type BrokerMembershipSubject,
	type IntercomBrokerStateStore,
	OUTBOX_CLAIM_STALE_AFTER_MS,
	type OutboxStore,
	type RecipientPresenceSubject,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import {
	openMemoryHeldSendFixture,
	openMemoryKnownSessionFixture,
	openMemoryLeaseStoreFixture,
	openMemoryOutboxFixture,
	openMemoryPendingAskFixture,
	openMemoryReleasedAskFixture,
	openMemoryRestoringReservationFixture,
	openMemorySentMessageFixture,
	openMemoryWakeUpBusFixture,
} from "../helpers/intercom-multinode-memory-reference.js";

const NODE = "node-1";
const HOST = "boot-1/pid:[1]";
const SOCKET = "/agent/intercom/broker.sock";
const KEY = `${NODE}:${HOST}:${SOCKET}`;
/** Process ids of the seeded brokers: the crashed one has exited, the others still run. */
const DEAD_PID = 101;
const LIVE_PID = 102;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const membership = (brokerId: string, instanceKey?: string, pid?: number): BrokerMembershipSubject => ({
	kind: "broker",
	brokerId,
	nodeId: NODE,
	startedAt: 1,
	...(instanceKey === undefined ? {} : { instanceKey }),
	...(pid === undefined ? {} : { pid }),
});

const presence = (targetIdentity: string): RecipientPresenceSubject => ({
	kind: "presence",
	targetIdentity,
	session: { id: targetIdentity, cwd: "/work", model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
});

/**
 * A shared store holding the live leases, and a claimed outbox row, of a broker that was killed (it released
 * nothing), of a live broker on the same host and socket, and of brokers elsewhere.
 */
async function crashedCluster() {
	const leaseFixture = await openMemoryLeaseStoreFixture();
	const outboxFixture = await openMemoryOutboxFixture();
	const fixtures = {
		heldSends: await openMemoryHeldSendFixture(),
		reservations: await openMemoryRestoringReservationFixture(),
		pendingAsks: await openMemoryPendingAskFixture(),
		releasedAsks: await openMemoryReleasedAskFixture(),
		sentMessages: await openMemorySentMessageFixture(),
		knownSessions: await openMemoryKnownSessionFixture(),
	};
	const bus = await openMemoryWakeUpBusFixture();
	cleanups.push(() => bus.close());
	const seed = await leaseFixture.connect();
	const take = async (subject: BrokerMembershipSubject | RecipientPresenceSubject, holderId: string) =>
		assert.equal((await seed.acquire(subject, holderId, BROKER_LEASE_STALE_AFTER_MS)).status, "acquired");
	await take(membership("crashed", KEY, DEAD_PID), "crashed");
	await take(presence("hosted-by-crashed"), "crashed");
	await take(membership("other", `${NODE}:${HOST}:/other/broker.sock`, DEAD_PID), "other");
	await take(presence("hosted-by-other"), "other");
	await take(membership("legacy", KEY), "legacy");
	await take(presence("hosted-by-legacy"), "legacy");
	const outbox = await outboxFixture.connect();
	for (const [messageId, claimantId] of [
		["claimed-by-crashed", "crashed"],
		["claimed-by-other", "other"],
	] as const) {
		const targetIdentity = `target-of-${claimantId}`;
		await outbox.enqueue({
			targetIdentity,
			originBrokerId: "sender-broker",
			digest: messageId,
			frame: {
				type: "message",
				from: presence("sender").session,
				message: { id: messageId, timestamp: 1, content: { text: messageId } },
			},
		} as Parameters<OutboxStore["enqueue"]>[0]);
		const claimed = await outbox.claim({ targetIdentity, claimantId, staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS });
		assert.equal(claimed.status, "claimed");
	}

	const start = async (options: Partial<MultiNodeRouterOptions> = {}) => {
		const leases = await leaseFixture.connect();
		const state: IntercomBrokerStateStore = {
			leases,
			outbox: await outboxFixture.connect(),
			heldSends: await fixtures.heldSends.connect(),
			reservations: await fixtures.reservations.connect(),
			pendingAsks: await fixtures.pendingAsks.connect(),
			releasedAsks: await fixtures.releasedAsks.connect(),
			sentMessages: await fixtures.sentMessages.connect(),
			knownSessions: await fixtures.knownSessions.connect(),
			close: async () => {},
		};
		const router = await MultiNodeRouter.start({
			state,
			bus: await bus.connect(),
			nodeId: NODE,
			hostIdentity: HOST,
			isProcessAlive: (pid) => pid !== DEAD_PID,
			// No process start can be read here unless a test says what it is.
			processStartToken: () => undefined,
			...options,
			host: {
				sessions: new Map(),
				write: () => true,
				writeConfirmed: (_socket, _frame, onSettled) => onSettled(true),
				supervisorCache: new SupervisorChannelCache(),
				pendingQuestions: new PendingQuestionIndex(),
				deliveredMessages: { lookupForTarget: () => "miss", lookupQuestionTarget: () => undefined },
				dispatch: () => {},
				revokeReleasedReservation: () => {},
			},
		});
		cleanups.push(() => router.close());
		return { leases, outbox: state.outbox, router };
	};
	return { start };
}

const holderOf = async (leases: BrokerLeaseStore, targetIdentity: string) => {
	const read = await leases.read({ kind: "presence", targetIdentity });
	return read.status === "found" ? read.lease.holderId : read.status;
};

const stateOf = async (outbox: OutboxStore, messageId: string) => {
	const read = await outbox.read(messageId);
	return read.status === "found" ? read.row.state : read.status;
};

test("a restarted broker retires its killed instance's leases and claims as it starts, and no other broker's (#5038)", async () => {
	const { start } = await crashedCluster();
	const { leases, outbox } = await start({ instanceKey: SOCKET });
	assert.equal(await holderOf(leases, "hosted-by-crashed"), "missing");
	assert.deepEqual(await leases.read({ kind: "broker", brokerId: "crashed" }), { status: "missing" });
	assert.equal(await stateOf(outbox, "claimed-by-crashed"), "queued");
	assert.equal(await holderOf(leases, "hosted-by-other"), "other");
	assert.equal(await holderOf(leases, "hosted-by-legacy"), "legacy");
	assert.equal(await stateOf(outbox, "claimed-by-other"), "claimed");
	const liveBrokers = (await leases.listLive("broker", BROKER_LEASE_STALE_AFTER_MS)).map((lease) => lease.holderId);
	assert.ok(liveBrokers.includes("other"));
	assert.ok(!liveBrokers.includes("crashed"));
});

test("a broker with the same host name and socket but another host identity retires nothing (#5038)", async () => {
	const { start } = await crashedCluster();
	const { leases, outbox } = await start({ instanceKey: SOCKET, hostIdentity: "boot-2/pid:[1]" });
	assert.equal(await holderOf(leases, "hosted-by-crashed"), "crashed");
	assert.equal(await stateOf(outbox, "claimed-by-crashed"), "claimed");
});

test("two live brokers with the same host name and socket but different host identities never retire each other (#5038)", async () => {
	const { start } = await crashedCluster();
	const first = await start({ instanceKey: SOCKET, hostIdentity: "machine-a", isProcessAlive: () => false });
	const second = await start({ instanceKey: SOCKET, hostIdentity: "machine-b", isProcessAlive: () => false });
	for (const { router } of [first, second]) {
		assert.equal((await first.leases.read({ kind: "broker", brokerId: router.brokerId })).status, "found");
	}
});

test("an earlier instance whose process still runs is not retired (#5038)", async () => {
	const { start } = await crashedCluster();
	const { leases, outbox } = await start({ instanceKey: SOCKET, isProcessAlive: () => true });
	assert.equal(await holderOf(leases, "hosted-by-crashed"), "crashed");
	assert.equal(await stateOf(outbox, "claimed-by-crashed"), "claimed");
});

test("a broker on another socket, or without an instance key, leaves a live broker's leases alone (#5038)", async () => {
	const { start } = await crashedCluster();
	const { leases: elsewhere } = await start({ instanceKey: "/elsewhere/broker.sock" });
	assert.equal(await holderOf(elsewhere, "hosted-by-crashed"), "crashed");
	const { leases: unkeyed, router: first } = await start({ isProcessAlive: () => false });
	await start({ isProcessAlive: () => false });
	assert.equal(await holderOf(unkeyed, "hosted-by-crashed"), "crashed");
	assert.equal(await holderOf(unkeyed, "hosted-by-other"), "other");
	assert.equal((await unkeyed.read({ kind: "broker", brokerId: first.brokerId })).status, "found");
});

test("a broker started again on the same socket supersedes the instance before it once its process exited (#5038)", async () => {
	const { start } = await crashedCluster();
	const socket = "/restarted/broker.sock";
	const { leases, router: previous } = await start({ instanceKey: socket, pid: LIVE_PID });
	const { router: next } = await start({ instanceKey: socket, pid: DEAD_PID + 1, isProcessAlive: () => false });
	assert.deepEqual(await leases.read({ kind: "broker", brokerId: previous.brokerId }), { status: "missing" });
	assert.equal((await leases.read({ kind: "broker", brokerId: next.brokerId })).status, "found");
});

test("an earlier instance whose process id a later process now holds is retired (#5252)", async () => {
	const { start } = await crashedCluster();
	const socket = "/reused-pid/broker.sock";
	const starts = new Map([[LIVE_PID, "start-of-the-broker"]]);
	const processStartToken = (pid: number) => starts.get(pid);
	const { leases, router: killed } = await start({ instanceKey: socket, pid: LIVE_PID, processStartToken });
	// While that instance still runs with the start it recorded, a broker starting on its socket leaves it alone.
	await start({ instanceKey: socket, pid: LIVE_PID + 4, isProcessAlive: () => true, processStartToken });
	assert.equal((await leases.read({ kind: "broker", brokerId: killed.brokerId })).status, "found");

	// The broker is killed, and the host gives its process id to a later process before the broker starts again.
	starts.set(LIVE_PID, "start-of-a-later-process");
	const { router: next } = await start({
		instanceKey: socket,
		pid: LIVE_PID + 8,
		isProcessAlive: () => true,
		processStartToken,
	});
	assert.deepEqual(await leases.read({ kind: "broker", brokerId: killed.brokerId }), { status: "missing" });
	const own = await leases.read({ kind: "broker", brokerId: next.brokerId });
	assert.equal(own.status, "found");
	assert.equal(
		own.status === "found" && own.lease.subject.kind === "broker" ? own.lease.subject.processStart : undefined,
		undefined,
		"a broker whose own start cannot be read records none",
	);
});

interface FakeHost {
	readonly platform: NodeJS.Platform;
	readonly files?: Record<string, string>;
	readonly links?: Record<string, string>;
	readonly commands?: Record<string, string>;
	/** How many times each command times out before it answers, as PowerShell can on a loaded host. */
	readonly timeouts?: Record<string, number>;
	readonly unwritable?: boolean;
}

/** A host as the identity sources see it; a missing file, link or command throws as the real ones do. */
function fakeSources(
	host: FakeHost,
): HostIdentitySources & { readonly files: Map<string, string>; readonly runs: string[] } {
	const files = new Map(Object.entries(host.files ?? {}));
	const runs: string[] = [];
	const timedOut = new Map<string, number>();
	const missing = (what: string): never => {
		throw Object.assign(new Error(`${what} missing`), { code: "ENOENT" });
	};
	return {
		platform: host.platform,
		files,
		runs,
		readFile: (path) => files.get(path) ?? missing(path),
		readLink: (path) => host.links?.[path] ?? missing(path),
		run: (command, args) => {
			runs.push(command);
			const line = [command, ...args].join(" ");
			if ((timedOut.get(line) ?? 0) < (host.timeouts?.[line] ?? 0)) {
				timedOut.set(line, (timedOut.get(line) ?? 0) + 1);
				throw Object.assign(new Error(`${command} timed out`), { code: "ETIMEDOUT" });
			}
			return host.commands?.[line] ?? missing(command);
		},
		writeNewPrivateFile: (path, content) => {
			if (host.unwritable === true) missing(path);
			if (files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
			files.set(path, content);
		},
		configDir: "/config/intercom",
	};
}

const WINDOWS_REG = "reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid";
/** Where the fake host keeps its saved machine id, in this platform's path form. */
const SAVED_ID_PATH = join("/config/intercom", "machine-id");
const MAC_IOREG = "ioreg -rd1 -c IOPlatformExpertDevice";
const MAC_SESSION = "sysctl -n kern.bootsessionuuid";
const WINDOWS_BOOT = WINDOWS_BOOT_TIME_COMMAND.join(" ");
const BOOTED = "2026-11-15T04:00:00.1234560Z";

test("on Linux a host is its boot id and process namespace (#5038)", () => {
	const files = { "/proc/sys/kernel/random/boot_id": "boot-a\n", "/etc/machine-id": "ignored" };
	const links = { "/proc/self/ns/pid": "pid:[7]" };
	assert.equal(brokerHostIdentity(fakeSources({ platform: "linux", files, links })), "boot-a/pid:[7]");
	assert.equal(brokerHostIdentity(fakeSources({ platform: "linux", files })), "boot-a");
});

test("off Linux a host is the OS machine id with its boot (#5038)", () => {
	const windows = fakeSources({
		platform: "win32",
		commands: {
			[WINDOWS_REG]:
				"\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    guid-w\r\n",
			[WINDOWS_BOOT]: `${BOOTED}\r\n`,
		},
	});
	assert.equal(brokerHostIdentity(windows), `guid-w/boot-${BOOTED}`);
	assert.equal(
		brokerHostIdentity(
			fakeSources({ platform: "win32", commands: { [WINDOWS_REG]: "MachineGuid    REG_SZ    guid-w" } }),
		),
		undefined,
	);
	const session = fakeSources({
		platform: "darwin",
		commands: { [MAC_IOREG]: '"IOPlatformUUID" = "uuid-m"', [MAC_SESSION]: "session-a\n" },
	});
	assert.equal(brokerHostIdentity(session), "uuid-m/session-session-a");
	const ioreg = fakeSources({
		platform: "darwin",
		commands: {
			[MAC_IOREG]: '+-o J316sAP  <class IOPlatformExpertDevice>\n    "IOPlatformUUID" = "uuid-m"\n',
			[MAC_SESSION]: "s",
		},
	});
	assert.equal(brokerHostIdentity(ioreg), "uuid-m/session-s");
	assert.equal(
		osMachineId(fakeSources({ platform: "win32", commands: { [WINDOWS_REG]: "no guid here" } })),
		undefined,
	);
	assert.equal(osMachineId(fakeSources({ platform: "darwin", commands: { [MAC_IOREG]: "no uuid here" } })), undefined);
	assert.equal(
		osMachineId(fakeSources({ platform: "darwin", commands: { [MAC_IOREG]: '"IOPlatformUUID"="tight"' } })),
		"tight",
	);
	assert.deepEqual(fakeSources({ platform: "darwin" }).runs, []);
});

test("a host command that times out once, as PowerShell can on a loaded host, is run again, so every broker of the host reads one identity (#5252)", () => {
	const commands = {
		[WINDOWS_REG]: "MachineGuid    REG_SZ    guid-w",
		[WINDOWS_BOOT]: BOOTED,
	};
	const steady = brokerHostIdentity(fakeSources({ platform: "win32", commands }));
	assert.equal(steady, `guid-w/boot-${BOOTED}`);
	for (const slow of [WINDOWS_BOOT, WINDOWS_REG]) {
		const loaded = fakeSources({ platform: "win32", commands, timeouts: { [slow]: HOST_COMMAND_ATTEMPTS - 1 } });
		assert.equal(brokerHostIdentity(loaded), steady, slow);
	}
	// One that never answers still leaves the host without that fact, after its attempts.
	const hung = fakeSources({ platform: "win32", commands, timeouts: { [WINDOWS_BOOT]: HOST_COMMAND_ATTEMPTS } });
	assert.equal(brokerHostIdentity(hung), undefined);
	assert.equal(hung.runs.filter((command) => command === WINDOWS_BOOT_TIME_COMMAND[0]).length, HOST_COMMAND_ATTEMPTS);
});

test("without a per-boot random value a host has no identity, so nothing is retired early (#5038)", () => {
	const guid = { [WINDOWS_REG]: "MachineGuid    REG_SZ    guid-w" };
	const uuid = { [MAC_IOREG]: '"IOPlatformUUID" = "uuid-m"' };
	// macOS whose sysctl fails, and Windows whose PowerShell fails, each with a machine id.
	assert.equal(brokerHostIdentity(fakeSources({ platform: "darwin", commands: uuid })), undefined);
	assert.equal(brokerHostIdentity(fakeSources({ platform: "win32", commands: guid })), undefined);
	// Linux without a readable boot id, with a machine id the OS keeps anyway.
	const machineIds = { "/etc/machine-id": "mid", "/var/lib/dbus/machine-id": "dbus" };
	const links = { "/proc/self/ns/pid": "pid:[7]" };
	assert.equal(brokerHostIdentity(fakeSources({ platform: "linux", files: machineIds, links })), undefined);
	// FreeBSD and the rest have neither.
	for (const platform of ["freebsd", "openbsd", "sunos", "aix"] as const) {
		const host = fakeSources({ platform, files: machineIds, commands: { ...guid, ...uuid, [MAC_SESSION]: "s" } });
		assert.equal(brokerHostIdentity(host), undefined, platform);
		assert.equal(osMachineId(host), undefined, platform);
		assert.deepEqual(host.runs, [], platform);
		assert.equal(host.files.has(SAVED_ID_PATH), false, platform);
	}
});

test("without an OS machine id a host keeps a random id saved once in the config directory (#5038)", () => {
	const host = fakeSources({ platform: "darwin", commands: { [MAC_SESSION]: "s" } });
	const first = brokerHostIdentity(host);
	assert.match(first ?? "", /^[0-9a-f-]{36}\/session-s$/);
	assert.equal(brokerHostIdentity(host), first);
	assert.equal(host.files.get(SAVED_ID_PATH), first?.split("/")[0]);
	assert.notEqual(brokerHostIdentity(fakeSources({ platform: "darwin", commands: { [MAC_SESSION]: "s" } })), first);
	assert.equal(persistedMachineId(fakeSources({ platform: "win32", files: { [SAVED_ID_PATH]: " kept\n" } })), "kept");
});

test("a host with no machine id it can read or save has no identity (#5038)", () => {
	const booted = { [WINDOWS_BOOT]: BOOTED };
	assert.equal(brokerHostIdentity(fakeSources({ platform: "win32", commands: booted, unwritable: true })), undefined);
});

test("the real sources save a private machine id once and run commands (#5038)", () => {
	const dir = mkdtempSync(join(tmpdir(), "intercom-host-"));
	try {
		const sources = systemSources(join(dir, "nested", "intercom"));
		const id = persistedMachineId(sources);
		assert.match(id ?? "", /^[0-9a-f-]{36}$/);
		assert.equal(persistedMachineId(systemSources(join(dir, "nested", "intercom"))), id);
		const path = join(dir, "nested", "intercom", "machine-id");
		if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.throws(() => sources.writeNewPrivateFile(path, "other"), { code: "EEXIST" });
		assert.equal(readFileSync(path, "utf8"), id);
		assert.equal(sources.run(process.execPath, ["-e", "process.stdout.write('out')"]), "out");
		if (process.platform === "linux")
			assert.equal(sources.readLink("/proc/self/ns/pid"), readlinkSync("/proc/self/ns/pid"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a process this one may not signal still counts as alive (#5038)", (context) => {
	if (process.platform === "win32") return context.skip();
	assert.equal(isProcessAlive(1), true);
});

test("by default a broker uses the real host identity, so its next instance supersedes it (#5038)", async () => {
	const { start } = await crashedCluster();
	const socket = "/real-host/broker.sock";
	const { leases, router: previous } = await start({ instanceKey: socket, hostIdentity: undefined });
	await start({ instanceKey: socket, hostIdentity: undefined, isProcessAlive: () => false });
	assert.deepEqual(await leases.read({ kind: "broker", brokerId: previous.brokerId }), { status: "missing" });
});

test("the real host's identity is stable (#5038)", () => {
	const identity = brokerHostIdentity();
	assert.equal(brokerHostIdentity(), identity);
	if (process.platform === "linux") {
		const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		assert.equal(identity, `${bootId}/${readlinkSync("/proc/self/ns/pid")}`);
	}
});

test("clones with the same machine id started together are told apart by their boot (#5038)", () => {
	const mac = (session: string) =>
		brokerHostIdentity(
			fakeSources({
				platform: "darwin",
				commands: { [MAC_IOREG]: '"IOPlatformUUID" = "cloned"', [MAC_SESSION]: session },
			}),
		);
	assert.notEqual(mac("session-1"), mac("session-2"));
	const windows = (booted: string) =>
		brokerHostIdentity(
			fakeSources({
				platform: "win32",
				commands: { [WINDOWS_REG]: "MachineGuid    REG_SZ    cloned", [WINDOWS_BOOT]: booted },
			}),
		);
	assert.notEqual(windows("2026-11-15T04:00:00.1000000Z"), windows("2026-11-15T04:00:00.1000010Z"));
});

test("two machines with the same host name and boot minute but different machine ids never retire each other (#5038)", async () => {
	const { start } = await crashedCluster();
	const machine = (guid: string) =>
		brokerHostIdentity(
			fakeSources({
				platform: "win32",
				commands: { [WINDOWS_REG]: `MachineGuid    REG_SZ    ${guid}`, [WINDOWS_BOOT]: BOOTED },
			}),
		);
	assert.notEqual(machine("guid-1"), machine("guid-2"));
	// Each sees the other's pid as exited, as a pid from another machine would be.
	const first = await start({ instanceKey: SOCKET, hostIdentity: machine("guid-1"), isProcessAlive: () => false });
	const second = await start({ instanceKey: SOCKET, hostIdentity: machine("guid-2"), isProcessAlive: () => false });
	for (const { router } of [first, second]) {
		assert.equal((await first.leases.read({ kind: "broker", brokerId: router.brokerId })).status, "found");
	}
});

test("a broker without a reliable host identity never retires an earlier instance early (#5038)", async () => {
	const { start } = await crashedCluster();
	const socket = "/no-identity/broker.sock";
	const { leases, router: previous } = await start({ instanceKey: socket, hostIdentity: null });
	await start({ instanceKey: socket, hostIdentity: null, isProcessAlive: () => false });
	await start({ instanceKey: SOCKET, hostIdentity: null, isProcessAlive: () => false });
	assert.equal((await leases.read({ kind: "broker", brokerId: previous.brokerId })).status, "found");
	assert.equal(await holderOf(leases, "hosted-by-crashed"), "crashed");
});

test("a broker records its own process id, and a membership without one is never taken for a dead instance (#5038)", async () => {
	const { start } = await crashedCluster();
	const { leases, router } = await start({ instanceKey: SOCKET, isProcessAlive: () => false });
	const own = await leases.read({ kind: "broker", brokerId: router.brokerId });
	assert.equal(
		own.status === "found" && own.lease.subject.kind === "broker" ? own.lease.subject.pid : undefined,
		process.pid,
	);
	assert.equal(await holderOf(leases, "hosted-by-legacy"), "legacy");
	assert.equal(await holderOf(leases, "hosted-by-crashed"), "missing");
});

test("a process counts as alive while it runs and dead once it exited (#5038)", async () => {
	assert.equal(isProcessAlive(process.pid), true);
	const child = spawn(process.execPath, ["-e", ""]);
	const pid = child.pid!;
	await new Promise((resolve) => child.once("exit", resolve));
	assert.equal(isProcessAlive(pid), false);
});
