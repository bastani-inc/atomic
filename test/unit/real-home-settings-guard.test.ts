import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { DefaultSettingsOutcome } from "../fixtures/real-home-storage-guard/default-settings.fixture.js";
import {
	CHILD_VITEST_TIMEOUT_MS,
	OPT_OUT_ENV,
	runGuardFixture,
} from "../fixtures/real-home-storage-guard/run-fixture.js";
import {
	installRealHomeSettingsGuard,
	protectedSettingsFileOf,
	RealHomeSettingsReadError,
	readTargetPath,
	realHomeSettingsFiles,
} from "../helpers/real-home-settings-guard.js";
import { isRealHomeAccessError, RealHomeAccessError } from "../helpers/real-home-storage-guard.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const scratch = makeTempDirectory("atomic-real-home-settings-guard-");
afterAll(() => removeTempDirectory(scratch));

function isRefusal(path: string, file: string) {
	return (error: RealHomeSettingsReadError) => {
		assert.ok(error instanceof RealHomeSettingsReadError);
		assert.equal(error.code, "real-home-settings-read");
		assert.equal(error.path, path);
		assert.equal(error.protectedFile, file);
		return true;
	};
}

test("RealHomeSettingsReadError names the read path, its code and the fix", () => {
	const fix =
		"The shared test setup gives every test file a temporary ATOMIC_CODING_AGENT_DIR; a test that removes it or names the real agent directory must point it, or the settings manager, at a temporary directory instead";
	const error = new RealHomeSettingsReadError(
		"/home/u/.atomic/agent/settings.json",
		"/home/u/.atomic/agent/settings.json",
	);
	assert.ok(error instanceof RealHomeAccessError);
	assert.equal(isRealHomeAccessError(error), true);
	assert.equal(error.name, "RealHomeSettingsReadError");
	assert.equal(error.code, "real-home-settings-read");
	assert.equal(error.path, "/home/u/.atomic/agent/settings.json");
	assert.equal(error.protectedFile, "/home/u/.atomic/agent/settings.json");
	assert.equal(error.hint, fix);
	assert.equal(
		error.message,
		`Test read the real home directory's agent settings: /home/u/.atomic/agent/settings.json (real-home-settings-read). ${fix}.`,
	);
});

describe("realHomeSettingsFiles", () => {
	test("covers Atomic's and pi's agent settings under every home Atomic could resolve", () => {
		const settings = (home: string) => [
			join(home, ".atomic", "agent", "settings.json"),
			join(home, ".pi", "agent", "settings.json"),
		];
		assert.deepEqual(
			realHomeSettingsFiles({
				HOME: "/posix-home",
				USERPROFILE: "/profile",
				HOMEDRIVE: "C:",
				HOMEPATH: "\\Users\\u",
			}),
			[...settings(homedir()), ...settings("/posix-home"), ...settings("/profile"), ...settings("C:\\Users\\u")],
		);
	});

	test("lists each file once when two homes differ only by a trailing separator", () => {
		assert.deepEqual(realHomeSettingsFiles({ HOME: `${homedir()}/` }), [
			join(homedir(), ".atomic", "agent", "settings.json"),
			join(homedir(), ".pi", "agent", "settings.json"),
		]);
	});
});

test("readTargetPath reads a path, Buffer or file URL, and nothing from a descriptor, handle or other URL", async () => {
	const file = join(scratch, "target.json");
	writeFileSync(file, "{}");
	assert.equal(readTargetPath(file), file);
	assert.equal(readTargetPath(Buffer.from(file)), file);
	assert.equal(readTargetPath(pathToFileURL(file)), file);
	assert.equal(readTargetPath(new URL("https://example.test/settings.json")), undefined);
	assert.equal(readTargetPath(7), undefined);
	const handle = await fs.promises.open(file);
	try {
		assert.equal(readTargetPath(handle), undefined);
	} finally {
		await handle.close();
	}
});

