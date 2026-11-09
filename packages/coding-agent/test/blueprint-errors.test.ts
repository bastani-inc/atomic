import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	BlueprintBuildFailedError,
	type BlueprintBuildFailedErrorFields,
	BlueprintError,
	BlueprintInvalidError,
	type BlueprintInvalidErrorFields,
	BlueprintStepFailedError,
	type BlueprintStepFailedErrorFields,
	BlueprintStepTimedOutError,
	type BlueprintStepTimedOutErrorFields,
	BlueprintUsesUnsupportedError,
	type BlueprintUsesUnsupportedErrorFields,
	type BlueprintUsesUnsupportedReason,
	findBlueprintError,
	isBlueprintBuildFailedError,
	isBlueprintError,
	isBlueprintInvalidError,
	isBlueprintStepFailedError,
	isBlueprintStepTimedOutError,
	isBlueprintUsesUnsupportedError,
	rehydrateBlueprintError,
	serializeBlueprintError,
} from "../src/core/resume/index.ts";

const location = {
	blueprint: "/repo/.atomic/blueprint.yaml",
	scope: "repository",
	section: "initialize",
	index: 1,
	step: "install toolchain",
} as const;

const samples: readonly BlueprintError[] = [
	new BlueprintInvalidError({
		blueprint: location.blueprint,
		scope: "repository",
		reason: "uses-in-maintenance",
		rule: "'uses' steps are not supported in maintenance sections",
		subject: "maintenance[0]",
	}),
	new BlueprintStepFailedError({ ...location, exitStatus: 7, signal: null, logPath: "/store/log.log" }),
	new BlueprintStepTimedOutError({
		...location,
		logPath: "/store/log.log",
		timeoutMs: 10_800_000,
		elapsedMs: 10_800_123,
		phase: "initialize",
	}),
	new BlueprintUsesUnsupportedError({
		...location,
		uses: "github.com/acme/docker-action@v1",
		reason: "docker-action",
		detail: "Docker actions are not supported",
		logPath: "/store/log.log",
	}),
	new BlueprintBuildFailedError({ phase: "ledger", detail: "the build ledger could not be written" }),
];

