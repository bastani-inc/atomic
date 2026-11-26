import assert from "node:assert/strict";
import { test } from "vitest";
import { expiredProjects } from "../distributed/harness/expiry.mjs";

const HOUR = 3_600_000;
const now = Date.parse("2026-11-26T12:00:00.000Z");

const projects = [
	{ project: "adt-20261126-030000-aaaa", createdAt: now - 9 * HOUR },
	{ project: "adt-20261126-110000-bbbb", createdAt: now - 1 * HOUR },
	{ project: "adt-20261126-100000-cccc", createdAt: undefined },
	{ project: "someone-elses-project", createdAt: now - 100 * HOUR },
];

test("the sweeper removes the harness's runs past the limit, and runs with only volumes or networks left", () => {
	assert.deepEqual(
		expiredProjects(projects, { now, ttlHours: 6 }).map((entry) => entry.project),
		["adt-20261126-030000-aaaa", "adt-20261126-100000-cccc"],
	);
});

test("with --run-id it looks at that run only, and --force removes it whatever its age", () => {
	assert.deepEqual(expiredProjects(projects, { now, ttlHours: 6, runId: "20261126-110000-bbbb" }), []);
	assert.deepEqual(expiredProjects(projects, { now, ttlHours: 6, runId: "20261126-110000-bbbb", force: true }), [
		{ project: "adt-20261126-110000-bbbb", reason: "named with --run-id and --force" },
	]);
});

test("projects the harness did not start are never removed", () => {
	assert.ok(
		!expiredProjects(projects, { now, ttlHours: 0 }).some((entry) => entry.project === "someone-elses-project"),
	);
});
