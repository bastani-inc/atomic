import assert from "node:assert/strict";
import { test } from "vitest";
import type { ToolGroupRole } from "../src/modes/interactive/components/tool-block.ts";
import { ToolGroupTracker } from "../src/modes/interactive/components/tool-group-tracker.ts";

function roleText(role: ToolGroupRole | undefined): string {
	if (role === undefined || role.kind === "standalone") return "alone";
	if (role.kind === "hidden") return "hidden";
	return `head ${role.clauses.map((clause) => `${clause.family}:${clause.count}`).join(",")}`;
}

function harness(groupBash: boolean) {
	const tracker = new ToolGroupTracker({ groupBash });
	const roles = new Map<string, ToolGroupRole>();
	const order: string[] = [];
	const call = (id: string, toolName: string) => {
		order.push(id);
		tracker.append(id, toolName, "pending", (role) => roles.set(id, role));
	};
	const view = () => order.map((id) => `${id}=${roleText(roles.get(id))}`).join(" ");
	return { tracker, call, view };
}

test("three done reads and a done bash collapse into one row in stage and subagent views (#5350)", () => {
	const { tracker, call, view } = harness(true);
	for (const [id, tool] of [
		["r1", "read"],
		["r2", "read"],
		["b1", "bash"],
		["r3", "read"],
	] as const) {
		call(id, tool);
		tracker.settle(id, "done");
	}
	assert.equal(view(), "r1=head read:3,bash:1 r2=hidden b1=hidden r3=hidden");
});

test("the main view keeps bash calls out of groups and lets them split the reads around them (#5350)", () => {
	const { tracker, call, view } = harness(false);
	for (const [id, tool] of [
		["r1", "read"],
		["r2", "read"],
		["b1", "bash"],
		["r3", "read"],
	] as const) {
		call(id, tool);
		tracker.settle(id, "done");
	}
	assert.equal(view(), "r1=head read:2 r2=hidden b1=alone r3=alone");
});

test("a failed call renders alone and splits the group; groups resume after it (#5350)", () => {
	const { tracker, call, view } = harness(true);
	for (const [id, state] of [
		["a", "done"],
		["b", "done"],
		["c", "failed"],
		["d", "done"],
		["e", "done"],
	] as const) {
		call(id, "read");
		tracker.settle(id, state);
	}
	assert.equal(view(), "a=head read:2 b=hidden c=alone d=head read:2 e=hidden");
});

test("the last running call renders alone and joins the group when it is done (#5350)", () => {
	const { tracker, call, view } = harness(true);
	call("a", "read");
	tracker.settle("a", "done");
	call("b", "search");
	tracker.settle("b", "done");
	call("c", "ls");
	assert.equal(view(), "a=head read:1,search:1 b=hidden c=alone");
	tracker.settle("c", "done");
	assert.equal(view(), "a=head read:1,search:1,list:1 b=hidden c=hidden");
});

test("prose and other tool families break groups; clauses keep first-appearance order (#5350)", () => {
	const { tracker, call, view } = harness(true);
	for (const [id, tool] of [
		["f1", "find"],
		["r1", "read"],
		["f2", "find"],
	] as const) {
		call(id, tool);
		tracker.settle(id, "done");
	}
	tracker.break();
	call("r2", "read");
	tracker.settle("r2", "done");
	call("e1", "edit");
	tracker.settle("e1", "done");
	call("r3", "read");
	tracker.settle("r3", "done");
	call("r4", "read");
	tracker.settle("r4", "done");
	assert.equal(view(), "f1=head find:2,read:1 r1=hidden f2=hidden r2=alone e1=alone r3=head read:2 r4=hidden");
});

test("a member that fails after joining splits the group it was in (#5350)", () => {
	const { tracker, call, view } = harness(true);
	for (const id of ["a", "b", "c"]) {
		call(id, "read");
		tracker.settle(id, "done");
	}
	tracker.settle("b", "failed");
	assert.equal(view(), "a=alone b=alone c=alone");
});

test("a call still running at a break joins its group when it finishes, and later calls start a new group (#5350)", () => {
	const { tracker, call, view } = harness(true);
	call("a", "read");
	tracker.settle("a", "done");
	call("b", "read");
	tracker.break();
	call("c", "read");
	tracker.settle("c", "done");
	call("d", "read");
	tracker.settle("d", "done");
	tracker.settle("b", "done");
	assert.equal(view(), "a=head read:2 b=hidden c=head read:2 d=hidden");
});

test("a returned call whose work continues in the background stays alone and splits the group (#5350)", () => {
	const { tracker, call, view } = harness(true);
	for (const [id, tool, state] of [
		["a", "read", "done"],
		["b", "read", "done"],
		["y", "bash", "background"],
		["c", "read", "done"],
		["d", "read", "done"],
	] as const) {
		call(id, tool);
		tracker.settle(id, state);
	}
	assert.equal(view(), "a=head read:2 b=hidden y=alone c=head read:2 d=hidden");
});
