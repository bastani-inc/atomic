import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
	embeddedPostgresTestHooks,
	shutdownEmbeddedDbosPostgres,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import type { EmbeddedPostgresRunContext } from "../../packages/workflows/src/durable/dbos-embedded-postgres-root.js";

afterEach(() => {
	embeddedPostgresTestHooks.setProcessIdentityReader(undefined);
	embeddedPostgresTestHooks.setActiveCluster(undefined);
});

test("pg_ctl start opts into direct-exit command completion", async () => {
	const calls: { readonly command: string; readonly completion?: "successful-exit" }[] = [];
	const context: EmbeddedPostgresRunContext = {
		baseDir: "/unused",
		runAsOwner: async (command, _args, options) => {
			calls.push({ command, completion: options?.completion });
			return { exitCode: 0, stdout: "server started", stderr: "" };
		},
	};

	await embeddedPostgresTestHooks.startCluster("pg_ctl", "/data", "/postgres.log", context);

	assert.deepEqual(calls, [{ command: "pg_ctl", completion: "successful-exit" }]);
});

test("a reachable instance after failed pg_ctl start is attached but not owned", async () => {
	const context: EmbeddedPostgresRunContext = {
		baseDir: "/unused",
		runAsOwner: async (_command, _args, options) => {
			assert.equal(options?.completion, "successful-exit");
			return { exitCode: 1, stdout: "", stderr: "already starting" };
		},
	};

	const startedHere = await embeddedPostgresTestHooks.startCluster(
		"pg_ctl",
		"/data",
		"/postgres.log",
		context,
		async () => true,
	);

	assert.equal(startedHere, false);
});

test("embedded shutdown ownership requires the captured PID and process identity", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "atomic-postmaster-owner-"));
	try {
		embeddedPostgresTestHooks.setProcessIdentityReader(async () => "owned-instance");
		writeFileSync(join(dataDir, "postmaster.pid"), `${process.pid}\n5439\n`);
		assert.equal(await embeddedPostgresTestHooks.clusterStillRunning(dataDir, process.pid, "owned-instance"), true);

		writeFileSync(join(dataDir, "postmaster.pid"), `${process.pid + 1}\n5439\n`);
		assert.equal(
			await embeddedPostgresTestHooks.clusterStillRunning(dataDir, process.pid, "owned-instance"),
			false,
			"a different postmaster in the same data directory is not owned",
		);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("the host process has a stable process-instance identity", async () => {
	const first = await embeddedPostgresTestHooks.readProcessIdentity(process.pid);
	const second = await embeddedPostgresTestHooks.readProcessIdentity(process.pid);

	assert.ok(first, `expected ${process.platform} to expose a process start identity`);
	assert.equal(second, first);
});

test("embedded teardown does not stop a missing or replacement postmaster", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "atomic-postmaster-replaced-"));
	let stopCalls = 0;
	const context: EmbeddedPostgresRunContext = {
		baseDir: dataDir,
		runAsOwner: async () => {
			stopCalls += 1;
			return { exitCode: 0, stdout: "", stderr: "" };
		},
	};
	try {
		embeddedPostgresTestHooks.setProcessIdentityReader(async () => "owned-instance");
		for (const replacementPid of [undefined, process.pid + 1]) {
			if (replacementPid === undefined) rmSync(join(dataDir, "postmaster.pid"), { force: true });
			else writeFileSync(join(dataDir, "postmaster.pid"), `${replacementPid}\n5439\n`);
			embeddedPostgresTestHooks.setActiveCluster("pg_ctl", dataDir, context, process.pid, "owned-instance");

			await shutdownEmbeddedDbosPostgres();
		}

		assert.equal(stopCalls, 0, "a missing or replacement postmaster must not receive pg_ctl stop");
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("embedded teardown fails safe when process identity is unavailable", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "atomic-postmaster-missing-identity-"));
	let stopCalls = 0;
	const context: EmbeddedPostgresRunContext = {
		baseDir: dataDir,
		runAsOwner: async () => {
			stopCalls += 1;
			return { exitCode: 0, stdout: "", stderr: "" };
		},
	};
	try {
		writeFileSync(join(dataDir, "postmaster.pid"), `${process.pid}\n5439\n`);
		embeddedPostgresTestHooks.setProcessIdentityReader(async () => undefined);
		embeddedPostgresTestHooks.setActiveCluster("pg_ctl", dataDir, context, process.pid, "owned-instance");

		await shutdownEmbeddedDbosPostgres();

		assert.equal(stopCalls, 0);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("embedded teardown does not stop a reused PID with a changed process identity", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "atomic-postmaster-reused-pid-"));
	let stopCalls = 0;
	const context: EmbeddedPostgresRunContext = {
		baseDir: dataDir,
		runAsOwner: async () => {
			stopCalls += 1;
			return { exitCode: 0, stdout: "", stderr: "" };
		},
	};
	try {
		writeFileSync(join(dataDir, "postmaster.pid"), `${process.pid}\n5439\n`);
		embeddedPostgresTestHooks.setProcessIdentityReader(async () => "replacement-instance");
		embeddedPostgresTestHooks.setActiveCluster("pg_ctl", dataDir, context, process.pid, "owned-instance");

		await shutdownEmbeddedDbosPostgres();

		assert.equal(stopCalls, 0, "a reused numeric PID must not receive pg_ctl stop");
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("embedded teardown stops the captured process instance and waits until it exits", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "atomic-postmaster-stop-"));
	let stopCalls = 0;
	let identityReads = 0;
	const context: EmbeddedPostgresRunContext = {
		baseDir: dataDir,
		runAsOwner: async (command, args) => {
			stopCalls += 1;
			assert.equal(command, "pg_ctl");
			assert.deepEqual(args.slice(0, 3), ["-D", dataDir, "-m"]);
			return { exitCode: 0, stdout: "server stopped", stderr: "" };
		},
	};
	try {
		writeFileSync(join(dataDir, "postmaster.pid"), `${process.pid}\n5439\n`);
		embeddedPostgresTestHooks.setProcessIdentityReader(async () => {
			identityReads += 1;
			return identityReads < 3 ? "owned-instance" : undefined;
		});
		embeddedPostgresTestHooks.setActiveCluster("pg_ctl", dataDir, context, process.pid, "owned-instance");

		await Promise.all([shutdownEmbeddedDbosPostgres(), shutdownEmbeddedDbosPostgres()]);

		assert.equal(stopCalls, 1);
		assert.equal(identityReads, 3, "shutdown must revalidate identity while waiting for exit");
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});
