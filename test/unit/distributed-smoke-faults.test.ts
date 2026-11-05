import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { DistributedCommandError } from "../distributed/harness/errors.mjs";
import { createRandom } from "../distributed/harness/prng.mjs";
import { runSmoke } from "../distributed/harness/suites.mjs";

const posixOnly = test.skipIf(process.platform === "win32");

type Writer = {
	unit: string;
	holder: string;
	host: string;
	lease: string;
	count: number;
	acks: string;
	activeBefore: string[];
};
type Result = { exitCode: number; stdout: string; stderr: string; elapsedMs: number };
type AzureCall = { action: string; vm: string; wait?: boolean; nic?: string };

const answer = (stdout = ""): Result => ({ exitCode: 0, stdout, stderr: "", elapsedMs: 0 });

class Fleet {
	readonly root = mkdtempSync(join(tmpdir(), "adt-fleet-"));
	readonly scripts: { host: string; script: string }[] = [];
	readonly writers: Writer[] = [];
	readonly agentCalls: { host: string; command: string; args: readonly string[] }[] = [];
	readonly active = new Set<string>();
	readonly azure = new FakeAzure(this);
	boot = 1;
	epoch = 0;
	onScript: (host: string, script: string) => void = () => {};
	onAgent: (command: string, args: readonly string[]) => void = () => {};
	constructor() {
		mkdirSync(join(this.root, "logs"), { recursive: true });
	}
	local(path: string) {
		return path.replaceAll("/opt/adt", this.root);
	}
	host(name: string, ip: string, roles: string[], signal?: AbortSignal) {
		return new FakeHost(this, name, ip, roles, signal);
	}
	grow() {
		for (const writer of this.writers) {
			if (!this.active.has(writer.unit)) continue;
			for (let index = 0; index < 4; index++)
				appendFileSync(
					this.local(writer.acks),
					`{"event":"ack","index":${100 + index},"key":"${writer.holder}-g${index}"}\n`,
				);
		}
	}
	rebootHost(name: string) {
		this.boot++;
		for (const writer of this.writers) if (writer.host === name) this.active.delete(writer.unit);
	}
	cleanup() {
		rmSync(this.root, { recursive: true, force: true });
	}
}

class FakeAzure {
	signal: AbortSignal | undefined;
	readonly calls: AzureCall[] = [];
	nics = 2;
	power = "VM running";
	failOn: string | undefined;
	constructor(private readonly fleet: Fleet) {}
	private enter() {
		if (this.signal?.aborted) throw this.signal.reason;
	}
	async vmFacts(vm: string) {
		this.enter();
		return { encryptionAtHost: true, size: vm, nics: this.nics, powerState: this.power };
	}
	async vmPower(vm: string, action: string, options: { wait?: boolean } = {}) {
		this.enter();
		this.calls.push({ action, vm, wait: options.wait ?? true });
		if (this.failOn === action) throw new Error(`az vm ${action} failed`);
		if (action === "deallocate") {
			this.power = "VM deallocated";
			this.fleet.rebootHost(vm);
		} else if (action === "start" || action === "restart") {
			this.power = "VM running";
			this.fleet.rebootHost(vm);
		} else throw new Error(`unknown power action ${action}`);
	}
	async vmNic(vm: string, nic: string, action: string) {
		this.enter();
		this.calls.push({ action: `nic ${action}`, vm, nic });
		if (this.power !== "VM deallocated") throw new Error("a NIC changes only on a deallocated VM");
		if (action === "add") this.nics++;
		else if (action === "remove") this.nics--;
		else throw new Error(`unknown NIC action ${action}`);
	}
}

