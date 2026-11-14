/**
 * The conformance suite every built-in worker host provisioner passes (#4768), against a fake CLI on `PATH`: a Node
 * script that keeps its cloud in a JSON state file (`test/fixtures/fake-cloud.mjs`) and records each call. No cloud is
 * ever called.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import type { ProvisionedHost, WorkerHostProvisioner } from "../../packages/workflows/src/workers/fleet-types.js";
import { sleep } from "./runtime.js";

export type FakeCloudKind = "vmss" | "deployment" | "statefulset" | "command";
export type FakeCloudMode = "ok" | "hang" | "auth" | "malformed" | "raw";

export interface FakeCloudHost {
	readonly id: string;
	readonly n: number;
	readonly phase: "creating" | "running" | "deleting";
	readonly seen: boolean;
	readonly created: number;
	/** A provisioning state the fake `az` reports instead of the one its phase gives. */
	readonly state?: string;
	/** A pod phase the fake `kubectl` reports instead of the one its phase gives. */
	readonly podPhase?: string;
}

interface FakeCloudState {
	kind: FakeCloudKind;
	target: Readonly<Record<string, string | undefined>>;
	mode: FakeCloudMode;
	nextId: number;
	hosts: FakeCloudHost[];
	/** Replicas the fake `kubectl get` reports instead of the pods it counts, as if another writer changed them. */
	reportReplicas?: number;
	/** What every call prints in `raw` mode. */
	raw?: string;
	/** What the fake `kubectl get <workload>` prints instead of the workload. */
	rawWorkload?: string;
}

/** A fake cloud in its own directory, with the fake CLIs it installs first on `PATH`. */
export class FakeCloud {
	readonly dir: string;
	private readonly path = process.env.PATH;

	private constructor(dir: string) {
		this.dir = dir;
	}

	/** A fake cloud of `kind` holding no host. `target` is what its CLI answers for; anything else is not found. */
	static create(kind: FakeCloudKind, target: Readonly<Record<string, string | undefined>> = {}): FakeCloud {
		const cloud = new FakeCloud(mkdtempSync(join(tmpdir(), "atomic-fake-cloud-")));
		cloud.write({ kind, target, mode: "ok", nextId: 0, hosts: [] });
		writeFileSync(join(cloud.dir, "calls.jsonl"), "");
		return cloud;
	}

