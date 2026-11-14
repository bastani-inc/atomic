import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "vitest";
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
				assert.deepEqual(
					calls.map((call) => call[2]),
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
		for (const bad of [
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
	});
});