class FakeHost {
	readonly user = "adt";
	readonly vmName: string;
	readonly region = "region-a";
	constructor(
		private readonly fleet: Fleet,
		readonly name: string,
		readonly ip: string,
		readonly roles: string[],
		public signal?: AbortSignal,
	) {
		this.vmName = name;
	}
	async waitForSsh() {
		if (this.signal?.aborted) throw this.signal.reason;
	}
	async agent(command: string, args: readonly string[] = []) {
		if (this.signal?.aborted) throw this.signal.reason;
		this.fleet.agentCalls.push({ host: this.name, command, args });
		this.fleet.onAgent(command, args);
		if (command === "facts") return { bootId: `boot-${this.fleet.boot}`, clockMs: Date.now() };
		if (command === "read") return { entries: [] };
		if (command === "integrity") return { result: ["ok"] };
		throw new Error(`unexpected agent command ${command}`);
	}
	async json(script: string, options: { operation: string }) {
		const result = await this.run(script, options);
		return JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
	}
	async run(script: string, options: { operation: string; allowExitCodes?: number[] }): Promise<Result> {
		const fleet = this.fleet;
		if (this.signal?.aborted) throw this.signal.reason;
		fleet.scripts.push({ host: this.name, script });
		fleet.onScript(this.name, script);
		if (this.signal?.aborted) throw this.signal.reason;
		if (script.includes("systemd-run")) {
			const unit = /--unit=(\S+)/.exec(script)?.[1] as string;
			const acks = /--acks (\S+)/.exec(script)?.[1] as string;
			const holder = /--holder (\S+)/.exec(script)?.[1] ?? unit;
			const count = Number(/--count (\d+)/.exec(script)?.[1]);
			const lease = /--lease (\S+)/.exec(script)?.[1] ?? "none";
			const writer = { unit, holder, host: this.name, lease, count, acks, activeBefore: [...fleet.active] };
			fleet.writers.push(writer);
			const lines = [`{"event":"lease","epoch":${++fleet.epoch}}`];
			for (let index = 0; index < 10; index++)
				lines.push(`{"event":"ack","index":${index},"key":"${holder}-${index}"}`);
			if (count <= 5) lines.push('{"event":"done"}');
			else fleet.active.add(unit);
			writeFileSync(fleet.local(acks), `${lines.join("\n")}\n`);
			return answer();
		}
		const stopped = /systemctl stop (\S+)/.exec(script);
		if (stopped !== null) {
			const unit = stopped[1] as string;
			const writer = fleet.writers.find((candidate) => candidate.unit === unit);
			fleet.active.delete(unit);
			const file = writer === undefined ? undefined : fleet.local(writer.acks);
			if (file !== undefined && existsSync(file) && !readFileSync(file, "utf8").includes('"done"'))
				appendFileSync(file, '{"event":"done"}\n');
			return answer();
		}
		if (script.includes("systemctl show -p MainPID"))
			return answer('{"pid":0,"active":"inactive","result":"success","state":"-"}');
		if (script.includes("ip -o link")) return answer("2\n");
		if (script.includes("dd if=/dev/zero")) return answer('{"result":"No space left on device","ms":3}');
		if (script.includes("e2fsck")) return answer('{"fsck":1,"mounted":true}');
		if (script.includes("df --output")) return answer("0\n");
		if (script.startsWith("if [ -e ") || script.includes("gateway-stats.json")) {
			fleet.grow();
			const result = spawnSync("bash", ["-c", `set -euo pipefail\n${fleet.local(script)}`], { encoding: "utf8" });
			const allowed = [0, ...(options.allowExitCodes ?? [])];
			if (!allowed.includes(result.status ?? -1))
				throw new DistributedCommandError({
					tool: "ssh",
					operation: options.operation,
					exitCode: result.status,
					signal: null,
				});
			return { exitCode: result.status ?? 0, stdout: result.stdout, stderr: result.stderr, elapsedMs: 0 };
		}
		if (/iptables|tc qdisc|sudo |rm -f|fallocate/.test(script)) return answer();
		throw new Error(`the fake fleet does not know this script: ${script.slice(0, 80)}`);
	}
}

type SmokeOptions = {
	signal?: AbortSignal;
	seed?: number;
	vmRole?: number | null;
	faults?: Parameters<typeof runSmoke>[0]["faults"];
};