	/** Installs `name` on `PATH`: a shell script that runs `fixture` with this cloud's directory. */
	installCli(name: string, fixture: string): void {
		const bin = join(this.dir, "bin");
		const script = join(bin, name);
		const fixturePath = fileURLToPath(new URL(`../fixtures/${fixture}`, import.meta.url));
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			script,
			`#!/bin/sh\nFAKE_CLOUD_DIR=${quote(this.dir)} exec ${quote(process.execPath)} ${quote(fixturePath)} "$@"\n`,
		);
		chmodSync(script, 0o755);
		process.env.PATH = `${bin}${delimiter}${this.path ?? ""}`;
	}

	read(): FakeCloudState {
		return JSON.parse(readFileSync(join(this.dir, "state.json"), "utf8")) as FakeCloudState;
	}

	write(state: FakeCloudState): void {
		writeFileSync(join(this.dir, "state.json"), JSON.stringify(state));
	}

	setMode(mode: FakeCloudMode): void {
		this.write({ ...this.read(), mode });
	}

	/** Makes every call print `raw` and exit 0. */
	printRaw(raw: string): void {
		this.write({ ...this.read(), mode: "raw", raw });
	}

	/** Adds a host as the cloud would report it, such as a pod that was evicted. */
	addHost(host: Omit<FakeCloudHost, "n" | "seen" | "created"> & { readonly seen?: boolean }): void {
		const state = this.read();
		this.write({
			...state,
			hosts: [...state.hosts, { n: state.nextId + 100, seen: true, created: Date.now(), ...host }],
		});
	}

	/** The ids of the hosts the cloud counts: not deleting. */
	activeIds(): string[] {
		return this.read()
			.hosts.filter((host) => host.phase !== "deleting" && host.podPhase !== "Failed")
			.map((host) => host.id)
			.toSorted();
	}

	/** The argv of every CLI call so far. */
	calls(): string[][] {
		return readFileSync(join(this.dir, "calls.jsonl"), "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as string[]);
	}

	/** The pids of each hung CLI call and of the grandchild it started. */
	hungPids(): number[] {
		const file = join(this.dir, "hung.jsonl");
		if (!existsSync(file)) return [];
		return readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.flatMap((line) => JSON.parse(line) as number[]);
	}

	/** Stops the processes of hung calls that are still alive, restores `PATH` and removes the directory. */
	dispose(): void {
		for (const pid of this.hungPids()) if (alive(pid)) process.kill(pid, "SIGKILL");
		process.env.PATH = this.path;
		rmSync(this.dir, { recursive: true, force: true });
	}
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A provisioner over a fresh fake cloud, the secret its fake CLI prints when it refuses credentials, and cleanup. */
export interface ProvisionerConformanceSubject {
	readonly cloud: FakeCloud;
	provisioner(options?: { readonly timeoutMs?: number }): WorkerHostProvisioner;
	readonly secret: string;
	dispose(): void;
}

const never = () => new AbortController().signal;

async function waitFor<T>(what: string, check: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = check();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

/** Lists until every host runs; returns each list on the way. */
async function listUntilRunning(provisioner: WorkerHostProvisioner, count: number): Promise<ProvisionedHost[][]> {
	const lists: ProvisionedHost[][] = [];
	for (let attempt = 0; attempt < 5; attempt++) {
		const hosts = [...(await provisioner.list(never()))];
		lists.push(hosts);
		if (hosts.length === count && hosts.every((host) => host.state === "running")) return lists;
	}
	assert.fail(`the hosts never all ran: ${JSON.stringify(lists)}`);
}

/** Lists until `id` is gone, which may take a list that reports it draining first. */
async function listUntilGone(provisioner: WorkerHostProvisioner, id: string): Promise<ProvisionedHost[]> {
	for (let attempt = 0; attempt < 4; attempt++) {
		const hosts = await provisioner.list(never());
		if (!hosts.some((host) => host.id === id)) return [...hosts];
		assert.ok(hosts.every((host) => host.id !== id || host.state === "draining" || host.state === "stopped"));
	}
	assert.fail(`${id} was never removed`);
}

function ids(hosts: readonly ProvisionedHost[]): string[] {
	return hosts.map((host) => host.id).toSorted();
}

/** Everything an error carries that could reach a fleet event or a log: messages, names and fields down its causes. */
function errorText(error: unknown): string {
	const parts: string[] = [];
	for (let current = error; current !== undefined && current !== null; current = (current as Error).cause) {
		parts.push(String(current), JSON.stringify(current), (current as Error).stack ?? "");
		if (typeof current !== "object") break;
	}
	return parts.join("\n");
}

function exitCodeOf(error: unknown): number | undefined {
	for (let current = error; current instanceof Error; current = current.cause) {
		const code = (current as Error & { exitCode?: number }).exitCode;
		if (code !== undefined) return code;
	}
	return undefined;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof Error, `rejected with a non-Error: ${String(error)}`);
		return error;
	}
	assert.fail("expected a rejection");
}

/**
 * Registers the conformance suite for one provisioner. `setup` builds a provisioner over a fresh fake cloud for each
 * case; a CLI's process must be stopped (with its children) on a timeout or an abort.
 */
