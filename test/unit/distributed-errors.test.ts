import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { AzureRun, checkPrerequisites } from "../distributed/harness/azure.mjs";
import { runCommand } from "../distributed/harness/commands.mjs";
import { buildPlan, parseRunArgs, parseTopology, resolveRunOptions } from "../distributed/harness/config.mjs";
import {
	attachCleanupFailure,
	DistributedCommandError,
	DistributedConfigError,
	DistributedFaultError,
	DistributedFeatureUnavailableError,
	DistributedInvariantError,
	DistributedPrerequisiteError,
	DistributedProvisionError,
	DistributedScenarioPendingError,
	DistributedSecurityError,
	DistributedTeardownError,
	DistributedTestError,
	DistributedTimeoutError,
	isCancellation,
	isDistributedCommandError,
	isDistributedConfigError,
	isDistributedFaultError,
	isDistributedFeatureUnavailableError,
	isDistributedInvariantError,
	isDistributedPrerequisiteError,
	isDistributedProvisionError,
	isDistributedScenarioPendingError,
	isDistributedSecurityError,
	isDistributedTeardownError,
	isDistributedTestError,
	isDistributedTimeoutError,
	isRetryableDistributedError,
	MAX_CAUSE_DEPTH,
	rehydrateDistributedError,
	serializeDistributedError,
} from "../distributed/harness/errors.mjs";
import { invariantFailures } from "../distributed/harness/invariants.mjs";
import { Manifest } from "../distributed/harness/manifest.mjs";
import { gateVerdict } from "../distributed/harness/security.mjs";

const topology = parseTopology(
	JSON.parse(readFileSync(new URL("../distributed/topology.json", import.meta.url), "utf8")),
);
const node = process.execPath;
const control = { resourceGroup: "control-rg", vnet: "control-vnet", sshSourcePrefix: "10.20.1.0/24" };
const context = () => ({ secrets: new Set<string>() });

const samples = (): [Error, (value: unknown) => boolean, string][] => [
	[
		new DistributedConfigError({
			source: "cli",
			field: "--nodes",
			reason: "invalid-value",
			expected: "a positive integer",
			actual: "0",
		}),
		isDistributedConfigError,
		"invalid-config",
	],
	[
		new DistributedPrerequisiteError({ missing: [{ what: "az login", why: "w", fix: "az login" }] }),
		isDistributedPrerequisiteError,
		"missing-prerequisite",
	],
	[
		new DistributedCommandError({ tool: "az", operation: "op", exitCode: 1, signal: null }),
		isDistributedCommandError,
		"command-failed",
	],
	[new DistributedTimeoutError({ phase: "p", timeoutMs: 1, elapsedMs: 2 }), isDistributedTimeoutError, "timeout"],
	[new DistributedProvisionError({ step: "s", resource: "r" }), isDistributedProvisionError, "provision-failed"],
	[
		new DistributedSecurityError({ violations: [{ check: "c", subject: "s", detail: "d" }] }),
		isDistributedSecurityError,
		"security-check-failed",
	],
	[
		new DistributedFaultError({ profile: "oom", stage: "observe", target: "t" }),
		isDistributedFaultError,
		"fault-failed",
	],
	[
		new DistributedInvariantError({ invariant: "i", scenario: "s", expected: 1, actual: 2 }),
		isDistributedInvariantError,
		"invariant-violated",
	],
	[
		new DistributedFeatureUnavailableError({ suite: "s", issue: "#1", capability: "c" }),
		isDistributedFeatureUnavailableError,
		"feature-unavailable",
	],
	[
		new DistributedScenarioPendingError({ suite: "s", issue: "#1", capability: "c" }),
		isDistributedScenarioPendingError,
		"scenario-pending",
	],
	[
		new DistributedTeardownError({ runId: "r", remaining: ["x"], errors: [] }),
		isDistributedTeardownError,
		"teardown-incomplete",
	],
];