const smoke = (fleet: Fleet, profiles: readonly string[], options: SmokeOptions = {}) => {
	const vmRole = options.vmRole === undefined ? 2 : options.vmRole;
	const nodes = [
		fleet.host("node-1", "10.60.0.4", ["large"], options.signal),
		fleet.host("node-2", "10.61.0.4", ["small"], options.signal),
		fleet.host("node-3", "10.60.0.5", ["git-less"], options.signal),
	];
	if (vmRole !== null) (nodes[vmRole] as FakeHost).roles.push("vm-faults", "second-nic");
	fleet.azure.signal = options.signal;
	return runSmoke({
		runId: "adtrun",
		attempt: "a1",
		nodes: nodes as never,
		primary: fleet.host("db-1", "10.60.0.10", [], options.signal) as never,
		replica: fleet.host("db-2", "10.61.0.10", [], options.signal) as never,
		azure: fleet.azure as never,
		random: createRandom(options.seed ?? 7),
		profiles,
		gatewayPort: 8443,
		namespace: "adt",
		...(options.signal === undefined ? {} : { signal: options.signal }),
		log: () => {},
		started: performance.now(),
		faults: options.faults ?? [],
	});
};

const withFleet = async (body: (fleet: Fleet) => Promise<void>) => {
	const fleet = new Fleet();
	try {
		await body(fleet);
	} finally {
		fleet.cleanup();
	}
};

type Smoked = Awaited<ReturnType<typeof smoke>>;

const faultOf = (result: Smoked, profile: string) => {
	const found = result.faults.find((item) => item.profile === profile);
	assert.ok(found, `${profile} was exercised`);
	return found;
};

const invariantOf = (result: Smoked, name: string) => result.invariants.find((item) => item.name === name);

afterEach(() => {
	vi.useRealTimers();
});

posixOnly("a NIC-only run stops the writer holding the lease before the node writes again (#4331)", async () => {
	await withFleet(async (fleet) => {
		const result = await smoke(fleet, ["nic-detach"]);
		const takeovers = fleet.writers.filter((writer) => writer.lease === "takeover-expired");
		assert.ok(takeovers.length >= 2, "the fault and the final check each start a takeover writer");
		for (const writer of takeovers)
			assert.deepEqual(writer.activeBefore, [], `${writer.holder} started while another writer held the lease`);
		const nic = faultOf(result, "nic-detach");
		assert.equal(nic.recovered, true);
		assert.equal(nic.effectObserved, true);
		assert.equal(nic.error, undefined);
	});
});

posixOnly(
	"nic-detach deallocates, removes the NIC and starts without waiting, then re-adds it and starts again",
	async () => {
		await withFleet(async (fleet) => {
			await smoke(fleet, ["nic-detach"]);
			assert.deepEqual(fleet.azure.calls, [
				{ action: "deallocate", vm: "node-3", wait: true },
				{ action: "nic remove", vm: "node-3", nic: "node-3-nic2" },
				{ action: "start", vm: "node-3", wait: false },
				{ action: "deallocate", vm: "node-3", wait: true },
				{ action: "nic add", vm: "node-3", nic: "node-3-nic2" },
				{ action: "start", vm: "node-3", wait: false },
			]);
			assert.equal(fleet.azure.nics, 2);
		});
	},
);

posixOnly("nic-detach whose deallocation failed leaves the NIC and the running VM alone while reverting", async () => {
	await withFleet(async (fleet) => {
		fleet.azure.failOn = "deallocate";
		const result = await smoke(fleet, ["nic-detach"]);
		assert.deepEqual(fleet.azure.calls, [{ action: "deallocate", vm: "node-3", wait: true }]);
		const nic = faultOf(result, "nic-detach");
		assert.equal(nic.error?.code, "fault-failed");
		assert.equal(Reflect.get(nic.error?.fields ?? {}, "stage"), "apply");
		assert.equal(nic.applied, false);
	});
});

posixOnly("vm-restart requests the restart without waiting and leaves a running VM alone", async () => {
	await withFleet(async (fleet) => {
		const result = await smoke(fleet, ["vm-restart"]);
		assert.deepEqual(fleet.azure.calls, [{ action: "restart", vm: "node-3", wait: false }]);
		const restart = faultOf(result, "vm-restart");
		assert.equal(restart.error, undefined);
		assert.equal(restart.effectObserved, true);
		assert.equal(restart.recovered, true);
	});
});

