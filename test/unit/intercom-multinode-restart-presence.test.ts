import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
	brokerHostIdentity,
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

interface FakeHost {
	readonly platform: NodeJS.Platform;
	readonly files?: Record<string, string>;
	readonly links?: Record<string, string>;
	readonly commands?: Record<string, string>;
	readonly bootTimeMs?: number;
	readonly unwritable?: boolean;
}

/** A host as the identity sources see it; a missing file, link or command throws as the real ones do. */
function fakeSources(
	host: FakeHost,
): HostIdentitySources & { readonly files: Map<string, string>; readonly runs: string[] } {
	const files = new Map(Object.entries(host.files ?? {}));
	const runs: string[] = [];
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
			return host.commands?.[[command, ...args].join(" ")] ?? missing(command);
		},
		writeNewPrivateFile: (path, content) => {
			if (host.unwritable === true) missing(path);
			if (files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
			files.set(path, content);
		},
		configDir: "/config/intercom",
		bootTimeMs: host.bootTimeMs ?? 1_800_000,
	};
}

const WINDOWS_REG = "reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid";
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
	const mac = fakeSources({
		platform: "darwin",
		commands: { [MAC_IOREG]: '+-o J316sAP  <class IOPlatformExpertDevice>\n    "IOPlatformUUID" = "uuid-m"\n' },
		bootTimeMs: 1_805_000,
	});
	assert.equal(brokerHostIdentity(mac), "uuid-m/boot-30");
	assert.equal(
		brokerHostIdentity(fakeSources({ platform: "freebsd", files: { "/etc/machine-id": "mid\n" } })),
		"mid/boot-30",
	);
	assert.equal(
		brokerHostIdentity(fakeSources({ platform: "freebsd", files: { "/var/lib/dbus/machine-id": "dbus" } })),
		"dbus/boot-30",
	);
	assert.equal(
		brokerHostIdentity(
			fakeSources({ platform: "freebsd", files: { "/etc/machine-id": "mid" }, bootTimeMs: 1_900_000 }),
		),
		"mid/boot-32",
	);
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

test("without an OS machine id a host keeps a random id saved once in the config directory (#5038)", () => {
	const host = fakeSources({ platform: "darwin" });
	const first = brokerHostIdentity(host);
	assert.match(first ?? "", /^[0-9a-f-]{36}\/boot-30$/);
	assert.equal(brokerHostIdentity(host), first);
	assert.equal(host.files.get("/config/intercom/machine-id"), first?.split("/")[0]);
	assert.notEqual(brokerHostIdentity(fakeSources({ platform: "darwin" })), first);
	assert.equal(
		persistedMachineId(fakeSources({ platform: "win32", files: { "/config/intercom/machine-id": " kept\n" } })),
		"kept",
	);
});

test("a host with no machine id it can read or save has no identity (#5038)", () => {
	assert.equal(brokerHostIdentity(fakeSources({ platform: "win32", unwritable: true })), undefined);
});

test("the real sources save a private machine id once, run commands and read this boot (#5038)", () => {
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
		assert.ok(Math.abs(sources.bootTimeMs - (Date.now() - uptime() * 1000)) < 5_000);
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
