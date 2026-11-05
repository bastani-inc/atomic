import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify, X509Certificate } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, vi } from "vitest";
import {
	isDistributedConfigError,
	isDistributedFeatureUnavailableError,
	isDistributedScenarioPendingError,
	isDistributedSecurityError,
	isDistributedTeardownError,
} from "../distributed/harness/errors.mjs";
import { runLifecycle } from "../distributed/harness/lifecycle.mjs";
import { Manifest } from "../distributed/harness/manifest.mjs";
import { overallStatus, renderMarkdown, suiteStatus, writeReport } from "../distributed/harness/report.mjs";
import { createRunSecrets, loadRunSecrets, mintToken, writeSecretFile } from "../distributed/harness/secrets.mjs";
import { bindViolations, gateVerdict, publicAddressChecks } from "../distributed/harness/security.mjs";
import { FEATURE_PROBES, featureSkip, parseCapabilities, selectedSuites } from "../distributed/harness/suites.mjs";
import { parseSweepArgs, sweep } from "../distributed/sweep.mjs";

const posixOnly = test.skipIf(process.platform === "win32");

type Report = Parameters<typeof renderMarkdown>[0];
type FaultRecord = NonNullable<Report["suites"][number]["faults"]>[number];
type SerializedError = NonNullable<Report["error"]>;
type ReportVm = Report["topology"]["vms"][number];

const report = (overrides: Partial<Report> = {}): Report => ({
	schemaVersion: 1,
	runId: "r",
	startedAt: "2026-11-05T02:30:00.000Z",
	command: "node test/distributed/run.mjs --suite smoke",
	replay: {
		ref: "main",
		suite: "smoke",
		chaos: "none",
		nodes: 3,
		regions: ["eastus2"],
		seed: 1,
		prng: "mulberry32/v1",
		dbStorage: "premium-ssd",
		dbRegion: "westus3",
	},
	topology: { resourceGroup: "r-rg", expiresAt: "2026-11-05T06:30:00.000Z", vms: [] },
	suites: [],
	coverage: [],
	durations: {},
	environment: {},
	...overrides,
});

const reportVm = (overrides: Pick<ReportVm, "name" | "roles" | "region" | "size"> & Partial<ReportVm>): ReportVm => ({
	kind: "node",
	template: "large",
	hostIndex: 4,
	secondaryNic: false,
	dataDisk: false,
	encryptionAtHost: false,
	...overrides,
});

const fault = (overrides: Pick<FaultRecord, "profile" | "target"> & Partial<FaultRecord>): FaultRecord => ({
	parameters: {},
	applied: true,
	effectObserved: false,
	recovered: false,
	observed: {},
	timeline: [],
	...overrides,
});

const serialized = (overrides: Pick<SerializedError, "name" | "code" | "message">): SerializedError => ({
	retryable: false,
	fields: {},
	...overrides,
});

const lifecycle = (overrides: Partial<Parameters<typeof runLifecycle>[0]> & { log?: string[] } = {}) => {
	const log = overrides.log ?? [];
	const step = (name: string, fail?: unknown) => ({
		name,
		run: async () => {
			log.push(name);
			if (fail !== undefined) throw fail;
		},
	});
	return {
		log,
		run: () =>
			runLifecycle({
				steps: [step("provision"), step("security-gate")],
				scenarios: async () => void log.push("scenarios"),
				teardown: async () => {
					log.push("teardown");
					return { ok: true };
				},
				provisioned: () => true,
				keep: false,
				...overrides,
				...(overrides.steps === undefined ? {} : { steps: overrides.steps }),
			}),
		step,
	};
};

test("scenarios start only after every step, and teardown always follows", async () => {
	const ok = lifecycle();
	const outcome = await ok.run();
	assert.deepEqual(ok.log, ["provision", "security-gate", "scenarios", "teardown"]);
	assert.deepEqual(outcome, {
		completed: ["provision", "security-gate"],
		scenariosStarted: true,
		error: undefined,
		cancelled: false,
		teardown: { ok: true },
		teardownSkipped: undefined,
	});
});

test("a failed security gate starts zero scenarios and still tears down (#4331)", async () => {
	const log: string[] = [];
	const gateFailure = (() => {
		try {
			gateVerdict([{ name: "zero-public-ips", subject: "vm", passed: false, observed: ["20.1.1.1"] }]);
		} catch (error) {
			return error;
		}
	})();
	const harness = lifecycle({ log });
	const outcome = await runLifecycle({
		steps: [harness.step("provision"), harness.step("security-gate", gateFailure), harness.step("never")],
		scenarios: async () => void log.push("scenarios"),
		teardown: async () => {
			log.push("teardown");
			return { ok: true };
		},
		provisioned: () => true,
		keep: false,
	});
	assert.deepEqual(log, ["provision", "security-gate", "teardown"]);
	assert.equal(outcome.scenariosStarted, false);
	assert.deepEqual(outcome.completed, ["provision"]);
	assert.ok(isDistributedSecurityError(outcome.error));
	assert.equal(outcome.cancelled, false);
	assert.deepEqual(outcome.teardown, { ok: true });
});

test("--keep never keeps a topology whose security gate failed (#4331)", async () => {
	const gateFailure = new Error("gate failed");
	const run = async (steps: { name: string; fail?: Error; teardownOnFailure?: boolean }[], scenarios?: Error) => {
		const log: string[] = [];
		const outcome = await runLifecycle({
			steps: steps.map(({ name, fail, teardownOnFailure }) => ({
				name,
				...(teardownOnFailure === undefined ? {} : { teardownOnFailure }),
				run: async () => {
					log.push(name);
					if (fail !== undefined) throw fail;
				},
			})),
			scenarios: async () => {
				log.push("scenarios");
				if (scenarios !== undefined) throw scenarios;
			},
			teardown: async () => {
				log.push("teardown");
				return { ok: true };
			},
			provisioned: () => true,
			keep: true,
		});
		return { log, outcome };
	};
	const failedGate = await run([
		{ name: "provision" },
		{ name: "security-gate", fail: gateFailure, teardownOnFailure: true },
	]);
	assert.deepEqual(failedGate.log, ["provision", "security-gate", "teardown"]);
	assert.equal(failedGate.outcome.error, gateFailure);
	assert.equal(failedGate.outcome.teardownSkipped, undefined);
	assert.deepEqual(failedGate.outcome.teardown, { ok: true });
	const failedScenario = await run(
		[{ name: "provision" }, { name: "security-gate", teardownOnFailure: true }],
		new Error("scenario failed"),
	);
	assert.deepEqual(failedScenario.log, ["provision", "security-gate", "scenarios"]);
	assert.equal(failedScenario.outcome.teardownSkipped, "kept");
	const failedAfterGate = await run([
		{ name: "security-gate", teardownOnFailure: true },
		{ name: "deploy", fail: new Error("deploy failed") },
	]);
	assert.deepEqual(failedAfterGate.log, ["security-gate", "deploy"]);
	assert.equal(failedAfterGate.outcome.teardownSkipped, "kept");
	const failedProvision = await run([{ name: "provision", fail: new Error("quota"), teardownOnFailure: false }]);
	assert.equal(failedProvision.outcome.teardownSkipped, "kept");
	const noSteps = await run([], new Error("scenario failed"));
	assert.deepEqual(noSteps.log, ["scenarios"]);
	assert.equal(noSteps.outcome.teardownSkipped, "kept");
});