describe("protectedSettingsFileOf", () => {
	const home = join(scratch, "home");
	const settings = join(home, ".atomic", "agent", "settings.json");
	beforeAll(() => mkdirSync(dirname(settings), { recursive: true }));

	test("matches the file in every form, including paths that only normalize to it", () => {
		assert.equal(protectedSettingsFileOf(settings, [settings]), settings);
		assert.equal(protectedSettingsFileOf(Buffer.from(settings), [settings]), settings);
		assert.equal(protectedSettingsFileOf(pathToFileURL(settings), ["/unrelated/settings.json", settings]), settings);
		assert.equal(
			protectedSettingsFileOf(join(home, "other", "..", ".atomic", "agent", "settings.json"), [settings]),
			settings,
		);
		assert.equal(protectedSettingsFileOf(relative(process.cwd(), settings), [settings]), settings);
	});

	test("leaves project settings, other files in the agent directory and descriptors alone", () => {
		assert.equal(
			protectedSettingsFileOf(join(scratch, "project", ".atomic", "settings.json"), [settings]),
			undefined,
		);
		assert.equal(protectedSettingsFileOf(join(home, ".atomic", "agent", "settings.json.bak"), [settings]), undefined);
		assert.equal(protectedSettingsFileOf(join(home, ".atomic", "agent", "models.json"), [settings]), undefined);
		assert.equal(protectedSettingsFileOf(3, [settings]), undefined);
	});

	test("protects only files named settings.json, whatever else the list holds", () => {
		const auth = join(home, ".atomic", "agent", "auth.json");
		assert.equal(protectedSettingsFileOf(auth, [auth]), undefined);
	});

	test("compares without case only on platforms that fold it", () => {
		const absent = join(scratch, "absent-home", ".atomic", "agent", "settings.json");
		const shouted = join(scratch, "absent-home", ".ATOMIC", "agent", "SETTINGS.JSON");
		assert.equal(protectedSettingsFileOf(shouted, [absent], "win32"), absent);
		assert.equal(protectedSettingsFileOf(shouted, [absent], "darwin"), absent);
		assert.equal(protectedSettingsFileOf(shouted, [absent], "linux"), undefined);
	});

	test("sees through a symlinked home in either direction", () => {
		const realHome = join(scratch, "real-home");
		const aliasHome = join(scratch, "alias-home");
		mkdirSync(join(realHome, ".atomic", "agent"), { recursive: true });
		writeFileSync(join(realHome, ".atomic", "agent", "settings.json"), "{}");
		symlinkSync(realHome, aliasHome, "junction");
		const viaReal = join(realHome, ".atomic", "agent", "settings.json");
		const viaAlias = join(aliasHome, ".atomic", "agent", "settings.json");
		assert.equal(protectedSettingsFileOf(viaReal, [viaAlias]), viaAlias);
		assert.equal(protectedSettingsFileOf(viaAlias, [viaReal]), viaReal);
	});
});

describe("installRealHomeSettingsGuard", () => {
	const home = join(scratch, "guarded-home");
	const agentDir = join(home, ".atomic", "agent");
	const settings = join(agentDir, "settings.json");
	const content = JSON.stringify({ routerModel: "auto" });

	test("the shared setup installed it for every settings file of the real homes", () => {
		assert.deepEqual(installRealHomeSettingsGuard([]).files, realHomeSettingsFiles());
	});

	test("the file reads normally until the guard protects it", () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settings, content);
		assert.equal(readFileSync(settings, "utf8"), content);
	});

	describe("once the file is protected", () => {
		let guard: ReturnType<typeof installRealHomeSettingsGuard>;
		beforeAll(() => {
			guard = installRealHomeSettingsGuard([settings]);
		});

		test("refuses readFileSync in every form, through named imports and the module namespace alike", async () => {
			const loadedLater = await import("node:fs");
			assert.throws(() => readFileSync(settings, "utf8"), isRefusal(settings, settings));
			assert.throws(() => fs.readFileSync(Buffer.from(settings)), isRefusal(settings, settings));
			assert.throws(() => loadedLater.readFileSync(pathToFileURL(settings)), isRefusal(settings, settings));
			assert.throws(() => guard.assertNoViolations(), AggregateError);
		});

		test("refuses fs.promises.readFile, by rejecting", async () => {
			await assert.rejects(readFile(settings, "utf8"), isRefusal(settings, settings));
			await assert.rejects(fs.promises.readFile(pathToFileURL(settings)), isRefusal(settings, settings));
			assert.throws(() => guard.assertNoViolations(), AggregateError);
		});

		test("refuses the callback readFile, through its callback", async () => {
			const result = await new Promise<{ error: NodeJS.ErrnoException | null; data?: string }>((resolve) =>
				fs.readFile(settings, "utf8", (error, data) => resolve({ error, data })),
			);
			assert.equal(result.data, undefined);
			isRefusal(settings, settings)(result.error as RealHomeSettingsReadError);
			assert.throws(() => guard.assertNoViolations(), isRefusal(settings, settings));
		});

		test("fails the check once for a refusal the caller caught, then starts clean", () => {
			assert.throws(() => readFileSync(settings), RealHomeSettingsReadError);
			assert.throws(() => guard.assertNoViolations(), isRefusal(settings, settings));
			guard.assertNoViolations();
		});

		test("reports several refusals together", () => {
			const legacy = join(home, ".pi", "agent", "settings.json");
			installRealHomeSettingsGuard([legacy]);
			assert.throws(() => readFileSync(settings), RealHomeSettingsReadError);
			assert.throws(() => readFileSync(legacy), RealHomeSettingsReadError);
			assert.throws(
				() => guard.assertNoViolations(),
				(error: AggregateError) => {
					assert.ok(error instanceof AggregateError);
					assert.equal(error.message, "2 real-home settings reads were rejected");
					assert.deepEqual(
						error.errors.map((refusal: RealHomeSettingsReadError) => [refusal.code, refusal.path]),
						[
							["real-home-settings-read", settings],
							["real-home-settings-read", legacy],
						],
					);
					return true;
				},
			);
		});

		test("the settings manager keeps the refusal as a load error before reading the renamed key, and the check still fails", () => {
			const project = join(scratch, "project");
			mkdirSync(project, { recursive: true });
			const manager = SettingsManager.create(project, agentDir);
			const errors = manager.drainErrors();
			assert.equal(errors.length, 1);
			assert.equal(errors[0]?.scope, "global");
			assert.ok(isRefusal(settings, settings)(errors[0]?.error as RealHomeSettingsReadError));
			assert.throws(() => guard.assertNoViolations(), RealHomeSettingsReadError);
		});

		test("leaves other files, project settings and descriptor reads working", async () => {
			const project = join(scratch, "readable-project", ".atomic", "settings.json");
			mkdirSync(dirname(project), { recursive: true });
			writeFileSync(project, "{}");
			writeFileSync(join(agentDir, "models.json"), "{}");
			assert.equal(readFileSync(project, "utf8"), "{}");
			assert.equal(await readFile(join(agentDir, "models.json"), "utf8"), "{}");
			const data = await new Promise<string>((resolve, reject) =>
				fs.readFile(project, "utf8", (error, text) => (error ? reject(error) : resolve(text))),
			);
			assert.equal(data, "{}");
			const descriptor = fs.openSync(project, "r");
			try {
				assert.equal(readFileSync(descriptor, "utf8"), "{}");
			} finally {
				fs.closeSync(descriptor);
			}
			guard.assertNoViolations();
		});

		test("installing again adds new files to the guard the shared setup installed, once each", () => {
			const other = join(scratch, "other-home", ".atomic", "agent", "settings.json");
			const before = [...guard.files];
			const again = installRealHomeSettingsGuard([settings, other, other]);
			assert.equal(again, guard);
			assert.deepEqual(again.files, [...before, other]);
			assert.throws(() => readFileSync(other), isRefusal(other, other));
			assert.throws(() => guard.assertNoViolations(), RealHomeSettingsReadError);
		});
	});
});