export function runProvisionerConformance(name: string, setup: () => ProvisionerConformanceSubject): void {
	const posixOnly = test.skipIf(process.platform === "win32");
	const cases: [string, (subject: ProvisionerConformanceSubject) => Promise<void>][] = [
		[
			"list of an empty fleet is an empty array",
			async ({ provisioner }) => {
				assert.deepEqual(await provisioner().list(never()), []);
			},
		],
		[
			"list reports new hosts pending before running, with an id and a time each",
			async ({ provisioner }) => {
				const fleet = provisioner();
				await fleet.scaleTo(2, never());
				const lists = await listUntilRunning(fleet, 2);
				assert.ok(lists.length >= 2, "the hosts ran without a list that reported them pending");
				assert.deepEqual(
					lists[0]!.map((host) => host.state),
					["pending", "pending"],
				);
				assert.deepEqual(ids(lists[0]!), ids(lists.at(-1)!));
				assert.equal(new Set(ids(lists[0]!)).size, 2);
				for (const host of lists.at(-1)!) assert.ok(Number.isFinite(host.since) && host.since > 0);
			},
		],
		[
			"scaleTo is idempotent",
			async ({ provisioner, cloud }) => {
				const fleet = provisioner();
				await fleet.scaleTo(3, never());
				const first = cloud.activeIds();
				await fleet.scaleTo(3, never());
				await fleet.scaleTo(3, never());
				assert.equal(first.length, 3);
				assert.deepEqual(cloud.activeIds(), first);
				assert.deepEqual(ids(await fleet.list(never())), first);
			},
		],
		[
			"scaleTo only adds toward a higher target and keeps the hosts it has",
			async ({ provisioner, cloud }) => {
				const fleet = provisioner();
				await fleet.scaleTo(1, never());
				const [first] = cloud.activeIds();
				await fleet.scaleTo(3, never());
				const after = cloud.activeIds();
				assert.equal(after.length, 3);
				assert.ok(after.includes(first!));
			},
		],
		[
			"scaleTo survives a target changed mid-call, and the last target holds",
			async ({ provisioner, cloud }) => {
				const fleet = provisioner();
				await Promise.all([fleet.scaleTo(2, never()), fleet.scaleTo(4, never())]);
				assert.ok([2, 4].includes(cloud.activeIds().length));
				await fleet.scaleTo(4, never());
				assert.equal(cloud.activeIds().length, 4);
				await listUntilRunning(fleet, 4);
			},
		],
		[
			"drain removes only the named host and lowers the count by one",
			async ({ provisioner, cloud }) => {
				const fleet = provisioner();
				await fleet.scaleTo(3, never());
				const running = ids((await listUntilRunning(fleet, 3)).at(-1)!);
				await fleet.drain(running[1]!, never());
				assert.deepEqual(cloud.activeIds(), [running[0]!, running[2]!]);
				assert.deepEqual(ids(await listUntilGone(fleet, running[1]!)), [running[0]!, running[2]!]);
			},
		],
		[
			"drain of an unknown or already removed id is a no-op",
			async ({ provisioner, cloud }) => {
				const fleet = provisioner();
				await fleet.scaleTo(2, never());
				const running = ids((await listUntilRunning(fleet, 2)).at(-1)!);
				await fleet.drain("no-such-host", never());
				assert.deepEqual(cloud.activeIds(), running);
				await fleet.drain(running[0]!, never());
				await fleet.drain(running[0]!, never());
				await listUntilGone(fleet, running[0]!);
				await fleet.drain(running[0]!, never());
				assert.deepEqual(cloud.activeIds(), [running[1]!]);
			},
		],
		[
			"a CLI that hangs is stopped with its children at the timeout",
			async ({ provisioner, cloud }) => {
				cloud.setMode("hang");
				const started = Date.now();
				const error = await rejection(provisioner({ timeoutMs: 300 }).list(never()));
				assert.ok(Date.now() - started < 5_000, "the timeout did not stop the call");
				assert.equal((error as Error & { code?: string }).code, "timeout");
				assert.match(error.message, /did not finish within/);
				const pids = cloud.hungPids();
				assert.equal(pids.length, 2);
				await waitFor("the hung CLI to stop", () => (pids.some(alive) ? undefined : true));
			},
		],
		[
			"an aborted signal stops the CLI with its children",
			async ({ provisioner, cloud }) => {
				cloud.setMode("hang");
				const abort = new AbortController();
				const call = rejection(provisioner().scaleTo(2, abort.signal));
				const pids = await waitFor("the CLI to start", () => {
					const found = cloud.hungPids();
					return found.length === 2 ? found : undefined;
				});
				const reason = new Error("stopping");
				abort.abort(reason);
				assert.equal(await call, reason);
				await waitFor("the aborted CLI to stop", () => (pids.some(alive) ? undefined : true));
			},
		],
		[
			"a signal aborted before the call runs no CLI",
			async ({ provisioner, cloud }) => {
				const abort = new AbortController();
				abort.abort(new Error("stopped"));
				const fleet = provisioner();
				for (const call of [
					() => fleet.list(abort.signal),
					() => fleet.scaleTo(1, abort.signal),
					() => fleet.drain("x", abort.signal),
				])
					assert.equal((await rejection(call())).message, "stopped");
				assert.deepEqual(cloud.calls(), []);
			},
		],
		[
			"output that is not the expected JSON rejects as malformed",
			async ({ provisioner, cloud }) => {
				cloud.setMode("malformed");
				const error = await rejection(provisioner().list(never()));
				assert.equal((error as Error & { code?: string }).code, "malformed");
				assert.doesNotMatch(error.message, /"items"/);
			},
		],
		[
			"refused credentials reject with the CLI's exit code and no secret",
			async ({ provisioner, cloud, secret }) => {
				const fleet = provisioner();
				await fleet.scaleTo(1, never());
				const [id] = cloud.activeIds();
				cloud.setMode("auth");
				for (const call of [
					() => fleet.list(never()),
					() => fleet.scaleTo(2, never()),
					() => fleet.drain(id!, never()),
				]) {
					const error = await rejection(call());
					assert.equal(exitCodeOf(error), 1);
					assert.equal((error as Error & { code?: string }).code, "auth");
					const text = errorText(error);
					assert.ok(!text.includes(secret), `the secret leaked: ${text}`);
					assert.doesNotMatch(text, /eyJhbGciOi/);
				}
			},
		],
	];
	describe(`${name} provisioner conformance (#4768)`, () => {
		for (const [title, body] of cases)
			posixOnly(`${name}: ${title} (#4768)`, async () => {
				const subject = setup();
				try {
					await body(subject);
				} finally {
					subject.dispose();
				}
			});
	});
}
