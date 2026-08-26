import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, test } from "vitest";
import {
	defaultEmbeddedBaseDir,
	type EmbeddedPostgresRunContext,
	type LocalCommandRunner,
	prepareBinariesForOwner,
	ROOT_EMBEDDED_BASE_DIR,
	resolveEmbeddedRunContext,
	resolvePrivilegeDrop,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres-root.js";

interface FakeCall {
	readonly command: string;
	readonly args: readonly string[];
	readonly uid?: number;
	readonly gid?: number;
	readonly completion?: "successful-exit";
}

function fakeRunner(
	respond: (
		command: string,
		args: readonly string[],
		uid?: number,
		gid?: number,
	) => { exitCode: number; stdout?: string },
	calls: FakeCall[] = [],
): LocalCommandRunner {
	return async (command, args, options) => {
		calls.push({
			command,
			args,
			uid: options?.uid,
			...(options?.gid !== undefined ? { gid: options.gid } : {}),
			...(options?.completion !== undefined ? { completion: options.completion } : {}),
		});
		const result = respond(command, args, options?.uid, options?.gid);
		return { exitCode: result.exitCode, stdout: result.stdout ?? "", stderr: "" };
	};
}

const noCommands: LocalCommandRunner = async () => {
	throw new Error("no command expected");
};

function removeSealedScratch(path: string): void {
	const makeWritable = (entry: string): void => {
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(entry);
		} catch {
			return;
		}
		if (stat.isSymbolicLink()) return;
		if (stat.isDirectory()) {
			chmodSync(entry, 0o700);
			for (const child of readdirSync(entry)) makeWritable(join(entry, child));
		} else {
			chmodSync(entry, 0o600);
		}
	};
	makeWritable(path);
	rmSync(path, { recursive: true, force: true });
}

/** Answers account lookups and honors a complete spawn-uid/gid privilege drop like Node. */
function nodeLikeRunner(accounts: Record<string, number>, calls: FakeCall[] = []): LocalCommandRunner {
	return fakeRunner((command, args, uid, gid) => {
		if (command === "id" && args.length === 2 && args[1] !== undefined) {
			const id = accounts[args[1]];
			return id === undefined ? { exitCode: 1 } : { exitCode: 0, stdout: `${id}\n` };
		}
		if (command === "id" && args[0] === "-u") return { exitCode: 0, stdout: `${uid ?? 0}\n` };
		if (command === "id" && args[0] === "-g") return { exitCode: 0, stdout: `${gid ?? 0}\n` };
		if (command === "id" && args[0] === "-G") return { exitCode: 0, stdout: `${gid ?? 0} 1234\n` };
		return { exitCode: 1 };
	}, calls);
}

type IdentityFlag = "-u" | "-g" | "-G";

function identityFlag(command: string, args: readonly string[]): IdentityFlag | undefined {
	if (command === "id" && (args[0] === "-u" || args[0] === "-g" || args[0] === "-G")) return args[0];
	const idIndex = args.lastIndexOf("id");
	const wrappedFlag = args[idIndex + 1];
	if (idIndex >= 0 && (wrappedFlag === "-u" || wrappedFlag === "-g" || wrappedFlag === "-G")) return wrappedFlag;
	const shellProbe = args.find((arg) => arg.startsWith("'id' "));
	const shellMatch = shellProbe === undefined ? undefined : /^'id' '(-[ugG])'$/.exec(shellProbe);
	return shellMatch?.[1] as IdentityFlag | undefined;
}

function identityResult(
	flag: IdentityFlag | undefined,
	identity: { readonly uid: number; readonly gid: number; readonly groups: string },
): { exitCode: number; stdout?: string } {
	if (flag === "-u") return { exitCode: 0, stdout: `${identity.uid}\n` };
	if (flag === "-g") return { exitCode: 0, stdout: `${identity.gid}\n` };
	if (flag === "-G") return { exitCode: 0, stdout: identity.groups };
	return { exitCode: 1 };
}

