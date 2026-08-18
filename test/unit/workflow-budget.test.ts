import assert from "node:assert/strict";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { loadConfigFile } from "../../packages/workflows/src/extension/config-file-loader.js";
import { withWorkflowDefaults } from "../../packages/workflows/src/extension/config-loader.js";
import { WorkflowParametersSchema } from "../../packages/workflows/src/extension/workflow-schema.js";
import {
	resolve_budget,
	validateWorkflowBudget,
	type WorkflowBudget,
} from "../../packages/workflows/src/shared/budget.js";
import {
	isReturnedBlockedWorkflowStatus,
	isReturnedResumableBlockedWorkflowStatus,
} from "../../packages/workflows/src/shared/returned-run-status.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

const BUDGET_FIELDS = [
	["maxDurationMs", 10, 20, 30],
	["maxTokens", 11, 21, 31],
	["maxCost", 12.5, 22.5, 32.5],
	["warnAtPercent", 13.5, 23.5, 33.5],
] as const satisfies readonly [keyof WorkflowBudget, number, number, number][];

function budgetField(field: keyof WorkflowBudget, value: number): WorkflowBudget {
	return { [field]: value };
}

describe("workflow budget resolution", () => {
	test("budget later layers win per field for every layer-presence combination", () => {
		for (const [field, configValue, definitionValue, runValue] of BUDGET_FIELDS) {
			for (const configPresent of [false, true]) {
				for (const definitionPresent of [false, true]) {
					for (const runPresent of [false, true]) {
						const resolved = resolve_budget({
							...(configPresent ? { config: budgetField(field, configValue) } : {}),
							...(definitionPresent ? { definition: budgetField(field, definitionValue) } : {}),
							...(runPresent ? { run: budgetField(field, runValue) } : {}),
						});
						const expected = runPresent
							? runValue
							: definitionPresent
								? definitionValue
								: configPresent
									? configValue
									: 0;

						assert.equal(
							resolved[field],
							expected,
							`${field}: ${configPresent}/${definitionPresent}/${runPresent}`,
						);
					}
				}
			}
		}
	});

	test("budget later zero disables a field", () => {
		const resolved = resolve_budget({
			config: { maxDurationMs: 10, maxTokens: 20, maxCost: 30, warnAtPercent: 80 },
			definition: { maxDurationMs: 0, maxTokens: 0 },
			run: { maxCost: 0, warnAtPercent: 0 },
		});

		assert.equal(resolved.maxDurationMs, 0);
		assert.equal(resolved.maxTokens, 0);
		assert.equal(resolved.maxCost, 0);
		assert.equal(resolved.warnAtPercent, 0);
	});
});

describe("workflow budget validation", () => {
	test("budget rejects negative, non-finite, and non-integer integer dimensions", () => {
		const invalid: readonly WorkflowBudget[] = [
			{ maxDurationMs: -1 },
			{ maxTokens: -1 },
			{ maxDurationMs: Number.NaN },
			{ maxTokens: Number.POSITIVE_INFINITY },
			{ maxDurationMs: 1.5 },
			{ maxTokens: 1.5 },
			{ maxCost: -0.01 },
			{ warnAtPercent: Number.NEGATIVE_INFINITY },
		];
		for (const budget of invalid) {
			assert.notEqual(validateWorkflowBudget(budget), null, JSON.stringify(budget));
		}
	});

	test("budget accepts zero and finite fractional cost and warning values", () => {
		const budget = { maxDurationMs: 0, maxTokens: 0, maxCost: 1.25, warnAtPercent: 80.5 };

		assert.equal(validateWorkflowBudget(budget), null);
		assert.throws(() => resolve_budget({ run: { maxTokens: 1.5 } }), TypeError);
	});

	test("budget config validation rejects an invalid declaration", async () => {
		const directory = makeTempDirectory("atomic-workflow-budget-");
		try {
			const filePath = join(directory, "config.json");
			await writeFileEnsuringDir(filePath, JSON.stringify({ budget: { maxTokens: -1 } }));
			const outcome = await loadConfigFile(filePath);

			assert.deepEqual(outcome.kind, "error");
			if (outcome.kind === "error") assert.match(outcome.diagnostic.message, /budget\.maxTokens/);
		} finally {
			removeTempDirectory(directory);
		}
	});
});

describe("workflow budget plumbing", () => {
	test("budget config defaults and authored declarations resolve without enforcement", () => {
		const effective = withWorkflowDefaults({ budget: { maxDurationMs: 100, maxCost: 2.5 } });
		assert.equal(effective.budget.maxDurationMs, 100);
		assert.equal(effective.budget.maxCost, 2.5);
		assert.equal(effective.budget.maxTokens, 0);

		const definition = workflow({
			name: "budget-child",
			description: "budget declaration test",
			budget: { maxTokens: 25 },
			outputs: { result: Type.String() },
			run: () => ({ result: "done" }),
		});
		assert.equal(definition.budget?.maxTokens, 25);
		assert.ok(Object.isFrozen(definition.budget));
		assert.throws(
			() =>
				workflow({
					name: "invalid-budget-child",
					description: "budget declaration test",
					budget: { maxDurationMs: -1 },
					outputs: {},
					run: () => ({}),
				}),
			TypeError,
		);
	});

	test("budget tool schema mirrors declared budget validation", () => {
		assert.equal(
			Value.Check(WorkflowParametersSchema, {
				action: "run",
				workflow: "budget-child",
				budget: { maxDurationMs: 0, maxTokens: 1, maxCost: 1.25, warnAtPercent: 80.5 },
			}),
			true,
		);
		assert.equal(
			Value.Check(WorkflowParametersSchema, { action: "run", workflow: "budget-child", budget: { maxTokens: 1.5 } }),
			false,
		);
		assert.equal(
			Value.Check(WorkflowParametersSchema, { action: "run", workflow: "budget-child", budget: { maxCost: -1 } }),
			false,
		);
	});
});

test("budget_exceeded is a resumable returned blocked status", () => {
	assert.equal(isReturnedBlockedWorkflowStatus("budget_exceeded"), true);
	assert.equal(isReturnedResumableBlockedWorkflowStatus("budget_exceeded"), true);
});