describe("blueprint error family (#4588)", () => {
	test("each concrete error has a literal name, a stable code, a hint and is not retryable (#4588)", () => {
		assert.deepEqual(
			samples.map((error) => [error.name, error.code, error.retryable]),
			[
				["BlueprintInvalidError", "blueprint-invalid", false],
				["BlueprintStepFailedError", "blueprint-step-failed", false],
				["BlueprintStepTimedOutError", "blueprint-step-timed-out", false],
				["BlueprintUsesUnsupportedError", "blueprint-uses-unsupported", false],
				["BlueprintBuildFailedError", "blueprint-build-failed", false],
			],
		);
		for (const error of samples) {
			assert.ok(error instanceof BlueprintError);
			assert.ok(error.hint.length > 0);
			assert.ok(error.message.includes(`(${error.code})`));
			assert.ok(error.message.endsWith(error.hint));
		}
	});

	test("guards accept their own class and reject the others (#4588)", () => {
		const guards = [
			isBlueprintInvalidError,
			isBlueprintStepFailedError,
			isBlueprintStepTimedOutError,
			isBlueprintUsesUnsupportedError,
			isBlueprintBuildFailedError,
		];
		for (const [index, error] of samples.entries()) {
			assert.ok(isBlueprintError(error));
			assert.deepEqual(
				guards.map((guard) => guard(error)),
				guards.map((_guard, guardIndex) => guardIndex === index),
			);
		}
		assert.equal(isBlueprintError(new Error("plain")), false);
		assert.equal(isBlueprintError(undefined), false);
	});

	test("typed fields mirror the fields record and carry the failing step (#4588)", () => {
		const failed = samples[1];
		assert.ok(isBlueprintStepFailedError(failed));
		assert.equal(failed.exitStatus, 7);
		assert.equal(failed.step, "install toolchain");
		assert.equal(failed.section, "initialize");
		assert.equal(failed.logPath, "/store/log.log");
		assert.deepEqual(failed.fields, {
			...location,
			exitStatus: 7,
			signal: null,
			logPath: "/store/log.log",
		});
		assert.ok(Object.isFrozen(failed.fields));
		const timedOut = samples[2];
		assert.ok(isBlueprintStepTimedOutError(timedOut));
		assert.equal(timedOut.timeoutMs, 10_800_000);
		assert.equal(timedOut.elapsedMs, 10_800_123);
		assert.equal(timedOut.phase, "initialize");
	});

	test("the message of a step failure names the blueprint, the step and the log (#4588)", () => {
		const message = samples[1]!.message;
		assert.ok(message.includes("/repo/.atomic/blueprint.yaml"));
		assert.ok(message.includes("install toolchain"));
		assert.ok(message.includes("status 7"));
		assert.ok(message.includes("/store/log.log"));
	});

	test("every error survives serialize and rehydrate as the same class with its fields (#4588)", () => {
		for (const error of samples) {
			const form = JSON.parse(JSON.stringify(serializeBlueprintError(error)));
			const rebuilt = rehydrateBlueprintError(form);
			assert.equal(rebuilt.constructor, error.constructor);
			assert.equal(rebuilt.name, error.name);
			assert.equal(rebuilt.code, error.code);
			assert.equal(rebuilt.message, error.message);
			assert.equal(rebuilt.hint, error.hint);
			assert.deepEqual(rebuilt.fields, error.fields);
			assert.ok(isBlueprintError(rebuilt));
		}
	});

	test("a cause chain survives the round trip, bounded and without stack traces (#4588)", () => {
		const root = new Error("spawn ENOENT");
		const error = new BlueprintStepFailedError(
			{ ...location, exitStatus: null, signal: null, logPath: "/l.log" },
			root,
		);
		const form = serializeBlueprintError(error);
		assert.equal(form.cause?.message, "spawn ENOENT");
		assert.equal("stack" in (form.cause ?? {}), false);
		const rebuilt = rehydrateBlueprintError(form);
		assert.ok(rebuilt.cause instanceof Error);
		assert.equal((rebuilt.cause as Error).message, "spawn ENOENT");
	});

	test("an unknown name or code rehydrates into the family base and keeps what it was (#4588)", () => {
		const rebuilt = rehydrateBlueprintError({
			name: "BlueprintFutureError",
			code: "blueprint-future",
			message: "something new (blueprint-future). Do the new thing.",
			hint: "Do the new thing.",
			retryable: true,
			fields: { detail: "x" },
		});
		assert.ok(rebuilt instanceof BlueprintError);
		assert.equal(rebuilt.name, "BlueprintFutureError");
		assert.equal(rebuilt.code, "blueprint-future");
		assert.equal(rebuilt.retryable, true);
		assert.deepEqual(rebuilt.fields, { detail: "x" });
		assert.ok(isBlueprintError(rebuilt));
		assert.equal(isBlueprintInvalidError(rebuilt), false);
	});

	test("a known name with a code from another class rehydrates as the base (#4588)", () => {
		const rebuilt = rehydrateBlueprintError({
			name: "BlueprintInvalidError",
			code: "blueprint-step-failed",
			message: "m",
			hint: "h",
			retryable: false,
			fields: {},
		});
		assert.equal(rebuilt.constructor, BlueprintError);
	});

	test("guards recognise a plain object that crossed a boundary by name and code (#4588)", () => {
		const crossed = { name: "BlueprintStepFailedError", code: "blueprint-step-failed" };
		assert.ok(isBlueprintStepFailedError(crossed));
		assert.ok(isBlueprintError(crossed));
		assert.equal(isBlueprintInvalidError(crossed), false);
		assert.equal(isBlueprintStepFailedError({ name: "BlueprintStepFailedError", code: "blueprint-invalid" }), false);
		assert.equal(isBlueprintError({ name: "Unrelated", code: "blueprint-invalid" }), false);
	});

	test("findBlueprintError walks the cause chain (#4588)", () => {
		const inner = samples[1]!;
		const wrapped = new Error("outer", { cause: new Error("middle", { cause: inner }) });
		assert.equal(findBlueprintError(wrapped), inner);
		assert.equal(findBlueprintError(wrapped, isBlueprintInvalidError), undefined);
		assert.equal(findBlueprintError(new Error("none")), undefined);
	});
});

const BLUEPRINT = "/repo/.atomic/blueprint.yaml";
const STEP_SUMMARY = `The initialize step "install toolchain" of the repository blueprint ${BLUEPRINT}`;

