import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "vitest";
import { redactSecrets } from "../../packages/workflows/src/workers/provisioners/cli.js";
import {
	createWorkerHostProvisioner,
	WorkerProvisionerError,
} from "../../packages/workflows/src/workers/provisioners/index.js";
import { FakeCloud, runProvisionerConformance } from "../helpers/provisioner-conformance.js";

const fakeCommand = fileURLToPath(new URL("../fixtures/fake-provision-command.mjs", import.meta.url));
const AZURE_SECRET = "Az-Cl1ent~Secret.9f3c2b7e1d";
const KUBE_TOKEN = "kube-token-4f1d9e8c7b6a5d4c3b2a";
const COMMAND_TOKEN = "cmd-tok-0a9b8c7d6e5f4a3b";
const never = () => new AbortController().signal;
const posixOnly = test.skipIf(process.platform === "win32");

/** Environment variables a test set, restored after it. */
const savedEnv = new Map<string, string | undefined>();
function setEnv(name: string, value: string): void {
	if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
	process.env[name] = value;
}
afterEach(() => {
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	savedEnv.clear();
});

const VMSS = { resourceGroup: "atomic-rg", name: "atomic-workers", subscription: "sub-1" };

function azureCloud(): FakeCloud {
	const cloud = FakeCloud.create("vmss", VMSS);
	cloud.installCli("az", "fake-az.mjs");
	setEnv("AZURE_CLIENT_SECRET", AZURE_SECRET);
	return cloud;
}

function kubeCloud(kind: "deployment" | "statefulset", context?: string): FakeCloud {
	const cloud = FakeCloud.create(kind, {
		namespace: "atomic",
		workload: "atomic-worker",
		selector: "app=atomic-worker",
		context,
	});
	cloud.installCli("kubectl", "fake-kubectl.mjs");
	setEnv("KUBE_TOKEN", KUBE_TOKEN);
	return cloud;
}

function commandCloud(): FakeCloud {
	return FakeCloud.create("command");
}

function commandArgs(cloud: FakeCloud, action: string): string[] {
	return [process.execPath, fakeCommand, cloud.dir, `--token=${COMMAND_TOKEN}`, action];
}

runProvisionerConformance("azure-vmss", () => {
	const cloud = azureCloud();
	return {
		cloud,
		secret: AZURE_SECRET,
		provisioner: (options) => createWorkerHostProvisioner({ kind: "azure-vmss", ...VMSS, ...options }),
		dispose: () => cloud.dispose(),
	};
});

runProvisionerConformance("kubernetes", () => {
	const cloud = kubeCloud("deployment");
	return {
		cloud,
		secret: KUBE_TOKEN,
		provisioner: (options) =>
			createWorkerHostProvisioner({
				kind: "kubernetes",
				namespace: "atomic",
				deployment: "atomic-worker",
				selector: "app=atomic-worker",
				...options,
			}),
		dispose: () => cloud.dispose(),
	};
});

runProvisionerConformance("command", () => {
	const cloud = commandCloud();
	return {
		cloud,
		secret: COMMAND_TOKEN,
		provisioner: (options) =>
			createWorkerHostProvisioner({
				kind: "command",
				up: commandArgs(cloud, "up"),
				down: commandArgs(cloud, "down"),
				list: commandArgs(cloud, "list"),
				...options,
			}),
		dispose: () => cloud.dispose(),
	};
});

async function rejection(promise: Promise<unknown>): Promise<WorkerProvisionerError> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof WorkerProvisionerError, `not a WorkerProvisionerError: ${String(error)}`);
		return error;
	}
	assert.fail("expected a rejection");
}

