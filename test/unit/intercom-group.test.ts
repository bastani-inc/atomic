import assert from "node:assert/strict";
import { runtimeIntercomGroupEnvKey } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import {
	DEFAULT_GROUP,
	normalizeGroup,
	resolveHomeGroup,
	validateRuntimeGroup,
} from "../../packages/intercom/group.js";
import { clearRuntimeIntercomGroup, setRuntimeIntercomGroup } from "../../packages/intercom/runtime-group.ts";

const ENV_KEYS = ["ATOMIC_INTERCOM_GROUP", "PI_INTERCOM_GROUP"] as const;
const RUNTIME_SESSION_KEYS = ["session-a", "session-b", "session-1", "session-2"] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
		delete saved[key];
	}
	for (const sessionId of RUNTIME_SESSION_KEYS) clearRuntimeIntercomGroup(sessionId);
});

function setEnv(key: string, value: string | undefined): void {
	if (!(key in saved)) saved[key] = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

test("normalizeGroup collapses empty/whitespace/undefined to default and trims names", () => {
	assert.equal(normalizeGroup(undefined), DEFAULT_GROUP);
	assert.equal(normalizeGroup(null), DEFAULT_GROUP);
	assert.equal(normalizeGroup(""), DEFAULT_GROUP);
	assert.equal(normalizeGroup("   "), DEFAULT_GROUP);
	assert.equal(normalizeGroup("default"), DEFAULT_GROUP);
	assert.equal(normalizeGroup("  teamA  "), "teamA");
});

test("validateRuntimeGroup trims named groups and permits explicit default", () => {
	assert.equal(validateRuntimeGroup("  teamA  "), "teamA");
	assert.equal(validateRuntimeGroup("default"), DEFAULT_GROUP);
	assert.throws(() => validateRuntimeGroup(""), /non-empty/);
	assert.throws(() => validateRuntimeGroup("   "), /non-empty/);
	assert.throws(() => validateRuntimeGroup("true"), /reserved/);
	assert.throws(() => validateRuntimeGroup(" AUTO "), /reserved/);
});

test("runtime group entries stay isolated per session and clean up independently", () => {
	setRuntimeIntercomGroup("session-a", "group-a");
	setRuntimeIntercomGroup("session-b", "group-b");
	assert.equal(process.env[runtimeIntercomGroupEnvKey("session-a")], "group-a");
	assert.equal(process.env[runtimeIntercomGroupEnvKey("session-b")], "group-b");

	clearRuntimeIntercomGroup("session-a");
	assert.equal(process.env[runtimeIntercomGroupEnvKey("session-a")], undefined);
	assert.equal(process.env[runtimeIntercomGroupEnvKey("session-b")], "group-b");
	clearRuntimeIntercomGroup("session-b");
});

test("home resolution ignores a joined runtime entry and gives admitted policy the narrowest scope", () => {
	setEnv("ATOMIC_INTERCOM_GROUP", undefined);
	setEnv("PI_INTERCOM_GROUP", undefined);
	setRuntimeIntercomGroup("session-1", "runtimeGroup");
	const sessionContext = {
		sessionManager: { getSessionId: () => "session-1" },
	};
	assert.equal(resolveHomeGroup({ group: "configGroup" }, sessionContext), "configGroup");
	assert.equal(
		resolveHomeGroup(
			{ group: "configGroup" },
			{
				...sessionContext,
				subagentPolicy: { intercomGroup: "policyGroup" },
				orchestrationContext: { intercomGroup: "contextGroup" },
			},
		),
		"policyGroup",
	);
});

test("resolveHomeGroup precedence: subagentPolicy > orchestrationContext > env > config > default", () => {
	setEnv("ATOMIC_INTERCOM_GROUP", undefined);
	setEnv("PI_INTERCOM_GROUP", undefined);

	setEnv("ATOMIC_INTERCOM_GROUP", "envGroup");
	assert.equal(
		resolveHomeGroup({ group: "configGroup" }, { orchestrationContext: { intercomGroup: "ctxGroup" } }),
		"ctxGroup",
	);
	assert.equal(
		resolveHomeGroup(
			{ group: "configGroup" },
			{
				subagentPolicy: { intercomGroup: "policyGroup" },
				orchestrationContext: { intercomGroup: "ctxGroup" },
			},
		),
		"policyGroup",
	);

	assert.equal(resolveHomeGroup({ group: "configGroup" }, {}), "envGroup");

	setEnv("ATOMIC_INTERCOM_GROUP", undefined);
	setEnv("PI_INTERCOM_GROUP", "legacyGroup");
	assert.equal(resolveHomeGroup({ group: "configGroup" }, {}), "legacyGroup");

	setEnv("PI_INTERCOM_GROUP", undefined);
	assert.equal(resolveHomeGroup({ group: "configGroup" }, {}), "configGroup");
	assert.equal(resolveHomeGroup({}, {}), DEFAULT_GROUP);
	assert.equal(resolveHomeGroup(undefined, undefined), DEFAULT_GROUP);
});

test("a defined-but-empty ATOMIC_INTERCOM_GROUP shadows the legacy PI_INTERCOM_GROUP", () => {
	setEnv("ATOMIC_INTERCOM_GROUP", "");
	setEnv("PI_INTERCOM_GROUP", "legacy");

	assert.equal(resolveHomeGroup({ group: "configured" }, {}), "configured");
	assert.equal(resolveHomeGroup(undefined, {}), DEFAULT_GROUP);
	assert.equal(resolveHomeGroup({ group: "configured" }, { orchestrationContext: { intercomGroup: "ctx" } }), "ctx");

	setEnv("ATOMIC_INTERCOM_GROUP", "   ");
	assert.equal(resolveHomeGroup({ group: "configured" }, {}), "configured");

	setEnv("ATOMIC_INTERCOM_GROUP", undefined);
	assert.equal(resolveHomeGroup({ group: "configured" }, {}), "legacy");
});