describe("blueprint error messages and properties (#4588)", () => {
	test("each error's message is its summary, its code and its hint, verbatim (#4588)", () => {
		assert.deepEqual(
			samples.map((error) => error.message),
			[
				`The repository blueprint ${BLUEPRINT} is invalid: 'uses' steps are not supported in maintenance sections (maintenance[0]) (blueprint-invalid). Fix the blueprint; the next build picks the change up.`,
				`${STEP_SUMMARY} exited with status 7 (blueprint-step-failed). Check the build log /store/log.log for the exact error, then fix the environment and the blueprint; the next build runs it again.`,
				`${STEP_SUMMARY} did not finish within 10800000 ms (blueprint-step-timed-out). Check the build log /store/log.log, make the step finish sooner or non-interactive, then fix the blueprint; the next build runs it again.`,
				`${STEP_SUMMARY} cannot run github.com/acme/docker-action@v1: Docker actions are not supported (blueprint-uses-unsupported). Replace the action with a \`run\` step, or use a Node.js or composite action; details are in /store/log.log.`,
				"The blueprint build stopped while reading or writing the build ledger: the build ledger could not be written (blueprint-build-failed). Check that the agent directory is readable and writable; the next resume builds again.",
			],
		);
	});

	test("each unsupported-action reason gets the remediation that fits it, followed by the log path (#4588)", () => {
		const hints: Record<BlueprintUsesUnsupportedReason, string> = {
			"docker-action":
				"Replace the action with a `run` step, or use a Node.js or composite action; details are in /store/log.log.",
			"unknown-action-type":
				"Replace the action with a `run` step, or use a Node.js or composite action; details are in /store/log.log.",
			"required-input-missing": "Add the missing input under `with`; details are in /store/log.log.",
			"action-not-found":
				"Check the `github.com/<owner>/<repo>@<ref>` reference and that the action has an action.yml; details are in /store/log.log.",
			"action-fetch-failed":
				"Check the `github.com/<owner>/<repo>@<ref>` reference and the network access to GitHub; details are in /store/log.log.",
			"action-metadata-invalid": "Pin a ref whose action.yml is valid; details are in /store/log.log.",
			"node-unavailable": "Install Node.js and put it on PATH; details are in /store/log.log.",
			"unsupported-expression":
				"Pass the value through `with` instead of the unsupported expression, or use a `run` step; details are in /store/log.log.",
		};
		for (const [reason, hint] of Object.entries(hints) as [BlueprintUsesUnsupportedReason, string][]) {
			const error = new BlueprintUsesUnsupportedError({
				...location,
				uses: "github.com/acme/action@v1",
				reason,
				detail: "d",
				logPath: "/store/log.log",
			});
			assert.equal(error.hint, hint, reason);
		}
	});

	test("a step whose log could not be created points at the build directory instead of a log (#4588)", () => {
		const error = new BlueprintStepFailedError({
			...location,
			exitStatus: null,
			signal: null,
			logPath: null,
		});
		assert.equal(error.logPath, null);
		assert.equal(
			error.hint,
			"Make the build directory under the agent directory writable, then the next build runs the step again.",
		);
	});

	test("an invalid blueprint without a subject leaves the subject out of its message (#4588)", () => {
		const error = new BlueprintInvalidError({
			blueprint: BLUEPRINT,
			scope: "global",
			reason: "yaml-syntax",
			rule: "YAML syntax error (BAD_INDENT)",
			subject: null,
		});
		assert.equal(
			error.message,
			`The global blueprint ${BLUEPRINT} is invalid: YAML syntax error (BAD_INDENT) (blueprint-invalid). Fix the blueprint; the next build picks the change up.`,
		);
		assert.equal(error.subject, null);
	});

	test("a step failure says whether a signal stopped it or it never started (#4588)", () => {
		const signalled = new BlueprintStepFailedError({
			...location,
			exitStatus: null,
			signal: "SIGTERM",
			logPath: "/l.log",
		});
		assert.ok(signalled.message.startsWith(`${STEP_SUMMARY} was stopped by SIGTERM (blueprint-step-failed).`));
		const both = new BlueprintStepFailedError({ ...location, exitStatus: 9, signal: "SIGKILL", logPath: "/l.log" });
		assert.ok(both.message.includes(" was stopped by SIGKILL (blueprint-step-failed)."));
		const unstarted = new BlueprintStepFailedError({
			...location,
			exitStatus: null,
			signal: null,
			logPath: "/l.log",
		});
		assert.ok(unstarted.message.startsWith(`${STEP_SUMMARY} could not be started (blueprint-step-failed).`));
		const zero = new BlueprintStepFailedError({ ...location, exitStatus: 0, signal: null, logPath: "/l.log" });
		assert.ok(zero.message.startsWith(`${STEP_SUMMARY} exited with status 0 (blueprint-step-failed).`));
	});

	test("every field is also a property of the error, and fields is a frozen copy (#4588)", () => {
		for (const error of samples) {
			assert.ok(Object.keys(error.fields).length > 0);
			for (const [key, value] of Object.entries(error.fields)) {
				assert.deepEqual(Reflect.get(error, key), value, `${error.name}.${key}`);
			}
			assert.ok(Object.isFrozen(error.fields));
		}
	});

	test("the base error carries its own name, code, hint, fields and optional cause (#4588)", () => {
		const fields = { detail: "x" };
		const plain = new BlueprintError("blueprint-build-failed", "summary", "do this", fields);
		assert.equal(plain.name, "BlueprintError");
		assert.equal(plain.code, "blueprint-build-failed");
		assert.equal(plain.hint, "do this");
		assert.equal(plain.retryable, false);
		assert.equal(plain.message, "summary (blueprint-build-failed). do this");
		assert.deepEqual(plain.fields, { detail: "x" });
		assert.notEqual(plain.fields, fields);
		assert.equal(Object.hasOwn(plain, "cause"), false);
		const cause = new Error("root");
		const caused = new BlueprintError("blueprint-build-failed", "summary", "do this", fields, cause);
		assert.equal(caused.cause, cause);
	});

	test("every concrete error keeps the cause it was given (#4588)", () => {
		const cause = new Error("root");
		const invalid: BlueprintInvalidErrorFields = {
			blueprint: BLUEPRINT,
			scope: "global",
			reason: "invalid-shell",
			rule: "r",
			subject: null,
		};
		const failed: BlueprintStepFailedErrorFields = { ...location, exitStatus: 1, signal: null, logPath: "/l" };
		const timedOut: BlueprintStepTimedOutErrorFields = {
			...location,
			logPath: "/l",
			timeoutMs: 1,
			elapsedMs: 2,
			phase: "initialize",
		};
		const unsupported: BlueprintUsesUnsupportedErrorFields = {
			...location,
			uses: "github.com/a/b@v1",
			reason: "docker-action",
			detail: "d",
			logPath: "/l",
		};
		const build: BlueprintBuildFailedErrorFields = { phase: "ledger", detail: "d" };
		const caused = [
			new BlueprintInvalidError(invalid, cause),
			new BlueprintStepFailedError(failed, cause),
			new BlueprintStepTimedOutError(timedOut, cause),
			new BlueprintUsesUnsupportedError(unsupported, cause),
			new BlueprintBuildFailedError(build, cause),
		];
		for (const error of caused) assert.equal(error.cause, cause);
		for (const error of samples) assert.equal(Object.hasOwn(error, "cause"), false);
	});
});