describe("azure-vmss provisioner (#4768)", () => {
	posixOnly("drives az vmss with argument arrays, --no-wait and the subscription (#4768)", async () => {
		const cloud = azureCloud();
		try {
			const fleet = createWorkerHostProvisioner({ kind: "azure-vmss", ...VMSS });
			await fleet.scaleTo(2, never());
			await fleet.list(never());
			await fleet.drain("1", never());
			const scope = ["--resource-group", "atomic-rg", "--name", "atomic-workers", "--subscription", "sub-1"];
			assert.deepEqual(cloud.calls(), [
				["vmss", "scale", ...scope, "--new-capacity", "2", "--no-wait", "--output", "none"],
				["vmss", "list-instances", ...scope, "--output", "json"],
				["vmss", "list-instances", ...scope, "--output", "json"],
				["vmss", "delete-instances", ...scope, "--instance-ids", "1", "--no-wait", "--output", "none"],
			]);
		} finally {
			cloud.dispose();
		}
	});

	posixOnly("maps provisioning states and leaves out instances being deleted (#4768)", async () => {
		const cloud = azureCloud();
		try {
			for (const [id, state] of [
				["10", "Creating"],
				["11", "Succeeded"],
				["12", "Updating"],
				["13", "Failed"],
				["14", "Canceled"],
				["15", "Deleting"],
			] as const)
				cloud.addHost({ id, phase: "running", state });
			const hosts = await createWorkerHostProvisioner({ kind: "azure-vmss", ...VMSS }).list(never());
			assert.deepEqual(
				hosts.map((host) => [host.id, host.state]),
				[
					["10", "pending"],
					["11", "running"],
					["12", "running"],
					["13", "failed"],
					["14", "failed"],
				],
			);
		} finally {
			cloud.dispose();
		}
	});

	posixOnly("leaves --subscription out when none is given (#4768)", async () => {
		const cloud = FakeCloud.create("vmss", { ...VMSS, subscription: undefined });
		cloud.installCli("az", "fake-az.mjs");
		try {
			await createWorkerHostProvisioner({
				kind: "azure-vmss",
				resourceGroup: "atomic-rg",
				name: "atomic-workers",
			}).list(never());
			assert.deepEqual(cloud.calls(), [
				["vmss", "list-instances", "--resource-group", "atomic-rg", "--name", "atomic-workers", "--output", "json"],
			]);
		} finally {
			cloud.dispose();
		}
	});

	posixOnly("reads each instance's creation time, or uses now without one (#4768)", async () => {
		const cloud = azureCloud();
		try {
			cloud.printRaw(
				JSON.stringify([
					{ instanceId: "1", provisioningState: "Succeeded", timeCreated: "2026-11-14T08:00:00Z" },
					{ instanceId: "2", provisioningState: "Creating" },
					{ instanceId: "3", provisioningState: "Creating", timeCreated: "not a time" },
				]),
			);
			const before = Date.now();
			const hosts = await createWorkerHostProvisioner({ kind: "azure-vmss", ...VMSS }).list(never());
			assert.equal(hosts[0]!.since, Date.parse("2026-11-14T08:00:00Z"));
			for (const host of hosts.slice(1)) assert.ok(host.since >= before && host.since <= Date.now());
		} finally {
			cloud.dispose();
		}
	});

	posixOnly("rejects instance lists it cannot read, without quoting them (#4768)", async () => {
		const cloud = azureCloud();
		try {
			const fleet = createWorkerHostProvisioner({ kind: "azure-vmss", ...VMSS });
			for (const raw of [
				'{"value": []}',
				"[null]",
				'["1"]',
				'[{"provisioningState":"Succeeded"}]',
				'[{"instanceId":"","provisioningState":"Succeeded"}]',
				'[{"instanceId":1,"provisioningState":"Succeeded"}]',
				'[{"instanceId":"1"}]',
				'[{"instanceId":"1","provisioningState":"Succeeded","timeCreated":5}]',
			]) {
				cloud.printRaw(raw);
				const error = await rejection(fleet.list(never()));
				assert.equal(error.code, "malformed", raw);
				assert.equal(
					error.message,
					"az vmss list-instances printed JSON that is not a list of scale set instances.",
					raw,
				);
			}
			cloud.printRaw("Succeeded");
			assert.equal(
				(await rejection(fleet.list(never()))).message,
				"az vmss list-instances printed output that is not JSON.",
			);
		} finally {
			cloud.dispose();
		}
	});

	posixOnly("passes option values literally, never through a shell (#4768)", async () => {
		const hostile = "rg; touch pwned $(id) `id`";
		const cloud = FakeCloud.create("vmss", { ...VMSS, resourceGroup: hostile });
		cloud.installCli("az", "fake-az.mjs");
		try {
			await createWorkerHostProvisioner({ kind: "azure-vmss", ...VMSS, resourceGroup: hostile }).scaleTo(1, never());
			assert.equal(cloud.calls()[0]![3], hostile);
			assert.equal(cloud.activeIds().length, 1);
		} finally {
			cloud.dispose();
		}
	});

	posixOnly("a scale set that is not found rejects with the CLI's exit code and its message (#4768)", async () => {
		const cloud = azureCloud();
		try {
			const error = await rejection(
				createWorkerHostProvisioner({ kind: "azure-vmss", ...VMSS, name: "other" }).list(never()),
			);
			assert.equal(error.code, "exit");
			assert.equal(error.exitCode, 3);
			assert.match(error.message, /^az vmss list-instances exited with code 3: .*ResourceNotFound/);
		} finally {
			cloud.dispose();
		}
	});

	test("an az that is not installed rejects as missing (#4768)", async () => {
		setEnv("PATH", "/nonexistent-atomic-bin");
		const error = await rejection(createWorkerHostProvisioner({ kind: "azure-vmss", ...VMSS }).list(never()));
		assert.equal(error.code, "missing-cli");
		assert.match(error.message, /az was not found/);
	});
});

