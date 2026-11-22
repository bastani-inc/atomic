import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
	brokerHostIdentity,
	createBrokerHostIdentityReader,
	HOST_COMMAND_ATTEMPTS,
	type HostIdentitySources,
	isProcessAlive,
	osMachineId,
	persistedMachineId,
	processStartedAt,
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
import { keptExitedPid } from "../helpers/exited-process.js";
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
			// This host reads no process starts unless a test says it does.
			processStartedAt: () => null,
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
				holdsReservation: () => true,
				fence: () => {},
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

test("a restarted broker retires its killed instance's leases and claims even once they went stale (#5252)", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		const { start } = await crashedCluster();
		// The restarted broker starts routing across nodes only after the killed instance's leases went stale, as a
		// loaded host can delay it: the killed instance's presence must still be retired, so its recipients count as lost.
		vi.setSystemTime(Date.now() + BROKER_LEASE_STALE_AFTER_MS + 1_000);
		const { leases, outbox } = await start({ instanceKey: SOCKET });
		assert.equal(await holderOf(leases, "hosted-by-crashed"), "missing");
		assert.deepEqual(await leases.read({ kind: "broker", brokerId: "crashed" }), { status: "missing" });
		assert.equal(await stateOf(outbox, "claimed-by-crashed"), "queued");
		assert.equal(await holderOf(leases, "hosted-by-other"), "other");
		assert.equal(await holderOf(leases, "hosted-by-legacy"), "legacy");
	} finally {
		vi.useRealTimers();
	}
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

test("an earlier instance whose process id a process started after it now holds is retired (#5252)", async () => {
	const { start } = await crashedCluster();
	// The killed broker recorded its start at 1; the host gave its process id to a process that started at 5000.
	const { leases, outbox } = await start({
		instanceKey: SOCKET,
		isProcessAlive: () => true,
		processStartedAt: (pid) => (pid === DEAD_PID ? 5_000 : undefined),
	});
	assert.equal(await holderOf(leases, "hosted-by-crashed"), "missing");
	assert.deepEqual(await leases.read({ kind: "broker", brokerId: "crashed" }), { status: "missing" });
	assert.equal(await stateOf(outbox, "claimed-by-crashed"), "queued");

	// One whose process started before it recorded its start is still that instance, and is left alone.
	const { start: startAgain } = await crashedCluster();
	const { leases: kept } = await startAgain({
		instanceKey: SOCKET,
		isProcessAlive: () => true,
		processStartedAt: (pid) => (pid === DEAD_PID ? 0 : undefined),
	});
	assert.equal(await holderOf(kept, "hosted-by-crashed"), "crashed");
});

test("an earlier instance whose pid's start cannot be read is not taken for it, as when a short-lived process held the pid (#5252)", async () => {
	const { start } = await crashedCluster();
	// The process the host gave the killed broker's pid is gone before its start can be read.
	const { leases } = await start({
		instanceKey: SOCKET,
		isProcessAlive: () => true,
		processStartedAt: () => undefined,
	});
	assert.equal(await holderOf(leases, "hosted-by-crashed"), "missing");
	assert.deepEqual(await leases.read({ kind: "broker", brokerId: "crashed" }), { status: "missing" });
});

