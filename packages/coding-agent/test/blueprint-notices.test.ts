import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { type BlueprintNotice, blueprintNotices } from "../src/core/resume/blueprint/notices.ts";
import {
	BlueprintBuildFailedError,
	type BlueprintBuildOutcome,
	type BlueprintFailure,
	BlueprintInvalidError,
	type BlueprintScope,
	BlueprintStepFailedError,
	SETUP_COMMAND_ALIAS,
} from "../src/core/resume/index.ts";

function failure(scope: BlueprintScope, blueprint: string, step = "install"): BlueprintFailure {
	return {
		scope,
		blueprint,
		root: scope === "global" ? null : "/repo",
		directory: scope === "global" ? null : ".",
		error: new BlueprintStepFailedError({
			blueprint,
			scope,
			section: "initialize",
			index: 0,
			step,
			exitStatus: 2,
			signal: null,
			logPath: "/store/step.log",
		}),
		logPath: "/store/step.log",
		outputTail: "",
	};
}

function outcome(overrides: Partial<BlueprintBuildOutcome> = {}): BlueprintBuildOutcome {
	return { status: "success", kind: "full", layers: [], failures: [], warnings: [], removed: [], ...overrides };
}

const CLONE_WARNING = {
	code: "clone-ignored",
	blueprint: "/repo/.atomic/blueprint.yaml",
	message: "'clone' is ignored: a resume restores the recorded tree instead of cloning the repository",
} as const;

const DEPRECATION: BlueprintNotice = {
	type: "warning",
	message: `Deprecation warning: ${SETUP_COMMAND_ALIAS} is deprecated and will be removed in the next release. Move its command into the maintenance section of .atomic/blueprint.yaml.`,
};