describe("blueprint error guards on values that crossed a boundary (#4588)", () => {
	const crossings = [
		["BlueprintInvalidError", "blueprint-invalid", isBlueprintInvalidError],
		["BlueprintStepFailedError", "blueprint-step-failed", isBlueprintStepFailedError],
		["BlueprintStepTimedOutError", "blueprint-step-timed-out", isBlueprintStepTimedOutError],
		["BlueprintUsesUnsupportedError", "blueprint-uses-unsupported", isBlueprintUsesUnsupportedError],
		["BlueprintBuildFailedError", "blueprint-build-failed", isBlueprintBuildFailedError],
	] as const;

	test("each guard accepts exactly the name and code of its own class (#4588)", () => {
		for (const [name, code, guard] of crossings) {
			assert.equal(guard({ name, code }), true, name);
			assert.equal(isBlueprintError({ name, code }), true, name);
			assert.equal(guard({ name: "BlueprintError", code }), false, `${name} with the base name`);
			assert.equal(guard({ name: "Other", code }), false, `${name} with another name`);
			assert.equal(guard({ name, code: "blueprint-future" }), false, `${name} with an unknown code`);
			assert.equal(guard({ name }), false, `${name} without a code`);
			assert.equal(guard({ code }), false, `${name} without a name`);
			assert.equal(guard(null), false);
			assert.equal(guard(undefined), false);
			assert.equal(guard(name), false);
			for (const [otherName, otherCode] of crossings) {
				if (otherName === name) continue;
				assert.equal(guard({ name: otherName, code: otherCode }), false, `${name} guard on ${otherName}`);
				assert.equal(guard({ name, code: otherCode }), false, `${name} with the code of ${otherName}`);
			}
		}
	});

	test("the family guard needs a string name that the family knows and one of its codes (#4588)", () => {
		assert.equal(isBlueprintError(null), false);
		assert.equal(isBlueprintError({ name: "BlueprintError", code: "blueprint-step-failed" }), true);
		assert.equal(isBlueprintError({ name: "BlueprintError", code: "blueprint-future" }), false);
		assert.equal(isBlueprintError({ name: "BlueprintFutureError", code: "blueprint-invalid" }), false);
		assert.equal(
			isBlueprintError({ name: { toString: () => "BlueprintInvalidError" }, code: "blueprint-invalid" }),
			false,
		);
		assert.equal(isBlueprintError({ name: ["BlueprintInvalidError"], code: "blueprint-invalid" }), false);
	});
});