test("every concrete error has a literal name, stable code, hint, fields and its own guard", () => {
	const guards = samples().map(([, guard]) => guard);
	for (const [error, guard, code] of samples()) {
		assert.ok(error instanceof DistributedTestError);
		assert.ok(isDistributedTestError(error));
		assert.equal(Reflect.get(error as object, "code"), code);
		assert.equal(error.name, error.constructor.name);
		assert.ok(error.name.startsWith("Distributed") && error.name.endsWith("Error"));
		assert.ok(guard(error), error.name);
		assert.equal(guards.filter((other) => other(error)).length, 1, `${error.name} matches only its own guard`);
		const hint = Reflect.get(error as object, "hint");
		assert.ok(typeof hint === "string" && hint.endsWith("."), error.name);
		assert.ok(error.message.includes(`(${code}).`), error.message);
		assert.ok(error.message.endsWith(hint), error.message);
		assert.equal(typeof Reflect.get(error as object, "fields"), "object");
		assert.ok(guard(JSON.parse(JSON.stringify({ name: error.name, code }))), `${error.name} structural guard`);
		assert.ok(!guard({ name: error.name, code: "other" }));
		assert.ok(!guard({ name: "Other", code }));
	}
	for (const value of [
		null,
		undefined,
		1,
		"DistributedConfigError",
		new Error("x"),
		{ name: 1, code: "invalid-config" },
		{ name: "DistributedConfigError" },
	]) {
		assert.ok(!isDistributedConfigError(value));
		assert.ok(!isDistributedTestError(value));
	}
	assert.ok(isDistributedTestError({ name: "DistributedFutureError", code: "future" }));
	assert.ok(!isDistributedTestError({ name: "DistributedFuture", code: "future" }));
	assert.ok(!isDistributedTestError({ name: "XDistributedError", code: "x" }));
});

test("retryability is explicit and found anywhere in a bounded cause chain", () => {
	assert.equal(
		new DistributedCommandError({ tool: "ssh", operation: "o", exitCode: 255, signal: null, retryable: true })
			.retryable,
		true,
	);
	assert.equal(new DistributedTeardownError({ runId: "r", remaining: [], errors: [] }).retryable, true);
	for (const [error] of samples().filter(([error]) => !(error instanceof DistributedTeardownError)))
		assert.equal(Reflect.get(error as object, "retryable"), false, error.name);
	const retryable = new DistributedTimeoutError({ phase: "p", timeoutMs: 1, elapsedMs: 1, retryable: true });
	assert.ok(isRetryableDistributedError(retryable));
	assert.ok(
		isRetryableDistributedError(new DistributedProvisionError({ step: "s", resource: "r", cause: retryable })),
	);
	assert.ok(
		!isRetryableDistributedError(new DistributedProvisionError({ step: "s", resource: "r", cause: new Error("x") })),
	);
	assert.ok(!isRetryableDistributedError(Object.assign(new Error("x"), { retryable: true })));
	assert.ok(!isRetryableDistributedError(null));
	assert.ok(!isRetryableDistributedError("text"));
	let deep: unknown = retryable;
	for (let depth = 1; depth < MAX_CAUSE_DEPTH; depth++)
		deep = new DistributedProvisionError({ step: "s", resource: String(depth), cause: deep });
	assert.ok(isRetryableDistributedError(deep));
	deep = new DistributedProvisionError({ step: "s", resource: "past the bound", cause: deep });
	assert.ok(!isRetryableDistributedError(deep));
});

test("cancellation is recognized from the signal's reason or an AbortError, never as a failure", () => {
	const controller = new AbortController();
	const reason = new Error("stop");
	assert.ok(!isCancellation(reason, controller.signal));
	controller.abort(reason);
	assert.ok(isCancellation(reason, controller.signal));
	assert.ok(!isCancellation(new Error("stop"), controller.signal));
	assert.ok(isCancellation(new DOMException("x", "AbortError")));
	assert.ok(!isCancellation(new DistributedTimeoutError({ phase: "p", timeoutMs: 1, elapsedMs: 1 })));
	assert.ok(!isCancellation(null));
});

test("a cleanup failure is attached to the primary failure and never replaces it", () => {
	const primary = new DistributedProvisionError({ step: "create VM", resource: "vm" });
	const cleanup = new DistributedTeardownError({ runId: "r", remaining: ["/x"], errors: [] });
	assert.equal(attachCleanupFailure(primary, cleanup), primary);
	assert.equal(primary.cleanupCause, cleanup);
	assert.ok(!Object.keys(primary).includes("cleanupCause") || primary.cleanupCause === cleanup);
	const plain = new Error("plain");
	attachCleanupFailure(plain, cleanup);
	assert.equal(Reflect.get(plain, "cleanupCause"), cleanup);
	assert.equal(attachCleanupFailure("text", cleanup), "text");
	assert.equal(attachCleanupFailure(undefined, cleanup), undefined);
});

