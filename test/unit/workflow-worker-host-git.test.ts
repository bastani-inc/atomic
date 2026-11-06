import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test, vi } from "vitest";
import type { ResolvedGit } from "../../packages/coding-agent/src/index.js";
import { GitUnavailableError, isGitUnavailableError } from "../../packages/coding-agent/src/utils/git-errors.js";
import {
	isSharedPoolSetupError,
	rehydrateWorkerPlacementError,
	type SharedPoolSetupError,
	serializeWorkerPlacementError,
} from "../../packages/workflows/src/workers/placement-errors.js";
import { startWorkflowWorkerHost } from "../../packages/workflows/src/workers/worker-host.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";

const git = vi.hoisted(() => ({
	resolutions: 0,
	lookups: 0,
	resolve: async (): Promise<ResolvedGit> => {
		throw new Error("unset");
	},
	present: (): ResolvedGit => ({ source: "system", version: "2.45.0", path: "/usr/bin/git", env: {} }),
}));

vi.mock("@bastani/atomic", async (importOriginal) => ({
	...(await importOriginal<typeof import("@bastani/atomic")>()),
	resolveGit: async () => {
		git.resolutions++;
		return git.resolve();
	},
	resolveGitSync: () => {
		git.lookups++;
		return git.present();
	},
}));

const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const countingAdapter = fileURLToPath(new URL("../fixtures/counting-storage-adapter.mjs", import.meta.url));
const NOT_INSTALLED = new GitUnavailableError({
	code: "not-installed",
	installDir: "/home/user/.atomic/bin/git",
	platform: "linux",
	arch: "x64",
	installCommand: "sudo apt-get install -y git",
});

afterEach(() => {
	git.resolutions = 0;
	git.resolve = async () => {
		throw new Error("unset");
	};
	git.lookups = 0;
	git.present = () => ({ source: "system", version: "2.45.0", path: "/usr/bin/git", env: {} });
});

/** A host's git source and whether it restores: given a restore function, by default, or with `restore: false`. */
async function hostStats(directory: string, restore: "given" | "default" | false, gitPath?: string) {
	const host = await startWorkflowWorkerHost({
		journal: {
			adapter: libsql,
			options: { url: pathToFileURL(join(directory, "shared.db")).href },
			prefix: "acme_",
		},
		agentDir: join(directory, "agent"),
		maxWorkers: 1,
		hostId: "host-g",
		...(restore === "given" ? { restore: async () => directory } : restore === false ? { restore: false } : {}),
		...(gitPath === undefined ? {} : { git: { path: gitPath, env: {} } }),
	});
	try {
		const stats = await host.stats();
		return [stats.git, stats.restore];
	} finally {
		await host.stop();
	}
}