test("a teardown failure is attached to the primary failure, or reported on its own", async () => {
	const primary = new Error("scenario broke");
	const cleanup = new Error("group delete failed");
	const failing = await lifecycle({
		scenarios: async () => Promise.reject(primary),
		teardown: async () => ({ ok: false, error: cleanup }),
	}).run();
	assert.equal(failing.error, primary);
	assert.equal(Reflect.get(primary, "cleanupCause"), cleanup);
	const thrown = new Error("teardown threw");
	const primary2 = new Error("p");
	const throwing = await lifecycle({
		scenarios: async () => Promise.reject(primary2),
		teardown: async () => Promise.reject(thrown),
	}).run();
	assert.equal(throwing.error, primary2);
	assert.deepEqual(throwing.teardown, { ok: false, error: thrown });
	assert.equal(Reflect.get(primary2, "cleanupCause"), thrown);
	const alone = await lifecycle({ teardown: async () => ({ ok: false, error: cleanup }) }).run();
	assert.equal(alone.error, undefined);
	assert.deepEqual(alone.teardown, { ok: false, error: cleanup });
	const aloneThrown = await lifecycle({ teardown: async () => Promise.reject(thrown) }).run();
	assert.equal(aloneThrown.error, undefined);
	assert.deepEqual(aloneThrown.teardown, { ok: false, error: thrown });
});

test("keep and nothing-provisioned skip teardown; cancellation stays a cancellation", async () => {
	const kept = lifecycle();
	assert.equal((await lifecycle({ keep: true, log: kept.log }).run()).teardownSkipped, "kept");
	assert.ok(!kept.log.includes("teardown"));
	const empty = lifecycle({ provisioned: () => false });
	const nothing = await empty.run();
	assert.equal(nothing.teardownSkipped, "nothing-provisioned");
	assert.ok(!empty.log.includes("teardown"));
	const controller = new AbortController();
	const reason = new DOMException("SIGINT", "AbortError");
	const harness = lifecycle();
	const outcome = await runLifecycle({
		steps: [{ name: "provision", run: async () => controller.abort(reason) }, harness.step("security-gate")],
		scenarios: async () => void harness.log.push("scenarios"),
		teardown: async () => {
			harness.log.push("teardown");
			return { ok: true };
		},
		provisioned: () => true,
		keep: false,
		signal: controller.signal,
	});
	assert.equal(outcome.error, reason);
	assert.equal(outcome.cancelled, true);
	assert.deepEqual(harness.log, ["teardown"]);
	const late = new AbortController();
	const lateOutcome = await runLifecycle({
		steps: [{ name: "gate", run: async () => late.abort(reason) }],
		scenarios: async () => assert.fail("scenarios must not start after cancellation"),
		teardown: async () => ({ ok: true }),
		provisioned: () => true,
		keep: false,
		signal: late.signal,
	});
	assert.deepEqual(
		[lateOutcome.completed, lateOutcome.scenariosStarted, lateOutcome.cancelled],
		[["gate"], false, true],
	);
});

test("sqld must listen on loopback for HTTP and admin, and the private address for TLS and replication", () => {
	const expected = { privateIp: "10.60.0.10", gatewayPort: 8443, replicationPort: 5001, loopbackPorts: [8080, 9090] };
	assert.deepEqual(
		bindViolations(
			["0.0.0.0:22", "127.0.0.1:8080", "127.0.0.1:9090", "10.60.0.10:8443", "10.60.0.10:5001", "127.0.0.53%lo:53"],
			expected,
		),
		[],
	);
	assert.deepEqual(
		bindViolations(["0.0.0.0:8080", "[::]:9090", "0.0.0.0:8443", "10.60.0.10:8443", "*:5001"], expected),
		["0.0.0.0:8080", "[::]:9090", "0.0.0.0:8443", "*:5001"],
	);
	assert.deepEqual(bindViolations(["127.0.0.1:8080"], expected), ["missing 10.60.0.10:8443"]);
	assert.deepEqual(bindViolations([], expected), ["missing 10.60.0.10:8443"]);
});

test("a planned VM missing from the public-IP listing fails the gate instead of going unchecked (#4331)", () => {
	const listed = [
		{ vm: "n1", publicIps: [] },
		{ vm: "n3", publicIps: [] },
		{ vm: "n3", publicIps: ["20.1.1.1"] },
		{ vm: "stray", publicIps: [] },
	];
	const checks = publicAddressChecks(listed, ["n1", "n2", "n3"]);
	assert.deepEqual(checks, [
		{ name: "zero-public-ips", subject: "n1", passed: true, observed: [] },
		{ name: "zero-public-ips", subject: "n3", passed: true, observed: [] },
		{ name: "zero-public-ips", subject: "n3", passed: false, observed: ["20.1.1.1"] },
		{ name: "zero-public-ips", subject: "stray", passed: true, observed: [] },
		{ name: "zero-public-ips", subject: "n2", passed: false, observed: "missing from the listing" },
	]);
	assert.notEqual(checks[2].observed, listed[2].publicIps);
	assert.throws(
		() => gateVerdict(publicAddressChecks([{ vm: "n1", publicIps: [] }], ["n1", "n2"])),
		(error) => {
			assert.ok(isDistributedSecurityError(error));
			assert.deepEqual(Reflect.get(error as object, "fields").violations, [
				{ check: "zero-public-ips", subject: "n2", detail: '"missing from the listing"' },
			]);
			return true;
		},
	);
	assert.deepEqual(publicAddressChecks([], []), []);
	assert.deepEqual(publicAddressChecks([{ vm: "n1", publicIps: [] }], ["n1"]).length, 1);
});

test("the gate passes only with checks that all passed", () => {
	const checks = [{ name: "a", subject: "s", passed: true, observed: 1 }];
	assert.deepEqual(gateVerdict(checks), { passed: true, checks });
	assert.notEqual(gateVerdict(checks).checks, checks);
	assert.throws(
		() => gateVerdict([]),
		(error) =>
			isDistributedSecurityError(error) && Reflect.get(error as object, "fields").violations[0].check === "gate-ran",
	);
	assert.throws(
		() =>
			gateVerdict([
				{ name: "x", subject: "s", passed: false, observed: "y".repeat(500) },
				{ name: "z", subject: "t", passed: false, observed: undefined },
			]),
		(error) => {
			const violations = Reflect.get(error as object, "fields").violations;
			assert.equal(violations[0].detail.length, 300);
			assert.equal(violations[1].detail, "");
			assert.equal(
				(error as Error).message,
				"The security gate found 2 violation(s): x, z (security-check-failed). No scenario ran and the run was torn down; fix the network or database configuration named in the violations.",
			);
			return true;
		},
	);
});

const capabilities = (extra: { workflows?: string[]; atomic?: string[]; members?: Record<string, string[]> } = {}) => ({
	workflows: ["resolveRunJournal", ...(extra.workflows ?? [])],
	atomic: ["createAgentSession", ...(extra.atomic ?? [])],
	members: extra.members ?? {},
});

test("feature suites skip with a typed reason when the ref lacks their interface", () => {
	assert.deepEqual(Object.keys(FEATURE_PROBES), [
		"multi-node-resume",
		"cross-host-pools",
		"shard-contention",
		"idle-density",
		"subscription-flood",
		"fork-under-load",
		"restore-cold",
		"team-ci",
		"pool-scale",
		"compaction",
	]);
	const missing = featureSkip("fork-under-load", capabilities());
	assert.ok(isDistributedFeatureUnavailableError(missing));
	assert.deepEqual(missing?.fields, { suite: "fork-under-load", issue: "#4321", capability: "export forkRun" });
	assert.equal(
		missing?.message,
		"Suite fork-under-load needs export forkRun from #4321, which the ref under test does not provide (feature-unavailable). Run the suite against a ref that contains #4321.",
	);
	const pending = featureSkip("fork-under-load", capabilities({ workflows: ["forkRun"] }));
	assert.ok(isDistributedScenarioPendingError(pending));
	assert.ok(
		isDistributedScenarioPendingError(featureSkip("restore-cold", capabilities({ atomic: ["GitProvisionError"] }))),
	);
	assert.ok(
		isDistributedFeatureUnavailableError(
			featureSkip("idle-density", capabilities({ members: { "atomic.AgentSessionRuntime": ["fork"] } })),
		),
	);
	assert.ok(
		isDistributedScenarioPendingError(
			featureSkip("idle-density", capabilities({ members: { "atomic.AgentSessionRuntime": ["rehydrate"] } })),
		),
	);
	assert.ok(
		isDistributedFeatureUnavailableError(
			featureSkip(
				"compaction",
				capabilities({ members: { "atomic.AgentSessionRuntime": ["awaitBackgroundCompaction"] } }),
			),
		),
	);
	assert.ok(
		isDistributedScenarioPendingError(
			featureSkip("compaction", capabilities({ members: { "atomic.AgentSession": ["awaitBackgroundCompaction"] } })),
		),
	);
	assert.equal(featureSkip("smoke", capabilities()), undefined);
	for (const [suite, probe] of Object.entries(FEATURE_PROBES)) assert.equal(probe.implemented, false, suite);
});