const SETTINGS_FIXTURE = "test/fixtures/real-home-storage-guard/default-settings.fixture.ts";

test(
	"the shared test setup fails a test that opts out of its agent directory and reads the real home's settings, though the settings manager catches the refusal (#4473)",
	async () => {
		const home = join(scratch, "fixture-home");
		const settings = join(home, ".atomic", "agent", "settings.json");
		mkdirSync(dirname(settings), { recursive: true });
		writeFileSync(settings, JSON.stringify({ routerModel: "auto" }));

		const optedOut = await runGuardFixture<DefaultSettingsOutcome>(SETTINGS_FIXTURE, scratch, "settings-opted-out", {
			HOME: home,
			USERPROFILE: home,
			[OPT_OUT_ENV]: "1",
		});
		assert.notEqual(optedOut.exitCode, 0, optedOut.output);
		assert.equal(optedOut.status, "failed", optedOut.output);
		assert.match(optedOut.failure, /^RealHomeSettingsReadError: .*\(real-home-settings-read\)/u);
		assert.deepEqual(optedOut.outcome, {
			agentDir: join(home, ".atomic", "agent"),
			errors: [{ name: "RealHomeSettingsReadError", guardCode: "real-home-settings-read", guardPath: settings }],
		});
	},
	CHILD_VITEST_TIMEOUT_MS,
);

test(
	"the shared test setup loads a test's settings from an agent directory of its own, in place of an inherited real-home one (#4473)",
	async () => {
		const home = join(scratch, "default-home");
		const artifacts = join(scratch, "default-artifacts");
		mkdirSync(join(home, ".atomic", "agent"), { recursive: true });
		writeFileSync(join(home, ".atomic", "agent", "settings.json"), JSON.stringify({ routerModel: "auto" }));
		mkdirSync(artifacts);

		const run = await runGuardFixture<DefaultSettingsOutcome>(SETTINGS_FIXTURE, scratch, "settings-default", {
			HOME: home,
			USERPROFILE: home,
			ATOMIC_WORKFLOW_ARTIFACT_DIR: artifacts,
			ATOMIC_CODING_AGENT_DIR: join(home, ".atomic", "agent"),
			PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		});
		assert.equal(run.exitCode, 0, run.output);
		assert.equal(run.status, "passed", run.output);
		assert.match(relative(artifacts, run.outcome.agentDir), /^agent-home-[^/\\]+[/\\]\.atomic[/\\]agent$/u);
		assert.deepEqual(run.outcome.errors, []);
	},
	CHILD_VITEST_TIMEOUT_MS,
);
