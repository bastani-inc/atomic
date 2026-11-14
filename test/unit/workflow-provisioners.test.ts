import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "vitest";
import { redactSecrets } from "../../packages/workflows/src/workers/provisioners/cli.js";
import {
	type CommandProvisionerOptions,
	createWorkerHostProvisioner,
	WorkerProvisionerError,
} from "../../packages/workflows/src/workers/provisioners/index.js";
import { FakeCloud, type FakeCloudKind, runProvisionerConformance } from "../helpers/provisioner-conformance.js";

const never = () => new AbortController().signal;
const posixOnly = test.skipIf(process.platform === "win32");
const SECRET = "Cl1ent~Secret.9f3c2b7e1d-4a5b";

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

/** The presets shipped in the coding-agent package's examples, each with the CLI it drives and the cloud it models. */
const PRESETS: readonly { readonly file: string; readonly cli: string; readonly kind: FakeCloudKind }[] = [
	{ file: "azure-vmss.json", cli: "az", kind: "vmss" },
	{ file: "aws-asg.json", cli: "aws", kind: "asg" },
	{ file: "gcp-mig.json", cli: "gcloud", kind: "mig" },
	{ file: "kubernetes.json", cli: "kubectl", kind: "deployment" },
	{ file: "github-actions.json", cli: "gh", kind: "gh" },
];

function preset(file: string): CommandProvisionerOptions {
	const path = fileURLToPath(
		new URL(`../../packages/coding-agent/examples/worker-fleet/presets/${file}`, import.meta.url),
	);
	return JSON.parse(readFileSync(path, "utf8")) as CommandProvisionerOptions;
}

/** A fake cloud of `kind` with its fake CLI on `PATH`, and the secret the CLI prints when it refuses credentials. */
function fakeCloud(cli: string, kind: FakeCloudKind): FakeCloud {
	const cloud = FakeCloud.create(kind);
	cloud.installCli(cli);
	setEnv("FAKE_SECRET", SECRET);
	return cloud;
}