test("errors round-trip across a process boundary as the same class with fields and causes", () => {
	const cause = new DistributedCommandError({
		tool: "az",
		operation: "create",
		exitCode: 1,
		signal: null,
		detail: "quota",
		retryable: true,
	});
	const primary = new DistributedProvisionError({ step: "create VM", resource: "vm-1", detail: "d", cause });
	attachCleanupFailure(
		primary,
		new DistributedTeardownError({
			runId: "r",
			remaining: ["/a"],
			errors: [new DistributedCommandError({ tool: "az", operation: "delete", exitCode: 2, signal: null })],
		}),
	);
	const wire = JSON.parse(JSON.stringify(serializeDistributedError(primary)));
	assert.deepEqual(Object.keys(wire).sort(), [
		"cause",
		"cleanupCause",
		"code",
		"fields",
		"hint",
		"message",
		"name",
		"retryable",
	]);
	const back = rehydrateDistributedError(wire);
	assert.ok(back instanceof DistributedProvisionError);
	assert.ok(isDistributedProvisionError(back));
	assert.equal(back.message, primary.message);
	assert.equal(back.name, "DistributedProvisionError");
	assert.deepEqual(Reflect.get(back, "fields"), { step: "create VM", resource: "vm-1", detail: "d" });
	assert.equal(Reflect.get(back, "hint"), primary.hint);
	assert.ok(isDistributedCommandError(back.cause));
	assert.equal(Reflect.get(back.cause as object, "retryable"), true);
	assert.ok(isRetryableDistributedError(back));
	const cleanup = Reflect.get(back, "cleanupCause");
	assert.ok(isDistributedTeardownError(cleanup));
	assert.ok(isDistributedCommandError(Reflect.get(cleanup as object, "errors")[0]));
	assert.equal(Reflect.get(Reflect.get(cleanup as object, "errors")[0], "fields").exitCode, 2);
	assert.equal(String(Reflect.get(back, "stack")), `DistributedProvisionError: ${primary.message}`);
	assert.ok(!Object.keys(back).includes("stack"));
	for (const [error] of samples()) {
		const again = rehydrateDistributedError(JSON.parse(JSON.stringify(serializeDistributedError(error))));
		assert.equal(again.constructor, error.constructor, error.name);
		assert.deepEqual(Reflect.get(again, "fields"), Reflect.get(error as object, "fields"));
	}
});

test("unknown names rehydrate into the family base, keeping name and code", () => {
	const future = rehydrateDistributedError({
		name: "WorkerPlacementError",
		code: "no-host",
		message: "m",
		retryable: false,
		fields: { host: "h" },
	});
	assert.ok(future instanceof DistributedTestError);
	assert.equal(future.name, "WorkerPlacementError");
	assert.equal(Reflect.get(future, "code"), "no-host");
	assert.deepEqual(Reflect.get(future, "fields"), { host: "h" });
	const inherited = rehydrateDistributedError({
		name: "toString",
		code: "x",
		message: "m",
		retryable: false,
		fields: {},
	});
	assert.equal(inherited.constructor, DistributedTestError);
});

test("serialization is bounded, cycle-safe and handles non-errors", () => {
	assert.deepEqual(serializeDistributedError("boom"), {
		name: "NonError",
		code: "non-error",
		message: "boom",
		retryable: false,
		fields: {},
	});
	assert.deepEqual(serializeDistributedError(null), {
		name: "NonError",
		code: "non-error",
		message: "null",
		retryable: false,
		fields: {},
	});
	assert.deepEqual(serializeDistributedError({}), {
		name: "Error",
		code: "unclassified",
		message: "",
		retryable: false,
		fields: {},
	});
	assert.deepEqual(serializeDistributedError(Object.assign(new TypeError("t"), { code: 5, fields: "x", hint: 3 })), {
		name: "TypeError",
		code: "unclassified",
		message: "t",
		retryable: false,
		fields: {},
	});
	const cyclic = new Error("loop") as Error & { cause?: unknown };
	cyclic.cause = cyclic;
	assert.deepEqual(serializeDistributedError(cyclic).cause, {
		name: "TruncatedCause",
		code: "truncated",
		message: "cause chain truncated",
		retryable: false,
		fields: {},
	});
	let deep: unknown = new Error("root");
	for (let index = 0; index < MAX_CAUSE_DEPTH + 3; index++)
		deep = new DistributedProvisionError({ step: "s", resource: String(index), cause: deep });
	let depth = 0;
	for (
		let node: { cause?: unknown; code?: string } | undefined = serializeDistributedError(deep);
		node !== undefined;
		node = node.cause as typeof node
	)
		depth++;
	assert.equal(depth, MAX_CAUSE_DEPTH + 1);
	const aggregate = Object.assign(new Error("many"), { errors: [new Error("a"), "b"] });
	assert.deepEqual(
		serializeDistributedError(aggregate).errors?.map((item) => item.message),
		["a", "b"],
	);
});

