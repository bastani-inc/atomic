import assert from "node:assert/strict";
import { chmod, copyFile, cp, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import pg from "pg";
import { test } from "vitest";
import { loadEmbeddedPostgresBinaries } from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";
import { readText, sleep } from "../helpers/runtime.js";

const REAL_SHARED_RUNTIME_REPAIR_TIMEOUT_MS = 180_000;
const SHARED_RUNTIME_REPAIR_WAIT_MS = 45_000;
const HEALTHY_MONITORING_OBSERVATION_MS = 6_000;
type WorkflowResult = Pick<ManagedResult, "metadata"> & { runId: string; completedCalls: number };

test(
	"shared DBOS consumers replace damaged same-version runtimes and retain checkpoints across repeated repairs",
	async () => {
		const home = new RealPostgresHome(true);
		const listener = await reserveListener();
		const base = join(home.path, ".atomic", "postgres");
		const data = join(base, "v18");
		const generations = home.runtimeCache;
		const first = home.client(
			listener.port,
			{ ATOMIC_WORKFLOW_ARTIFACT_DIR: join(home.path, "first-artifacts") },
			"managed-dbos-fault-client.ts",
		);
		const second = home.client(
			listener.port,
			{ ATOMIC_WORKFLOW_ARTIFACT_DIR: join(home.path, "second-artifacts") },
			"managed-dbos-fault-client.ts",
		);
		const damageCurrentRuntime = async () => {
			const launch = await readText(join(data, "postmaster.opts"));
			const executable = /^(.*[\\/]postgres(?:\.exe)?) "-D" /.exec(launch)?.[1];
			assert.ok(executable, "fixture must identify the currently running executable");
			const runtime = await realpath(dirname(dirname(executable)));
			assert.ok(runtime.startsWith(`${await realpath(generations)}${sep}`));
			const timezoneDirectory = join(
				runtime,
				"share",
				...(executable.endsWith(".exe") ? [] : ["postgresql"]),
				"timezonesets",
			);
			const timezoneFile = join(timezoneDirectory, "Default");
			await chmod(timezoneDirectory, 0o700);
			await chmod(timezoneFile, 0o600);
			await unlink(timezoneFile);
			return runtime;
		};
		const waitForReplacement = async (previous: WorkflowResult["metadata"]) => {
			const deadline = Date.now() + SHARED_RUNTIME_REPAIR_WAIT_MS;
			for (;;) {
				const current = await first.request<Pick<WorkflowResult, "metadata">>("metadata");
				if (current.metadata.server.pid !== previous.server.pid) {
					assert.equal(current.metadata.clusterId, previous.clusterId);
					assert.equal(current.metadata.directoryIdentity, previous.directoryIdentity);
					assert.equal(current.metadata.server.systemIdentifier, previous.server.systemIdentifier);
					return current.metadata;
				}
				assert.ok(
					Date.now() < deadline,
					"automatic monitoring must adopt a healthy runtime without manual recovery",
				);
				await sleep(100);
			}
		};
		try {
			await home.prewarmRuntime(await loadEmbeddedPostgresBinaries({ readOnly: true }));
			const a = await first.request<WorkflowResult>("warm");
			const b = await second.request<WorkflowResult>("warm");
			assert.deepEqual(a.metadata, b.metadata);
			const damagedOriginal = await damageCurrentRuntime();
			const repaired = await waitForReplacement(a.metadata);
			const damagedReplacement = await damageCurrentRuntime();
			assert.notEqual(damagedReplacement, damagedOriginal);
			const repairedAgain = await waitForReplacement(repaired);
			const entries = (await readdir(generations)).sort();
			const newcomer = home.client(listener.port);
			const attached = await newcomer.request<ManagedResult>("ensure");
			assert.deepEqual(attached.metadata, repairedAgain);
			assert.deepEqual(
				(await readdir(generations)).sort(),
				entries,
				"a fresh consumer must reuse the healthy repair",
			);
			const [resumedA, resumedB] = await Promise.all([
				first.request<WorkflowResult>("resume"),
				second.request<WorkflowResult>("resume"),
			]);
			assert.equal(resumedA.runId, a.runId);
			assert.equal(resumedB.runId, b.runId);
			assert.equal(resumedA.completedCalls, 1);
			assert.equal(resumedB.completedCalls, 1);
			assert.deepEqual(resumedA.metadata, resumedB.metadata);
			assert.equal(resumedA.metadata.server.pid, repairedAgain.server.pid);
			await first.request("inspect-peer", b.runId);
			await second.request("inspect-peer", a.runId);
			const connection = new pg.Client({
				host: "127.0.0.1",
				port: repairedAgain.server.port,
				user: "postgres",
				password: "atomic",
				database: "postgres",
				connectionTimeoutMillis: 2000,
				query_timeout: 2000,
			});
			try {
				await connection.connect();
				await connection.query("SELECT set_config('timezone_abbreviations', 'Default', true)");
			} finally {
				await connection.end();
			}
			await sleep(HEALTHY_MONITORING_OBSERVATION_MS);
			assert.deepEqual(
				(await readdir(generations)).sort(),
				entries,
				"healthy monitoring must reuse the replacement",
			);
			assert.equal(
				(await first.request<Pick<WorkflowResult, "metadata">>("metadata")).metadata.server.pid,
				repairedAgain.server.pid,
			);
		} finally {
			try {
				await home.cleanup();
			} finally {
				await listener.close();
			}
		}
	},
	REAL_SHARED_RUNTIME_REPAIR_TIMEOUT_MS,
);

test(
	"a healthy running server keeps its marker-less legacy generation without a restart",
	async () => {
		const home = new RealPostgresHome(true);
		const listener = await reserveListener();
		const base = join(home.path, ".atomic", "postgres");
		try {
			await home.prewarmRuntime(await loadEmbeddedPostgresBinaries({ readOnly: true }));
			const client = home.client(listener.port);
			const initial = await client.request<ManagedResult>("ensure");
			const launch = await readText(join(base, "v18", "postmaster.opts"));
			const executable = /^(.*[\\/]postgres(?:\.exe)?) "-D" /.exec(launch)?.[1];
			assert.ok(executable);
			const runtime = await realpath(dirname(dirname(executable)));
			const marker = join(runtime, ".atomic-runtime-complete.json");
			await chmod(marker, 0o600);
			await unlink(marker);
			const generations = home.runtimeCache;
			const entries = (await readdir(generations)).sort();
			const attached = await home.client(listener.port).request<ManagedResult>("ensure");
			assert.equal(attached.metadata.server.pid, initial.metadata.server.pid);
			await sleep(HEALTHY_MONITORING_OBSERVATION_MS);
			assert.equal((await client.request<ManagedResult>("ensure")).metadata.server.pid, initial.metadata.server.pid);
			assert.deepEqual((await readdir(generations)).sort(), entries);
		} finally {
			try {
				await home.cleanup();
			} finally {
				await listener.close();
			}
		}
	},
	REAL_SHARED_RUNTIME_REPAIR_TIMEOUT_MS,
);

test(
	"a running client recovers after its unavailable replacement installation is repaired",
	async () => {
		const home = new RealPostgresHome(true);
		const listener = await reserveListener();
		const base = join(home.path, ".atomic", "postgres");
		const source = join(home.path, "installation", "native");
		try {
			const installed = await loadEmbeddedPostgresBinaries({ readOnly: true });
			const installedRoot = dirname(dirname(installed.postgres));
			await cp(installedRoot, source, { recursive: true, verbatimSymlinks: true });
			await home.prewarmRuntime({
				pg_ctl: join(source, "bin", basename(installed.pg_ctl)),
				initdb: join(source, "bin", basename(installed.initdb)),
				postgres: join(source, "bin", basename(installed.postgres)),
			});
			const client = home.client(
				listener.port,
				{
					ATOMIC_POSTGRES_RUNTIME_DIR: source,
					ATOMIC_WORKFLOW_ARTIFACT_DIR: join(home.path, "artifacts"),
				},
				"managed-dbos-fault-client.ts",
			);
			const original = await client.request<WorkflowResult>("warm");
			const launch = await readText(join(base, "v18", "postmaster.opts"));
			const executable = /^(.*[\\/]postgres(?:\.exe)?) "-D" /.exec(launch)?.[1];
			assert.ok(executable);
			const runtime = await realpath(dirname(dirname(executable)));
			assert.ok(runtime.startsWith(`${await realpath(home.runtimeCache)}${sep}`));
			const relativeTimezone = join(
				"share",
				...(executable.endsWith(".exe") ? [] : ["postgresql"]),
				"timezonesets",
				"Default",
			);
			await unlink(join(source, relativeTimezone));
			await chmod(dirname(join(runtime, relativeTimezone)), 0o700);
			await chmod(join(runtime, relativeTimezone), 0o600);
			await unlink(join(runtime, relativeTimezone));
			const coldClient = home.client(
				listener.port,
				{
					ATOMIC_POSTGRES_RUNTIME_DIR: source,
					ATOMIC_WORKFLOW_ARTIFACT_DIR: join(home.path, "artifacts"),
				},
				"managed-dbos-fault-client.ts",
			);
			assert.equal(
				(await coldClient.request<Pick<WorkflowResult, "metadata">>("metadata")).metadata.server.pid,
				original.metadata.server.pid,
				"an incomplete replacement must not stop the owned server",
			);
			await copyFile(join(installedRoot, relativeTimezone), join(source, relativeTimezone));
			const attached = await coldClient.request<Pick<WorkflowResult, "metadata">>("attach");
			assert.notEqual(attached.metadata.server.pid, original.metadata.server.pid);
			const resumed = await client.request<WorkflowResult>("resume");
			assert.equal(resumed.runId, original.runId);
			assert.equal(resumed.completedCalls, 1);
			assert.equal(resumed.metadata.clusterId, original.metadata.clusterId);
			assert.equal(resumed.metadata.directoryIdentity, original.metadata.directoryIdentity);
			assert.equal(resumed.metadata.server.systemIdentifier, original.metadata.server.systemIdentifier);
		} finally {
			try {
				await home.cleanup();
			} finally {
				await listener.close();
			}
		}
	},
	REAL_SHARED_RUNTIME_REPAIR_TIMEOUT_MS,
);
