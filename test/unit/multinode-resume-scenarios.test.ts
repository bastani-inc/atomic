import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import {
	type AcceptanceScenario,
	MULTINODE_RESUME_SCENARIOS,
	type ScenarioPrerequisite,
} from "../fixtures/multinode-resume-scenarios.js";
import { moduleDir } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const repository = join(moduleDir(import.meta.url), "..", "..");

/** Why `prerequisite` is not usable yet, or undefined when its export exists. */
async function missing(prerequisite: ScenarioPrerequisite): Promise<string | undefined> {
	const exports = (await import(join(repository, prerequisite.module))) as Record<string, unknown>;
	const value = exports[prerequisite.name];
	if (value === undefined) return `${prerequisite.name} is not exported (${prerequisite.dependency})`;
	if (prerequisite.prototypeMember === undefined) return undefined;
	const prototype = (value as { readonly prototype?: Record<string, unknown> }).prototype;
	return typeof prototype?.[prerequisite.prototypeMember] === "function"
		? undefined
		: `${prerequisite.name}.prototype.${prerequisite.prototypeMember} does not exist (${prerequisite.dependency})`;
}

test("the acceptance list holds scenarios 1-7 once each, with invariants and chaos, and names tests that exist (#4329)", () => {
	assert.deepEqual(
		MULTINODE_RESUME_SCENARIOS.map((scenario) => scenario.id),
		[1, 2, 3, 4, 5, 6, 7],
	);
	for (const scenario of MULTINODE_RESUME_SCENARIOS) {
		assert.ok(scenario.invariants.length > 0, `scenario ${scenario.id} checks no invariant`);
		assert.ok(scenario.chaos.length > 0, `scenario ${scenario.id} injects no fault`);
		if (scenario.implementedBy === undefined) continue;
		const source = readFileSync(join(repository, scenario.implementedBy.file), "utf8");
		assert.ok(
			source.includes(`"${scenario.implementedBy.test}"`),
			`scenario ${scenario.id}'s test is not in ${scenario.implementedBy.file}`,
		);
	}
});

test("every acceptance scenario runs end to end (#4329)", async () => {
	const pending: string[] = [];
	for (const scenario of MULTINODE_RESUME_SCENARIOS satisfies readonly AcceptanceScenario[]) {
		if (scenario.implementedBy !== undefined) continue;
		const unwritten = (scenario.scenarios ?? []).filter(
			(id) => MULTINODE_RESUME_SCENARIOS.find((candidate) => candidate.id === id)?.implementedBy === undefined,
		);
		const blockers = [
			...(await Promise.all(scenario.prerequisites.map(missing))).filter(
				(reason): reason is string => reason !== undefined,
			),
			...(unwritten.length > 0 ? [`scenarios ${unwritten.join(", ")} and their chaos variants`] : []),
		];
		pending.push(
			`scenario ${scenario.id} (${scenario.title}): ${
				blockers.length > 0 ? `waiting for ${blockers.join("; ")}` : "its exports are available; write the scenario"
			}`,
		);
	}
	assert.deepEqual(pending, [], pending.join("\n"));
});