test.skipIf(process.platform === "win32")(
	"a worker host that restores runs the git resolveGit() resolves, from the system or provisioned (#4310)",
	async () => {
		const directory = makeLibsqlDirectory();
		try {
			for (const source of ["system", "provisioned"] as const) {
				git.resolve = async () => ({ path: `/git/${source}`, env: {}, source, version: "2.45.0" });
				assert.deepEqual(await hostStats(directory, "given"), [source, true]);
			}
			assert.equal(git.resolutions, 2);
		} finally {
			await removeLibsqlDirectory(directory);
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a worker host without a restore function never downloads git: it restores by default only with the git this machine has (#4416)",
	async () => {
		const directory = makeLibsqlDirectory();
		try {
			assert.deepEqual(await hostStats(directory, "default"), ["system", true], "the snapshot restore by default");
			assert.deepEqual(await hostStats(directory, false), ["system", false], "none with restore: false");
			git.present = () => ({
				source: "provisioned",
				version: "2.45.0",
				path: "/home/user/.atomic/bin/git",
				env: { GIT_EXEC_PATH: "/home/user/.atomic/bin/git/libexec" },
			});
			assert.deepEqual(
				await hostStats(directory, "default"),
				["provisioned", true],
				"a git Atomic installed before",
			);
			git.present = () => {
				throw NOT_INSTALLED;
			};
			assert.deepEqual(await hostStats(directory, "default"), ["unavailable", false], "it starts without git");
			assert.deepEqual(await hostStats(directory, false), ["unavailable", false]);
			assert.equal(git.resolutions, 0, "resolveGit() was never asked, so nothing was downloaded");
			assert.equal(git.lookups, 5, "each host took the git this machine has, which never downloads");
		} finally {
			await removeLibsqlDirectory(directory);
		}
	},
);

test("a worker host that restores but gets no git fails setup typed, with resolveGit()'s error and hint (#4310)", async () => {
	const directory = makeLibsqlDirectory();
	const opens = join(directory, "opens.log");
	git.resolve = async () => {
		throw NOT_INSTALLED;
	};
	try {
		const outcome = await startWorkflowWorkerHost({
			journal: { adapter: countingAdapter, options: { log: opens } },
			agentDir: join(directory, "agent"),
			maxWorkers: 1,
			restore: async () => directory,
		}).then(
			() => undefined,
			(error: Error) => error,
		);
		assert.ok(isSharedPoolSetupError(outcome), String(outcome));
		const error = outcome as SharedPoolSetupError;
		const [problem] = error.problems;
		assert.deepEqual(
			[error.code, error.operation, problem?.code, problem?.fields],
			["git-unavailable", "worker-host", "git-unavailable", { reason: "not-installed", platform: process.platform }],
		);
		assert.equal(problem?.hint, NOT_INSTALLED.hint, "the install hint is resolveGit()'s own");
		assert.ok(isGitUnavailableError(error.cause), "and its error is the cause");
		assert.ok(
			error.message.startsWith(
				"Shared worker pool setup incomplete for startWorkflowWorkerHost: missing git, which a restore port needs and which Atomic could not provide (not-installed) (git-unavailable)",
			),
			error.message,
		);
		const crossed = rehydrateWorkerPlacementError(JSON.parse(JSON.stringify(serializeWorkerPlacementError(error))));
		assert.ok(isSharedPoolSetupError(crossed));
		assert.deepEqual(crossed.problems, error.problems);
		assert.equal(existsSync(opens) ? readFileSync(opens, "utf8") : "", "", "the journal was never opened");
	} finally {
		await removeLibsqlDirectory(directory);
	}
});

test.skipIf(process.platform === "win32")(
	"a worker host that names its own git runs that one, probed, and resolves none (#4310)",
	async () => {
		const directory = makeLibsqlDirectory();
		try {
			assert.deepEqual(await hostStats(directory, "given", "git"), ["system", true]);
			assert.deepEqual(await hostStats(directory, "default", "git"), ["system", true]);
			assert.deepEqual(await hostStats(directory, "default", join(directory, "no-such-git")), [
				"unavailable",
				false,
			]);
			assert.equal(git.resolutions, 0);
		} finally {
			await removeLibsqlDirectory(directory);
		}
	},
);

test("a resolveGit() failure that is not about git is not reported as missing git (#4310)", async () => {
	const directory = makeLibsqlDirectory();
	const broken = new Error("resolver bug");
	git.resolve = async () => {
		throw broken;
	};
	try {
		await assert.rejects(
			startWorkflowWorkerHost({
				journal: { adapter: countingAdapter, options: { log: join(directory, "opens.log") } },
				agentDir: join(directory, "agent"),
				maxWorkers: 1,
				restore: async () => directory,
			}),
			(error: Error) => error === broken,
		);
	} finally {
		await removeLibsqlDirectory(directory);
	}
});

test("a failure to look up this machine's git that is not about git is not reported as missing git (#4416)", async () => {
	const directory = makeLibsqlDirectory();
	const broken = new Error("lookup bug");
	git.present = () => {
		throw broken;
	};
	try {
		await assert.rejects(
			startWorkflowWorkerHost({
				journal: { adapter: countingAdapter, options: { log: join(directory, "opens.log") } },
				agentDir: join(directory, "agent"),
				maxWorkers: 1,
			}),
			(error: Error) => error === broken,
		);
		assert.equal(git.resolutions, 0);
	} finally {
		await removeLibsqlDirectory(directory);
	}
});

test.skipIf(process.platform === "win32")(
	"a host without a restore function and without git reports no git problem with its other setup problems (#4416)",
	async () => {
		const directory = makeLibsqlDirectory();
		git.present = () => {
			throw NOT_INSTALLED;
		};
		try {
			const outcome = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(directory, "shared.db")).href },
					secrets: { authToken: { env: "ATOMIC_TEST_WORKER_HOST_TOKEN_NOT_SET" } },
				},
				agentDir: join(directory, "agent"),
				maxWorkers: 1,
			}).then(
				() => undefined,
				(error: Error) => error,
			);
			assert.ok(isSharedPoolSetupError(outcome), String(outcome));
			assert.deepEqual(
				outcome.problems.map((problem) => problem.code),
				["journal-secret-unavailable"],
			);
			assert.equal(outcome.cause, undefined, "a git it does not need is no cause of its refusal");
			assert.equal(git.resolutions, 0);
		} finally {
			await removeLibsqlDirectory(directory);
		}
	},
);
