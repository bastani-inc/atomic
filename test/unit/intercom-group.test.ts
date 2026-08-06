import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { DEFAULT_GROUP, normalizeGroup, resolveHomeGroup } from "../../packages/intercom/group.js";

const ENV_KEYS = ["ATOMIC_INTERCOM_GROUP", "PI_INTERCOM_GROUP"] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
		delete saved[key];
	}
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
	assert.equal(normalizeGroup("default"), "default");
	assert.equal(normalizeGroup("  teamA  "), "teamA");
});

test("resolveHomeGroup precedence: orchestrationContext > env > config > default", () => {
	setEnv("ATOMIC_INTERCOM_GROUP", undefined);
	setEnv("PI_INTERCOM_GROUP", undefined);

	// orchestrationContext wins over everything
	setEnv("ATOMIC_INTERCOM_GROUP", "envGroup");
	assert.equal(
		resolveHomeGroup({ group: "configGroup" }, { orchestrationContext: { intercomGroup: "ctxGroup" } }),
		"ctxGroup",
	);

	// env wins over config when no context group
	assert.equal(resolveHomeGroup({ group: "configGroup" }, {}), "envGroup");

	// legacy PI_ env is honored via getEnvValue fallback
	setEnv("ATOMIC_INTERCOM_GROUP", undefined);
	setEnv("PI_INTERCOM_GROUP", "legacyGroup");
	assert.equal(resolveHomeGroup({ group: "configGroup" }, {}), "legacyGroup");

	// config used when no env/context
	setEnv("PI_INTERCOM_GROUP", undefined);
	assert.equal(resolveHomeGroup({ group: "configGroup" }, {}), "configGroup");

	// default when nothing set
	assert.equal(resolveHomeGroup({}, {}), DEFAULT_GROUP);
	assert.equal(resolveHomeGroup(undefined, undefined), DEFAULT_GROUP);
});

test("a defined-but-empty ATOMIC_INTERCOM_GROUP shadows the legacy PI_INTERCOM_GROUP", () => {
	// `getEnvValue` returned the first `!== undefined` value across [ATOMIC_*, PI_*], so an empty
	// ATOMIC value yields "" and never falls back to the legacy name. The local helper uses `??`
	// to keep that exactly; `||` would wrongly resolve "legacy" here.
	setEnv("ATOMIC_INTERCOM_GROUP", "");
	setEnv("PI_INTERCOM_GROUP", "legacy");

	assert.equal(resolveHomeGroup({ group: "configured" }, {}), "configured");
	assert.equal(resolveHomeGroup(undefined, {}), DEFAULT_GROUP);
	assert.equal(resolveHomeGroup({ group: "configured" }, { orchestrationContext: { intercomGroup: "ctx" } }), "ctx");

	// A whitespace-only ATOMIC value shadows the legacy name the same way.
	setEnv("ATOMIC_INTERCOM_GROUP", "   ");
	assert.equal(resolveHomeGroup({ group: "configured" }, {}), "configured");

	// Only an entirely absent ATOMIC value defers to the legacy name.
	setEnv("ATOMIC_INTERCOM_GROUP", undefined);
	assert.equal(resolveHomeGroup({ group: "configured" }, {}), "legacy");
});