test("a malformed capabilities document is a broken deployment, not a missing feature", () => {
	assert.deepEqual(parseCapabilities({ workflows: ["a"], atomic: ["b"], members: { x: ["c"] }, artifact: {} }), {
		workflows: ["a"],
		atomic: ["b"],
		members: { x: ["c"] },
	});
	for (const bad of [
		null,
		"x",
		{},
		{ workflows: ["a"], atomic: ["b"] },
		{ workflows: "a", atomic: [], members: {} },
		{ workflows: [], atomic: [1], members: {} },
		{ workflows: [], atomic: [], members: { x: [1] } },
		{ workflows: [], atomic: [], members: null },
	]) {
		assert.equal(parseCapabilities(bad), undefined, JSON.stringify(bad));
	}
	assert.deepEqual(selectedSuites("all").length, 11);
	assert.deepEqual(selectedSuites("compaction"), ["compaction"]);
});

test("run status: cancelled, then failure, then incomplete coverage or teardown", () => {
	const passed = {
		cancelled: false,
		error: undefined,
		suites: [{ name: "s", issue: "#1", status: "passed" as const }],
		coverage: [{ status: "exercised" }],
		teardownOk: true,
	};
	assert.equal(overallStatus(passed), "passed");
	assert.equal(overallStatus({ ...passed, teardownOk: null }), "passed");
	assert.equal(overallStatus({ ...passed, cancelled: true, error: new Error("x") }), "cancelled");
	assert.equal(overallStatus({ ...passed, error: new Error("x") }), "failed");
	assert.equal(overallStatus({ ...passed, suites: [{ name: "s", issue: "#1", status: "failed" }] }), "failed");
	assert.equal(overallStatus({ ...passed, suites: [{ name: "s", issue: "#1", status: "skipped" }] }), "passed");
	assert.equal(overallStatus({ ...passed, coverage: [{ status: "incomplete" }] }), "failed");
	assert.equal(overallStatus({ ...passed, coverage: [{ status: "missing" }] }), "failed");
	assert.equal(overallStatus({ ...passed, coverage: [{ status: "skipped" }] }), "passed");
	assert.equal(overallStatus({ ...passed, teardownOk: false }), "failed");
	assert.equal(suiteStatus([{ name: "i", passed: true, expected: 1, actual: 1 }], [{}]), "passed");
	assert.equal(suiteStatus([], []), "failed");
	assert.equal(suiteStatus([{ name: "i", passed: false, expected: 1, actual: 2 }], []), "failed");
	assert.equal(
		suiteStatus([{ name: "i", passed: true, expected: 1, actual: 1 }], [{ error: new Error("x") }]),
		"failed",
	);
});

test("the report is rendered from one object and never contains a registered secret", () => {
	const dir = mkdtempSync(join(tmpdir(), "adt-report-"));
	const token = "eyJhbGciOiJFZERTQSJ9.eyJwIjp7fX0.c2lnbmF0dXJlLXZhbHVl";
	const fixture = report({
		runId: "adt2611050230-beef",
		status: "passed",
		replay: {
			ref: "main",
			sha: "a".repeat(40),
			suite: "smoke",
			chaos: "smoke",
			nodes: 3,
			regions: ["eastus2", "westus3"],
			seed: 4331,
			prng: "mulberry32/v1",
			artifactDigest: "d",
			dbStorage: "premium-ssd",
			dbRegion: "westus3",
		},
		nvmeSkip: { code: "encryption-at-host-unavailable", detail: "EncryptionAtHost is not registered" },
		topology: {
			resourceGroup: "adt2611050230-beef-rg",
			expiresAt: "2026-11-05T06:30:00.000Z",
			vms: [reportVm({ name: "vm|1", roles: ["large"], region: "eastus2", size: "s", privateIp: "10.60.0.20" })],
		},
		security: {
			passed: true,
			checks: [
				{ name: "zero-public-ips", subject: "vm", passed: true, observed: [] },
				{ name: "tokenless-rejected", subject: "n", passed: false, observed: { leaked: token } },
			],
		},
		suites: [
			{
				name: "smoke",
				issue: "#4331",
				status: "passed",
				invariants: [{ name: "journal-integrity", passed: true, expected: ["ok"], actual: ["ok"] }],
				faults: [
					fault({
						profile: "partition",
						target: "n1",
						effectObserved: true,
						recovered: true,
						observed: { secret: "my-shared-secret-value" },
						timeline: [{ at: 5, event: "applied" }],
					}),
				],
				metrics: {
					sharedJournal: { entries: 1, epochs: [1], atLeastOnceReplays: 0, writers: 1 },
					writerErrors: [],
					appendLatencyMs: { count: 0, median: null, p10: null, p90: null },
				},
			},
			{
				name: "compaction",
				issue: "#4330",
				status: "skipped",
				reason: serialized({
					name: "DistributedFeatureUnavailableError",
					code: "feature-unavailable",
					message: "m",
				}),
			},
		],
		coverage: [
			{ profile: "partition", status: "exercised" },
			{ profile: "oom", status: "missing" },
		],
		teardown: {
			ok: true,
			steps: [],
			queries: [
				{ label: "resources", command: "az resource list", ok: true, result: [] },
				{ label: "groups", command: "az group list", ok: false, result: [] },
			],
			remaining: [],
		},
		error: serialized({ name: "DistributedProvisionError", code: "provision-failed", message: `boom ${token}` }),
		durations: { total: 1 },
	});
	const paths = writeReport(dir, fixture, ["my-shared-secret-value"]);
	assert.deepEqual(paths, { json: join(dir, "report.json"), markdown: join(dir, "report.md") });
	const json = readFileSync(paths.json, "utf8");
	const markdown = readFileSync(paths.markdown, "utf8");
	for (const text of [json, markdown]) {
		assert.ok(!text.includes(token));
		assert.ok(!text.includes("my-shared-secret-value"));
	}
	assert.equal(JSON.parse(json).paths.markdown, paths.markdown);
	assert.ok(markdown.startsWith("# Distributed test run adt2611050230-beef\n\nStatus: **passed**"));
	for (const fragment of [
		'| vm\\|1 | node | ["large"] | eastus2 | s | 10.60.0.20 |',
		"(local NVMe skipped: encryption-at-host-unavailable)",
		"| zero-public-ips | vm | yes | [] |",
		"| tokenless-rejected | n | **no** |",
		"| compaction | #4330 | skipped | `feature-unavailable`: m |",
		"| partition | exercised | n1 | true | true |",
		"| oom | missing |",
		'| journal-integrity | yes | ["ok"] | ["ok"] |',
		"| 5 | partition | applied |",
		"- `az resource list` → []",
		"- `az group list` → query failed",
		"Result: **zero resources left**",
		"`DistributedProvisionError` (`provision-failed`)",
		`--replay ${paths.json}`,
	]) {
		assert.ok(markdown.includes(fragment), fragment);
	}
	const minimal = renderMarkdown(report({ status: "failed" }));
	assert.ok(minimal.includes("Result: **not run**"));
	assert.ok(minimal.includes("Database storage: premium-ssd\n"));
	assert.ok(
		renderMarkdown(
			report({
				status: "failed",
				security: { passed: false, checks: [] },
				teardown: { ok: false, steps: [], queries: [], remaining: [] },
			}),
		).includes("Result: **incomplete**"),
	);
	assert.ok(
		renderMarkdown(report({ status: "failed", security: { passed: false, checks: [] } })).includes(
			"Result: **failed**",
		),
	);
	const kept = renderMarkdown(
		report({
			status: "passed",
			teardown: {
				ok: null,
				kept: true,
				expiresAt: "2026-11-05T06:30:00.000Z",
				reuse: "node test/distributed/run.mjs --reuse r",
				sweep: "node test/distributed/sweep.mjs --run-id r --force",
			},
		}),
	);
	assert.ok(
		kept.includes("## Teardown\n\nResult: **incomplete**\n\n\n## Phase durations"),
		"a kept run lists no queries",
	);
});