describe("blueprint notices (#4588)", () => {
	test("a build that ran and found nothing wrong says nothing (#4588)", () => {
		assert.deepEqual(blueprintNotices(outcome({ kind: "full" }), false), []);
		assert.deepEqual(blueprintNotices(outcome({ kind: "differential" }), false), []);
	});

	test("a repository failure is one Partial build warning with the failure's own message (#4588)", () => {
		const repository = failure("repository", "/repo/.atomic/blueprint.yaml", "Install toolchain");
		const [notice, ...rest] = blueprintNotices(outcome({ status: "partial", failures: [repository] }), false);
		assert.deepEqual(rest, []);
		assert.deepEqual(notice, {
			type: "warning",
			message: `Partial build: ${repository.error.message} The rest of that blueprint did not run; the other blueprints were built.`,
		});
		assert.ok(notice?.message.includes('"Install toolchain"'));
		assert.ok(notice?.message.includes("/repo/.atomic/blueprint.yaml"));
	});

	test("a workspace failure is a Partial build warning too (#4588)", () => {
		const workspace = failure("workspace", "/repo/services/api/.atomic/blueprint.yaml");
		const [notice] = blueprintNotices(outcome({ status: "partial", failures: [workspace] }), false);
		assert.equal(notice?.type, "warning");
		assert.ok(notice?.message.startsWith(`Partial build: ${workspace.error.message} `));
	});

	test("a global failure is a FAILED warning that says the session resumed anyway and what may be missing (#4588)", () => {
		const global = failure("global", "/home/a/.atomic/agent/blueprint.yaml", "Install tools");
		const [notice, ...rest] = blueprintNotices(outcome({ status: "failed", failures: [global] }), false);
		assert.deepEqual(rest, []);
		assert.deepEqual(notice, {
			type: "warning",
			message: `Blueprint build FAILED: ${global.error.message} The session resumed anyway, but repository setup did not run.`,
		});
	});

	test("a post-build failure does not claim that repository setup did not run (#4588)", () => {
		const postBuild: BlueprintFailure = {
			...failure("global", "/g.yaml", "Check tools"),
			error: new BlueprintStepFailedError({
				blueprint: "/g.yaml",
				scope: "global",
				section: "post-build",
				index: 0,
				step: "Check tools",
				exitStatus: 1,
				signal: null,
				logPath: "/store/step.log",
			}),
		};
		const [notice] = blueprintNotices(outcome({ status: "failed", failures: [postBuild] }), false);
		assert.equal(
			notice?.message,
			`Blueprint build FAILED: ${postBuild.error.message} The session resumed anyway, and the repositories were set up before it ran.`,
		);
	});

	test("a global initialize, maintenance or invalid-blueprint failure says repository setup did not run (#4588)", () => {
		const withSection = (section: "initialize" | "maintenance"): BlueprintFailure => ({
			...failure("global", "/g.yaml"),
			error: new BlueprintStepFailedError({
				blueprint: "/g.yaml",
				scope: "global",
				section,
				index: 0,
				step: "step",
				exitStatus: 1,
				signal: null,
				logPath: "/store/step.log",
			}),
		});
		const invalid: BlueprintFailure = {
			...failure("global", "/g.yaml"),
			error: new BlueprintInvalidError({
				blueprint: "/g.yaml",
				scope: "global",
				reason: "yaml-syntax",
				rule: "bad",
				subject: null,
			}),
		};
		for (const failed of [withSection("initialize"), withSection("maintenance"), invalid]) {
			const [notice] = blueprintNotices(outcome({ status: "failed", failures: [failed] }), false);
			assert.ok(
				notice?.message.endsWith("The session resumed anyway, but repository setup did not run."),
				notice?.message,
			);
		}
	});

	test("a crash of the build itself says repository setup may not have run (#4588)", () => {
		const crash: BlueprintFailure = {
			...failure("global", "/g.yaml"),
			error: new BlueprintBuildFailedError({ phase: "unknown", detail: "boom" }),
		};
		const [notice] = blueprintNotices(outcome({ status: "failed", failures: [crash] }), false);
		assert.ok(notice?.message.endsWith("The session resumed anyway, but repository setup may not have run."));
	});

	test("each failure earns its own warning, in order, with the global one worded differently (#4588)", () => {
		const failures = [
			failure("global", "/g.yaml"),
			failure("repository", "/repo/.atomic/blueprint.yaml"),
			failure("workspace", "/repo/w/.atomic/blueprint.yaml"),
		];
		const notices = blueprintNotices(outcome({ status: "failed", failures }), false);
		assert.deepEqual(
			notices.map((notice) => notice.message.split(":")[0]),
			["Blueprint build FAILED", "Partial build", "Partial build"],
		);
		for (const [index, notice] of notices.entries()) {
			assert.equal(notice.type, "warning");
			assert.ok(notice.message.includes(failures[index]?.error.message ?? "missing"));
		}
	});

	test("a build warning names its blueprint and ends with a period (#4588)", () => {
		assert.deepEqual(blueprintNotices(outcome({ warnings: [CLONE_WARNING] }), false), [
			{
				type: "warning",
				message: `Blueprint /repo/.atomic/blueprint.yaml: ${CLONE_WARNING.message}.`,
			},
		]);
	});

	test("failures come first, then build warnings, then the deprecation notice (#4588)", () => {
		const repository = failure("repository", "/repo/.atomic/blueprint.yaml");
		const notices = blueprintNotices(
			outcome({
				status: "partial",
				failures: [repository],
				warnings: [CLONE_WARNING, { ...CLONE_WARNING, blueprint: "/w.yaml" }],
			}),
			true,
		);
		assert.deepEqual(
			notices.map((notice) => notice.message.split(":")[0]),
			["Partial build", "Blueprint /repo/.atomic/blueprint.yaml", "Blueprint /w.yaml", "Deprecation warning"],
		);
		assert.deepEqual(notices.at(-1), DEPRECATION);
		assert.ok(notices.every((notice) => notice.type === "warning"));
	});

	test("the deprecation notice needs both the configured alias and a build that ran (#4588)", () => {
		assert.deepEqual(blueprintNotices(outcome({ kind: "full" }), true), [DEPRECATION]);
		assert.deepEqual(blueprintNotices(outcome({ kind: "differential" }), true), [DEPRECATION]);
		assert.deepEqual(blueprintNotices(outcome({ kind: "full" }), false), []);
		assert.deepEqual(blueprintNotices(outcome({ kind: undefined, status: "skipped" }), true), []);
	});

	test("a build that ran nothing says nothing, however much it still carries (#4588)", () => {
		const nothing = outcome({ kind: undefined, status: "skipped", warnings: [CLONE_WARNING] });
		assert.deepEqual(blueprintNotices(nothing, true), []);
		assert.deepEqual(blueprintNotices(nothing, false), []);
	});

	test("a failure that precedes any build step still earns its warning, without a deprecation notice (#4588)", () => {
		const unreadable = new BlueprintBuildFailedError({ phase: "read-blueprint", detail: "EACCES" });
		const failed: BlueprintFailure = {
			scope: "global",
			blueprint: "/g.yaml",
			root: null,
			directory: null,
			error: unreadable,
			logPath: null,
			outputTail: "",
		};
		const notices = blueprintNotices(
			outcome({ status: "failed", kind: undefined, failures: [failed], warnings: [CLONE_WARNING] }),
			true,
		);
		assert.deepEqual(
			notices.map((notice) => notice.message),
			[
				`Blueprint build FAILED: ${unreadable.message} The session resumed anyway, but repository setup did not run.`,
				`Blueprint ${CLONE_WARNING.blueprint}: ${CLONE_WARNING.message}.`,
			],
		);
	});
});
