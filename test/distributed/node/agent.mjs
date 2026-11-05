#!/usr/bin/env node
// @ts-check
/**
 * Node-side agent of the distributed harness. It runs on the private Atomic VMs against the deployed ref and prints
 * one JSON document (or JSON lines, for `writer`) on stdout. It reads credentials only from the files it is given and
 * never prints them.
 *
 *   facts                                    environment facts: Node, kernel, memory, git and fault tools
 *   capabilities --ref-dir D                 export names the deployed ref provides
 *   security --url U --namespace N --token-file F --foreign-token-file G --ca C --decoy-ca X --backend-port P
 *   writer --ref-dir D <journal> --run R --holder H --acks A --count C [--interval-ms I] [--lease acquire|takeover-expired]
 *          [--stale-ms S] [--takeover-timeout-ms T] [--max-error-ms E] [--hog-after K --hog-mb M]
 *   read --ref-dir D <journal> --run R
 *   stale-append --ref-dir D <journal> --run R --holder H --epoch E --key K
 *   integrity --ref-dir D <journal>
 *
 * <journal> is `--journal shared --url U --namespace N --token-file F` or `--journal local --path P`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { cpus, homedir, hostname, release, totalmem } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [command, ...rest] = process.argv.slice(2);
/** @type {Record<string, string>} */
const flags = {};
for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, "")] = rest[index + 1];

/** @param {string} name */
function flag(name) {
	const value = flags[name];
	if (value === undefined) throw new TypeError(`agent ${command} needs --${name}`);
	return value;
}

/** @param {unknown} value */
function print(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * A credential-free description of a thrown value, keeping Atomic's typed names and codes.
 * @param {unknown} error
 * @returns {{ name: string, code: string | null, message: string, cause?: { name: string, code: string | null, message: string } }}
 */
function describe(error) {
	const record = typeof error === "object" && error !== null ? error : { message: String(error) };
	const text = String(Reflect.get(record, "message") ?? "")
		.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted-jwt]")
		.slice(0, 300);
	const code = Reflect.get(record, "code");
	const cause = Reflect.get(record, "cause");
	return {
		name: String(Reflect.get(record, "name") ?? "Error"),
		code: typeof code === "string" ? code : null,
		message: text,
		...(cause !== undefined && cause !== null && typeof cause === "object"
			? { cause: (({ name, code, message }) => ({ name, code, message }))(describe(cause)) }
			: {}),
	};
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} binary */
function has(binary) {
	return spawnSync("sh", ["-c", `command -v ${binary}`], { encoding: "utf8" }).status === 0;
}

/** @param {string} module */
function kernelModule(module) {
	return spawnSync("modinfo", ["-n", module], { encoding: "utf8" }).status === 0;
}

/**
 * The deployed ref's public module, resolved from its own tree.
 * @param {string} specifier
 */
async function importFromRef(specifier) {
	const require = createRequire(join(flag("ref-dir"), "package.json"));
	return import(pathToFileURL(require.resolve(specifier)).href);
}

async function openJournal() {
	const { resolveRunJournal } = await importFromRef("@bastani/atomic/workflows");
	const agentDir = join(homedir(), ".adt-agent", "agent");
	if (flag("journal") === "local") return resolveRunJournal({ agentDir, journal: { path: flag("path") } });
	return resolveRunJournal({
		agentDir,
		journal: {
			adapter: join(flag("ref-dir"), "packages", "storage-libsql", "libsql.js"),
			options: { url: flag("url"), namespace: flag("namespace") },
			secrets: { authToken: { file: flag("token-file") } },
		},
	});
}

/** @param {string} runId @param {number} index */
function digestOf(runId, index) {
	return createHash("sha256").update(`${runId}:${index}`).digest("hex");
}

/** @param {string | undefined} key */
function indexOfKey(key) {
	const match = /^cp-(\d+)$/.exec(key ?? "");
	return match === null ? undefined : Number(match[1]);
}