test("a Windows process's start is read as its creation time, and a process of another platform's is not read (#5252)", async () => {
	const startOf = (pid: number) =>
		[
			"powershell",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and -not $p.HasExited) { $p.StartTime.ToFileTimeUtc() }`,
		].join(" ");
	// 2026-11-15T04:00:00.000Z as a Windows file time (100 ns since 1601).
	const windows = fakeSources({ platform: "win32", commands: { [startOf(process.pid)]: "134391888000000000\r\n" } });
	assert.equal(await processStartedAt(process.pid, windows), Date.parse("2026-11-15T04:00:00.000Z"));
	// One whose start PowerShell does not answer is unknown.
	assert.equal(await processStartedAt(process.pid, fakeSources({ platform: "win32", commands: {} })), undefined);
	const linux = fakeSources({ platform: "linux" });
	assert.equal(await processStartedAt(process.pid, linux), null);
	assert.deepEqual(linux.runs, []);
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
		run: async (command, args) => {
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

test("on Linux a host is its boot id and process namespace (#5038)", async () => {
	const files = { "/proc/sys/kernel/random/boot_id": "boot-a\n", "/etc/machine-id": "ignored" };
	const links = { "/proc/self/ns/pid": "pid:[7]" };
	assert.equal(await brokerHostIdentity(fakeSources({ platform: "linux", files, links })), "boot-a/pid:[7]");
	assert.equal(await brokerHostIdentity(fakeSources({ platform: "linux", files })), "boot-a");
});

test("off Linux a host is the OS machine id with its boot (#5038)", async () => {
	const windows = fakeSources({
		platform: "win32",
		commands: {
			[WINDOWS_REG]:
				"\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    guid-w\r\n",
			[WINDOWS_BOOT]: `${BOOTED}\r\n`,
		},
	});
	assert.equal(await brokerHostIdentity(windows), `guid-w/boot-${BOOTED}`);
	assert.equal(
		await brokerHostIdentity(
			fakeSources({ platform: "win32", commands: { [WINDOWS_REG]: "MachineGuid    REG_SZ    guid-w" } }),
		),
		undefined,
	);
	const session = fakeSources({
		platform: "darwin",
		commands: { [MAC_IOREG]: '"IOPlatformUUID" = "uuid-m"', [MAC_SESSION]: "session-a\n" },
	});
	assert.equal(await brokerHostIdentity(session), "uuid-m/session-session-a");
	const ioreg = fakeSources({
		platform: "darwin",
		commands: {
			[MAC_IOREG]: '+-o J316sAP  <class IOPlatformExpertDevice>\n    "IOPlatformUUID" = "uuid-m"\n',
			[MAC_SESSION]: "s",
		},
	});
	assert.equal(await brokerHostIdentity(ioreg), "uuid-m/session-s");
	assert.equal(
		await osMachineId(fakeSources({ platform: "win32", commands: { [WINDOWS_REG]: "no guid here" } })),
		undefined,
	);
	assert.equal(
		await osMachineId(fakeSources({ platform: "darwin", commands: { [MAC_IOREG]: "no uuid here" } })),
		undefined,
	);
	assert.equal(
		await osMachineId(fakeSources({ platform: "darwin", commands: { [MAC_IOREG]: '"IOPlatformUUID"="tight"' } })),
		"tight",
	);
	assert.deepEqual(fakeSources({ platform: "darwin" }).runs, []);
});

test("a host command that times out once, as PowerShell can on a loaded host, is run again, so every broker of the host reads one identity (#5252)", async () => {
	const commands = {
		[WINDOWS_REG]: "MachineGuid    REG_SZ    guid-w",
		[WINDOWS_BOOT]: BOOTED,
	};
	const steady = await brokerHostIdentity(fakeSources({ platform: "win32", commands }));
	assert.equal(steady, `guid-w/boot-${BOOTED}`);
	for (const slow of [WINDOWS_BOOT, WINDOWS_REG]) {
		const loaded = fakeSources({ platform: "win32", commands, timeouts: { [slow]: HOST_COMMAND_ATTEMPTS - 1 } });
		assert.equal(await brokerHostIdentity(loaded), steady, slow);
	}
	// One that never answers still leaves the host without that fact, after its attempts.
	const hung = fakeSources({ platform: "win32", commands, timeouts: { [WINDOWS_BOOT]: HOST_COMMAND_ATTEMPTS } });
	assert.equal(await brokerHostIdentity(hung), undefined);
	assert.equal(hung.runs.filter((command) => command === WINDOWS_BOOT_TIME_COMMAND[0]).length, HOST_COMMAND_ATTEMPTS);
});

test("without a per-boot random value a host has no identity, so nothing is retired early (#5038)", async () => {
	const guid = { [WINDOWS_REG]: "MachineGuid    REG_SZ    guid-w" };
	const uuid = { [MAC_IOREG]: '"IOPlatformUUID" = "uuid-m"' };
	// macOS whose sysctl fails, and Windows whose PowerShell fails, each with a machine id.
	assert.equal(await brokerHostIdentity(fakeSources({ platform: "darwin", commands: uuid })), undefined);
	assert.equal(await brokerHostIdentity(fakeSources({ platform: "win32", commands: guid })), undefined);
	// Linux without a readable boot id, with a machine id the OS keeps anyway.
	const machineIds = { "/etc/machine-id": "mid", "/var/lib/dbus/machine-id": "dbus" };
	const links = { "/proc/self/ns/pid": "pid:[7]" };
	assert.equal(await brokerHostIdentity(fakeSources({ platform: "linux", files: machineIds, links })), undefined);
	// FreeBSD and the rest have neither.
	for (const platform of ["freebsd", "openbsd", "sunos", "aix"] as const) {
		const host = fakeSources({ platform, files: machineIds, commands: { ...guid, ...uuid, [MAC_SESSION]: "s" } });
		assert.equal(await brokerHostIdentity(host), undefined, platform);
		assert.equal(await osMachineId(host), undefined, platform);
		assert.deepEqual(host.runs, [], platform);
		assert.equal(host.files.has(SAVED_ID_PATH), false, platform);
	}
});

test("without an OS machine id a host keeps a random id saved once in the config directory (#5038)", async () => {
	const host = fakeSources({ platform: "darwin", commands: { [MAC_SESSION]: "s" } });
	const first = await brokerHostIdentity(host);
	assert.match(first ?? "", /^[0-9a-f-]{36}\/session-s$/);
	assert.equal(await brokerHostIdentity(host), first);
	assert.equal(host.files.get(SAVED_ID_PATH), first?.split("/")[0]);
	assert.notEqual(
		await brokerHostIdentity(fakeSources({ platform: "darwin", commands: { [MAC_SESSION]: "s" } })),
		first,
	);
	assert.equal(persistedMachineId(fakeSources({ platform: "win32", files: { [SAVED_ID_PATH]: " kept\n" } })), "kept");
});

test("a host with no machine id it can read or save has no identity (#5038)", async () => {
	const booted = { [WINDOWS_BOOT]: BOOTED };
	assert.equal(
		await brokerHostIdentity(fakeSources({ platform: "win32", commands: booted, unwritable: true })),
		undefined,
	);
});

test("the real sources save a private machine id once and run commands (#5038)", async () => {
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
		assert.equal(await sources.run(process.execPath, ["-e", "process.stdout.write('out')"]), "out");
		if (process.platform === "linux")
			assert.equal(sources.readLink("/proc/self/ns/pid"), readlinkSync("/proc/self/ns/pid"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a broker's sources save a machine id only into the Intercom directory it holds, never into a removed one again", () => {
	const dir = mkdtempSync(join(tmpdir(), "intercom-host-"));
	try {
		const intercom = join(dir, "intercom");
		mkdirSync(intercom);
		let held = true;
		const sources = systemSources(intercom, () => held);
		const id = persistedMachineId(sources);
		assert.match(id ?? "", /^[0-9a-f-]{36}$/, "saved while the directory is held");

		rmSync(intercom, { recursive: true });
		held = false;
		assert.equal(persistedMachineId(sources), undefined);
		assert.equal(existsSync(intercom), false, "the removed directory is not made again");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const HOST_COMMAND_RUN_MS = 300;
const EVENT_LOOP_TICK_MS = 10;

test("a host command runs while the broker's event loop keeps turning (#5252)", async () => {
	const sources = systemSources(mkdtempSync(join(tmpdir(), "intercom-host-")));
	let ticks = 0;
	const ticking = setInterval(() => ticks++, EVENT_LOOP_TICK_MS);
	try {
		const output = await sources.run(process.execPath, [
			"-e",
			`setTimeout(() => process.stdout.write("out"), ${HOST_COMMAND_RUN_MS})`,
		]);
		assert.equal(output, "out");
	} finally {
		clearInterval(ticking);
		rmSync(sources.configDir, { recursive: true, force: true });
	}
	assert.ok(ticks > 0, "the event loop turned while the command ran");
});

test("a process this one may not signal still counts as alive (#5038)", (context) => {
	if (process.platform === "win32") return context.skip();
	assert.equal(isProcessAlive(1), true);
});

test("by default a broker supersedes an instance with an independently read real host identity (#5038, #5343)", async () => {
	const { start } = await crashedCluster();
	const socket = "/real-host/broker.sock";
	const { leases, router: previous } = await start({
		instanceKey: socket,
		hostIdentity: await brokerHostIdentity(systemSources()),
	});
	await start({ instanceKey: socket, hostIdentity: undefined, isProcessAlive: () => false });
	assert.deepEqual(await leases.read({ kind: "broker", brokerId: previous.brokerId }), { status: "missing" });
});

test("the real host's identity is stable across independent reads (#5038, #5343)", async () => {
	const identity = await brokerHostIdentity(systemSources());
	assert.ok(identity, "the real host provides an identity");
	assert.equal(await brokerHostIdentity(systemSources()), identity);
	if (process.platform === "linux") {
		const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		assert.equal(identity, `${bootId}/${readlinkSync("/proc/self/ns/pid")}`);
	}
});

test("default host identity reads share one promise and match an independent read (#5252, #5343)", async () => {
	const first = brokerHostIdentity();
	assert.equal(brokerHostIdentity(), first);
	assert.equal(await first, await brokerHostIdentity(systemSources()));
	assert.equal(brokerHostIdentity(), first);
});

test("host identity readers share pending and successful reads per config directory (#5252, #5343)", async () => {
	const host = fakeSources({
		platform: "darwin",
		commands: { [MAC_SESSION]: "session-a", [MAC_IOREG]: '"IOPlatformUUID" = "machine-a"' },
	});
	let configDir = "/config/first";
	const read = createBrokerHostIdentityReader(() => ({ ...host, configDir }));
	const first = read();
	assert.equal(read(), first, "concurrent brokers share the pending read");
	assert.equal(await first, "machine-a/session-session-a");
	assert.equal(read(), first, "a successful read stays cached");
	assert.deepEqual(host.runs, ["sysctl", "ioreg"]);

	configDir = "/config/second";
	const second = read();
	assert.notEqual(second, first, "different config directories have separate reads");
	assert.equal(await second, await first);
	assert.equal(read(), second);
	assert.deepEqual(host.runs, ["sysctl", "ioreg", "sysctl", "ioreg"]);
	configDir = "/config/first";
	assert.equal(read(), first, "reading another directory does not evict this one");
});

test("an unsuccessful host identity read is evicted before the next broker retries (#5252, #5343)", async () => {
	const commands: Record<string, string> = {};
	const host = fakeSources({ platform: "darwin", commands });
	const read = createBrokerHostIdentityReader(() => host);
	const failed = read();
	assert.equal(read(), failed, "concurrent brokers share even a failing read");
	assert.equal(await failed, undefined);

	commands[MAC_SESSION] = "session-a";
	commands[MAC_IOREG] = '"IOPlatformUUID" = "machine-a"';
	const retry = read();
	assert.notEqual(retry, failed, "a broker retries after the failed read settles");
	assert.equal(read(), retry);
	assert.equal(await retry, "machine-a/session-session-a");
	assert.equal(read(), retry, "the retry's successful identity stays cached");
	assert.deepEqual(host.runs, ["sysctl", "sysctl", "ioreg"]);
});

test("clones with the same machine id started together are told apart by their boot (#5038)", async () => {
	const mac = (session: string) =>
		brokerHostIdentity(
			fakeSources({
				platform: "darwin",
				commands: { [MAC_IOREG]: '"IOPlatformUUID" = "cloned"', [MAC_SESSION]: session },
			}),
		);
	assert.notEqual(await mac("session-1"), await mac("session-2"));
	const windows = (booted: string) =>
		brokerHostIdentity(
			fakeSources({
				platform: "win32",
				commands: { [WINDOWS_REG]: "MachineGuid    REG_SZ    cloned", [WINDOWS_BOOT]: booted },
			}),
		);
	assert.notEqual(await windows("2026-11-15T04:00:00.1000000Z"), await windows("2026-11-15T04:00:00.1000010Z"));
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
	assert.notEqual(await machine("guid-1"), await machine("guid-2"));
	// Each sees the other's pid as exited, as a pid from another machine would be.
	const first = await start({
		instanceKey: SOCKET,
		hostIdentity: await machine("guid-1"),
		isProcessAlive: () => false,
	});
	const second = await start({
		instanceKey: SOCKET,
		hostIdentity: await machine("guid-2"),
		isProcessAlive: () => false,
	});
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
	const exited = await keptExitedPid();
	try {
		assert.equal(isProcessAlive(exited.pid), false);
	} finally {
		await exited.release();
	}
});
