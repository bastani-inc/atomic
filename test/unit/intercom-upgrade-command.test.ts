import assert from "node:assert/strict";
import { IntercomBrokerUpgradeError } from "@bastani/atomic";
import { describe, test } from "vitest";
import { runIntercomCommand } from "../../packages/coding-agent/src/cli/intercom-command.js";
import type {
	BrokerQuery,
	IntercomBrokerControl,
	UpgradeOutcome,
} from "../../packages/coding-agent/src/core/intercom-broker-control.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

const agentDir = useTemporaryAgentDir();

function control(
	upgrade: UpgradeOutcome | Error,
	query: BrokerQuery = { state: "stopped" },
): {
	control: IntercomBrokerControl;
	upgrades: string[];
} {
	const upgrades: string[] = [];
	return {
		upgrades,
		control: {
			BROKER_PROTOCOL: { min: 1, max: 2 },
			queryIntercomBroker: async () => query,
			expectedBrokerStorage: () => undefined,
			readLiveBrokers: async () => [],
			restartIntercomBroker: async () => ({ status: "not-running" }),
			upgradeIntercomBroker: async (directory, options) => {
				upgrades.push(directory);
				if (upgrade instanceof Error) throw upgrade;
				if (upgrade.status === "stopped")
					options?.onProgress?.("Stopping the older Intercom broker (pid 41); no session is connected.");
				return upgrade;
			},
			describeMultiNodeStatus: () => "off",
			projectHomeGroup: () => undefined,
		},
	};
}

async function intercom(
	args: string[],
	broker: IntercomBrokerControl,
): Promise<{ code: number; out: string[]; err: string[] }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runIntercomCommand(args, {
		agentDir,
		log: (line) => out.push(line),
		error: (line) => err.push(line),
		loadControl: async () => broker,
	});
	return { code, out, err };
}

describe("atomic intercom upgrade (#4538)", () => {
	const outcomes: ReadonlyArray<readonly [UpgradeOutcome, readonly string[]]> = [
		[
			{ status: "not-running" },
			["No Intercom broker is running. The next session that uses Intercom starts this version's broker."],
		],
		[
			{ status: "unreported", pid: 40 },
			[
				"The Intercom broker (pid 40) was started by an older atomic that does not report its sessions, so it was left running. Run `atomic intercom restart` to replace it.",
			],
		],
		[
			{ status: "unreported" },
			[
				"The Intercom broker was started by an older atomic that does not report its sessions, so it was left running. Run `atomic intercom restart` to replace it.",
			],
		],
		[
			{ status: "current", pid: 41, protocol: { min: 1, max: 2 }, decision: "compatible" },
			["The running Intercom broker (pid 41, protocol 1-2) needs no upgrade."],
		],
		[
			{ status: "current", pid: 41, protocol: { min: 3, max: 3 }, decision: "incompatible" },
			[
				"The running Intercom broker (pid 41, protocol 3) shares no protocol version with this atomic, so it was left running for its sessions.",
			],
		],
		[
			{ status: "deferred", pid: 41, sessions: 1, protocol: { min: 1, max: 1 } },
			[
				"The running Intercom broker (pid 41, protocol 1) is older, and 1 session is connected, so it was left running. The next session of this version hands it over to a new broker without disconnecting them.",
			],
		],
		[
			{ status: "deferred", pid: 41, sessions: 3, protocol: { min: 1, max: 1 } },
			[
				"The running Intercom broker (pid 41, protocol 1) is older, and 3 sessions are connected, so it was left running. The next session of this version hands it over to a new broker without disconnecting them.",
			],
		],
		[
			{ status: "stopped", previous: { pid: 41, protocol: { min: 1, max: 1 } } },
			[
				"Stopping the older Intercom broker (pid 41); no session is connected.",
				"Stopped the older Intercom broker (pid 41). No session was connected; the next session that uses Intercom starts this version's broker.",
			],
		],
	];
	for (const [outcome, lines] of outcomes) {
		test(`reports ${outcome.status}${"decision" in outcome ? ` (${outcome.decision})` : ""} and exits 0`, async () => {
			const { control: broker, upgrades } = control(outcome);
			const result = await intercom(["upgrade"], broker);
			assert.deepEqual(result, { code: 0, out: lines, err: [] });
			assert.deepEqual(upgrades, [agentDir]);
		});
	}

	test("a failed upgrade exits 1 with the typed error's message, which names the fix", async () => {
		const failure = new IntercomBrokerUpgradeError({ phase: "stop", previousPid: 41, previousProtocolMax: 1 });
		const result = await intercom(["upgrade"], control(failure).control);
		assert.equal(result.code, 1);
		assert.deepEqual(result.out, []);
		assert.deepEqual(result.err, [`Error: ${failure.message}`]);
		assert.match(result.err[0] ?? "", /atomic intercom restart/);
	});

	test("intercom status names the protocol of a broker, and says an older one is replaced by the next session", async () => {
		const running = (protocol?: { min: number; max: number }): BrokerQuery => ({
			state: "running",
			report: {
				pid: 41,
				sessions: 2,
				multiNode: { status: "off" },
				...(protocol === undefined ? {} : { protocol }),
			},
		});
		const older = await intercom(["status"], control({ status: "not-running" }, running()).control);
		assert.equal(older.code, 0);
		assert.equal(
			older.out.at(-1),
			"Protocol: 1, older than this version's 1-2; the next session of this version replaces it",
		);
		const current = await intercom(
			["status"],
			control({ status: "not-running" }, running({ min: 1, max: 2 })).control,
		);
		assert.equal(current.out.at(-1), "Protocol: 1-2");
		const newer = await intercom(["status"], control({ status: "not-running" }, running({ min: 2, max: 3 })).control);
		assert.equal(newer.out.at(-1), "Protocol: 2-3");
	});
});