describe("embedded Postgres root run context", () => {
	test("non-root keeps the home-directory base and pass-through runner", async () => {
		const context = await resolveEmbeddedRunContext(noCommands, 1000, "linux");
		assert.equal(context.baseDir, defaultEmbeddedBaseDir());
		assert.equal(context.owner, undefined);
		assert.equal(context.runAsOwner, noCommands);
	});

	test("non-Linux root keeps the default context", async () => {
		for (const platform of ["darwin", "win32"] as const) {
			const context = await resolveEmbeddedRunContext(noCommands, 0, platform);
			assert.equal(context.baseDir, defaultEmbeddedBaseDir());
			assert.equal(context.owner, undefined);
			assert.equal(context.runAsOwner, noCommands);
		}
	});

	test("Linux root resolves the first unprivileged candidate account", async () => {
		const context = await resolveEmbeddedRunContext(nodeLikeRunner({ postgres: 70 }), 0, "linux");
		assert.equal(context.baseDir, ROOT_EMBEDDED_BASE_DIR);
		assert.deepEqual(context.owner, { uid: 70, gid: 70, name: "postgres" });
	});

	test("Linux root falls back through candidates and rejects uid 0", async () => {
		const context = await resolveEmbeddedRunContext(nodeLikeRunner({ postgres: 0, nobody: 65534 }), 0, "linux");
		assert.deepEqual(context.owner, { uid: 65534, gid: 65534, name: "nobody" });
	});

	test("Linux root without any unprivileged account keeps the default context", async () => {
		const context = await resolveEmbeddedRunContext(
			fakeRunner(() => ({ exitCode: 1 })),
			0,
			"linux",
		);
		assert.equal(context.baseDir, defaultEmbeddedBaseDir());
		assert.equal(context.owner, undefined);
	});

	test("Linux root without any working privilege drop keeps the default context", async () => {
		// Accounts resolve, but every drop strategy still reports uid 0.
		const runner = fakeRunner((command, args) => {
			if (command === "id" && args.length === 2) return { exitCode: 0, stdout: "65534\n" };
			if (args.includes("-u") || args.includes("id -u") || args.some((a) => a.includes("id"))) {
				return { exitCode: 0, stdout: "0\n" };
			}
			return { exitCode: 0, stdout: "0\n" };
		});
		const context = await resolveEmbeddedRunContext(runner, 0, "linux");
		assert.equal(context.baseDir, defaultEmbeddedBaseDir());
		assert.equal(context.owner, undefined);
	});
});

describe("privilege drop strategy probing", () => {
	const owner = { uid: 65534, gid: 65534, name: "nobody" } as const;

	test("prefers the spawn uid/gid options when the runtime honors them", async () => {
		const calls: FakeCall[] = [];
		const drop = await resolvePrivilegeDrop(nodeLikeRunner({}, calls), owner);
		assert.ok(drop);
		const result = await drop("echo", ["hi"], { completion: "successful-exit" });
		assert.equal(result.exitCode, 1); // fake runner: non-id commands fail, but…
		const last = calls.at(-1)!;
		assert.equal(last.command, "echo"); // …the command ran directly with uid set
		assert.equal(last.uid, owner.uid);
		assert.equal(last.completion, "successful-exit");
		assert.equal(last.gid, owner.gid);
		assert.deepEqual(
			calls.slice(0, 3).map(({ command, args, uid, gid }) => ({ command, args, uid, gid })),
			[
				{ command: "id", args: ["-u"], uid: owner.uid, gid: owner.gid },
				{ command: "id", args: ["-g"], uid: owner.uid, gid: owner.gid },
				{ command: "id", args: ["-G"], uid: owner.uid, gid: owner.gid },
			],
		);
	});

	test("rejects a strategy whose uid is correct but primary gid remains root", async () => {
		const runner = fakeRunner((command, args, uid, gid) => {
			if (command !== "id") return { exitCode: 1 };
			if (args[0] === "-u") return { exitCode: 0, stdout: `${uid ?? 0}\n` };
			if (args[0] === "-g") return { exitCode: 0, stdout: `${gid === owner.gid ? 0 : (gid ?? 0)}\n` };
			if (args[0] === "-G") return { exitCode: 0, stdout: `${owner.gid} 0\n` };
			return { exitCode: 1 };
		});

		assert.equal(await resolvePrivilegeDrop(runner, owner), undefined);
	});

	test("rejects uid/gid-correct strategies that retain supplementary group 0", async () => {
		const runner = fakeRunner((command, args, uid, gid) => {
			if (command !== "id") return { exitCode: 1 };
			return identityResult(identityFlag(command, args), {
				uid: uid ?? 0,
				gid: gid ?? 0,
				groups: `${owner.gid} 1234 0\n`,
			});
		});

		assert.equal(await resolvePrivilegeDrop(runner, owner), undefined);
	});

	test("rejects a strategy whose supplementary groups omit the target primary gid", async () => {
		const runner = fakeRunner((command, args, uid, gid) => {
			if (command !== "id") return { exitCode: 1 };
			return identityResult(identityFlag(command, args), {
				uid: uid ?? 0,
				gid: gid ?? 0,
				groups: "1234 4321\n",
			});
		});

		assert.equal(await resolvePrivilegeDrop(runner, owner), undefined);
	});

	test("rejects malformed, empty, duplicate, and unsafe numeric group output", async () => {
		for (const groups of ["", "65534 root\n", "65534 65534\n", "65534\n1234\n", "9007199254740992\n"]) {
			const runner = fakeRunner((command, args) =>
				identityResult(identityFlag(command, args), { uid: owner.uid, gid: owner.gid, groups }),
			);
			assert.equal(await resolvePrivilegeDrop(runner, owner), undefined, JSON.stringify(groups));
		}
	});

	test("accepts legitimate additional nonroot groups regardless of order", async () => {
		const runner = fakeRunner((command, args) =>
			identityResult(identityFlag(command, args), {
				uid: owner.uid,
				gid: owner.gid,
				groups: `1234 ${owner.gid} 4321\n`,
			}),
		);
		assert.ok(await resolvePrivilegeDrop(runner, owner));
	});

	test("rejects truncated group output even when the retained suffix is valid", async () => {
		const runner: LocalCommandRunner = async (command, args) => {
			const result = identityResult(identityFlag(command, args), {
				uid: owner.uid,
				gid: owner.gid,
				groups: `${owner.gid} 1234\n`,
			});
			return {
				exitCode: result.exitCode,
				stdout: result.stdout ?? "",
				stderr: "",
				...(identityFlag(command, args) === "-G" ? { stdoutTruncated: true } : {}),
			};
		};

		assert.equal(await resolvePrivilegeDrop(runner, owner), undefined);
	});

	test("falls back to setpriv when spawn uid/gid options are silently ignored", async () => {
		const calls: FakeCall[] = [];
		const runner = fakeRunner((command, args) => {
			if (command === "id") {
				return identityResult(identityFlag(command, args), { uid: 0, gid: 0, groups: "0\n" });
			}
			if (command === "setpriv") {
				assert.deepEqual(args.slice(0, 3), ["--reuid=65534", "--regid=65534", "--clear-groups"]);
				return identityResult(identityFlag(command, args), {
					uid: owner.uid,
					gid: owner.gid,
					groups: `${owner.gid}\n`,
				});
			}
			return { exitCode: 1 };
		}, calls);

		const drop = await resolvePrivilegeDrop(runner, owner);
		assert.ok(drop);
		await drop("initdb", ["-D", "/data"], { completion: "successful-exit" });
		const last = calls.at(-1)!;
		assert.equal(last.command, "setpriv");
		assert.deepEqual(last.args.slice(-3), ["initdb", "-D", "/data"]);
		assert.equal(last.completion, "successful-exit");
	});

	test("accepts a fallback only after that candidate proves its full identity", async () => {
		const calls: FakeCall[] = [];
		const runner = fakeRunner((command, args) => {
			const groups = command === "runuser" ? `${owner.gid} 1234\n` : `${owner.gid} 0\n`;
			return identityResult(identityFlag(command, args), { uid: owner.uid, gid: owner.gid, groups });
		}, calls);

		const drop = await resolvePrivilegeDrop(runner, owner);
		assert.ok(drop);
		await drop("initdb", ["-D", "/data"]);
		assert.equal(calls.at(-1)?.command, "runuser");
		assert.ok(calls.some(({ command, args }) => command === "setpriv" && args.at(-1) === "-G"));
	});

	test("falls back through runuser to su and reports failure when nothing proves a drop", async () => {
		const suRunner = fakeRunner((command, args) =>
			identityResult(identityFlag(command, args), {
				uid: command === "su" ? owner.uid : 0,
				gid: command === "su" ? owner.gid : 0,
				groups: command === "su" ? `${owner.gid}\n` : "0\n",
			}),
		);
		assert.ok(await resolvePrivilegeDrop(suRunner, owner));

		const nothingWorks = fakeRunner((command, args) =>
			identityResult(identityFlag(command, args), { uid: owner.uid, gid: owner.gid, groups: `${owner.gid} 0\n` }),
		);
		assert.equal(await resolvePrivilegeDrop(nothingWorks, owner), undefined);
	});
});