for (const { file, cli, kind } of PRESETS)
	runProvisionerConformance(`${file} preset`, () => {
		const cloud = fakeCloud(cli, kind);
		return {
			cloud,
			secret: SECRET,
			provisioner: (options) => createWorkerHostProvisioner({ ...preset(file), ...options }),
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

describe("command provisioner presets (#4768)", () => {
	/** Each preset's commands for scaleTo(2) from nothing, a list, and a drain of the first host, as the CLI gets them. */
	posixOnly("each preset passes its CLI the commands it documents, with placeholders filled (#4768)", async () => {
		for (const { file, cli, kind } of PRESETS) {
			const cloud = fakeCloud(cli, kind);
			try {
				const config = preset(file);
				const fleet = createWorkerHostProvisioner(config);
				await fleet.scaleTo(2, never());
				const hosts = await fleet.list(never());
				const id = hosts[0]!.id;
				await fleet.drain(id, never());
				const fill = (args: readonly string[], values: Record<string, string>) =>
					args.slice(1).map((arg) => arg.replace(/\{(\w+)\}/g, (_, name: string) => values[name]!));
				const ups = (Array.isArray(config.up[0]) ? config.up : [config.up]) as string[][];
				const downs = (Array.isArray(config.down[0]) ? config.down : [config.down]) as string[][];
				const lists = ((Array.isArray(config.list[0]) ? config.list : [config.list]) as string[][]).map((list) =>
					list.slice(1),
				);
				const upCalls = config.upEach === true ? [0, 1].map(() => ups[0]!) : ups;
				assert.deepEqual(
					cloud.calls(),
					[
						...lists,
						...upCalls.map((up) => fill(up, { target: "2", add: config.upEach === true ? "1" : "2" })),
						...lists,
						...lists,
						...downs.map((down) => fill(down, { id, remaining: "1" })),
					],
					file,
				);
				assert.equal(hosts.length, 2, file);
				assert.ok(!cloud.activeIds().includes(id), file);
				assert.equal(cloud.activeIds().length, 1, file);
			} finally {
				cloud.dispose();
			}
		}
	});

	posixOnly("the Kubernetes preset leaves terminating and ended pods out (#4768)", async () => {
		const cloud = fakeCloud("kubectl", "deployment");
		try {
			cloud.addHost({ id: "atomic-worker-evicted", phase: "running", podPhase: "Failed" });
			cloud.addHost({ id: "atomic-worker-done", phase: "running", podPhase: "Succeeded" });
			cloud.addHost({ id: "atomic-worker-going", phase: "deleting", seen: false });
			cloud.addHost({ id: "atomic-worker-lost", phase: "running", podPhase: "Unknown" });
			cloud.addHost({ id: "atomic-worker-up", phase: "running" });
			const hosts = await createWorkerHostProvisioner(preset("kubernetes.json")).list(never());
			assert.deepEqual(
				hosts.map((host) => [host.id, host.state]),
				[
					["atomic-worker-lost", "pending"],
					["atomic-worker-up", "running"],
				],
			);
		} finally {
			cloud.dispose();
		}
	});

	posixOnly("a preset whose CLI is not installed rejects as missing (#4768)", async () => {
		setEnv("PATH", "/nonexistent-atomic-bin");
		const error = await rejection(createWorkerHostProvisioner(preset("aws-asg.json")).list(never()));
		assert.equal(error.code, "missing-cli");
		assert.equal(
			error.message,
			"the list command failed: aws was not found. Install it on this machine, or put it on PATH.",
		);
	});
});

describe("command provisioner (#4768)", () => {
	function script(source: string): string[] {
		return [process.execPath, "-e", source];
	}

	/** A list command that prints `hosts`, and an up and a down command that record their environment in `log`. */
	function recorded(log: string, hosts: string) {
		const record = (name: string) =>
			script(
				`require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(name)}, process.argv.slice(1), process.env.ATOMIC_TARGET, process.env.ATOMIC_ADD, process.env.ATOMIC_PROVIDER_ID, process.env.ATOMIC_REMAINING]) + '\\n')`,
			);
		return {
			up: [
				[...record("up-1"), "--", "--size={target}", "add={add}"],
				[...record("up-2"), "--", "{unknown}"],
			],
			down: [...record("down"), "--", "--instance={id}", "--count={remaining}"],
			list: script(`process.stdout.write(${JSON.stringify(hosts)})`),
		};
	}

	function calls(log: string): string[][] {
		return readFileSync(log, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as string[]);
	}

	test("fills placeholders and the environment, runs steps in order, and adds only what list lacks (#4768)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-command-steps-"));
		const log = join(dir, "log");
		try {
			const two = '[{"id":"a","state":"running"},{"id":"b","state":"pending"}]';
			const fleet = createWorkerHostProvisioner({ kind: "command", ...recorded(log, two) });
			await fleet.scaleTo(5, never());
			await fleet.scaleTo(2, never());
			await fleet.scaleTo(1, never());
			await fleet.drain("b", never());
			await fleet.drain("missing", never());
			assert.deepEqual(calls(log), [
				["up-1", ["--size=5", "add=3"], "5", "3", null, null],
				["up-2", ["{unknown}"], "5", "3", null, null],
				["down", ["--instance=b", "--count=1"], null, null, "b", "1"],
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("with upEach, runs up once for each host to add (#4768)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-command-each-"));
		const log = join(dir, "log");
		try {
			const commands = recorded(log, '[{"id":"a","state":"running"}]');
			const fleet = createWorkerHostProvisioner({ kind: "command", ...commands, up: commands.up[0]!, upEach: true });
			await fleet.scaleTo(4, never());
			assert.deepEqual(
				calls(log).map((call) => [call[1], call[3]]),
				[
					[["--size=4", "add=1"], "1"],
					[["--size=4", "add=1"], "1"],
					[["--size=4", "add=1"], "1"],
				],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("does not remove a host the list reports draining, and runs changes one at a time (#4768)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-command-serial-"));
		const log = join(dir, "log");
		try {
			const fleet = createWorkerHostProvisioner({
				kind: "command",
				...recorded(log, '[{"id":"a","state":"draining"},{"id":"b","state":"failed"}]'),
			});
			await Promise.all([fleet.drain("a", never()), fleet.drain("b", never()), fleet.scaleTo(3, never())]);
			assert.deepEqual(
				calls(log).map((call) => call[0]),
				["down", "up-1", "up-2"],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reads hosts through listFormat: a path to the items, ids, states, times and host ids (#4768)", async () => {
		const list = (output: object, listFormat: object) =>
			createWorkerHostProvisioner({
				kind: "command",
				up: script("0"),
				down: script("0"),
				list: script(`process.stdout.write(${JSON.stringify(JSON.stringify(output))})`),
				listFormat,
			}).list(never());
		const output = {
			Groups: [
				{
					Instances: [
						{ Id: 7, Life: "InService", At: "2026-11-14T08:00:00Z", Meta: { host: "h7" } },
						{ Id: "i-2", Life: "Pending", At: 1234 },
						{ Id: "i-3", Life: "Terminating", At: 1 },
						{ Id: "i-4", Life: "Warmed:Pending", At: null },
					],
				},
			],
		};
		const format = {
			items: "Groups.0.Instances",
			id: "Id",
			state: "Life",
			since: "At",
			hostId: "Meta.host",
			states: { InService: "running", Pending: "pending", Terminating: null, "*": "stopped" },
		};
		const before = Date.now();
		const hosts = await list(output, format);
		assert.deepEqual(hosts.slice(0, 2), [
			{ id: "7", hostId: "h7", state: "running", since: Date.parse("2026-11-14T08:00:00Z") },
			{ id: "i-2", state: "pending", since: 1234 },
		]);
		assert.equal(hosts.length, 3);
		assert.deepEqual([hosts[2]!.id, hosts[2]!.state], ["i-4", "stopped"]);
		assert.ok(hosts[2]!.since >= before);
		const { "*": _, ...strict } = format.states;
		for (const [bad, listFormat] of [
			[output, { ...format, states: strict }],
			[output, { ...format, items: "Groups.1.Instances" }],
			[output, { ...format, items: "Groups.0" }],
			[{ Groups: [{ Instances: [{ Id: true, Life: "InService" }] }] }, format],
			[{ Groups: [{ Instances: [{ Id: "", Life: "InService" }] }] }, format],
			[{ Groups: [{ Instances: [{ Id: "x", Life: 3 }] }] }, format],
			[{ Groups: [{ Instances: [{ Id: "x", Life: "InService", At: "soon" }] }] }, format],
			[{ Groups: [{ Instances: [{ Id: "x", Life: "InService", Meta: { host: 5 } }] }] }, format],
			[
				{
					Groups: [
						{
							Instances: [
								{ Id: "x", Life: "InService" },
								{ Id: "x", Life: "Pending" },
							],
						},
					],
				},
				format,
			],
		] as const) {
			const error = await rejection(list(bad, listFormat));
			assert.equal(error.code, "malformed", JSON.stringify(bad));
			assert.equal(
				error.message,
				"the list command printed JSON that its listFormat does not match: an array of hosts with distinct ids and states it maps.",
			);
		}
	});

	test("several list commands report their hosts together, a host two report counting once (#4768)", async () => {
		const print = (hosts: object[]) => script(`process.stdout.write(${JSON.stringify(JSON.stringify(hosts))})`);
		const fleet = createWorkerHostProvisioner({
			kind: "command",
			up: script("0"),
			down: script("0"),
			list: [
				print([
					{ id: "a", state: "pending", since: 1 },
					{ id: "b", state: "pending", since: 2 },
				]),
				print([
					{ id: "b", state: "running", since: 3 },
					{ id: "c", state: "running", since: 4 },
				]),
				print([]),
			],
		});
		assert.deepEqual(await fleet.list(never()), [
			{ id: "a", state: "pending", since: 1 },
			{ id: "b", state: "running", since: 3 },
			{ id: "c", state: "running", since: 4 },
		]);
		const twice = createWorkerHostProvisioner({
			kind: "command",
			up: script("0"),
			down: script("0"),
			list: [
				print([]),
				print([
					{ id: "x", state: "running" },
					{ id: "x", state: "pending" },
				]),
			],
		});
		assert.equal((await rejection(twice.list(never()))).code, "malformed");
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
			list: script("process.stdout.write('[]')"),
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
					list: script("process.stdout.write('[]')"),
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
				list: script("process.stdout.write('[]')"),
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
				createWorkerHostProvisioner({
					kind: "command",
					up: [file],
					down: [file],
					list: [process.execPath, "-e", "process.stdout.write('[]')"],
				}).scaleTo(1, never()),
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
			/Invalid provisioner options: kind must be "command", not "elsewhere"\./,
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
		assert.equal(createWorkerHostProvisioner({ ...ok, up: [["a"], ["b", "c"]], down: [["d"]] }).kind, "command");
		assert.throws(
			() => createWorkerHostProvisioner({ ...ok, up: [["a"], []] }),
			/up must be a non-empty array of strings: an executable and its arguments, or a non-empty array of such commands, run in order\./,
		);
		assert.equal(createWorkerHostProvisioner({ ...ok, list: [["a"], ["b"]] }).kind, "command");
		assert.throws(
			() => createWorkerHostProvisioner({ ...ok, list: [["a"], [""]] }),
			/list must be a non-empty array of strings: an executable and its arguments, or a non-empty array of such commands, run in order\./,
		);
		assert.throws(() => createWorkerHostProvisioner({ ...ok, up: [[]] }), /up must be a non-empty array/);
		assert.throws(
			() => createWorkerHostProvisioner({ ...ok, upEach: "yes" as unknown as boolean }),
			/upEach must be true or false when given\./,
		);
		assert.equal(createWorkerHostProvisioner({ ...ok, upEach: false }).kind, "command");
		type Format = NonNullable<Parameters<typeof createWorkerHostProvisioner>[0]["listFormat"]>;
		for (const [listFormat, message] of [
			[[], /listFormat must be an object\./],
			[null, /listFormat must be an object\./],
			["id", /listFormat must be an object\./],
			[{ items: "" }, /listFormat\.items must be a non-empty path when given\./],
			[{ id: 5 }, /listFormat\.id must be a non-empty path when given\./],
			[{ state: "" }, /listFormat\.state must be/],
			[{ since: "" }, /listFormat\.since must be/],
			[{ hostId: "" }, /listFormat\.hostId must be/],
			[
				{ states: { a: "up" } },
				/listFormat\.states must map each provider state to pending, running, draining, stopped, failed or null\./,
			],
			[{ states: [] }, /listFormat\.states must map/],
			[{ states: null }, /listFormat\.states must map/],
			[{ states: "running" }, /listFormat\.states must map/],
		] as const)
			assert.throws(
				() => createWorkerHostProvisioner({ ...ok, listFormat: listFormat as unknown as Format }),
				message,
				JSON.stringify(listFormat),
			);
		assert.equal(
			createWorkerHostProvisioner({
				...ok,
				listFormat: { items: "a", id: "b", state: "c", since: "d", hostId: "e", states: { x: null, y: "failed" } },
			}).kind,
			"command",
		);
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
