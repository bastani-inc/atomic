import { describe, expect, test } from "vitest";
import { Value } from "typebox/value";
import {
	MAX_PARALLEL_TASKS,
	SubagentParams,
} from "../examples/extensions/subagent/schemas.js";

function makeTasks(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		agent: "worker",
		task: `Task ${index + 1}`,
	}));
}

describe("subagent example parallel task limit", () => {
	test("accepts 50 parallel tasks and rejects 51", () => {
		expect(MAX_PARALLEL_TASKS).toBe(50);
		expect(
			Value.Check(SubagentParams, { tasks: makeTasks(MAX_PARALLEL_TASKS) }),
		).toBe(true);
		expect(
			Value.Check(SubagentParams, {
				tasks: makeTasks(MAX_PARALLEL_TASKS + 1),
			}),
		).toBe(false);
	});
});