describe("kubernetes provisioner (#4768)", () => {
	const deployment = {
		kind: "kubernetes",
		namespace: "atomic",
		deployment: "atomic-worker",
		selector: "app=atomic-worker",
	} as const;

	posixOnly(
		"drains a Deployment's pod by deleting it, then scaling down by one from the count it read (#4768)",
		async () => {
			const cloud = kubeCloud("deployment", "prod");
			try {
				const fleet = createWorkerHostProvisioner({ ...deployment, context: "prod" });
				await fleet.scaleTo(2, never());
				const [pod] = cloud.activeIds();
				await fleet.drain(pod!, never());
				const scope = ["--namespace", "atomic", "--context", "prod"];
				assert.deepEqual(cloud.calls(), [
					[...scope, "scale", "deployment/atomic-worker", "--replicas=2"],
					[
						...scope,
						"get",
						"pods",
						"--selector",
						"app=atomic-worker",
						"--field-selector",
						`metadata.name=${pod}`,
						"--output",
						"json",
					],
					[...scope, "get", "deployment", "atomic-worker", "--output", "json"],
					[...scope, "delete", "pod", pod!, "--wait=false", "--ignore-not-found"],
					[...scope, "scale", "deployment/atomic-worker", "--replicas=1", "--current-replicas=2"],
				]);
				assert.equal(cloud.activeIds().length, 1);
				assert.ok(!cloud.activeIds().includes(pod!));
			} finally {
				cloud.dispose();
			}
		},
	);

	posixOnly(
		"reports pod phases, leaves out terminating pods, and deletes an ended pod without scaling (#4768)",
		async () => {
			const cloud = kubeCloud("deployment");
			try {
				const fleet = createWorkerHostProvisioner(deployment);
				await fleet.scaleTo(1, never());
				cloud.addHost({ id: "atomic-worker-evicted", phase: "running", podPhase: "Failed" });
				cloud.addHost({ id: "atomic-worker-done", phase: "running", podPhase: "Succeeded" });
				cloud.addHost({ id: "atomic-worker-lost", phase: "running", podPhase: "Unknown" });
				cloud.addHost({ id: "atomic-worker-old", phase: "deleting" });
				const states = Object.fromEntries((await fleet.list(never())).map((host) => [host.id, host.state]));
				assert.deepEqual(states, {
					[cloud.activeIds().find((id) => id.startsWith("atomic-worker-7d9c"))!]: "pending",
					"atomic-worker-evicted": "failed",
					"atomic-worker-done": "stopped",
					"atomic-worker-lost": "pending",
				});
				const before = cloud.calls().length;
				await fleet.drain("atomic-worker-evicted", never());
				const calls = cloud.calls().slice(before);
				assert.deepEqual(calls, [
					[
						"--namespace",
						"atomic",
						"get",
						"pods",
						"--selector",
						"app=atomic-worker",
						"--field-selector",
						"metadata.name=atomic-worker-evicted",
						"--output",
						"json",
					],
					[
						"--namespace",
						"atomic",
						"delete",
						"pod",
						"atomic-worker-evicted",
						"--wait=false",
						"--ignore-not-found",
					],
				]);
				await fleet.drain("atomic-worker-done", never());
				assert.deepEqual(
					cloud
						.calls()
						.slice(before + 2)
						.map((call) => call[2]),
					["get", "delete"],
				);
			} finally {
				cloud.dispose();
			}
		},
	);

	posixOnly("a StatefulSet drains only its highest ordinal, by scaling down (#4768)", async () => {
		const cloud = kubeCloud("statefulset");
		try {
			const fleet = createWorkerHostProvisioner({
				kind: "kubernetes",
				namespace: "atomic",
				statefulSet: "atomic-worker",
				selector: "app=atomic-worker",
			});
			await fleet.scaleTo(3, never());
			assert.deepEqual(cloud.activeIds(), ["atomic-worker-0", "atomic-worker-1", "atomic-worker-2"]);
			await fleet.drain("atomic-worker-1", never());
			assert.deepEqual(cloud.activeIds(), ["atomic-worker-0", "atomic-worker-1", "atomic-worker-2"]);
			assert.ok(!cloud.calls().some((call) => call.includes("delete")));
			await fleet.drain("atomic-worker-2", never());
			assert.deepEqual(cloud.activeIds(), ["atomic-worker-0", "atomic-worker-1"]);
			assert.deepEqual(cloud.calls().at(-1), [
				"--namespace",
				"atomic",
				"scale",
				"statefulset/atomic-worker",
				"--replicas=2",
				"--current-replicas=3",
			]);
		} finally {
			cloud.dispose();
		}
	});

	posixOnly(
		"a scale-down that lost a race with another change rejects, and removes nothing more (#4768)",
		async () => {
			const cloud = kubeCloud("deployment");
			try {
				const fleet = createWorkerHostProvisioner(deployment);
				await fleet.scaleTo(2, never());
				const [pod] = cloud.activeIds();
				// Another writer changed the replicas between the drain's read and its scale-down.
				cloud.write({ ...cloud.read(), reportReplicas: 3 });
				const error = await rejection(fleet.drain(pod!, never()));
				assert.equal(error.code, "exit");
				assert.match(error.message, /^kubectl scale exited with code 1: error: Expected replicas to be 3, was 2/);
				assert.equal(cloud.activeIds().length, 2);
			} finally {
				cloud.dispose();
			}
		},
	);

	posixOnly("reads each pod's start or creation time, or uses now without one (#4768)", async () => {
		const cloud = kubeCloud("deployment");
		try {
			cloud.printRaw(
				JSON.stringify({
					items: [
						{
							metadata: { name: "a", creationTimestamp: "2026-11-14T08:00:00Z" },
							status: { phase: "Running", startTime: "2026-11-14T08:01:00Z" },
						},
						{ metadata: { name: "b", creationTimestamp: "2026-11-14T08:00:00Z" }, status: { phase: "Pending" } },
						{ metadata: { name: "c", creationTimestamp: "2026-11-14T08:00:00Z" }, status: { phase: "Running" } },
						{ metadata: { name: "d" } },
						{ metadata: { name: "e", creationTimestamp: "nope" }, status: { phase: "Failed" } },
					],
				}),
			);
			const before = Date.now();
			const hosts = await createWorkerHostProvisioner(deployment).list(never());
			assert.deepEqual(
				hosts.slice(0, 3).map((host) => [host.id, host.state, host.since]),
				[
					["a", "running", Date.parse("2026-11-14T08:01:00Z")],
					["b", "pending", Date.parse("2026-11-14T08:00:00Z")],
					["c", "running", Date.parse("2026-11-14T08:00:00Z")],
				],
			);
			assert.deepEqual(
				hosts.slice(3).map((host) => [host.id, host.state]),
				[
					["d", "pending"],
					["e", "failed"],
				],
			);
			for (const host of hosts.slice(3)) assert.ok(host.since >= before && host.since <= Date.now());
		} finally {
			cloud.dispose();
		}
	});

	posixOnly("rejects pod lists and replica counts it cannot read (#4768)", async () => {
		const cloud = kubeCloud("deployment");
		try {
			const fleet = createWorkerHostProvisioner(deployment);
			for (const raw of [
				"null",
				"[]",
				'{"items": {}}',
				'{"items": [null]}',
				'{"items": [{"metadata": {}}]}',
				'{"items": [{}]}',
				'{"items": [{"metadata": {"name": ""}}]}',
			]) {
				cloud.printRaw(raw);
				const error = await rejection(fleet.list(never()));
				assert.equal(error.code, "malformed", raw);
				assert.equal(error.message, "kubectl get pods printed JSON that is not a list of pods.", raw);
			}
			cloud.setMode("ok");
			await fleet.scaleTo(1, never());
			const [pod] = cloud.activeIds();
			for (const raw of [
				"null",
				"{}",
				'{"spec": {}}',
				'{"spec": {"replicas": "1"}}',
				'{"spec": {"replicas": 1.5}}',
				'{"spec": {"replicas": -1}}',
			]) {
				cloud.write({ ...cloud.read(), rawWorkload: raw });
				const error = await rejection(fleet.drain(pod!, never()));
				assert.equal(error.code, "malformed", raw);
				assert.equal(error.message, "kubectl get deployment printed no replica count.", raw);
			}
			assert.deepEqual(cloud.activeIds(), [pod!]);
		} finally {
			cloud.dispose();
		}
	});

	posixOnly("drain leaves a terminating pod, and a workload already at zero, alone (#4768)", async () => {
		const cloud = kubeCloud("deployment");
		try {
			const fleet = createWorkerHostProvisioner(deployment);
			cloud.addHost({ id: "atomic-worker-going", phase: "deleting", seen: false });
			await fleet.drain("atomic-worker-going", never());
			assert.deepEqual(
				cloud.calls().map((call) => call[2]),
				["get"],
			);
			cloud.addHost({ id: "atomic-worker-stray", phase: "running" });
			cloud.write({ ...cloud.read(), reportReplicas: 0 });
			await fleet.drain("atomic-worker-stray", never());
			assert.deepEqual(
				cloud.calls().map((call) => call.slice(2, 4)),
				[
					["get", "pods"],
					["get", "pods"],
					["get", "deployment"],
				],
			);
		} finally {
			cloud.dispose();
		}
	});

	posixOnly("Forbidden is an auth error (#4768)", async () => {
		const cloud = kubeCloud("deployment");
		try {
			const error = await rejection(
				createWorkerHostProvisioner({ ...deployment, namespace: "elsewhere" }).list(never()),
			);
			assert.equal(error.code, "auth");
			assert.equal(error.exitCode, 1);
			assert.match(error.message, /^kubectl get pods exited with code 1: .*Forbidden/);
		} finally {
			cloud.dispose();
		}
	});

	test("requires exactly one of deployment and statefulSet (#4768)", () => {
		assert.throws(
			() =>
				createWorkerHostProvisioner({
					kind: "kubernetes",
					namespace: "atomic",
					selector: "app=a",
				} as Parameters<typeof createWorkerHostProvisioner>[0]),
			/exactly one of deployment and statefulSet/,
		);
		assert.throws(
			() =>
				createWorkerHostProvisioner({
					kind: "kubernetes",
					namespace: "atomic",
					selector: "app=a",
					deployment: "a",
					statefulSet: "b",
				} as Parameters<typeof createWorkerHostProvisioner>[0]),
			/exactly one of deployment and statefulSet/,
		);
	});
});