test("tokens are EdDSA JWTs sqld accepts and scoped to the run's namespaces", async () => {
	const keys = generateKeyPairSync("ed25519");
	const token = mintToken(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
		namespaces: ["smoke"],
		issuedAt: 100,
		expiresAt: 200,
	});
	const [header, body, signature] = token.split(".");
	assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "EdDSA", typ: "JWT" });
	assert.deepEqual(JSON.parse(Buffer.from(body, "base64url").toString()), {
		iat: 100,
		exp: 200,
		p: { rw: { ns: ["smoke"] } },
	});
	assert.ok(verify(null, Buffer.from(`${header}.${body}`), keys.publicKey, Buffer.from(signature, "base64url")));
	const dir = join(mkdtempSync(join(tmpdir(), "adt-secrets-")), "secrets");
	const context = { secrets: new Set<string>() };
	const secrets = await createRunSecrets(context, {
		dir,
		runId: "adt2611050230-beef",
		hosts: [{ name: "db", ip: "10.60.0.10" }],
		namespaces: ["smoke"],
		validHours: 6,
	});
	assert.deepEqual([...context.secrets], secrets.tokenValues);
	const [own, foreign] = secrets.tokenValues;
	const publicKey = createPublicKey(readFileSync(secrets.jwtPublicKey));
	const check = (value: string) => {
		const [h, b, s] = value.split(".");
		return verify(null, Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, "base64url"));
	};
	assert.ok(check(own));
	assert.ok(!check(foreign));
	const claims = JSON.parse(Buffer.from(own.split(".")[1], "base64url").toString());
	assert.equal(claims.exp - claims.iat, 300 + 6 * 3600);
	const certificate = readFileSync(secrets.hostCert("db").cert, "utf8");
	assert.ok(certificate.startsWith("-----BEGIN CERTIFICATE-----"));
	const reloadContext = { secrets: new Set<string>(["earlier"]) };
	const reloaded = loadRunSecrets(reloadContext, dir);
	assert.deepEqual([...reloadContext.secrets], ["earlier", ...secrets.tokenValues]);
	const { hostCert: reloadedHost, ...reloadedPaths } = reloaded;
	const { hostCert: createdHost, ...createdPaths } = secrets;
	assert.deepEqual(reloadedPaths, createdPaths);
	assert.deepEqual(createdPaths, {
		dir,
		caCert: join(dir, "ca.pem"),
		decoyCaCert: join(dir, "decoy-ca.pem"),
		jwtPublicKey: join(dir, "jwt.pub"),
		token: join(dir, "token"),
		foreignToken: join(dir, "foreign-token"),
		tokenValues: secrets.tokenValues,
	});
	assert.deepEqual(reloadedHost("db"), createdHost("db"));
	assert.deepEqual(createdHost("db"), { cert: join(dir, "db.pem"), key: join(dir, "db.key") });
});

posixOnly("reports, manifests and run secrets are owner-only files (#4331)", async () => {
	const root = mkdtempSync(join(tmpdir(), "adt-modes-"));
	const written = writeReport(root, report({ status: "passed" }), []);
	const manifest = new Manifest(root, {
		runId: "r",
		resourceGroup: "g",
		expiresAt: "e",
		subscription: "s",
		control: { resourceGroup: "c", vnet: "v" },
		entries: [],
	});
	manifest.plan("vm", "r-n1", "g");
	const dir = join(root, "nested", "secrets");
	await createRunSecrets(
		{ secrets: new Set<string>() },
		{
			dir,
			runId: "adt2611050230-beef",
			hosts: [{ name: "db", ip: "10.60.0.10" }],
			namespaces: ["smoke"],
			validHours: 6,
		},
	);
	const mode = (path: string) => statSync(path).mode & 0o777;
	assert.equal(mode(written.json), 0o600);
	assert.equal(mode(written.markdown), 0o600);
	assert.equal(mode(join(root, "manifest.json")), 0o600);
	assert.equal(mode(dir), 0o700);
	for (const file of ["token", "foreign-token", "jwt.key", "jwt.pub", "ca.key", "decoy-ca.key", "db.key"])
		assert.equal(mode(join(dir, file)), 0o600, file);
	const existing = join(root, "existing");
	writeFileSync(existing, "old", { mode: 0o644 });
	chmodSync(existing, 0o644);
	writeSecretFile(existing, "new");
	assert.equal(mode(existing), 0o600);
	assert.equal(readFileSync(existing, "utf8"), "new");
});

test("run tokens are issued five minutes in the past and expire after the TTL plus that margin", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(1_800_000_000_750));
	try {
		const dir = join(mkdtempSync(join(tmpdir(), "adt-claims-")), "secrets");
		const secrets = await createRunSecrets(
			{ secrets: new Set<string>() },
			{ dir, runId: "adt2611050230-beef", hosts: [], namespaces: ["smoke", "other"], validHours: 0.0001 },
		);
		for (const value of secrets.tokenValues) {
			assert.deepEqual(JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString()), {
				iat: 1_800_000_000 - 300,
				exp: 1_800_000_000 - 300 + 300 + 1,
				p: { rw: { ns: ["smoke", "other"] } },
			});
		}
		assert.equal(readFileSync(secrets.token, "utf8"), `${secrets.tokenValues[0]}\n`);
		assert.equal(readFileSync(secrets.foreignToken, "utf8"), `${secrets.tokenValues[1]}\n`);
	} finally {
		vi.useRealTimers();
	}
});