test("missing prerequisites fail fast with every missing piece and no Azure call", async () => {
	const path = process.env.PATH;
	process.env.PATH = mkdtempSync(join(tmpdir(), "adt-empty-path-"));
	try {
		await assert.rejects(checkPrerequisites(context(), { control, needsBuilder: true }), (error) => {
			assert.ok(isDistributedPrerequisiteError(error));
			assert.equal(Reflect.get(error as object, "code"), "missing-prerequisite");
			const missing = Reflect.get(error as object, "fields").missing as { what: string; fix: string }[];
			assert.deepEqual(
				missing.map((item) => item.what),
				["ssh", "openssl", "crabbox", "az login", "control VNet control-vnet"],
			);
			assert.equal(Reflect.get(error as object, "hint"), `Fix: ${missing.map((item) => item.fix).join("; ")}.`);
			assert.ok(isDistributedCommandError(Reflect.get(error as object, "cause")));
			return true;
		});
		await assert.rejects(checkPrerequisites(context(), { control, needsBuilder: false }), (error) => {
			assert.ok(
				!(Reflect.get(error as object, "fields").missing as { what: string }[]).some(
					(item) => item.what === "crabbox",
				),
			);
			return true;
		});
	} finally {
		process.env.PATH = path;
	}
});

test("commands fail with typed exit, timeout and cancellation outcomes", async () => {
	const log = join(mkdtempSync(join(tmpdir(), "adt-cmd-")), "commands.log");
	const ctx = { log, secrets: new Set(["super-secret-token-value"]) };
	const ok = await runCommand(
		ctx,
		node,
		["-e", "process.stdout.write('out'); process.stderr.write('super-secret-token-value')"],
		{ operation: "ok", timeoutMs: 20_000 },
	);
	assert.deepEqual([ok.exitCode, ok.stdout, ok.stderr], [0, "out", "super-secret-token-value"]);
	const allowed = await runCommand(ctx, node, ["-e", "process.exit(4)"], {
		operation: "allowed",
		timeoutMs: 20_000,
		allowExitCodes: [4],
	});
	assert.equal(allowed.exitCode, 4);
	await assert.rejects(
		runCommand(ctx, node, ["-e", "console.error('a\\nb\\nc\\nd super-secret-token-value'); process.exit(3)"], {
			operation: "fails",
			timeoutMs: 20_000,
			retryableExitCodes: [255],
		}),
		(error) => {
			assert.ok(isDistributedCommandError(error));
			assert.deepEqual(Reflect.get(error as object, "fields"), {
				tool: node,
				operation: "fails",
				exitCode: 3,
				signal: null,
				detail: "b | c | d [redacted]",
			});
			assert.equal(Reflect.get(error as object, "retryable"), false);
			return true;
		},
	);
	await assert.rejects(
		runCommand(ctx, node, ["-e", "process.exit(255)"], {
			operation: "ssh-like",
			timeoutMs: 20_000,
			retryableExitCodes: [255],
		}),
		(error) => Reflect.get(error as object, "retryable") === true,
	);
	await assert.rejects(
		runCommand(ctx, node, ["-e", "setTimeout(() => {}, 60000)"], { operation: "slow", timeoutMs: 200 }),
		(error) => {
			assert.ok(isDistributedTimeoutError(error));
			assert.equal(Reflect.get(error as object, "fields").phase, "slow");
			assert.equal(Reflect.get(error as object, "fields").timeoutMs, 200);
			assert.ok(Reflect.get(error as object, "fields").elapsedMs >= 200);
			return true;
		},
	);
	const controller = new AbortController();
	const reason = new DOMException("stop", "AbortError");
	const pending = runCommand(ctx, node, ["-e", "setTimeout(() => {}, 60000)"], {
		operation: "cancelled",
		timeoutMs: 20_000,
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(reason), 100);
	await assert.rejects(pending, (error) => error === reason);
	await assert.rejects(
		runCommand(ctx, node, ["-e", "1"], { operation: "pre-aborted", timeoutMs: 1000, signal: controller.signal }),
		(error) => error === reason,
	);
	await assert.rejects(
		runCommand(ctx, "/nonexistent/adt-tool", [], { operation: "missing", timeoutMs: 1000 }),
		(error) => {
			assert.ok(isDistributedCommandError(error));
			assert.equal(Reflect.get(error as object, "fields").detail, "spawn failed");
			return true;
		},
	);
	const echoed = await runCommand(ctx, node, ["-e", "process.stdin.pipe(process.stdout)"], {
		operation: "stdin",
		timeoutMs: 20_000,
		input: "piped",
	});
	assert.equal(echoed.stdout, "piped");
	assert.ok(!readFileSync(log, "utf8").includes("super-secret-token-value"));
});

test("a failed create is wrapped with its step and stays recorded in the manifest for cleanup", async () => {
	const dir = mkdtempSync(join(tmpdir(), "adt-fake-az-"));
	writeFileSync(join(dir, "az"), '#!/bin/sh\necho "ERROR: quota exceeded" >&2\nexit 1\n', { mode: 0o755 });
	const path = process.env.PATH;
	process.env.PATH = `${dir}:${path}`;
	try {
		const options = resolveRunOptions(parseRunArgs(["--ref", "main"]), topology, { randomSeed: 1 });
		const plan = buildPlan(options, topology, { runId: "adt2611050230-beef", now: new Date("2026-11-05T02:30:00Z") });
		const manifest = new Manifest(dir, {
			runId: plan.runId,
			resourceGroup: plan.resourceGroup,
			expiresAt: plan.expiresAt,
			subscription: "s",
			control,
			entries: [],
		});
		const azure = new AzureRun({
			context: context(),
			plan,
			topology,
			manifest,
			control,
			controlVnetId: "/c",
			controlPrefixes: ["10.20.0.0/16"],
			sshPublicKey: "/k.pub",
		});
		await assert.rejects(azure.createGroup(), (error) => {
			assert.ok(isDistributedProvisionError(error));
			assert.deepEqual(Reflect.get(error as object, "fields"), {
				step: "create resource group",
				resource: "adt2611050230-beef-rg",
				detail: "",
			});
			assert.ok(isDistributedCommandError(Reflect.get(error as object, "cause")));
			assert.equal(Reflect.get(Reflect.get(error as object, "cause"), "fields").detail, "ERROR: quota exceeded");
			return true;
		});
		assert.deepEqual(Manifest.load(dir).data.entries, [
			{ kind: "group", name: "adt2611050230-beef-rg", scope: "subscription", state: "planned" },
		]);
	} finally {
		process.env.PATH = path;
	}
});

test("the security gate and invariant checks produce their typed failures", () => {
	assert.throws(
		() =>
			gateVerdict([
				{ name: "zero-public-ips", subject: "vm", passed: false, observed: ["1.2.3.4"] },
				{ name: "ok", subject: "x", passed: true, observed: 1 },
			]),
		(error) => {
			assert.ok(isDistributedSecurityError(error));
			assert.deepEqual(Reflect.get(error as object, "fields"), {
				violations: [{ check: "zero-public-ips", subject: "vm", detail: '["1.2.3.4"]' }],
			});
			return true;
		},
	);
	const failures = invariantFailures(
		[
			{ name: "journal-integrity", passed: false, expected: ["ok"], actual: ["bad"] },
			{ name: "x", passed: true, expected: 1, actual: 1 },
		],
		"smoke",
	);
	assert.equal(failures.length, 1);
	assert.ok(isDistributedInvariantError(failures[0]));
	assert.deepEqual(failures[0].fields, {
		invariant: "journal-integrity",
		scenario: "smoke",
		expected: ["ok"],
		actual: ["bad"],
	});
});