describe("command provisioner (#4768)", () => {
	function script(source: string): string[] {
		return [process.execPath, "-e", source];
	}

	test("passes the target and the provider id in the environment (#4768)", async () => {
		const record = script(
			"const e = process.env; process.stdout.write(JSON.stringify([{id: 't' + (e.ATOMIC_TARGET ?? '') + 'p' + (e.ATOMIC_PROVIDER_ID ?? ''), state: 'running', since: 1}]))",
		);
		const seen: string[] = [];
		const fleet = createWorkerHostProvisioner({
			kind: "command",
			up: script("if (process.env.ATOMIC_TARGET !== '3') process.exit(4)"),
			down: script("if (process.env.ATOMIC_PROVIDER_ID !== 'host-7') process.exit(5)"),
			list: record,
		});
		await fleet.scaleTo(3, never());
		await fleet.drain("host-7", never());
		for (const host of await fleet.list(never())) seen.push(host.id);
		assert.deepEqual(seen, ["tp"]);
	});

	test("list accepts ISO times and a hostId, and rejects hosts it cannot read (#4768)", async () => {
		const list = (hosts: string) =>
			createWorkerHostProvisioner({
				kind: "command",
				up: script("0"),
				down: script("0"),
				list: script(`process.stdout.write(${JSON.stringify(hosts)})`),
			}).list(never());
		assert.deepEqual(await list('[{"id":"a","hostId":"h1","state":"draining","since":"2026-11-14T00:00:00.000Z"}]'), [
			{ id: "a", hostId: "h1", state: "draining", since: Date.parse("2026-11-14T00:00:00.000Z") },
		]);
		assert.deepEqual(
			(
				await list(
					JSON.stringify(
						["pending", "running", "draining", "stopped", "failed"].map((state, index) => ({
							id: state,
							state,
							since: index + 1,
						})),
					),
				)
			).map((host) => [host.id, host.state, host.since, "hostId" in host]),
			[
				["pending", "pending", 1, false],
				["running", "running", 2, false],
				["draining", "draining", 3, false],
				["stopped", "stopped", 4, false],
				["failed", "failed", 5, false],
			],
		);
		assert.equal((await rejection(list("nope"))).message, "the list command printed output that is not JSON.");
		for (const bad of [
			"null",
			"[null]",
			"[5]",
			'[{"id":"a","state":"running","since":null}]',
			'[{"id":"a","state":"running","since":true}]',
			'{"id":"a"}',
			'[{"state":"running","since":1}]',
			'[{"id":"","state":"running","since":1}]',
			'[{"id":"a","state":"booting","since":1}]',
			'[{"id":"a","state":"running","since":"yesterday"}]',
			'[{"id":"a","hostId":7,"state":"running","since":1}]',
			'[{"id":"a","state":"running","since":1},{"id":"a","state":"running","since":1}]',
		]) {
			const error = await rejection(list(bad));
			assert.equal(error.code, "malformed", bad);
			assert.match(error.message, /^the list command printed/);
		}
	});

	test("a list host without a time keeps the time it was first listed (#4768)", async () => {
		const fleet = createWorkerHostProvisioner({
			kind: "command",
			up: script("0"),
			down: script("0"),
			list: script('process.stdout.write(\'[{"id":"a","state":"pending"}]\')'),
		});
		const [first] = await fleet.list(never());
		await new Promise((resolve) => setTimeout(resolve, 20));
		const [second] = await fleet.list(never());
		assert.equal(second!.since, first!.since);
	});

	test("a list host without a time gets a new one when its state changes or it comes back (#4768)", async () => {
		// Each call prints the next answer of a sequence kept in an environment-named file.
		const sequence = [
			'[{"id":"a","state":"pending"}]',
			'[{"id":"a","state":"running"}]',
			'[{"id":"a","state":"running"}]',
			"[]",
			'[{"id":"a","state":"running"}]',
		];
		const counter = join(mkdtempSync(join(tmpdir(), "atomic-command-list-")), "n");
		const fleet = createWorkerHostProvisioner({
			kind: "command",
			up: script("0"),
			down: script("0"),
			list: [
				...script(
					"const fs = require('fs'); const [file, ...answers] = process.argv.slice(1); const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0; fs.writeFileSync(file, String(n + 1)); process.stdout.write(answers[n]);",
				),
				counter,
				...sequence,
			],
		});
		const times: number[] = [];
		for (let index = 0; index < sequence.length; index++) {
			times.push((await fleet.list(never()))[0]?.since ?? -1);
			await new Promise((resolve) => setTimeout(resolve, 15));
		}
		assert.ok(times[1]! > times[0]!, "a new state keeps the old time");
		assert.equal(times[2], times[1]);
		assert.equal(times[3], -1);
		assert.ok(times[4]! > times[2]!, "a host that came back keeps the time from before it left");
		rmSync(dirname(counter), { recursive: true, force: true });
	});

	test("a failing command reports its exit code and stderr, never its arguments (#4768)", async () => {
		const fleet = createWorkerHostProvisioner({
			kind: "command",
			up: [
				...script("console.error('quota exceeded in eastus'); process.exit(7)"),
				"x",
				"--password",
				"hunter2-secret",
			],
			down: script("0"),
			list: script("0"),
		});
		const error = await rejection(fleet.scaleTo(1, never()));
		assert.equal(error.code, "exit");
		assert.equal(error.exitCode, 7);
		assert.equal(error.message, "the up command exited with code 7: quota exceeded in eastus");
		assert.doesNotMatch(JSON.stringify(error), /hunter2/);
	});

	test("a failing command's stderr is joined, trimmed and cut, and a signal or an unrunnable file is named (#4768)", async () => {
		const failing = (source: string, extra: readonly string[] = []) =>
			rejection(
				createWorkerHostProvisioner({
					kind: "command",
					up: [...script(source), ...extra],
					down: script("0"),
					list: script("0"),
				}).scaleTo(1, never()),
			);
		const joined = await failing("process.stderr.write('  first  \\r\\n\\r\\n  second\\n'); process.exit(2)");
		assert.equal(joined.message, "the up command exited with code 2: first second");
		assert.equal(joined.name, "WorkerProvisionerError");
		const long = await failing("process.stderr.write('x'.repeat(5000)); process.exit(3)");
		assert.equal(long.message, `the up command exited with code 3: ${"x".repeat(600)}…`);
		const fits = await failing("process.stderr.write('y'.repeat(600)); process.exit(3)");
		assert.equal(fits.message, `the up command exited with code 3: ${"y".repeat(600)}`);
		const silent = await failing("process.exit(4)");
		assert.equal(silent.message, "the up command exited with code 4");
		for (const [stderr, code] of [
			["Unauthorized", "auth"],
			["request unauthorised", "auth"],
			["403 Forbidden", "auth"],
			["Authentication failed", "auth"],
			["authentication required", "auth"],
			["authentication error: expired", "auth"],
			["You are not logged in", "auth"],
			["login required", "auth"],
			["Access denied", "auth"],
			["invalid credentials", "auth"],
			["quota exceeded", "exit"],
			["authorization pending", "exit"],
		] as const) {
			const error = await failing(`process.stderr.write(${JSON.stringify(stderr)}); process.exit(1)`);
			assert.equal(error.code, code, stderr);
		}
	});

	posixOnly("a command killed by a signal is named by it, with no exit code (#4768)", async () => {
		const killed = await rejection(
			createWorkerHostProvisioner({
				kind: "command",
				up: script("process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000)"),
				down: script("0"),
				list: script("0"),
			}).scaleTo(1, never()),
		);
		assert.equal(killed.code, "exit");
		assert.equal(killed.exitCode, undefined);
		assert.equal(killed.message, "the up command was stopped by SIGTERM");
	});

	posixOnly("a file that cannot be run is reported as such (#4768)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-command-noexec-"));
		const file = join(dir, "scale-to");
		writeFileSync(file, "#!/bin/sh\nexit 0\n");
		try {
			const error = await rejection(
				createWorkerHostProvisioner({ kind: "command", up: [file], down: [file], list: [file] }).scaleTo(
					1,
					never(),
				),
			);
			assert.equal(error.code, "exit");
			assert.equal(error.message, "the up command could not start (EACCES).");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("output past 64 MiB is refused (#4768)", async () => {
		const error = await rejection(
			createWorkerHostProvisioner({
				kind: "command",
				up: script("0"),
				down: script("0"),
				list: script(
					"const chunk = Buffer.alloc(1024 * 1024, 32); for (let i = 0; i < 65; i++) process.stdout.write(chunk);",
				),
			}).list(never()),
		);
		assert.equal(error.code, "malformed");
		assert.equal(error.message, "the list command printed more than 67108864 bytes.");
		const fits = await createWorkerHostProvisioner({
			kind: "command",
			up: script("0"),
			down: script("0"),
			list: script(
				"const chunk = Buffer.alloc(1024 * 1024, 32); for (let i = 0; i < 63; i++) process.stdout.write(chunk); process.stdout.write('[]');",
			),
		}).list(never());
		assert.deepEqual(fits, []);
	});

	test("checks its options (#4768)", () => {
		const ok = { kind: "command", up: ["a"], down: ["b"], list: ["c"] } as const;
		assert.throws(() => createWorkerHostProvisioner({ ...ok, up: [] }), /up must be a non-empty array of strings/);
		assert.throws(
			() => createWorkerHostProvisioner({ ...ok, list: [""] as unknown as string[] }),
			/list must be a non-empty array of strings/,
		);
		assert.throws(() => createWorkerHostProvisioner({ ...ok, timeoutMs: 0 }), /timeoutMs must be a positive integer/);
		assert.throws(
			() =>
				createWorkerHostProvisioner({ kind: "elsewhere" } as unknown as Parameters<
					typeof createWorkerHostProvisioner
				>[0]),
			/kind must be "azure-vmss", "kubernetes" or "command"/,
		);
		assert.equal(createWorkerHostProvisioner(ok).kind, "command");
		assert.throws(
			() => createWorkerHostProvisioner({ ...ok, down: ["a", ""] }),
			/down must be a non-empty array of strings/,
		);
		assert.throws(
			() => createWorkerHostProvisioner({ ...ok, up: "a" as unknown as string[] }),
			/up must be a non-empty array of strings/,
		);
		assert.equal(createWorkerHostProvisioner({ ...ok, timeoutMs: 1 }).kind, "command");
		for (const timeoutMs of [1.5, -1, "5"])
			assert.throws(
				() => createWorkerHostProvisioner({ ...ok, timeoutMs: timeoutMs as number }),
				/Invalid command provisioner options: timeoutMs must be a positive integer/,
			);
	});
});