test("the run CA signs host certificates for the database names and address, valid for the TTL in whole days", async () => {
	const validity = async (validHours: number) => {
		const dir = join(mkdtempSync(join(tmpdir(), "adt-certs-")), "secrets");
		const log = join(dirname(dir), "commands.log");
		const secrets = await createRunSecrets(
			{ log, secrets: new Set<string>() },
			{
				dir,
				runId: "adt2611050230-beef",
				hosts: [{ name: "db-primary", ip: "10.60.0.10" }],
				namespaces: [],
				validHours,
			},
		);
		const ca = new X509Certificate(readFileSync(secrets.caCert));
		const decoy = new X509Certificate(readFileSync(secrets.decoyCaCert));
		const host = new X509Certificate(readFileSync(secrets.hostCert("db-primary").cert));
		const days = (certificate: X509Certificate) =>
			Math.round((Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)) / 86_400_000);
		return { secrets, ca, decoy, host, log, days: [days(ca), days(decoy), days(host)] };
	};
	const { secrets, ca, decoy, host, log, days } = await validity(6);
	assert.deepEqual(
		readFileSync(log, "utf8")
			.split("\n")
			.filter((line) => line.includes(" $ openssl "))
			.map((line) => line.slice(line.lastIndexOf("  # ") + 4)),
		["create ca", "create decoy-ca", "create db-primary key", "sign db-primary certificate"],
	);
	const extensions = (path: string) =>
		execFileSync("openssl", ["x509", "-noout", "-ext", "basicConstraints,keyUsage", "-in", path], {
			encoding: "utf8",
		})
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
	for (const path of [secrets.caCert, secrets.decoyCaCert]) {
		assert.deepEqual(extensions(path), [
			"X509v3 Basic Constraints: critical",
			"CA:TRUE",
			"X509v3 Key Usage: critical",
			"Certificate Sign, CRL Sign",
		]);
	}
	assert.deepEqual(days, [2, 2, 2]);
	assert.equal(ca.subject, "CN=atomic-distributed-test adt2611050230-beef CA");
	assert.equal(decoy.subject, "CN=atomic-distributed-test adt2611050230-beef decoy CA");
	assert.equal(host.subject, "CN=db-primary");
	assert.equal(host.issuer, ca.subject);
	assert.equal(ca.ca, true);
	assert.equal(decoy.ca, true);
	assert.equal(host.ca, false);
	assert.ok(host.verify(ca.publicKey));
	assert.ok(!host.verify(decoy.publicKey));
	assert.equal(host.subjectAltName, "DNS:sqld, DNS:db-primary, IP Address:10.60.0.10");
	assert.deepEqual(host.keyUsage?.sort(), ["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"]);
	assert.equal(host.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
	assert.equal(ca.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
	assert.equal(
		createPrivateKey(readFileSync(secrets.hostCert("db-primary").key)).asymmetricKeyDetails?.namedCurve,
		"prime256v1",
	);
	assert.deepEqual((await validity(49)).days, [4, 4, 4]);
	assert.deepEqual((await validity(0)).days, [1, 1, 1]);
});

test("the manifest records planned resources before creation and survives a reload", () => {
	const dir = mkdtempSync(join(tmpdir(), "adt-manifest-"));
	const manifest = new Manifest(dir, {
		runId: "r",
		resourceGroup: "g",
		expiresAt: "e",
		subscription: "s",
		control: { resourceGroup: "c", vnet: "v" },
		entries: [],
	});
	manifest.plan("peering", "r-eastus2-from-control", "c/v");
	manifest.plan("peering", "r-eastus2-from-control", "c/v");
	manifest.plan("vm", "r-n1", "g");
	manifest.mark("vm", "r-n1", "g", "created");
	manifest.mark("vm", "absent", "g", "created");
	manifest.setBuilder("slug");
	const loaded = Manifest.load(dir);
	assert.deepEqual(loaded.data.entries, [
		{ kind: "peering", name: "r-eastus2-from-control", scope: "c/v", state: "planned" },
		{ kind: "vm", name: "r-n1", scope: "g", state: "created" },
	]);
	assert.equal(loaded.data.builder, "slug");
});

test("the sweeper's flags are validated before any az call", () => {
	assert.deepEqual(parseSweepArgs([]), { dryRun: false, force: false });
	assert.deepEqual(parseSweepArgs(["--dry-run", "--run-id", "adt2611050230-beef", "--force"]), {
		dryRun: true,
		force: true,
		runId: "adt2611050230-beef",
	});
	assert.equal(parseSweepArgs(["--now", "2026-11-05T00:00:00Z"]).now?.toISOString(), "2026-11-05T00:00:00.000Z");
	for (const [argv, field, reason] of [
		[["--force"], "--force", "invalid-value"],
		[["--run-id", "shared-runners"], "--run-id", "invalid-value"],
		[["--run-id"], "--run-id", "missing-value"],
		[["--now", "--dry-run"], "--now", "missing-value"],
		[["--now", "yesterday"], "--now", "invalid-value"],
		[["--delete-everything"], "--delete-everything", "unknown-flag"],
		[["--topology", "t.json"], "--topology", "unknown-flag"],
	] as const) {
		assert.throws(
			() => parseSweepArgs([...argv]),
			(error) =>
				isDistributedConfigError(error) &&
				Reflect.get(error as object, "fields").field === field &&
				Reflect.get(error as object, "fields").reason === reason,
			argv.join(" "),
		);
	}
});

test("the sweeper re-reads tags, deletes only expired runs and proves their absence", async () => {
	const expired = "adt2611050230-0001";
	const fresh = "adt2611050230-0002";
	const calls: string[] = [];
	const deleted = new Set<string>();
	const az = async (args: readonly string[], operation: string) => {
		calls.push(operation);
		const line = args.join(" ");
		if (line.startsWith("group list --query [?tags."))
			return [
				{ id: "/g1", name: `${expired}-rg` },
				{ id: "/g2", name: `${fresh}-rg` },
			];
		if (line.startsWith(`group show --name ${expired}-rg`))
			return {
				id: "/g1",
				name: `${expired}-rg`,
				tags: { "atomic-distributed-test": expired, "atomic-distributed-test-expiry": "2026-11-05T00:00:00Z" },
			};
		if (line.startsWith(`group show --name ${fresh}-rg`))
			return {
				id: "/g2",
				name: `${fresh}-rg`,
				tags: { "atomic-distributed-test": fresh, "atomic-distributed-test-expiry": "2026-11-06T00:00:00Z" },
			};
		if (line.startsWith("resource list --tag atomic-distributed-test --query"))
			return [
				{ id: "/stray", name: "stray", resourceGroup: "shared" },
				{ id: "/in", name: "in", resourceGroup: `${expired}-RG` },
			];
		if (line.startsWith("resource show --ids /stray"))
			return {
				"atomic-distributed-test": "adt2611050230-0003",
				"atomic-distributed-test-expiry": "2026-11-04T00:00:00Z",
			};
		if (
			line ===
			"network vnet peering list --resource-group control-rg --vnet-name control-vnet --query [].{name:name}"
		)
			return [{ name: `${expired}-eastus2-from-control` }, { name: `${fresh}-eastus2-from-control` }];
		if (line === "group list --query [].name") return [`${expired}-rg`, `${fresh}-rg`];
		if (
			line.startsWith(
				"network vnet peering list --resource-group control-rg --vnet-name control-vnet --query [].name",
			)
		)
			return [`${expired}-eastus2-from-control`, `${fresh}-eastus2-from-control`].filter(
				(name) => !deleted.has(name),
			);
		if (line.startsWith("network vnet peering delete")) {
			deleted.add(args[args.indexOf("--name") + 1]);
			return null;
		}
		if (line.startsWith("group exists")) return args[3] === `${expired}-rg`;
		if (line.startsWith("group delete") || line.startsWith("resource delete")) return null;
		return [];
	};
	const logs: string[] = [];
	const result = await sweep({
		az,
		control: { resourceGroup: "control-rg", vnet: "control-vnet" },
		now: new Date("2026-11-05T12:00:00Z"),
		force: false,
		dryRun: false,
		sleep: async () => {},
		clock: () => 0,
		log: (line) => logs.push(line),
	});
	assert.deepEqual(result.plan.groups, [{ name: `${expired}-rg`, runId: expired }]);
	assert.deepEqual(result.plan.resources, [{ id: "/stray", runId: "adt2611050230-0003" }]);
	assert.deepEqual(result.plan.controlPeerings, [{ name: `${expired}-eastus2-from-control`, runId: expired }]);
	assert.deepEqual(
		result.runs.map((run) => [run.runId, run.ok]),
		[
			[expired, true],
			["adt2611050230-0003", true],
		],
	);
	assert.ok(calls.includes(`delete control peering ${expired}-eastus2-from-control`));
	assert.ok(!calls.includes(`delete control peering ${fresh}-eastus2-from-control`));
	assert.ok(calls.includes(`delete resource group ${expired}-rg`));
	assert.ok(!calls.includes(`delete resource group ${fresh}-rg`));
	assert.ok(calls.includes("delete /stray"));
	assert.ok(!calls.some((call) => call.includes("read tags of in")));
	assert.deepEqual(logs, [
		"sweep plan: 1 group(s), 1 resource(s), 1 control peering(s); kept 2",
		`tearing down ${expired}`,
		"tearing down adt2611050230-0003",
	]);
	const before = calls.length;
	const dry = await sweep({
		az,
		control: { resourceGroup: "control-rg", vnet: "control-vnet" },
		now: new Date("2026-11-05T12:00:00Z"),
		force: false,
		dryRun: true,
		sleep: async () => {},
		clock: () => 0,
		log: () => {},
	});
	assert.deepEqual(dry.runs, []);
	assert.ok(!calls.slice(before).some((call) => call.startsWith("delete")));
	const failing = async (args: readonly string[], operation: string) =>
		args[0] === "group" && args[1] === "exists" ? Promise.reject(new Error("auth")) : az(args, operation);
	const failed = await sweep({
		az: failing,
		control: { resourceGroup: "control-rg", vnet: "control-vnet" },
		now: new Date("2026-11-05T12:00:00Z"),
		runId: expired,
		force: false,
		dryRun: false,
		sleep: async () => {},
		clock: () => 0,
		log: () => {},
	});
	assert.equal(failed.runs[0].ok, false);
	assert.ok(isDistributedTeardownError({ name: failed.runs[0].error?.name, code: failed.runs[0].error?.code }));
	await assert.rejects(
		sweep({
			az: async () => Promise.reject(new Error("not logged in")),
			control: { resourceGroup: "control-rg", vnet: "control-vnet" },
			now: new Date(),
			force: false,
			dryRun: false,
			sleep: async () => {},
			clock: () => 0,
			log: () => {},
		}),
		/not logged in/,
	);
});

test("each feature probe names its issue, its capability and the exact interface it looks for", () => {
	assert.deepEqual(
		Object.fromEntries(
			Object.entries(FEATURE_PROBES).map(([suite, probe]) => [suite, [probe.issue, probe.capability]]),
		),
		{
			"multi-node-resume": ["#4329", "export ResumeError"],
			"cross-host-pools": ["#4310", "export WorkerPlacementError"],
			"shard-contention": ["#4325", "export JournalShardUnavailableError"],
			"idle-density": ["#4309/#4326", "AgentSessionRuntime.rehydrate"],
			"subscription-flood": ["#4311", "export SubscriptionError"],
			"fork-under-load": ["#4321", "export forkRun"],
			"restore-cold": ["#4245", "export GitProvisionError"],
			"team-ci": ["#4320", "export TeamProfileError"],
			"pool-scale": ["#4312", "export createRegistry (local worker pools)"],
			compaction: ["#4330", "AgentSession.awaitBackgroundCompaction"],
		},
	);
	const exports: Record<string, string> = {
		"multi-node-resume": "ResumeError",
		"cross-host-pools": "WorkerPlacementError",
		"shard-contention": "JournalShardUnavailableError",
		"subscription-flood": "SubscriptionError",
		"fork-under-load": "forkRun",
		"restore-cold": "GitProvisionError",
		"team-ci": "TeamProfileError",
		"pool-scale": "createRegistry",
	};
	for (const [suite, name] of Object.entries(exports)) {
		assert.equal(FEATURE_PROBES[suite].present(capabilities({ workflows: [name] })), true, suite);
		assert.equal(FEATURE_PROBES[suite].present(capabilities({ atomic: [name] })), true, suite);
		assert.equal(FEATURE_PROBES[suite].present(capabilities({ workflows: [`${name}x`] })), false, suite);
	}
	const implemented = { custom: { issue: "#9", capability: "c", present: () => true, implemented: true } };
	assert.equal(featureSkip("custom", capabilities(), implemented), undefined);
	assert.deepEqual(
		featureSkip("custom", capabilities(), { custom: { ...implemented.custom, implemented: false } })?.fields,
		{ suite: "custom", issue: "#9", capability: "c" },
	);
	assert.equal(parseCapabilities({ workflows: ["a", 1], atomic: [], members: {} }), undefined);
	assert.equal(parseCapabilities({ workflows: [], atomic: [], members: { x: ["a"], y: [1] } }), undefined);
});

test("the manifest dedupes by kind, name and scope, and every change is flushed", () => {
	const dir = mkdtempSync(join(tmpdir(), "adt-manifest-2-"));
	const data = {
		runId: "r",
		resourceGroup: "g",
		expiresAt: "e",
		subscription: "s",
		control: { resourceGroup: "c", vnet: "v" },
		entries: [],
	};
	const manifest = new Manifest(dir, data);
	assert.deepEqual(Manifest.load(dir).data.entries, []);
	assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), `${JSON.stringify(data, null, "\t")}\n`);
	manifest.plan("nic", "n", "g");
	manifest.plan("vm", "n", "g");
	manifest.plan("nic", "m", "g");
	manifest.plan("nic", "n", "h");
	manifest.mark("nic", "n", "h", "created");
	assert.deepEqual(Manifest.load(dir).data.entries, [
		{ kind: "nic", name: "n", scope: "g", state: "planned" },
		{ kind: "vm", name: "n", scope: "g", state: "planned" },
		{ kind: "nic", name: "m", scope: "g", state: "planned" },
		{ kind: "nic", name: "n", scope: "h", state: "created" },
	]);
	manifest.mark("vm", "n", "g", "deleted");
	assert.equal(Manifest.load(dir).data.entries[1].state, "deleted");
});

