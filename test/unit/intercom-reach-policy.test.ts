import assert from "node:assert/strict";
import { test } from "vitest";
import {
	confinedIntercomChildGroup,
	IntercomPolicyError,
	SessionIntercomPolicy,
	sessionIntercomFacade,
} from "../../packages/coding-agent/src/core/intercom-policy.js";
import {
	admitsMemberships,
	canJoin,
	canLeave,
	canPeek,
	confinedChildGroup,
	createReachPolicy,
	isReachable,
	narrowMemberships,
	reachesAnyGroup,
	reachGroups,
	reachPolicyError,
} from "../../packages/intercom/reach-policy.js";

const docA = createReachPolicy("doc-a", ["doc-b", " doc-c ", "doc-b", "doc-a"]);

test("a reach policy keeps its home and each reachable group once (#5352)", () => {
	assert.deepEqual(docA, { home: "doc-a", reachable: ["doc-b", "doc-c"] });
	assert.deepEqual(reachGroups(docA), ["doc-a", "doc-b", "doc-c"]);
	assert.deepEqual(reachGroups(createReachPolicy("doc-a")), ["doc-a"]);
});

test("a session reaches its home, its reachable groups and the subgroups under its home, and nothing else (#5352)", () => {
	for (const group of ["doc-a", "doc-b", "doc-c", "doc-a/team", "doc-a/team/review"])
		assert.equal(isReachable(docA, group), true, group);
	for (const group of ["doc-d", "default", "doc-ab", "doc-a/", "doc-b/team", "workflow:run"])
		assert.equal(isReachable(docA, group), false, group);
	assert.equal(reachesAnyGroup(docA, ["doc-d", "doc-c"]), true);
	assert.equal(reachesAnyGroup(docA, ["doc-d", "doc-b/team"]), false);
});

test("reach is one way (#5352)", () => {
	const docB = createReachPolicy("doc-b");
	assert.equal(isReachable(docA, docB.home), true);
	assert.equal(isReachable(docB, docA.home), false);
});

test("a session joins and peeks only within its reach and never leaves its home (#5352)", () => {
	assert.equal(canJoin(docA, "doc-b"), true);
	assert.equal(canJoin(docA, "doc-d"), false);
	assert.equal(canJoin(docA, "doc-a/team"), false, "a subgroup is reached, not joined");
	assert.equal(canPeek(docA, "doc-a/team"), true);
	assert.equal(canPeek(docA, "doc-d"), false);
	assert.equal(canLeave(docA, "doc-a"), false);
	assert.equal(canLeave(docA, "doc-b"), true);
});

test("memberships stay within the reach and keep the home; narrowing drops the rest (#5352)", () => {
	assert.equal(admitsMemberships(docA, ["doc-a", "doc-b"]), true);
	assert.equal(admitsMemberships(docA, ["doc-b"]), false, "the home is always held");
	assert.equal(admitsMemberships(docA, ["doc-a", "doc-d"]), false);
	const narrowed = createReachPolicy("doc-a", ["doc-c"]);
	assert.deepEqual(narrowMemberships(narrowed, ["doc-b", "doc-c", "doc-a"]), ["doc-a", "doc-c"]);
	assert.deepEqual(narrowMemberships(narrowed, narrowMemberships(narrowed, ["doc-b", "doc-c"])), ["doc-a", "doc-c"]);
});

test("a host-supplied policy is refused with the reason when it is invalid (#5352)", () => {
	assert.match(reachPolicyError("", []) ?? "", /non-empty group name/);
	assert.match(reachPolicyError("auto", []) ?? "", /reserved/);
	assert.match(reachPolicyError("doc-a", "doc-b") ?? "", /array/);
	assert.match(reachPolicyError("doc-a", ["doc-b", 7]) ?? "", /non-empty group name/);
	assert.match(
		reachPolicyError(
			"doc-a",
			Array.from({ length: 1_001 }, (_, index) => `g${index}`),
		) ?? "",
		/1001 groups/,
	);
	assert.equal(reachPolicyError("doc-a", undefined), undefined);
	assert.throws(() => createReachPolicy("doc-a", ["true"]), /reserved/);
});

test("a child's group sits under its parent's home, never in the parent's reachable groups (#5352)", () => {
	for (const confine of [confinedChildGroup, confinedIntercomChildGroup]) {
		assert.equal(confine("doc-a", undefined), "doc-a");
		assert.equal(confine("doc-a", "  "), "doc-a");
		assert.equal(confine("doc-a", "doc-a"), "doc-a");
		assert.equal(confine("doc-a", "doc-a/team"), "doc-a/team");
		assert.equal(confine("doc-a", "team"), "doc-a/team");
		assert.equal(confine("doc-a", "doc-b"), "doc-a/doc-b");
		assert.equal(confine("doc-a", "doc-ab"), "doc-a/doc-ab");
	}
});

test("the host's policy validates the option, and a child's policy reaches nothing and can't change (#5352)", async () => {
	assert.throws(() => SessionIntercomPolicy.fromOptions({ group: " " }), IntercomPolicyError);
	assert.throws(() => SessionIntercomPolicy.fromOptions({ group: "doc-a", reachable: ["auto"] }), IntercomPolicyError);
	const host = SessionIntercomPolicy.fromOptions({ group: " doc-a ", reachable: ["doc-b", "doc-a", "doc-b"] });
	assert.equal(host.home, "doc-a");
	assert.deepEqual(host.reachable, ["doc-b"]);

	const applied: Array<readonly string[]> = [];
	const stop = host.onReachableChange((reachable) => {
		applied.push(reachable);
	});
	await host.setReachable(["doc-c"]);
	stop();
	await host.setReachable([]);
	assert.deepEqual(applied, [["doc-c"]]);
	assert.deepEqual(host.reachable, []);
	await assert.rejects(host.setReachable(["auto"]), IntercomPolicyError);

	const stage = SessionIntercomPolicy.forChild("workflow:run/team", host);
	assert.equal(stage.child, true);
	assert.deepEqual(stage.reachable, []);
	await assert.rejects(stage.setReachable(["doc-c"]), IntercomPolicyError);
	assert.equal(stage.childGroup("review"), "workflow:run/team/review");

	await host.setReachable(["doc-b"]);
	assert.throws(() => SessionIntercomPolicy.forChild("doc-b", host), /never gains its parent's reachable groups/);
	assert.throws(() => SessionIntercomPolicy.forChild(" doc-b ", host), IntercomPolicyError);
});

test("session.intercom refuses a reach change on a session created without the option (#5352)", async () => {
	const facade = sessionIntercomFacade(undefined);
	assert.equal(facade.group, undefined);
	assert.deepEqual(facade.reachable, []);
	await assert.rejects(facade.setReachable(["doc-b"]), IntercomPolicyError);
	const policy = SessionIntercomPolicy.fromOptions({ group: "doc-a" });
	const host = sessionIntercomFacade(policy);
	await host.setReachable(["doc-b"]);
	assert.equal(host.group, "doc-a");
	assert.deepEqual(host.reachable, ["doc-b"]);
});