describe("provisioner options (#4768)", () => {
	const vmss = { kind: "azure-vmss", resourceGroup: "rg", name: "set" } as const;
	const kube = { kind: "kubernetes", namespace: "ns", selector: "app=w", deployment: "w" } as const;
	type Config = Parameters<typeof createWorkerHostProvisioner>[0];

	test("require their names to be non-empty strings, and optional ones to be when given (#4768)", () => {
		assert.equal(createWorkerHostProvisioner(vmss).kind, "azure-vmss");
		assert.equal(createWorkerHostProvisioner(kube).kind, "kubernetes");
		const cases: [Config, RegExp][] = [
			[
				{ ...vmss, resourceGroup: "" },
				/Invalid azure-vmss provisioner options: resourceGroup must be a non-empty string\./,
			],
			[
				{ ...vmss, name: 5 as unknown as string },
				/azure-vmss provisioner options: name must be a non-empty string\./,
			],
			[{ ...vmss, subscription: "" }, /subscription must be a non-empty string when given\./],
			[{ ...vmss, subscription: 5 as unknown as string }, /subscription must be a non-empty string when given\./],
			[{ ...vmss, timeoutMs: 0 }, /Invalid azure-vmss provisioner options: timeoutMs must be a positive integer\./],
			[{ ...kube, namespace: "" }, /Invalid kubernetes provisioner options: namespace must be a non-empty string\./],
			[{ ...kube, selector: undefined as unknown as string }, /selector must be a non-empty string\./],
			[{ ...kube, context: "" }, /context must be a non-empty string when given\./],
			[{ ...kube, deployment: "" }, /deployment must be a non-empty string when given\./],
			[{ ...kube, deployment: undefined, statefulSet: "" }, /statefulSet must be a non-empty string when given\./],
			[{ ...kube, timeoutMs: -5 }, /Invalid kubernetes provisioner options: timeoutMs must be a positive integer\./],
		];
		for (const [config, message] of cases) assert.throws(() => createWorkerHostProvisioner(config), message);
	});
});