describe("embedded Postgres binaries under a drop-privilege owner", () => {
	function contextWith(baseDir: string, runAsOwner: LocalCommandRunner): EmbeddedPostgresRunContext {
		return { baseDir, owner: { uid: 65534, gid: 65534, name: "nobody" }, runAsOwner };
	}

	test("no owner returns the loaded binaries untouched", async () => {
		const binaries = {
			pg_ctl: "/pkg/native/bin/pg_ctl",
			initdb: "/pkg/native/bin/initdb",
			postgres: "/pkg/native/bin/postgres",
		};
		const context: EmbeddedPostgresRunContext = { baseDir: "/anywhere", runAsOwner: noCommands };
		assert.equal(await prepareBinariesForOwner(binaries, context, noCommands), binaries);
	});

	test("owner-accessible binaries are used in place", async () => {
		const calls: FakeCall[] = [];
		const binaries = {
			pg_ctl: "/pkg/native/bin/pg_ctl",
			initdb: "/pkg/native/bin/initdb",
			postgres: "/pkg/native/bin/postgres",
		};
		const result = await prepareBinariesForOwner(
			binaries,
			contextWith(
				"/var/lib/atomic-postgres",
				fakeRunner(() => ({ exitCode: 0, stdout: "initdb 18.0" }), calls),
			),
			noCommands,
		);
		assert.equal(result, binaries);
		assert.deepEqual(calls, [{ command: "/pkg/native/bin/initdb", args: ["--version"], uid: undefined }]);
	});

	test("inaccessible binaries are copied and sealed under the privileged publisher", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-test-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			mkdirSync(join(packageNative, "lib"), { recursive: true });
			writeFileSync(join(packageNative, "bin", "initdb"), "#!/bin/sh\n", { mode: 0o755 });
			writeFileSync(join(packageNative, "bin", "pg_ctl"), "#!/bin/sh\n", { mode: 0o755 });
			writeFileSync(join(packageNative, "bin", "postgres"), "#!/bin/sh\n", { mode: 0o755 });
			writeFileSync(join(packageNative, "lib", "libpq.so.5.18"), "lib");
			symlinkSync("libpq.so.5.18", join(packageNative, "lib", "libpq.so.5"));
			const baseDir = join(scratch, "cluster");
			mkdirSync(baseDir, { recursive: true });

			const rootCalls: FakeCall[] = [];
			const result = await prepareBinariesForOwner(
				{
					pg_ctl: join(packageNative, "bin", "pg_ctl"),
					initdb: join(packageNative, "bin", "initdb"),
					postgres: join(packageNative, "bin", "postgres"),
				},
				contextWith(
					baseDir,
					fakeRunner(() => ({ exitCode: 126 })),
				), // probe: permission denied
				fakeRunner(() => ({ exitCode: 0 }), rootCalls),
			);

			const copiedGeneration = dirname(dirname(result.initdb));
			assert.ok(copiedGeneration.startsWith(join(baseDir, "pg-runtime", "native-")));
			assert.equal(result.pg_ctl, join(copiedGeneration, "bin", "pg_ctl"));
			assert.equal(result.postgres, join(copiedGeneration, "bin", "postgres"));
			assert.ok(existsSync(result.initdb));
			assert.equal(
				readlinkSync(join(copiedGeneration, "lib", "libpq.so.5")),
				"libpq.so.5.18",
				"the copied runtime keeps shared-library aliases relative and self-contained",
			);
			const chown = rootCalls.find((call) => call.command === "chown");
			assert.deepEqual(chown?.args.slice(0, 2), ["-R", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`]);
			assert.ok(chown?.args[2]?.startsWith(join(baseDir, "pg-runtime", ".native-staged-")));
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("publishes a sealed generation that the runtime owner cannot mutate at the publication seam", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-sealed-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(packageNative, "bin", binary), `source ${binary}\n`, { mode: 0o755 });
			}
			const baseDir = join(scratch, "cluster");
			let sealedAtPublicationBoundary = false;
			const result = await prepareBinariesForOwner(
				{
					pg_ctl: join(packageNative, "bin", "pg_ctl"),
					initdb: join(packageNative, "bin", "initdb"),
					postgres: join(packageNative, "bin", "postgres"),
				},
				contextWith(
					baseDir,
					fakeRunner(() => ({ exitCode: 126 })),
				),
				fakeRunner(() => ({ exitCode: 0 })),
				{
					beforePublish: (stagedRuntime) => {
						for (const entry of [
							stagedRuntime,
							join(stagedRuntime, "bin"),
							join(stagedRuntime, "bin", "postgres"),
						]) {
							const stat = statSync(entry);
							assert.notEqual(stat.uid, 65534, "the runtime uid does not own sealed publication content");
							assert.equal(
								stat.mode & 0o022,
								0,
								"the runtime uid cannot mutate through group/other permissions",
							);
						}
						sealedAtPublicationBoundary = true;
					},
				},
			);

			const generation = dirname(dirname(result.initdb));
			assert.equal(sealedAtPublicationBoundary, true);
			assert.equal(readFileSync(result.postgres, "utf8"), "source postgres\n");
			assert.notEqual(statSync(generation).uid, 65534);
			assert.equal(statSync(generation).mode & 0o022, 0, "published root is not runtime-owner-writable");
			assert.equal(statSync(result.postgres).mode & 0o222, 0, "published binaries are not writable");
			if (process.platform === "win32") {
				assert.equal(statSync(result.postgres).mode & 0o444, 0o444, "published Windows binaries remain readable");
			} else {
				assert.equal(statSync(result.postgres).mode & 0o555, 0o555, "published binaries remain executable");
			}
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("rejects a mutation injected after sealed validation and before publication", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-publication-mutation-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(packageNative, "bin", binary), `source ${binary}\n`, { mode: 0o755 });
			}
			const baseDir = join(scratch, "cluster");
			await assert.rejects(
				prepareBinariesForOwner(
					{
						pg_ctl: join(packageNative, "bin", "pg_ctl"),
						initdb: join(packageNative, "bin", "initdb"),
						postgres: join(packageNative, "bin", "postgres"),
					},
					contextWith(
						baseDir,
						fakeRunner(() => ({ exitCode: 126 })),
					),
					fakeRunner(() => ({ exitCode: 0 })),
					{
						beforePublish: (stagedRuntime) => {
							const postgres = join(stagedRuntime, "bin", "postgres");
							chmodSync(postgres, 0o755);
							writeFileSync(postgres, "publication seam mutation\n");
						},
					},
				),
				/changed after sealed validation/,
			);
			assert.equal(
				readdirSync(join(baseDir, "pg-runtime")).some((entry) => entry.startsWith("native-")),
				false,
				"mutated bytes never acquire a published generation path",
			);
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("publishes a new generation when the legacy selected runtime has an absolute alias", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-test-"));
		try {
			const packageNative = join(scratch, "owner-inaccessible", "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			mkdirSync(join(packageNative, "lib"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(packageNative, "bin", binary), `source ${binary}\n`, { mode: 0o755 });
			}
			writeFileSync(join(packageNative, "lib", "libpq.so.5.18"), "source library");
			symlinkSync("libpq.so.5.18", join(packageNative, "lib", "libpq.so.5"));

			const baseDir = join(scratch, "cluster");
			const copiedNative = join(baseDir, "pg-runtime", "native");
			mkdirSync(join(copiedNative, "bin"), { recursive: true });
			mkdirSync(join(copiedNative, "lib"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(copiedNative, "bin", binary), `old ${binary}\n`, { mode: 0o755 });
			}
			writeFileSync(join(copiedNative, "lib", "libpq.so.5.18"), "old library");
			const absoluteAlias = join(packageNative, "lib", "libpq.so.5.18");
			symlinkSync(absoluteAlias, join(copiedNative, "lib", "libpq.so.5"));
			let sawCompleteOldRuntimeDuringStagedHandoff = false;

			const result = await prepareBinariesForOwner(
				{
					pg_ctl: join(packageNative, "bin", "pg_ctl"),
					initdb: join(packageNative, "bin", "initdb"),
					postgres: join(packageNative, "bin", "postgres"),
				},
				contextWith(
					baseDir,
					fakeRunner(() => ({ exitCode: 126 })),
				),
				fakeRunner((command) => {
					if (command === "chown") {
						assert.equal(readFileSync(join(copiedNative, "bin", "postgres"), "utf8"), "old postgres\n");
						assert.equal(readlinkSync(join(copiedNative, "lib", "libpq.so.5")), absoluteAlias);
						sawCompleteOldRuntimeDuringStagedHandoff = true;
					}
					return { exitCode: 0 };
				}),
			);

			const repairedNative = dirname(dirname(result.initdb));
			assert.equal(
				readlinkSync(join(repairedNative, "lib", "libpq.so.5")),
				"libpq.so.5.18",
				"the repaired generation must not retain an absolute alias into the inaccessible package prefix",
			);
			assert.equal(sawCompleteOldRuntimeDuringStagedHandoff, true);
			const runtimeEntries = readdirSync(join(baseDir, "pg-runtime"));
			assert.equal(
				runtimeEntries.some((entry) => entry.startsWith(".native-staged-")),
				false,
			);
			assert.equal(
				runtimeEntries.some((entry) => entry.startsWith(".native-retired-")),
				false,
				"content generations replace repair-specific retired directories",
			);
			assert.equal(readFileSync(join(copiedNative, "bin", "postgres"), "utf8"), "old postgres\n");
			assert.equal(readlinkSync(join(copiedNative, "lib", "libpq.so.5")), absoluteAlias);
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("refreshes a partial copied runtime even when initdb already exists", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-test-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			mkdirSync(join(packageNative, "lib"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(packageNative, "bin", binary), `source ${binary}\n`, { mode: 0o755 });
			}
			writeFileSync(join(packageNative, "lib", "libpq.so.5.18"), "source library");
			symlinkSync("libpq.so.5.18", join(packageNative, "lib", "libpq.so.5"));

			const baseDir = join(scratch, "cluster");
			const copiedNative = join(baseDir, "pg-runtime", "native");
			mkdirSync(join(copiedNative, "bin"), { recursive: true });
			writeFileSync(join(copiedNative, "bin", "initdb"), "partial initdb\n", { mode: 0o755 });

			const result = await prepareBinariesForOwner(
				{
					pg_ctl: join(packageNative, "bin", "pg_ctl"),
					initdb: join(packageNative, "bin", "initdb"),
					postgres: join(packageNative, "bin", "postgres"),
				},
				contextWith(
					baseDir,
					fakeRunner(() => ({ exitCode: 126 })),
				),
				fakeRunner(() => ({ exitCode: 0 })),
			);

			assert.equal(readFileSync(result.initdb, "utf8"), "source initdb\n");
			assert.equal(readFileSync(result.pg_ctl, "utf8"), "source pg_ctl\n");
			assert.equal(readFileSync(result.postgres, "utf8"), "source postgres\n");
			const repairedNative = dirname(dirname(result.initdb));
			assert.equal(readFileSync(join(repairedNative, "lib", "libpq.so.5.18"), "utf8"), "source library");
			assert.equal(readlinkSync(join(repairedNative, "lib", "libpq.so.5")), "libpq.so.5.18");
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("does not reuse a complete copied runtime from a different package identity", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-test-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(packageNative, "bin", binary), `current ${binary}\n`, { mode: 0o755 });
			}

			const legacySelected = join(scratch, "cluster", "pg-runtime", "native");
			mkdirSync(join(legacySelected, "bin"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(legacySelected, "bin", binary), `stale ${binary}\n`, { mode: 0o755 });
			}

			const result = await prepareBinariesForOwner(
				{
					pg_ctl: join(packageNative, "bin", "pg_ctl"),
					initdb: join(packageNative, "bin", "initdb"),
					postgres: join(packageNative, "bin", "postgres"),
				},
				contextWith(
					join(scratch, "cluster"),
					fakeRunner(() => ({ exitCode: 126 })),
				),
				fakeRunner(() => ({ exitCode: 0 })),
			);

			assert.equal(readFileSync(result.initdb, "utf8"), "current initdb\n");
			assert.notEqual(join(result.initdb, "..", ".."), legacySelected);
			assert.equal(readFileSync(join(legacySelected, "bin", "initdb"), "utf8"), "stale initdb\n");
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("reuses the exact complete generation for one source and publishes a new generation for changed source", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-test-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(packageNative, "bin", binary), `source ${binary}\n`, { mode: 0o755 });
			}
			const binaries = {
				pg_ctl: join(packageNative, "bin", "pg_ctl"),
				initdb: join(packageNative, "bin", "initdb"),
				postgres: join(packageNative, "bin", "postgres"),
			};
			const context = contextWith(
				join(scratch, "cluster"),
				fakeRunner(() => ({ exitCode: 126 })),
			);
			const rootRunner = fakeRunner(() => ({ exitCode: 0 }));

			const first = await prepareBinariesForOwner(binaries, context, rootRunner);
			const reused = await prepareBinariesForOwner(binaries, context, rootRunner);
			assert.equal(dirname(dirname(reused.initdb)), dirname(dirname(first.initdb)));

			writeFileSync(binaries.postgres, "changed postgres\n", { mode: 0o755 });
			const changed = await prepareBinariesForOwner(binaries, context, rootRunner);
			assert.notEqual(dirname(dirname(changed.initdb)), dirname(dirname(first.initdb)));
			assert.equal(readFileSync(changed.postgres, "utf8"), "changed postgres\n");
			assert.equal(readFileSync(first.postgres, "utf8"), "source postgres\n");
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("rejects an existing generation when the source changes after its initial snapshot", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-reuse-source-race-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(packageNative, "bin", binary), `source ${binary}\n`, { mode: 0o755 });
			}
			const binaries = {
				pg_ctl: join(packageNative, "bin", "pg_ctl"),
				initdb: join(packageNative, "bin", "initdb"),
				postgres: join(packageNative, "bin", "postgres"),
			};
			const context = contextWith(
				join(scratch, "cluster"),
				fakeRunner(() => ({ exitCode: 126 })),
			);
			const rootRunner = fakeRunner(() => ({ exitCode: 0 }));
			const original = await prepareBinariesForOwner(binaries, context, rootRunner);

			await assert.rejects(
				prepareBinariesForOwner(binaries, context, rootRunner, {
					afterInitialSourceSnapshot: () => {
						writeFileSync(binaries.postgres, "changed during reuse\n", { mode: 0o755 });
					},
				}),
				/source package changed while selecting an existing generation/,
			);
			assert.equal(readFileSync(original.postgres, "utf8"), "source postgres\n");

			const current = await prepareBinariesForOwner(binaries, context, rootRunner);
			assert.equal(readFileSync(current.postgres, "utf8"), "changed during reuse\n");
			assert.notEqual(dirname(dirname(current.postgres)), dirname(dirname(original.postgres)));
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("rejects staged content when the source changes after copy and sealing", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-create-source-race-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(packageNative, "bin", binary), `source ${binary}\n`, { mode: 0o755 });
			}
			const binaries = {
				pg_ctl: join(packageNative, "bin", "pg_ctl"),
				initdb: join(packageNative, "bin", "initdb"),
				postgres: join(packageNative, "bin", "postgres"),
			};
			const baseDir = join(scratch, "cluster");
			const context = contextWith(
				baseDir,
				fakeRunner(() => ({ exitCode: 126 })),
			);
			const rootRunner = fakeRunner(() => ({ exitCode: 0 }));

			await assert.rejects(
				prepareBinariesForOwner(binaries, context, rootRunner, {
					beforePublish: () => {
						writeFileSync(binaries.postgres, "changed after staged seal\n", { mode: 0o755 });
					},
				}),
				/source package changed while preparing a generation/,
			);
			assert.equal(
				readdirSync(join(baseDir, "pg-runtime")).some((entry) => entry.startsWith("native-")),
				false,
				"stale staged bytes never receive a deterministic generation path",
			);

			const current = await prepareBinariesForOwner(binaries, context, rootRunner);
			assert.equal(readFileSync(current.postgres, "utf8"), "changed after staged seal\n");
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("post-rename validation catches root mutation and repeated calls fail closed", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-post-rename-mutation-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(packageNative, "bin", binary), `source ${binary}\n`, { mode: 0o755 });
			}
			const binaries = {
				pg_ctl: join(packageNative, "bin", "pg_ctl"),
				initdb: join(packageNative, "bin", "initdb"),
				postgres: join(packageNative, "bin", "postgres"),
			};
			const baseDir = join(scratch, "cluster");
			const context = contextWith(
				baseDir,
				fakeRunner(() => ({ exitCode: 126 })),
			);
			const rootRunner = fakeRunner(() => ({ exitCode: 0 }));

			await assert.rejects(
				prepareBinariesForOwner(binaries, context, rootRunner, {
					afterPublish: (publishedRuntime) => {
						const postgres = join(publishedRuntime, "bin", "postgres");
						chmodSync(postgres, 0o755);
						writeFileSync(postgres, "root mutation through rename\n");
					},
				}),
				/published runtime changed during publication/,
			);
			const runtimeDir = join(baseDir, "pg-runtime");
			const entriesAfterMutation = readdirSync(runtimeDir).sort();
			assert.equal(entriesAfterMutation.filter((entry) => entry.startsWith("native-")).length, 1);

			for (let attempt = 0; attempt < 2; attempt += 1) {
				await assert.rejects(
					prepareBinariesForOwner(binaries, context, rootRunner),
					/corrupt and cannot be replaced while it may be in use/,
				);
				assert.deepEqual(readdirSync(runtimeDir).sort(), entriesAfterMutation);
			}
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("post-publication source changes are rejected before selecting the generation", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-post-publish-source-race-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(packageNative, "bin", binary), `source ${binary}\n`, { mode: 0o755 });
			}
			const binaries = {
				pg_ctl: join(packageNative, "bin", "pg_ctl"),
				initdb: join(packageNative, "bin", "initdb"),
				postgres: join(packageNative, "bin", "postgres"),
			};
			const context = contextWith(
				join(scratch, "cluster"),
				fakeRunner(() => ({ exitCode: 126 })),
			);
			const rootRunner = fakeRunner(() => ({ exitCode: 0 }));

			await assert.rejects(
				prepareBinariesForOwner(binaries, context, rootRunner, {
					afterPublish: () => {
						writeFileSync(binaries.postgres, "changed after publication\n", { mode: 0o755 });
					},
				}),
				/source package changed during publication/,
			);

			const current = await prepareBinariesForOwner(binaries, context, rootRunner);
			assert.equal(readFileSync(current.postgres, "utf8"), "changed after publication\n");
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("lease loss after publication validation rejects without selecting the result", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-publication-lease-loss-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(packageNative, "bin", binary), `source ${binary}\n`, { mode: 0o755 });
			}
			const binaries = {
				pg_ctl: join(packageNative, "bin", "pg_ctl"),
				initdb: join(packageNative, "bin", "initdb"),
				postgres: join(packageNative, "bin", "postgres"),
			};
			const baseDir = join(scratch, "cluster");
			const context = contextWith(
				baseDir,
				fakeRunner(() => ({ exitCode: 126 })),
			);
			let ownsLease = true;

			await assert.rejects(
				prepareBinariesForOwner(
					binaries,
					context,
					fakeRunner(() => ({ exitCode: 0 })),
					{
						publicationLease: {
							ownerToken: "publication-owner",
							refresh: () => ownsLease,
						},
						afterPublishValidation: () => {
							ownsLease = false;
						},
					},
				),
				/lost its setup lease after publication/,
			);
			assert.equal(
				readdirSync(join(baseDir, "pg-runtime")).filter((entry) => entry.startsWith("native-")).length,
				1,
				"the sealed deterministic generation remains available to a current lease owner",
			);
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("corrupt deterministic generation fails closed without repeated repair growth", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-test-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			mkdirSync(join(packageNative, "lib"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(packageNative, "bin", binary), `source ${binary}\n`, { mode: 0o755 });
			}
			writeFileSync(join(packageNative, "lib", "libpq.so.5.18"), "source library");
			symlinkSync("libpq.so.5.18", join(packageNative, "lib", "libpq.so.5"));
			const binaries = {
				pg_ctl: join(packageNative, "bin", "pg_ctl"),
				initdb: join(packageNative, "bin", "initdb"),
				postgres: join(packageNative, "bin", "postgres"),
			};
			const baseDir = join(scratch, "cluster");
			const context = contextWith(
				baseDir,
				fakeRunner(() => ({ exitCode: 126 })),
			);
			const rootRunner = fakeRunner(() => ({ exitCode: 0 }));

			const first = await prepareBinariesForOwner(binaries, context, rootRunner);
			const generation = dirname(dirname(first.initdb));
			const alias = join(generation, "lib", "libpq.so.5");
			chmodSync(join(generation, "lib"), 0o755);
			rmSync(alias);
			symlinkSync("missing-library", alias);
			const entriesAfterCorruption = readdirSync(join(baseDir, "pg-runtime")).sort();

			for (let attempt = 0; attempt < 3; attempt += 1) {
				await assert.rejects(
					prepareBinariesForOwner(binaries, context, rootRunner),
					/corrupt and cannot be replaced while it may be in use/,
				);
				assert.deepEqual(
					readdirSync(join(baseDir, "pg-runtime")).sort(),
					entriesAfterCorruption,
					"corruption never appends another generation or repair slot",
				);
			}
			assert.equal(readlinkSync(alias), "missing-library", "potentially executing corrupt evidence is retained");
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("generation selection work is bounded independently of legacy candidate count", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-scan-bound-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(packageNative, "bin", binary), `source ${binary}\n`, { mode: 0o755 });
			}
			const binaries = {
				pg_ctl: join(packageNative, "bin", "pg_ctl"),
				initdb: join(packageNative, "bin", "initdb"),
				postgres: join(packageNative, "bin", "postgres"),
			};
			const baseDir = join(scratch, "cluster");
			const context = contextWith(
				baseDir,
				fakeRunner(() => ({ exitCode: 126 })),
			);
			const rootRunner = fakeRunner(() => ({ exitCode: 0 }));
			const first = await prepareBinariesForOwner(binaries, context, rootRunner);
			const deterministicGeneration = dirname(dirname(first.initdb));
			const generationName = basename(deterministicGeneration);
			removeSealedScratch(deterministicGeneration);
			const runtimeDir = join(baseDir, "pg-runtime");
			for (let index = 0; index < 256; index += 1) {
				const legacy = join(runtimeDir, `${generationName}-legacy-${index}`);
				mkdirSync(legacy);
				writeFileSync(join(legacy, "evidence"), String(index));
			}

			let yields = 0;
			const selected = await prepareBinariesForOwner(binaries, context, rootRunner, {
				yieldToEventLoop: async () => {
					yields += 1;
				},
			});
			assert.equal(dirname(dirname(selected.initdb)), deterministicGeneration);
			assert.ok(yields < 4, `selection traversed unexpected legacy candidates (${yields} yields)`);
			assert.equal(
				readdirSync(runtimeDir).filter((entry) => entry.startsWith(`${generationName}-legacy-`)).length,
				256,
				"pre-existing unique generations remain finite migration evidence rather than current candidates",
			);
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("recovers without replacing legacy selected file and symlink forms", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-test-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			for (const binary of ["initdb", "pg_ctl", "postgres"]) {
				writeFileSync(join(packageNative, "bin", binary), `source ${binary}\n`, { mode: 0o755 });
			}
			const binaries = {
				pg_ctl: join(packageNative, "bin", "pg_ctl"),
				initdb: join(packageNative, "bin", "initdb"),
				postgres: join(packageNative, "bin", "postgres"),
			};

			for (const form of ["empty-directory", "file", "relative-link", "absolute-link", "dangling-link"] as const) {
				const baseDir = join(scratch, form);
				const runtimeDir = join(baseDir, "pg-runtime");
				const selected = join(runtimeDir, "native");
				mkdirSync(runtimeDir, { recursive: true });
				if (form === "empty-directory") mkdirSync(selected);
				if (form === "file") writeFileSync(selected, "not a runtime");
				if (form === "relative-link") {
					mkdirSync(join(baseDir, "redirect"));
					symlinkSync("../redirect", selected);
				}
				if (form === "absolute-link") {
					mkdirSync(join(baseDir, "absolute-redirect"));
					symlinkSync(join(baseDir, "absolute-redirect"), selected);
				}
				if (form === "dangling-link") symlinkSync("../missing-runtime", selected);

				const result = await prepareBinariesForOwner(
					binaries,
					contextWith(
						baseDir,
						fakeRunner(() => ({ exitCode: 126 })),
					),
					fakeRunner(() => ({ exitCode: 0 })),
				);
				assert.equal(readFileSync(result.initdb, "utf8"), "source initdb\n", form);
				assert.notEqual(dirname(dirname(result.initdb)), selected, form);
				if (form === "file") assert.equal(readFileSync(selected, "utf8"), "not a runtime");
				if (form === "relative-link") assert.equal(readlinkSync(selected), join("..", "redirect"));
				if (form === "absolute-link") assert.equal(readlinkSync(selected), join(baseDir, "absolute-redirect"));
				if (form === "dangling-link") assert.equal(readlinkSync(selected), join("..", "missing-runtime"));
			}
		} finally {
			removeSealedScratch(scratch);
		}
	});

	test("a failed publisher seal surfaces an actionable error", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-test-"));
		try {
			const packageNative = join(scratch, "pkg", "native");
			mkdirSync(join(packageNative, "bin"), { recursive: true });
			writeFileSync(join(packageNative, "bin", "initdb"), "#!/bin/sh\n", { mode: 0o755 });
			writeFileSync(join(packageNative, "bin", "pg_ctl"), "#!/bin/sh\n", { mode: 0o755 });
			writeFileSync(join(packageNative, "bin", "postgres"), "#!/bin/sh\n", { mode: 0o755 });
			const baseDir = join(scratch, "cluster");
			mkdirSync(baseDir, { recursive: true });

			await assert.rejects(
				prepareBinariesForOwner(
					{
						pg_ctl: join(packageNative, "bin", "pg_ctl"),
						initdb: join(packageNative, "bin", "initdb"),
						postgres: join(packageNative, "bin", "postgres"),
					},
					contextWith(
						baseDir,
						fakeRunner(() => ({ exitCode: 126 })),
					),
					fakeRunner(() => ({ exitCode: 1 })),
				),
				/Could not seal the copied embedded Postgres runtime/,
			);
		} finally {
			removeSealedScratch(scratch);
		}
	});
});