test("an empty gate reports exactly why it failed, and a kept teardown leaves no cleanup marker", async () => {
	assert.throws(
		() => gateVerdict([]),
		(error) => {
			assert.deepEqual(Reflect.get(error as object, "fields"), {
				violations: [{ check: "gate-ran", subject: "security gate", detail: "no checks recorded" }],
			});
			return true;
		},
	);
	const primary = new Error("scenario");
	await runLifecycle({
		steps: [],
		scenarios: async () => Promise.reject(primary),
		teardown: async () => ({ ok: true }),
		provisioned: () => true,
		keep: false,
	});
	assert.equal(Object.getOwnPropertyDescriptor(primary, "cleanupCause"), undefined);
});

test("run and suite status follow any failed suite, coverage gap, invariant or fault", () => {
	const base = { cancelled: false, error: undefined, coverage: [{ status: "exercised" }], teardownOk: true };
	assert.equal(
		overallStatus({
			...base,
			suites: [
				{ name: "a", issue: "#1", status: "passed" },
				{ name: "b", issue: "#2", status: "failed" },
			],
		}),
		"failed",
	);
	assert.equal(
		overallStatus({ ...base, suites: [], coverage: [{ status: "exercised" }, { status: "incomplete" }] }),
		"failed",
	);
	assert.equal(
		overallStatus({ ...base, suites: [], coverage: [{ status: "exercised" }, { status: "missing" }] }),
		"failed",
	);
	assert.equal(
		suiteStatus(
			[
				{ name: "a", passed: true, expected: 1, actual: 1 },
				{ name: "b", passed: false, expected: 1, actual: 2 },
			],
			[],
		),
		"failed",
	);
	assert.equal(
		suiteStatus([{ name: "a", passed: true, expected: 1, actual: 1 }], [{}, { error: new Error("x") }]),
		"failed",
	);
});