describe("secret redaction (#4768)", () => {
	test("redacts secret-named arguments and environment values, longest first (#4768)", () => {
		const env = { AZURE_CLIENT_SECRET: "abcdef", MY_TOKEN: "abcdefgh", PATH: "/usr/local/bin", API_KEY: "short" };
		assert.equal(
			redactSecrets("token abcdefgh, secret abcdef, path /usr/local/bin, key short", [], env),
			"token [redacted], secret [redacted], path /usr/local/bin, key short",
		);
		assert.equal(
			redactSecrets(
				"saw hunter22 and s3cr3tvalue and visible-value and plain-arg",
				["--client-secret=s3cr3tvalue", "-password", "hunter22", "token", "visible-value", "--name", "plain-arg"],
				{},
			),
			"saw [redacted] and [redacted] and visible-value and plain-arg",
		);
		assert.equal(redactSecrets("ends with --token", ["--token"], {}), "ends with --token");
		assert.equal(redactSecrets("a=b x--token=abcdefg", ["x--token=abcdefg"], {}), "a=b x--token=[redacted]");
	});

	test("redacts tokens a CLI prints (#4768)", () => {
		const cases: [string, string][] = [
			["Authorization: Bearer abc.def-ghi, next", "Authorization: Bearer [redacted], next"],
			["got eyJhbGciOi.eyJzdWIi.c2ln and eyJhbGciOi.eyJzdWIi done", "got [redacted] and [redacted] done"],
			[
				"password=hunter2 pwd: 'x1' passwd=y apikey=z api_key=z api-key=z",
				"password=[redacted] pwd: '[redacted]' passwd=[redacted] apikey=[redacted] api_key=[redacted] api-key=[redacted]",
			],
			[
				"client_secret: abc; access_key=k&sig=s signature=t",
				"client_secret: [redacted]; access_key=[redacted]&sig=[redacted] signature=[redacted]",
			],
			[
				"accesskey=k access-key=k credential=c token:t",
				"accesskey=[redacted] access-key=[redacted] credential=[redacted] token:[redacted]",
			],
			["status=500 name=atomic", "status=500 name=atomic"],
		];
		for (const [text, redacted] of cases) assert.equal(redactSecrets(text, [], {}), redacted, text);
	});
});