describe("blueprint error serialization (#4588)", () => {
	test("an error without a cause serializes without a cause key, and with one it carries it (#4588)", () => {
		const bare = serializeBlueprintError(samples[3]!);
		assert.equal("cause" in bare, false);
		assert.deepEqual(Object.keys(bare), ["name", "code", "message", "hint", "retryable", "fields"]);
		const withCause = serializeBlueprintError(
			new BlueprintBuildFailedError({ phase: "ledger", detail: "x" }, new Error("disk")),
		);
		assert.deepEqual(withCause.cause, { name: "Error", message: "disk" });
	});

	test("a rehydrated error keeps the cause that was passed in instead of the serialized one (#4588)", () => {
		const form = serializeBlueprintError(
			new BlueprintBuildFailedError({ phase: "ledger", detail: "x" }, new Error("serialized")),
		);
		const given = new Error("given");
		assert.equal(rehydrateBlueprintError(form, given).cause, given);
		const plain = rehydrateBlueprintError(serializeBlueprintError(samples[4]!));
		assert.equal(Object.hasOwn(plain, "cause"), false);
	});

	test("an unknown error rehydrates with read-only data properties and the right enumerability (#4588)", () => {
		const form = {
			name: "BlueprintFutureError",
			code: "blueprint-future",
			message: "something new (blueprint-future). Do the new thing.",
			hint: "Do the new thing.",
			retryable: true,
			fields: { detail: "x" },
			cause: { name: "RangeError", message: "deep" },
		};
		const rebuilt = rehydrateBlueprintError(form);
		const descriptor = (key: string) => Object.getOwnPropertyDescriptor(rebuilt, key);
		assert.deepEqual(descriptor("name"), {
			value: form.name,
			writable: false,
			enumerable: false,
			configurable: true,
		});
		assert.deepEqual(descriptor("message"), {
			value: form.message,
			writable: false,
			enumerable: false,
			configurable: true,
		});
		assert.deepEqual(descriptor("code"), {
			value: form.code,
			writable: false,
			enumerable: true,
			configurable: false,
		});
		assert.deepEqual(descriptor("hint"), {
			value: form.hint,
			writable: false,
			enumerable: true,
			configurable: false,
		});
		assert.deepEqual(descriptor("retryable"), {
			value: true,
			writable: false,
			enumerable: true,
			configurable: false,
		});
		assert.equal(descriptor("fields")?.enumerable, true);
		assert.deepEqual(descriptor("fields")?.value, { detail: "x" });
		assert.ok(Object.isFrozen(rebuilt.fields));
		assert.notEqual(rebuilt.fields, form.fields);
		const cause = descriptor("cause");
		assert.equal(cause?.enumerable, false);
		assert.equal(cause?.configurable, true);
		assert.ok(cause?.value instanceof Error);
		assert.equal(cause.value.name, "RangeError");
		assert.equal(cause.value.message, "deep");
		assert.deepEqual(Object.keys(rebuilt), ["code", "hint", "retryable", "fields"]);
		assert.equal(rebuilt.message, form.message);
		assert.equal(String(rebuilt), "BlueprintFutureError: something new (blueprint-future). Do the new thing.");
	});

	test("an unknown error without a cause has none, and the given cause wins (#4588)", () => {
		const form = {
			name: "BlueprintFutureError",
			code: "blueprint-future",
			message: "m",
			hint: "h",
			retryable: false,
			fields: {},
		};
		assert.equal(Object.hasOwn(rehydrateBlueprintError(form), "cause"), false);
		const given = new Error("given");
		assert.equal(rehydrateBlueprintError(form, given).cause, given);
	});

	test("the base error name rehydrates as the base class even with a family code (#4588)", () => {
		const rebuilt = rehydrateBlueprintError({
			name: "BlueprintError",
			code: "blueprint-invalid",
			message: "m",
			hint: "h",
			retryable: false,
			fields: {},
		});
		assert.equal(rebuilt.constructor, BlueprintError);
		assert.equal(rebuilt.name, "BlueprintError");
		assert.equal(rebuilt.code, "blueprint-invalid");
	});

	test("an inherited property name does not select a rehydrator (#4588)", () => {
		const rebuilt = rehydrateBlueprintError({
			name: "constructor",
			code: "blueprint-invalid",
			message: "m",
			hint: "h",
			retryable: false,
			fields: {},
		});
		assert.equal(rebuilt.constructor, BlueprintError);
		assert.equal(rebuilt.name, "constructor");
	});
});