async function facts() {
	const tools = [
		"git",
		"tc",
		"iptables",
		"dmsetup",
		"losetup",
		"mkfs.ext4",
		"e2fsck",
		"chronyc",
		"systemd-run",
		"fallocate",
	];
	print({
		hostname: hostname(),
		node: process.version,
		kernel: release(),
		memoryBytes: totalmem(),
		cpus: cpus().length,
		tools: Object.fromEntries(tools.map((tool) => [tool, has(tool)])),
		modules: Object.fromEntries(
			["sch_netem", "sch_tbf", "dm_delay", "dm_flakey", "loop"].map((module) => [module, kernelModule(module)]),
		),
		cgroup2: spawnSync("stat", ["-fc", "%T", "/sys/fs/cgroup"], { encoding: "utf8" }).stdout.trim() === "cgroup2fs",
		bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
		clockMs: Date.now(),
	});
}

async function capabilities() {
	const workflows = await importFromRef("@bastani/atomic/workflows");
	const atomic = await importFromRef("@bastani/atomic");
	/** @type {Record<string, string[]>} */
	const members = {};
	for (const name of ["AgentSessionRuntime", "AgentSession"]) {
		const value = atomic[name];
		if (typeof value === "function")
			members[`atomic.${name}`] = [
				...new Set([...Object.getOwnPropertyNames(value), ...Object.getOwnPropertyNames(value.prototype ?? {})]),
			].sort();
	}
	print({
		workflows: Object.keys(workflows).sort(),
		atomic: Object.keys(atomic).sort(),
		members,
		artifact: JSON.parse(readFileSync(join(flag("ref-dir"), ".atomic-distributed-artifact.json"), "utf8")),
	});
}

/**
 * One HTTP(S) request; resolves with the status or the transport error's code, never throwing.
 * @param {{ url: string, ca?: Buffer, token?: string, namespace?: string, timeoutMs?: number }} input
 * @returns {Promise<{ status?: number, error?: string }>}
 */
function probe({ url, ca, token, namespace, timeoutMs = 8000 }) {
	const target = new URL(url);
	const body = JSON.stringify({ requests: [{ type: "execute", stmt: { sql: "SELECT 1" } }, { type: "close" }] });
	/** @type {Record<string, string>} */
	const headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) };
	if (token !== undefined) headers.authorization = `Bearer ${token}`;
	if (namespace !== undefined) headers["x-namespace"] = namespace;
	return new Promise((resolve) => {
		const options = { method: "POST", headers, timeout: timeoutMs, ...(ca === undefined ? {} : { ca }) };
		const request = (target.protocol === "https:" ? https : http).request(target, options, (response) => {
			response.resume();
			response.on("end", () => resolve({ status: response.statusCode }));
		});
		request.on("timeout", () => request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
		request.on("error", (error) => resolve({ error: String(Reflect.get(error, "code") ?? error.name) }));
		request.end(body);
	});
}

async function security() {
	const url = new URL("/v2/pipeline", flag("url")).href;
	const host = new URL(flag("url")).hostname;
	const ca = readFileSync(flag("ca"));
	const decoy = readFileSync(flag("decoy-ca"));
	const token = readFileSync(flag("token-file"), "utf8").trim();
	const foreign = readFileSync(flag("foreign-token-file"), "utf8").trim();
	const namespace = flag("namespace");
	const tokenMode = (statSync(flag("token-file")).mode & 0o777).toString(8);
	const positive = await probe({ url, ca, token, namespace });
	const checks = [
		{ name: "authenticated-https-accepted", observed: positive, passed: positive.status === 200 },
		...(await Promise.all(
			[
				["tokenless-rejected", { url, ca, namespace }],
				["foreign-token-rejected", { url, ca, token: foreign, namespace }],
				["wrong-ca-rejected", { url, ca: decoy, token, namespace }],
				[
					"plaintext-gateway-rejected",
					{ url: `http://${host}:${new URL(flag("url")).port}/v2/pipeline`, token, namespace },
				],
				[
					"plaintext-backend-unreachable",
					{ url: `http://${host}:${flag("backend-port")}/v2/pipeline`, token, namespace, timeoutMs: 5000 },
				],
			].map(async ([name, input]) => {
				const observed = await probe(/** @type {Parameters<typeof probe>[0]} */ (input));
				const rejected =
					name === "tokenless-rejected" || name === "foreign-token-rejected"
						? observed.status === 401 || observed.status === 403
						: observed.status === undefined || observed.status >= 400;
				return { name: /** @type {string} */ (name), observed, passed: positive.status === 200 && rejected };
			}),
		)),
		{ name: "token-file-mode-600", observed: { mode: tokenMode }, passed: tokenMode === "600" },
	];
	print({ checks });
}