test("the Markdown report renders every section exactly", () => {
	const fixture = report({
		runId: "adt2611050230-beef",
		status: "failed",
		replay: {
			ref: "main",
			sha: "a".repeat(40),
			suite: "smoke",
			chaos: "partition",
			nodes: 3,
			regions: ["eastus2", "westus3"],
			seed: 7,
			prng: "mulberry32/v1",
			artifactDigest: "d",
			dbStorage: "premium-ssd",
			dbRegion: "westus3",
		},
		paths: { json: "/out/report.json", markdown: "/out/report.md" },
		error: serialized({ name: "DistributedProvisionError", code: "provision-failed", message: "boom" }),
		topology: {
			resourceGroup: "adt2611050230-beef-rg",
			expiresAt: "2026-11-05T06:30:00.000Z",
			vms: [reportVm({ name: "n1", roles: ["large"], region: "eastus2", size: "s" })],
		},
		security: { passed: true, checks: [{ name: "zero-public-ips", subject: "n1", passed: true, observed: [] }] },
		suites: [
			{
				name: "smoke",
				issue: "#4331",
				status: "failed",
				invariants: [{ name: "journal-integrity", passed: false, expected: ["ok"], actual: ["bad"] }],
				faults: [
					fault({
						profile: "partition",
						target: "n1",
						effectObserved: true,
						recovered: false,
						observed: { drops: 3 },
						timeline: [{ at: 5, event: "applied" }],
					}),
					fault({
						profile: "sigkill",
						target: "n2",
						effectObserved: false,
						recovered: false,
						error: serialized({ name: "DistributedFaultError", code: "fault-failed", message: "could\nnot" }),
					}),
					fault({ profile: "loss", target: "n2" }),
				],
			},
			{
				name: "compaction",
				issue: "#4330",
				status: "skipped",
				reason: serialized({
					name: "DistributedFeatureUnavailableError",
					code: "feature-unavailable",
					message: "missing",
				}),
			},
		],
		coverage: [
			{ profile: "partition", status: "incomplete" },
			{ profile: "sigkill", status: "incomplete" },
			{ profile: "oom", status: "missing" },
		],
		teardown: {
			ok: true,
			steps: [],
			queries: [{ label: "groups", command: "az group list", ok: true, result: [] }],
			remaining: [],
		},
		durations: { total: 1 },
	});

	assert.deepEqual(renderMarkdown(fixture).split("\n"), [
		"# Distributed test run adt2611050230-beef",
		"",
		"Status: **failed**",
		"",
		"- Ref: `main` → `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`",
		'- Suite: `smoke`, chaos: `partition`, nodes: 3, regions: ["eastus2","westus3"]',
		"- Seed: 7 (mulberry32/v1); replay with `node test/distributed/run.mjs --replay /out/report.json`",
		"- Artifact SHA-256: `d`",
		"- Database storage: premium-ssd",
		"",
		"## Failure",
		"",
		"`DistributedProvisionError` (`provision-failed`): boom",
		"",
		"## Topology",
		"",
		"| VM | Kind | Roles | Region | Size | Private IP |",
		"| --- | --- | --- | --- | --- | --- |",
		'| n1 | node | ["large"] | eastus2 | s |  |',
		"",
		"## Security gate",
		"",
		"Result: **passed**",
		"",
		"| Check | Subject | Passed | Observed |",
		"| --- | --- | --- | --- |",
		"| zero-public-ips | n1 | yes | [] |",
		"",
		"## Suites",
		"",
		"| Suite | Issue | Status | Reason |",
		"| --- | --- | --- | --- |",
		"| smoke | #4331 | failed |  |",
		"| compaction | #4330 | skipped | `feature-unavailable`: missing |",
		"",
		"## Chaos coverage",
		"",
		"| Profile | Status | Target | Effect observed | Recovered | Observed |",
		"| --- | --- | --- | --- | --- | --- |",
		'| partition | incomplete | n1 | true | false | {"drops":3} |',
		"| sigkill | incomplete | n2 | false | false | could not |",
		"| oom | missing |  |  |  |  |",
		"",
		"## Invariants",
		"",
		"| Invariant | Passed | Expected | Actual |",
		"| --- | --- | --- | --- |",
		'| journal-integrity | **no** | ["ok"] | ["bad"] |',
		"",
		"## Metrics",
		"",
		"```json",
		"{",
		'  "smoke": {},',
		'  "compaction": {}',
		"}",
		"```",
		"",
		"## Fault timeline",
		"",
		"| ms | Profile | Event |",
		"| --- | --- | --- |",
		"| 5 | partition | applied |",
		"",
		"## Teardown",
		"",
		"Result: **zero resources left**",
		"",
		"- `az group list` → []",
		"",
		"## Phase durations (ms)",
		"",
		"```json",
		"{",
		'  "total": 1',
		"}",
		"```",
		"",
	]);
	assert.deepEqual(
		renderMarkdown(
			report({
				status: "cancelled",
				nvmeSkip: { code: "encryption-at-host-unavailable", detail: "EncryptionAtHost is not registered" },
			}),
		).split("\n"),
		[
			"# Distributed test run r",
			"",
			"Status: **cancelled**",
			"",
			"- Ref: `main` → `unresolved`",
			'- Suite: `smoke`, chaos: `none`, nodes: 3, regions: ["eastus2"]',
			"- Seed: 1 (mulberry32/v1); replay with `node test/distributed/run.mjs --replay report.json`",
			"- Artifact SHA-256: `none`",
			"- Database storage: premium-ssd (local NVMe skipped: encryption-at-host-unavailable)",
			"",
			"## Topology",
			"",
			"| VM | Kind | Roles | Region | Size | Private IP |",
			"| --- | --- | --- | --- | --- | --- |",
			"",
			"## Security gate",
			"",
			"Result: **not run**",
			"",
			"| Check | Subject | Passed | Observed |",
			"| --- | --- | --- | --- |",
			"",
			"## Suites",
			"",
			"| Suite | Issue | Status | Reason |",
			"| --- | --- | --- | --- |",
			"",
			"## Chaos coverage",
			"",
			"| Profile | Status | Target | Effect observed | Recovered | Observed |",
			"| --- | --- | --- | --- | --- | --- |",
			"",
			"## Invariants",
			"",
			"| Invariant | Passed | Expected | Actual |",
			"| --- | --- | --- | --- |",
			"",
			"## Metrics",
			"",
			"```json",
			"{}",
			"```",
			"",
			"## Fault timeline",
			"",
			"| ms | Profile | Event |",
			"| --- | --- | --- |",
			"",
			"## Teardown",
			"",
			"Result: **not run**",
			"",
			"",
			"## Phase durations (ms)",
			"",
			"```json",
			"{}",
			"```",
			"",
		],
	);
	const dir = mkdtempSync(join(tmpdir(), "adt-report-modes-"));
	const minimal = report({ status: "passed" });
	const paths = writeReport(dir, minimal, []);
	assert.equal(readFileSync(paths.json, "utf8"), `${JSON.stringify({ ...minimal, paths }, null, "\t")}\n`);
});

test("the sweeper sends exact queries, survives empty listings and hands teardown the run's own peerings", async () => {
	const control = { resourceGroup: "control-rg", vnet: "control-vnet" };
	const run = "adt2611050230-0001";
	const other = "adt2611050230-0002";
	const calls: string[][] = [];
	let resourcePolls = 0;
	const az = async (args: readonly string[]) => {
		calls.push([...args]);
		const line = args.join(" ");
		if (line.startsWith("group list --query [?tags.")) return [{ id: "/g", name: `${run}-rg` }];
		if (line.startsWith(`group show --name ${run}-rg`))
			return {
				id: "/g",
				name: `${run}-rg`,
				tags: { "atomic-distributed-test": run, "atomic-distributed-test-expiry": "2026-11-05T00:00:00Z" },
			};
		if (
			line === "resource list --tag atomic-distributed-test --query [].{id:id,name:name,resourceGroup:resourceGroup}"
		)
			return null;
		if (
			line ===
			"network vnet peering list --resource-group control-rg --vnet-name control-vnet --query [].{name:name}"
		)
			return [{ name: `${run}-eastus2-from-control` }, { name: `${other}-eastus2-from-control` }];
		if (line === "group list --query [].name") return null;
		if (line === "network vnet peering list --resource-group control-rg --vnet-name control-vnet --query [].name")
			throw new Error("throttled");
		if (line.startsWith(`resource list --tag atomic-distributed-test=${run}`))
			return ++resourcePolls < 3 ? ["/late"] : [];
		if (line.startsWith("group exists")) return false;
		return [];
	};
	let clock = 5_000_000;
	const result = await sweep({
		az,
		control,
		now: new Date("2026-11-05T12:00:00Z"),
		runId: run,
		force: false,
		dryRun: false,
		sleep: async (ms: number) => {
			clock += ms;
		},
		clock: () => clock,
		log: () => {},
	});
	assert.deepEqual(calls.slice(0, 5), [
		["group", "list", "--query", '[?tags."atomic-distributed-test" != null].{id:id,name:name}'],
		["group", "show", "--name", `${run}-rg`, "--query", "{id:id,name:name,tags:tags}"],
		[
			"resource",
			"list",
			"--tag",
			"atomic-distributed-test",
			"--query",
			"[].{id:id,name:name,resourceGroup:resourceGroup}",
		],
		[
			"network",
			"vnet",
			"peering",
			"list",
			"--resource-group",
			"control-rg",
			"--vnet-name",
			"control-vnet",
			"--query",
			"[].{name:name}",
		],
		["group", "list", "--query", "[].name"],
	]);
	assert.deepEqual(result.plan.controlPeerings, [{ name: `${run}-eastus2-from-control`, runId: run }]);
	assert.ok(
		calls.some(
			(args) =>
				args.join(" ") ===
				`network vnet peering delete --resource-group control-rg --vnet-name control-vnet --name ${run}-eastus2-from-control`,
		),
	);
	assert.ok(!calls.some((args) => args.includes(`${other}-eastus2-from-control`) && args.includes("delete")));
	assert.equal(resourcePolls, 3);
	assert.equal(result.runs.length, 1);
	assert.equal(result.runs[0].runId, run);
	assert.equal(result.runs[0].ok, false);
	assert.equal(result.runs[0].error?.code, "teardown-incomplete");
	const deletes: string[][] = [];
	const straggler = await sweep({
		az: async (args: readonly string[]) => {
			const line = args.join(" ");
			if (line.startsWith("resource list --tag atomic-distributed-test --query"))
				return [{ id: "/s", name: "s", resourceGroup: "shared" }];
			if (line.startsWith("resource show --ids /s"))
				return { "atomic-distributed-test": other, "atomic-distributed-test-expiry": "2026-11-04T00:00:00Z" };
			if (args[1] === "delete") deletes.push([...args]);
			if (line.startsWith("group exists")) return false;
			return [];
		},
		control,
		now: new Date("2026-11-05T12:00:00Z"),
		force: false,
		dryRun: false,
		sleep: async () => {},
		clock: () => 0,
		log: () => {},
	});
	assert.deepEqual(deletes, [["resource", "delete", "--ids", "/s"]]);
	assert.deepEqual(straggler.runs, [{ runId: other, ok: true, remaining: [], queries: straggler.runs[0].queries }]);
	assert.ok(!Object.hasOwn(straggler.runs[0], "error"));
});