posixOnly("vm-deallocate waits for the deallocation and starts the VM again without waiting", async () => {
	await withFleet(async (fleet) => {
		const result = await smoke(fleet, ["vm-deallocate"]);
		assert.deepEqual(fleet.azure.calls, [
			{ action: "deallocate", vm: "node-3", wait: true },
			{ action: "start", vm: "node-3", wait: false },
		]);
		const deallocate = faultOf(result, "vm-deallocate");
		assert.equal(deallocate.error, undefined);
		assert.equal(deallocate.effectObserved, true);
		assert.equal(deallocate.recovered, true);
	});
});

posixOnly(
	"the VM-fault node is the one with the vm-faults role, else the last node, and never holds the first writer",
	async () => {
		await withFleet(async (fleet) => {
			await smoke(fleet, ["vm-deallocate"], { vmRole: 1 });
			assert.deepEqual(
				fleet.azure.calls.map((call) => call.vm),
				["node-2", "node-2"],
			);
		});
		await withFleet(async (fleet) => {
			await smoke(fleet, ["vm-deallocate"], { vmRole: null });
			assert.deepEqual(
				fleet.azure.calls.map((call) => call.vm),
				["node-3", "node-3"],
			);
		});
		for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
			await withFleet(async (fleet) => {
				await smoke(fleet, [], { vmRole: 1, seed });
				assert.notEqual(fleet.writers[0]?.host, "node-2", `seed ${seed} put the first writer on the VM-fault node`);
			});
		}
	},
);

posixOnly("the final check reads the journal through the primary and the replica of the run", async () => {
	await withFleet(async (fleet) => {
		await smoke(fleet, []);
		const reads = fleet.agentCalls.filter((call) => call.command === "read" && call.args.includes("--run"));
		const urls = reads.map((call) => call.args[call.args.indexOf("--url") + 1]);
		assert.ok(urls.includes("https://10.60.0.10:8443"), "primary");
		assert.ok(urls.includes("https://10.61.0.10:8443"), "replica");
		for (const call of reads) assert.equal(call.args[call.args.indexOf("--run") + 1], "adtrun-smoke-a1");
		for (const call of reads) assert.deepEqual(call.args.slice(0, 2), ["--ref-dir", "/opt/adt/atomic"]);
	});
});

posixOnly("a partition counts the requests the gateway served during its window", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	await withFleet(async (fleet) => {
		const stats = join(fleet.root, "logs", "gateway-stats.json");
		writeFileSync(stats, '{"requests":40}');
		fleet.onScript = (_host, script) => {
			if (script.includes("iptables -I")) writeFileSync(stats, '{"requests":100}');
		};
		const running = smoke(fleet, ["partition"]);
		let settled = false;
		running.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		while (!settled) await vi.advanceTimersByTimeAsync(1000);
		const result = await running;
		assert.equal(faultOf(result, "partition").observed.gatewayRequestsDuringWindow, 60);
	});
});

posixOnly("cancelling the run during a fault still clears the fault before the cancellation propagates", async () => {
	await withFleet(async (fleet) => {
		const controller = new AbortController();
		const reason = new DOMException("cancelled by SIGINT", "AbortError");
		fleet.onScript = (_host, script) => {
			if (script.includes("iptables -I")) controller.abort(reason);
		};
		await assert.rejects(smoke(fleet, ["partition"], { signal: controller.signal }), (error) => error === reason);
		const applied = fleet.scripts.findIndex(({ script }) => script.includes("iptables -I"));
		const cleared = fleet.scripts.findIndex(({ script }) => script.includes("iptables -D"));
		assert.ok(applied >= 0, "the partition was applied");
		assert.ok(cleared > applied, "the partition rules were deleted after the run was cancelled");
		assert.equal(fleet.scripts[cleared]?.host, fleet.scripts[applied]?.host, "on the host that was partitioned");
	});
});