/**
 * @param {string} path
 * @param {unknown} record
 */
function appendDurably(path, record) {
	const fd = openSync(path, "a", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(record)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

async function writer() {
	const runId = flag("run");
	const holder = flag("holder");
	const acks = flag("acks");
	const count = Number(flag("count"));
	const intervalMs = Number(flags["interval-ms"] ?? 250);
	const maxErrorMs = Number(flags["max-error-ms"] ?? 240_000);
	const hogAfter = flags["hog-after"] === undefined ? undefined : Number(flags["hog-after"]);
	const hogMb = Number(flags["hog-mb"] ?? 0);
	let stopping = false;
	process.on("SIGTERM", () => {
		stopping = true;
	});
	const record = (/** @type {Record<string, unknown>} */ event) =>
		appendDurably(acks, { ...event, holder, at: Date.now() });
	/** @type {unknown[]} */
	const hog = [];
	let errorSince = 0;
	/** @template T @param {string} step @param {() => Promise<T>} action @returns {Promise<T>} */
	const persist = async (step, action) => {
		for (;;) {
			try {
				const value = await action();
				errorSince = 0;
				return value;
			} catch (error) {
				const described = describe(error);
				if (described.name === "StaleLeaseError") {
					record({ event: "fenced", step, error: described });
					process.exit(3);
				}
				if (stopping) {
					record({ event: "stopped-while-failing", step, error: described });
					process.exit(0);
				}
				errorSince ||= Date.now();
				record({ event: "error", step, error: described });
				if (Date.now() - errorSince > maxErrorMs) {
					record({ event: "gave-up", step });
					process.exit(6);
				}
				await sleep(500);
			}
		}
	};
	const journal = await persist("open", () => openJournal());
	await persist("create-run", () =>
		journal.createRun({
			runId,
			name: "atomic-distributed-test",
			cwd: "/adt",
			createdAt: Date.now(),
			status: "running",
		}),
	);
	/** @type {{ runId: string, holderId: string, epoch: number }} */
	let lease;
	const mode = flags.lease ?? "acquire";
	const staleMs = Number(flags["stale-ms"] ?? 10_000);
	const takeoverDeadline = Date.now() + Number(flags["takeover-timeout-ms"] ?? 180_000);
	for (let attempt = 1; ; attempt++) {
		const outcome = await persist("lease", () =>
			mode === "acquire" ? journal.acquire(runId, holder) : journal.takeoverExpired(runId, holder, staleMs),
		);
		if (outcome.status === "acquired") {
			lease = outcome.lease;
			record({ event: "lease", epoch: lease.epoch, attempts: attempt });
			break;
		}
		if (attempt === 1 || attempt % 10 === 0)
			record({ event: "lease-held", by: outcome.holderId, epoch: outcome.epoch, attempts: attempt });
		if (mode === "acquire" || Date.now() > takeoverDeadline || stopping) {
			record({ event: "lease-unavailable", by: outcome.holderId, epoch: outcome.epoch, attempts: attempt });
			await journal.close();
			process.exit(4);
		}
		await sleep(1000);
	}
	let next = 0;
	for await (const entry of journal.read(runId)) {
		const index = indexOfKey(entry.key);
		if (index !== undefined && index >= next) next = index + 1;
	}
	record({ event: "resume", next, epoch: lease.epoch });
	let written = 0;
	while (written < count && !stopping) {
		const index = next;
		const digest = digestOf(runId, index);
		const started = performance.now();
		const outcome = await persist("append", () =>
			journal.append(
				lease,
				{ type: "CheckpointRecorded", payload: { kind: "task", index, digest } },
				{ key: `cp-${String(index).padStart(6, "0")}` },
			),
		);
		const ms = Math.round(performance.now() - started);
		record({
			event: "ack",
			key: outcome.entry.key,
			index,
			seq: outcome.entry.seq,
			epoch: outcome.entry.epoch,
			status: outcome.status,
			digest,
			ms,
		});
		await persist("renew", () => journal.renew(lease));
		next++;
		written++;
		if (hogAfter !== undefined && written >= hogAfter) {
			for (;;) {
				const chunk = Buffer.alloc(16 * 1024 * 1024, 1);
				hog.push(chunk);
				record({ event: "hog", mb: hog.length * 16 });
				if (hog.length * 16 >= hogMb) break;
				await sleep(50);
			}
		}
		await sleep(intervalMs);
	}
	await persist("release", () => journal.release(lease));
	record({ event: "done", written, stopped: stopping });
	await journal.close();
}

async function read() {
	const journal = await openJournal();
	const entries = [];
	for await (const entry of journal.read(flag("run"))) {
		const payload = /** @type {{ index?: number, digest?: string }} */ (entry.event.payload ?? {});
		entries.push({
			seq: entry.seq,
			epoch: entry.epoch,
			key: entry.key ?? null,
			type: entry.event.type,
			index: payload.index ?? null,
			digest: payload.digest ?? null,
		});
	}
	const lease = await journal.leaseState(flag("run"));
	await journal.close();
	print({ entries, lease: lease === undefined ? null : { holderId: lease.holderId, epoch: lease.epoch } });
}

async function staleAppend() {
	const journal = await openJournal();
	const lease = { runId: flag("run"), holderId: flag("holder"), epoch: Number(flag("epoch")) };
	try {
		const outcome = await journal.append(
			lease,
			{ type: "CheckpointRecorded", payload: { kind: "task", stale: true } },
			{ key: flag("key") },
		);
		print({ outcome: "appended", status: outcome.status, seq: outcome.entry.seq, epoch: outcome.entry.epoch });
	} catch (error) {
		print({ outcome: "rejected", error: describe(error) });
	} finally {
		await journal.close();
	}
}

async function integrity() {
	if (flag("journal") === "local") {
		const database = new DatabaseSync(flag("path"), { readOnly: true });
		const rows = database.prepare("PRAGMA integrity_check").all();
		database.close();
		print({ result: rows.map((row) => Object.values(row)[0]) });
		return;
	}
	const require = createRequire(join(flag("ref-dir"), "package.json"));
	const adapter = await import(
		pathToFileURL(join(flag("ref-dir"), "packages", "storage-libsql", "libsql.js")).href
	).catch(async () => {
		const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
		return createJiti(import.meta.url).import(join(flag("ref-dir"), "packages", "storage-libsql", "libsql.js"));
	});
	const database = await adapter.openLibsqlDatabase({
		url: flag("url"),
		namespace: flag("namespace"),
		authToken: readFileSync(flag("token-file"), "utf8").trim(),
	});
	const rows = await database.all("PRAGMA integrity_check");
	await database.close();
	print({ result: rows.map((/** @type {Record<string, unknown>} */ row) => Object.values(row)[0]) });
}

/** @type {Record<string, () => Promise<void>>} */
const commands = { facts, capabilities, security, writer, read, "stale-append": staleAppend, integrity };
const handler = commands[command ?? ""];
if (handler === undefined) {
	process.stderr.write(`unknown agent command ${command}\n`);
	process.exit(2);
}
try {
	await handler();
} catch (error) {
	print({ fatal: describe(error) });
	process.exit(1);
}