test("sweeper flag errors carry their exact expectation", () => {
	const fields = (argv: string[]) => {
		try {
			parseSweepArgs(argv);
		} catch (error) {
			return Reflect.get(error as object, "fields");
		}
		assert.fail("expected a configuration error");
	};
	assert.deepEqual(fields(["--now"]), {
		source: "cli",
		field: "--now",
		reason: "missing-value",
		expected: "a value after the flag",
		actual: null,
	});
	assert.deepEqual(fields(["--run-id", "x"]), {
		source: "cli",
		field: "--run-id",
		reason: "invalid-value",
		expected: "a run id like adt2611050230-beef",
		actual: "x",
	});
	assert.deepEqual(fields(["--now", "x"]), {
		source: "cli",
		field: "--now",
		reason: "invalid-value",
		expected: "an ISO-8601 instant",
		actual: "x",
	});
	assert.deepEqual(fields(["--x"]), {
		source: "cli",
		field: "--x",
		reason: "unknown-flag",
		expected: "--dry-run, --run-id, --force or --now",
		actual: "--x",
	});
	assert.deepEqual(fields(["--force"]), {
		source: "cli",
		field: "--force",
		reason: "invalid-value",
		expected: "--force only together with --run-id",
		actual: "--force",
	});
});

test("the sweeper names every az operation, tolerates empty listings and tears each run down with its own peerings", async () => {
	const control = { resourceGroup: "control-rg", vnet: "control-vnet" };
	const first = "adt2611050230-0001";
	const second = "adt2611050230-0002";
	const calls: { args: string[]; operation: string }[] = [];
	const expired = (name: string, run: string) => ({
		id: `/${name}`,
		name,
		tags: { "atomic-distributed-test": run, "atomic-distributed-test-expiry": "2026-11-05T00:00:00Z" },
	});
	const az = async (args: readonly string[], operation: string) => {
		calls.push({ args: [...args], operation });
		const line = args.join(" ");
		if (line.startsWith("group list --query [?tags."))
			return [
				{ id: "/a", name: `${first}-rg` },
				{ id: "/b", name: `${second}-rg` },
			];
		if (line.startsWith(`group show --name ${first}-rg`)) return expired(`${first}-rg`, first);
		if (line.startsWith(`group show --name ${second}-rg`)) return expired(`${second}-rg`, second);
		if (line.startsWith("resource list --tag atomic-distributed-test --query"))
			return [{ id: "/s", name: "s", resourceGroup: "shared" }];
		if (line.startsWith("resource show --ids /s")) return null;
		if (
			line ===
			"network vnet peering list --resource-group control-rg --vnet-name control-vnet --query [].{name:name}"
		)
			return [{ name: `${first}-x-from-control` }, { name: `${second}-x-from-control` }];
		if (line === "network vnet peering list --resource-group control-rg --vnet-name control-vnet --query [].name")
			throw new Error("throttled");
		if (line.startsWith("group exists")) return false;
		return [];
	};
	await sweep({
		az,
		control,
		now: new Date("2026-11-05T12:00:00Z"),
		force: false,
		dryRun: false,
		sleep: async () => {},
		clock: () => 0,
		log: () => {},
	});
	assert.deepEqual(calls.slice(0, 7), [
		{
			args: ["group", "list", "--query", '[?tags."atomic-distributed-test" != null].{id:id,name:name}'],
			operation: "list tagged groups",
		},
		{
			args: ["group", "show", "--name", `${first}-rg`, "--query", "{id:id,name:name,tags:tags}"],
			operation: `read tags of ${first}-rg`,
		},
		{
			args: ["group", "show", "--name", `${second}-rg`, "--query", "{id:id,name:name,tags:tags}"],
			operation: `read tags of ${second}-rg`,
		},
		{
			args: [
				"resource",
				"list",
				"--tag",
				"atomic-distributed-test",
				"--query",
				"[].{id:id,name:name,resourceGroup:resourceGroup}",
			],
			operation: "list tagged resources",
		},
		{ args: ["resource", "show", "--ids", "/s", "--query", "tags"], operation: "read tags of s" },
		{
			args: [
				"network",
				"vnet",
				"peering",
				"list",
				"--resource-group",
				"control-rg",
				"--vnet-name",
				"control-vnet",
				"--query",
				"[].{name:name}",
			],
			operation: "list control peerings",
		},
		{ args: ["group", "list", "--query", "[].name"], operation: "list resource groups" },
	]);
	const peeringDeletes = calls.filter((call) => call.args[3] === "delete").map((call) => call.args.at(-1));
	assert.deepEqual(peeringDeletes, [`${first}-x-from-control`, `${second}-x-from-control`]);
	const quiet: string[] = [];
	await sweep({
		az: async (args: readonly string[]) => {
			quiet.push(args.slice(0, 2).join(" "));
			return null;
		},
		control,
		now: new Date(),
		force: false,
		dryRun: true,
		sleep: async () => {},
		clock: () => 0,
		log: () => {},
	});
	assert.deepEqual(quiet, ["group list", "resource list", "network vnet", "group list"]);
});

test("manifest updates find the entry by kind, name and scope together", () => {
	const dir = mkdtempSync(join(tmpdir(), "adt-manifest-3-"));
	const manifest = new Manifest(dir, {
		runId: "r",
		resourceGroup: "g",
		expiresAt: "e",
		subscription: "s",
		control: { resourceGroup: "c", vnet: "v" },
		entries: [],
	});
	manifest.plan("nic", "first", "g");
	manifest.plan("nic", "second", "g");
	manifest.mark("nic", "second", "g", "created");
	assert.deepEqual(
		Manifest.load(dir).data.entries.map((entry) => entry.state),
		["planned", "created"],
	);
	assert.equal(parseCapabilities({ workflows: ["a", 1], atomic: ["x"], members: {} }), undefined);
});