posixOnly("cancelling the run during a VM fault still restores the VM through the Azure boundary", async () => {
	await withFleet(async (fleet) => {
		const controller = new AbortController();
		const reason = new DOMException("cancelled by SIGINT", "AbortError");
		const power = FakeAzure.prototype.vmPower;
		fleet.azure.vmPower = async function (this: FakeAzure, vm: string, action: string, options?: { wait?: boolean }) {
			await power.call(this, vm, action, options);
			if (action === "deallocate" && !controller.signal.aborted) controller.abort(reason);
		};
		await assert.rejects(smoke(fleet, ["vm-deallocate"], { signal: controller.signal }), (error) => error === reason);
		assert.deepEqual(fleet.azure.calls, [
			{ action: "deallocate", vm: "node-3", wait: true },
			{ action: "start", vm: "node-3", wait: false },
		]);
		assert.equal(fleet.azure.power, "VM running");
	});
});

posixOnly(
	"a writer's missing acknowledgement file fails the evidence invariant instead of shrinking the evidence",
	async () => {
		await withFleet(async (complete) => {
			const result = await smoke(complete, []);
			assert.deepEqual(invariantOf(result, "writer-evidence-complete"), {
				name: "writer-evidence-complete",
				passed: true,
				expected: { writers: 2, missing: [] },
				actual: { writers: 2, missing: [] },
			});
		});
		await withFleet(async (lossy) => {
			lossy.onAgent = (command) => {
				if (command === "integrity") rmSync(lossy.local(lossy.writers[0]?.acks ?? ""), { force: true });
			};
			const result = await smoke(lossy, []);
			const lost = lossy.writers[0] as Writer;
			assert.deepEqual(invariantOf(result, "writer-evidence-complete"), {
				name: "writer-evidence-complete",
				passed: false,
				expected: { writers: 2, missing: [] },
				actual: { writers: 2, missing: [lost.holder] },
			});
			const readable = invariantOf(result, "evidence-complete");
			assert.ok(
				((readable?.actual ?? { acks: 0 }) as { acks: number }).acks >= 10,
				"readable records are still checked",
			);
		});
	},
);

const diskFullFleet = (fleet: Fleet) => {
	fleet.onScript = (_host, script) => {
		const writer = fleet.writers.find((candidate) => candidate.holder.startsWith("local-"));
		if (script.includes("fallocate") && writer !== undefined)
			appendFileSync(
				fleet.local(writer.acks),
				`{"event":"error","at":${Date.now() + 5000},"error":{"name":"StorageUnavailableError"}}\n`,
			);
	};
};

posixOnly("a disk profile's local writer evidence is checked and recorded as an invariant", async () => {
	await withFleet(async (fleet) => {
		diskFullFleet(fleet);
		const result = await smoke(fleet, ["disk-full"]);
		const disk = faultOf(result, "disk-full");
		assert.equal(disk.error, undefined);
		assert.equal(disk.effectObserved, true);
		assert.equal(disk.recovered, true);
		assert.deepEqual(invariantOf(result, "disk-full/writer-evidence-complete"), {
			name: "disk-full/writer-evidence-complete",
			passed: true,
			expected: { writers: 1, missing: [] },
			actual: { writers: 1, missing: [] },
		});
		const evidence = invariantOf(result, "disk-full/evidence-complete");
		assert.equal(evidence?.passed, true);
		assert.ok((((evidence?.actual ?? {}) as { acks?: number }).acks ?? 0) >= 10);
	});
});

posixOnly(
	"a disk profile whose local writer file vanished fails its evidence invariant and names the writer",
	async () => {
		await withFleet(async (fleet) => {
			diskFullFleet(fleet);
			fleet.onAgent = (command, args) => {
				const writer = fleet.writers.find((candidate) => candidate.holder.startsWith("local-"));
				if (command === "integrity" && args.includes("local") && writer !== undefined)
					rmSync(fleet.local(writer.acks), { force: true });
			};
			const result = await smoke(fleet, ["disk-full"]);
			assert.deepEqual(invariantOf(result, "disk-full/writer-evidence-complete"), {
				name: "disk-full/writer-evidence-complete",
				passed: false,
				expected: { writers: 1, missing: [] },
				actual: { writers: 1, missing: ["local-disk-full-a1"] },
			});
			assert.equal(invariantOf(result, "disk-full/evidence-complete")?.passed, false);
		});
	},
);
