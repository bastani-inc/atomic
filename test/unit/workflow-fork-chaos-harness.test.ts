import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "vitest";
import {
	ATTEMPT_TERMINALS,
	abortDisposition,
	assertChaosInvariants,
	assertLocalSqliteReport,
	CHAOS_ERROR_CAUSE_DEPTH,
	CHAOS_INVARIANTS,
	ChaosInvariantError,
	expectedForkRetryable,
	findChaosInvariantError,
	foldAttempt,
	isChaosInvariantError,
	readChaosReport,
	redriveDecision,
	unexplainedAbortForks,
} from "../distributed/fork-chaos/verdict.mjs";
import { makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const harness = fileURLToPath(new URL("../distributed/fork-chaos/", import.meta.url));
const unixTest = process.platform === "win32" ? test.skip : test;
const temporary: string[] = [];
afterEach(() => {
	for (const directory of temporary.splice(0)) removeTempDirectory(directory);
});

test("fork chaos retryability follows the journal phase, including uncertain and confirmed commits (#4321)", () => {
	for (const phase of ["read", "claim"])
		assert.equal(expectedForkRetryable("journal-unavailable", phase), true, phase);
	for (const phase of ["commit", "commit-confirmed", "hydrate", undefined])
		assert.equal(expectedForkRetryable("journal-unavailable", phase), false, phase);
	for (const code of ["source-busy", "copy-failed", "session-unavailable"])
		assert.equal(expectedForkRetryable(code, undefined), true, code);
	for (const code of ["invalid-option", "source-not-found", "cleanup-failed", undefined])
		assert.equal(expectedForkRetryable(code, undefined), false, code);
});

describe("fork chaos cancellation bookkeeping", () => {
	// Attempt logs as workload.ts writes them for one cancelled attempt.
	const beforeWrite = [{ t: "intent" }, { t: "try", n: 1 }, { t: "aborted", n: 1 }];
	const adoptedAfterWrite = [
		{ t: "intent" },
		{ t: "copy-begin", forkRunId: "fork-1" },
		{ t: "copy-end", forkRunId: "fork-1", error: { code: "journal-unavailable" } },
		{ t: "aborted-after-write", forkRunId: "fork-1", phase: "rejected" },
		{ t: "adopted", forkRunId: "fork-1" },
		{ t: "done", forkRunId: "fork-1" },
	];
	const unconfirmedWrite = [
		{ t: "intent" },
		{ t: "copy-begin", forkRunId: "fork-1" },
		{ t: "aborted-after-write", forkRunId: "fork-1", phase: "rejected" },
		{ t: "aborted", forkRunId: "fork-1", phase: "rejected" },
	];
	// What recovery does with an attempt's log, given which of its copied forks the journal holds.
	const recover = (records: readonly { readonly t: string }[], held: readonly string[]) => {
		const state = foldAttempt(records);
		if (state.terminal) return { action: "none" };
		return redriveDecision(
			state.cancelled,
			[...state.forkRunIds].filter((id) => held.includes(id)),
		);
	};

	test("a cancellation adopts the fork its write named when the journal holds it, and never forks again (#4321)", () => {
		assert.equal(abortDisposition(undefined, undefined), "aborted-before-write");
		assert.equal(abortDisposition({ forkRunId: "fork-1" }, true), "adopt-written-fork");
		assert.equal(abortDisposition({ forkRunId: "fork-1" }, false), "aborted-write-unconfirmed");
	});

	test("recovery adopts a killed cancelled write's fork if present, and otherwise ends the attempt without forking again (#4321)", () => {
		const killedAfterCancelledWrite = adoptedAfterWrite.slice(0, 4);
		assert.deepEqual(recover(killedAfterCancelledWrite, ["fork-1"]), { action: "adopt", forkRunIds: ["fork-1"] });
		// The write may still land: the attempt ends with its candidate, for the global sweep, and issues no new fork.
		assert.deepEqual(recover(killedAfterCancelledWrite, []), {
			action: "end-aborted",
			forkRunId: "fork-1",
			phase: "rejected",
		});
		// Without a cancellation, a kill mid-copy whose fork is absent is driven again, as before.
		assert.deepEqual(recover(adoptedAfterWrite.slice(0, 2), []), { action: "drive" });
		for (const ended of [adoptedAfterWrite, unconfirmedWrite, beforeWrite])
			assert.deepEqual(recover(ended, ["fork-1"]), { action: "none" });
	});

	test("a process killed right after requesting the cancellation is never forked again (#4321)", () => {
		// abort-requested is fsynced before the signal aborts; the kill lands before the rejection is logged.
		const killedBeforeWrite = [{ t: "intent" }, { t: "try", n: 1 }, { t: "abort-requested", n: 1 }];
		const killedDuringWrite = [
			{ t: "intent" },
			{ t: "try", n: 1 },
			{ t: "copy-begin", forkRunId: "fork-1" },
			{ t: "abort-requested", n: 1, forkRunId: "fork-1", phase: "begun" },
		];
		// The write began after the request: its fork is the candidate.
		const writeAfterRequest = [
			{ t: "intent" },
			{ t: "abort-requested", n: 1 },
			{ t: "copy-begin", forkRunId: "fork-2" },
		];
		assert.deepEqual(recover(killedBeforeWrite, []), { action: "end-aborted" });
		assert.deepEqual(recover(killedDuringWrite, ["fork-1"]), { action: "adopt", forkRunIds: ["fork-1"] });
		assert.deepEqual(recover(killedDuringWrite, []), { action: "end-aborted", forkRunId: "fork-1", phase: "begun" });
		assert.deepEqual(recover(writeAfterRequest, []), { action: "end-aborted", forkRunId: "fork-2", phase: "begun" });

		// The checker then accepts only the candidate recovery recorded.
		const endedBeforeWrite = [...killedBeforeWrite, { t: "aborted", redriven: true }];
		const endedDuringWrite = [...killedDuringWrite, { t: "aborted", forkRunId: "fork-1", redriven: true }];
		assert.deepEqual(unexplainedAbortForks(endedBeforeWrite, ["fork-9"]), ["fork-9"]);
		assert.deepEqual(unexplainedAbortForks(endedDuringWrite, ["fork-1"]), []);
		assert.deepEqual(unexplainedAbortForks(endedDuringWrite, ["fork-2"]), ["fork-2"]);
	});

	test("the checker accepts only the candidate fork of a cancelled write, never a fork after a cancellation before writing (#4321)", () => {
		assert.deepEqual(unexplainedAbortForks(unconfirmedWrite, ["fork-1"]), [], "a cancelled write that landed later");
		assert.deepEqual(unexplainedAbortForks(unconfirmedWrite, []), []);
		assert.deepEqual(
			unexplainedAbortForks(unconfirmedWrite, ["fork-2"]),
			["fork-2"],
			"a fork other than the candidate",
		);
		assert.deepEqual(
			unexplainedAbortForks(beforeWrite, ["fork-1"]),
			["fork-1"],
			"a fork after a cancellation before writing",
		);
		assert.deepEqual(unexplainedAbortForks(beforeWrite, []), []);
	});

	test("only aborted records explain a cancelled attempt's fork, never records of other types (#4321)", () => {
		const otherRecords = [
			{ t: "copy-begin", forkRunId: "fork-2" },
			{ t: "abort-requested", forkRunId: "fork-2", phase: "begun" },
			{ t: "aborted-after-write", forkRunId: "fork-2", phase: "rejected" },
			{ t: "aborted" },
		];
		assert.deepEqual(unexplainedAbortForks(otherRecords, ["fork-2"]), ["fork-2"]);
		assert.deepEqual(unexplainedAbortForks([{ t: "aborted", forkRunId: "fork-2" }], ["fork-2", "fork-3"]), [
			"fork-3",
		]);
	});

	test("an attempt ends at each terminal record and at no other (#4321)", () => {
		assert.deepEqual(ATTEMPT_TERMINALS, [
			"done",
			"aborted",
			"probe-ok",
			"failed-nonretryable",
			"gave-up",
			"probe-unexpected-success",
		]);
		for (const t of ["done", "aborted", "probe-ok", "failed-nonretryable", "gave-up", "probe-unexpected-success"])
			assert.equal(foldAttempt([{ t: "intent" }, { t }]).terminal, true, t);
		for (const t of [
			"intent",
			"try",
			"copy-begin",
			"abort-requested",
			"aborted-after-write",
			"adopted",
			"redrive",
			"",
		])
			assert.equal(foldAttempt([{ t }]).terminal, false, t);
	});

	test("folding keeps the intent's plan and only valid copy-begin ids (#4321)", () => {
		const plan = { source: "run-1" };
		const state = foldAttempt([
			{ t: "try", plan: { source: "not-a-plan" } },
			{ t: "intent", plan },
			{ t: "intent" },
			{ t: "try", plan: { source: "must-not-replace-intent" } },
			{ t: "copy-begin", forkRunId: "fork-1" },
			{ t: "copy-begin", forkRunId: 7 },
			{ t: "copy-begin" },
			{ t: "copy-end", forkRunId: "fork-x" },
			{ t: "aborted", forkRunId: "fork-y" },
		]);
		assert.equal(state.plan, plan);
		assert.deepEqual([...state.forkRunIds], ["fork-1"]);
		assert.equal(state.cancelled, undefined, "no cancellation was requested");
		assert.equal(foldAttempt([{ t: "copy-begin", forkRunId: "fork-1" }]).plan, undefined);
	});

	test("a cancellation keeps its candidate when a later marker names none, and takes a newly named one (#4321)", () => {
		assert.deepEqual(foldAttempt([{ t: "abort-requested", forkRunId: 7, phase: 3 }]).cancelled, {});
		const kept = foldAttempt([
			{ t: "abort-requested", forkRunId: "fork-1", phase: "begun" },
			{ t: "aborted-after-write", phase: "rejected" },
		]);
		assert.deepEqual(kept.cancelled, { forkRunId: "fork-1", phase: "begun" });
		const replaced = foldAttempt([
			{ t: "abort-requested", forkRunId: "fork-1", phase: "begun" },
			{ t: "aborted-after-write", forkRunId: "fork-3", phase: "rejected" },
		]);
		assert.deepEqual(replaced.cancelled, { forkRunId: "fork-3", phase: "rejected" });
	});
});

const BRANCH = "feat-issue-4321-fork-and-time-travel";
const vnetId = (group: string, vnet: string) =>
	`/subscriptions/sub-1/resourceGroups/${group}/providers/Microsoft.Network/virtualNetworks/${vnet}`;
const flowLogId = (name: string) =>
	`/subscriptions/sub-1/resourceGroups/NetworkWatcherRG/providers/Microsoft.Network/networkWatchers/NetworkWatcher_westus3/flowLogs/${name}`;
const rows = (lines: readonly (readonly string[])[]) => lines.map((line) => `${line.join("\t")}\n`).join("");

/**
 * A stand-in `az` over four TSV tables (control peerings, groups, resources, flow logs). It answers the fixed list
 * queries teardown.sh issues, applies deletes to the tables, and logs every call.
 */
const AZ_STUB = `#!/usr/bin/env bash
d="$AZ_STUB_DIR"
printf '%s\\n' "$*" >>"$d/calls.log"
arg() { local want="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { printf '%s' "$2"; return; }; shift; done; }
drop() { awk -F'\\t' -v key="$2" -v col="$3" 'tolower($col) != tolower(key)' "$d/$1" >"$d/$1.tmp" && mv "$d/$1.tmp" "$d/$1"; }
case "$1 $2" in
"network vnet")
	case "$4" in
	list) cat "$d/peerings.tsv" ;;
	delete) drop peerings.tsv "$(arg -n "$@")" 1 ;;
	esac ;;
"group list") cat "$d/groups.tsv" ;;
"group delete") group="$(arg -n "$@")"; drop groups.tsv "$group" 1; drop resources.tsv "$group" 1 ;;
"group wait") ;;
"resource list")
	if [ -n "$(arg --resource-type "$@")" ]; then
		[ -e "$d/fail-flowlog-list" ] && exit 1
		[ -e "$d/fail-flowlog-list-once" ] && { rm "$d/fail-flowlog-list-once"; exit 1; }
		cut -f1 "$d/flowlogs.tsv"
	else cat "$d/resources.tsv"; fi ;;
"resource show") [ -e "$d/fail-flowlog-show" ] && exit 1; awk -F'\\t' -v id="$(arg --ids "$@")" '$1 == id { print $2 }' "$d/flowlogs.tsv" ;;
"resource delete") [ -e "$d/fail-flowlog-delete" ] && exit 1; drop flowlogs.tsv "$(arg --ids "$@")" 1 ;;
*) echo "unexpected az call: $*" >&2; exit 64 ;;
esac
`;

function teardownFixture(leftoverResources: readonly (readonly string[])[] = [], faults: readonly string[] = []) {
	const root = makeTempDirectory("fork-chaos-teardown-");
	temporary.push(root);
	const stub = join(root, "stub");
	const bin = join(root, "bin");
	mkdirSync(stub);
	mkdirSync(bin);
	writeFileSync(join(bin, "az"), AZ_STUB);
	chmodSync(join(bin, "az"), 0o755);
	writeFileSync(join(stub, "calls.log"), "");
	writeFileSync(
		join(stub, "peerings.tsv"),
		rows([
			["atomic-dt-demo-westus3", vnetId("atomic-dt-4321-demo-westus3", "fc-demo-vnet-westus3")],
			["atomic-dt-demo-centralus", vnetId("atomic-dt-4321-demo-centralus", "fc-demo-vnet-centralus")],
			// Another run whose id starts with this one, and a hand-made peering naming it: both stay.
			[
				"atomic-dt-demo-production-westus3",
				vnetId("atomic-dt-4321-demo-production-westus3", "fc-demo-production-vnet-westus3"),
			],
			["demo-hub-link", vnetId("demo-production", "demo")],
		]),
	);
	writeFileSync(
		join(stub, "groups.tsv"),
		rows([
			["atomic-dt-4321-demo-westus3", "demo", BRANCH],
			["atomic-dt-4321-demo-centralus", "demo", BRANCH],
			["atomic-dt-4321-demo-production-westus3", "demo-production", BRANCH],
			["demo-production", "-", "-"],
		]),
	);
	writeFileSync(
		join(stub, "resources.tsv"),
		rows([
			["atomic-dt-4321-demo-westus3", "Microsoft.Compute/virtualMachines", "demo", BRANCH],
			["atomic-dt-4321-demo-westus3", "Microsoft.Compute/disks", "demo", BRANCH],
			["atomic-dt-4321-demo-production-westus3", "Microsoft.Compute/disks", "demo-production", BRANCH],
			["demo-production", "Microsoft.Network/publicIPAddresses", "-", "-"],
			...leftoverResources,
		]),
	);
	writeFileSync(
		join(stub, "flowlogs.tsv"),
		rows([
			[flowLogId("fc-demo-vnet-westus3-flowlog"), vnetId("atomic-dt-4321-demo-westus3", "fc-demo-vnet-westus3")],
			[
				flowLogId("fc-demo-production-vnet-westus3-flowlog"),
				vnetId("atomic-dt-4321-demo-production-westus3", "fc-demo-production-vnet-westus3"),
			],
			[flowLogId("demo-flowlog"), vnetId("demo-production", "demo")],
		]),
	);
	for (const fault of faults) writeFileSync(join(stub, fault), "");
	const run = (runId: string) =>
		spawnSyncCollect(["bash", join(harness, "teardown.sh")], {
			env: {
				...process.env,
				PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
				AZ_STUB_DIR: stub,
				RUN_ID: runId,
				STATE_DIR: join(root, "state"),
				ARTIFACT_DIR: "",
				SUBSCRIPTION: "",
				ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP: "control-rg",
				ATOMIC_DISTRIBUTED_CONTROL_VNET: "control-vnet",
			},
		});
	const table = (name: string) => readFileSync(join(stub, name), "utf8");
	const calls = () => table("calls.log").split("\n").filter(Boolean);
	return { run, table, calls, stateDir: join(root, "state") };
}

describe("fork chaos teardown (#4321)", () => {
	unixTest("deletes only the run's own groups, peerings and flow logs, never similarly named ones", () => {
		const fixture = teardownFixture();
		const result = fixture.run("demo");
		assert.equal(result.exitCode, 0, result.stderr.toString());

		const deletes = fixture.calls().filter((call) => call.includes(" delete "));
		assert.deepEqual(deletes, [
			"network vnet peering delete -g control-rg --vnet-name control-vnet -n atomic-dt-demo-westus3 -o none",
			"network vnet peering delete -g control-rg --vnet-name control-vnet -n atomic-dt-demo-centralus -o none",
			"group delete -n atomic-dt-4321-demo-westus3 --yes --no-wait",
			"group delete -n atomic-dt-4321-demo-centralus --yes --no-wait",
			`resource delete --ids ${flowLogId("fc-demo-vnet-westus3-flowlog")} -o none`,
		]);
		assert.match(fixture.table("groups.tsv"), /^atomic-dt-4321-demo-production-westus3\t/m);
		assert.match(fixture.table("groups.tsv"), /^demo-production\t/m);
		assert.match(fixture.table("peerings.tsv"), /^atomic-dt-demo-production-westus3\t/m);
		assert.match(fixture.table("peerings.tsv"), /^demo-hub-link\t/m);
		assert.match(fixture.table("flowlogs.tsv"), /fc-demo-production-vnet-westus3-flowlog/);
		assert.match(fixture.table("flowlogs.tsv"), /\/demo-flowlog\t/);

		const proof = JSON.parse(readFileSync(join(fixture.stateDir, "teardown-proof.json"), "utf8"));
		assert.equal(proof.clean, true);
		assert.ok(Object.values(proof.queries).every((count) => count === 0));
	});

	unixTest("refuses a run id that is not a resource-name fragment before calling az", () => {
		const fixture = teardownFixture();
		const result = fixture.run("demo' || true");
		assert.equal(result.exitCode, 2);
		assert.match(result.stderr.toString(), /RUN_ID must be letters, digits and hyphens/);
		assert.deepEqual(fixture.calls(), []);
	});

	unixTest("exits nonzero with an unclean proof when a resource of the run remains", () => {
		// Tagged with the run but outside every run group, so deleting the run's groups leaves it behind.
		const fixture = teardownFixture([["shared-tools", "Microsoft.Network/publicIPAddresses", "demo", BRANCH]]);
		const result = fixture.run("demo");
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr.toString(), /error: resources of run demo remain or a verification query failed/);

		const proof = JSON.parse(readFileSync(join(fixture.stateDir, "teardown-proof.json"), "utf8"));
		assert.equal(proof.clean, false);
		assert.equal(proof.queries["az resource list: resources tagged atomic-run=demo"], 1);
		assert.equal(proof.queries["az resource list: public IPs tagged atomic-run=demo or in a run group"], 1);
	});

	const FLOW_LOG_PROOF =
		"az resource list --resource-type Microsoft.Network/networkWatchers/flowLogs: flow logs targeting a run VNet";
	const flowLogFaults: readonly [string, string, number | string][] = [
		["listing flow logs fails", "fail-flowlog-list", "query failed"],
		["a flow log's target cannot be read", "fail-flowlog-show", "query failed"],
		["deleting the run's flow log fails", "fail-flowlog-delete", 1],
		["the deletion pass misses the run's flow log", "fail-flowlog-list-once", 1],
	];
	for (const [name, fault, count] of flowLogFaults)
		unixTest(`exits nonzero with an unclean proof when ${name}`, () => {
			const fixture = teardownFixture([], [fault]);
			const result = fixture.run("demo");
			assert.equal(result.exitCode, 1);
			assert.match(result.stderr.toString(), /error: resources of run demo remain or a verification query failed/);

			const proof = JSON.parse(readFileSync(join(fixture.stateDir, "teardown-proof.json"), "utf8"));
			assert.equal(proof.clean, false);
			assert.equal(proof.queries[FLOW_LOG_PROOF], count);
			const others = Object.entries(proof.queries).filter(([query]) => query !== FLOW_LOG_PROOF);
			assert.ok(others.every(([, value]) => value === 0));
			assert.match(fixture.table("flowlogs.tsv"), /fc-demo-vnet-westus3-flowlog/);
			assert.match(fixture.table("flowlogs.tsv"), /fc-demo-production-vnet-westus3-flowlog/);
			assert.match(fixture.table("flowlogs.tsv"), /\/demo-flowlog\t/);
			assert.match(fixture.table("groups.tsv"), /^atomic-dt-4321-demo-production-westus3\t/m);
			assert.match(fixture.table("groups.tsv"), /^demo-production\t/m);
			assert.match(fixture.table("peerings.tsv"), /^atomic-dt-demo-production-westus3\t/m);
			assert.ok(
				fixture
					.calls()
					.filter((call) => call.startsWith("resource delete"))
					.every((call) => call.includes("fc-demo-vnet-westus3-flowlog")),
			);
		});
});

const passingReport = () => ({
	invariants: Object.fromEntries(CHAOS_INVARIANTS.map((name) => [name, { pass: true, violations: [] }])),
});

function verdictOf(text: string | undefined, checkerExitCode?: number | null): ChaosInvariantError {
	try {
		assertChaosInvariants(text, { checkerExitCode });
	} catch (error) {
		assert.ok(isChaosInvariantError(error));
		assert.ok(error instanceof ChaosInvariantError);
		assert.equal(error.retryable, false);
		return error;
	}
	assert.fail("expected the round to fail");
}

describe("fork chaos verdict (#4321)", () => {
	test("passes only a report in which every invariant passed and the checker exited 0", () => {
		assertChaosInvariants(JSON.stringify(passingReport()), { checkerExitCode: 0 });
		assertChaosInvariants(JSON.stringify(passingReport()));
	});

	test("a failed invariant fails the round and names it", () => {
		const report = passingReport();
		report.invariants.fencing.pass = false;
		const error = verdictOf(JSON.stringify(report), 1);
		assert.equal(error.code, "invariants-failed");
		assert.deepEqual(error.failedInvariants, ["fencing"]);
		assert.deepEqual(error.missingInvariants, []);
		assert.equal(error.checkerExitCode, 1);
		assert.equal(
			error.message,
			"Fork chaos round did not pass: invariants failed (failed: fencing; checker exit 1) (invariants-failed). " +
				"Open check.json and read the failed invariants' example violations before changing the fork code.",
		);
	});

	test("a missing report, unreadable JSON or an incomplete report fails the round", () => {
		assert.equal(verdictOf(undefined).code, "report-missing");
		assert.equal(verdictOf("  \n").code, "report-missing");

		const unreadable = verdictOf("{ truncated");
		assert.equal(unreadable.code, "report-invalid");
		assert.ok(unreadable.cause instanceof SyntaxError);

		const report = passingReport() as { invariants: Record<string, { pass: boolean | string }> };
		delete report.invariants.recovery;
		report.invariants.typedErrors.pass = "true";
		const incomplete = verdictOf(JSON.stringify(report));
		assert.equal(incomplete.code, "report-invalid");
		assert.deepEqual(incomplete.missingInvariants, ["typedErrors", "recovery"]);

		assert.deepEqual(verdictOf(JSON.stringify({})).missingInvariants, [...CHAOS_INVARIANTS]);
	});

	test("a checker that exited nonzero or was killed fails even a passing report", () => {
		assert.equal(verdictOf(JSON.stringify(passingReport()), 3).code, "checker-failed");
		const killed = verdictOf(JSON.stringify(passingReport()), null);
		assert.equal(killed.code, "checker-failed");
		assert.equal(killed.checkerExitCode, null);
		assert.match(killed.message, /checker ended by a signal/);
	});

	test("recognizes a chaos error structurally and through a bounded cause chain", () => {
		const local = new ChaosInvariantError("checker-failed", { checkerExitCode: 2 });
		assert.equal(findChaosInvariantError(local), local);

		// The same error rebuilt by another module copy or realm: only name and a known code.
		const structural = { name: "ChaosInvariantError", code: "invariants-failed" };
		assert.equal(findChaosInvariantError(structural), structural);
		assert.equal(isChaosInvariantError({ name: "ChaosInvariantError", code: "made-up" }), false);
		assert.equal(isChaosInvariantError({ name: "Error", code: "invariants-failed" }), false);
		assert.equal(isChaosInvariantError("ChaosInvariantError"), false);

		const wrapped = new Error("controller phase failed", { cause: new Error("check phase", { cause: local }) });
		assert.equal(findChaosInvariantError(wrapped), local);
		assert.equal(findChaosInvariantError(new Error("outer", { cause: structural })), structural);

		const wrap = (times: number) => {
			let error: Error = local;
			for (let index = 0; index < times; index++) error = new Error(`wrapper ${index}`, { cause: error });
			return error;
		};
		assert.equal(findChaosInvariantError(wrap(CHAOS_ERROR_CAUSE_DEPTH)), local);
		assert.equal(findChaosInvariantError(wrap(CHAOS_ERROR_CAUSE_DEPTH + 1)), undefined);

		const cyclic = new Error("cyclic");
		cyclic.cause = cyclic;
		assert.equal(isChaosInvariantError(cyclic), false);
	});

	test("a report that exists but cannot be read is a typed report-invalid error", () => {
		const directory = makeTempDirectory("fork-chaos-verdict-");
		temporary.push(directory);
		assert.equal(readChaosReport(join(directory, "absent.json")), undefined);
		try {
			readChaosReport(directory);
			assert.fail("expected reading a directory to fail");
		} catch (error) {
			assert.ok(error instanceof ChaosInvariantError);
			assert.equal(error.code, "report-invalid");
			assert.equal((error.cause as NodeJS.ErrnoException).code, "EISDIR");
		}
	});

	test("the verdict command exits nonzero for a missing, unreadable, invalid or failing report", () => {
		const directory = makeTempDirectory("fork-chaos-verdict-");
		temporary.push(directory);
		const failing = passingReport();
		failing.invariants.noCorruption.pass = false;
		const files = {
			passing: JSON.stringify(passingReport()),
			failing: JSON.stringify(failing),
			invalid: "not json",
			incomplete: JSON.stringify({ invariants: { fencing: { pass: true } } }),
		};
		for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, `${name}.json`), text);
		mkdirSync(join(directory, "unreadable.json"));
		const verdict = (file: string) => spawnSyncCollect([process.execPath, join(harness, "verdict.mjs"), file]);

		assert.equal(verdict(join(directory, "passing.json")).exitCode, 0);
		const expected = {
			failing: "invariants-failed",
			invalid: "report-invalid",
			incomplete: "report-invalid",
			unreadable: "report-invalid",
			absent: "report-missing",
		};
		for (const [name, code] of Object.entries(expected)) {
			const result = verdict(join(directory, `${name}.json`));
			assert.equal(result.exitCode, 1, name);
			assert.match(
				result.stderr.toString(),
				new RegExp(`^Fork chaos round did not pass: .*\\(${code}\\)\\. `),
				name,
			);
		}
	});
});

/**
 * Stand-ins for `az`, `ssh` and `timeout` around verify-security.sh. `az` answers from per-group fixtures and fails a
 * query when a matching `fail-*` flag file exists; `ssh` answers the probe and listener queries with healthy results.
 */
const SECURITY_AZ_STUB = `#!/usr/bin/env bash
d="$AZ_STUB_DIR"
printf '%s\\n' "$*" >>"$d/calls.log"
arg() { local want="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { printf '%s' "$2"; return; }; shift; done; }
rg="$(arg -g "$@")"
case "$1 $2 $3" in
"vm list-ip-addresses "*) [ -e "$d/fail-vm-$rg" ] && exit 1; cat "$d/vm-$rg.json" ;;
"network public-ip list") [ -e "$d/fail-public-ip-$rg" ] && exit 1; echo 0 ;;
"network lb list") echo 0 ;;
"network nic list") [ -e "$d/fail-nic-$rg" ] && exit 1; cat "$d/nics-$rg.tsv" ;;
"network nic list-effective-nsg") [ -e "$d/fail-nsg-$(arg -n "$@")" ] && exit 1; cat "$d/effective.json" ;;
*) echo "unexpected az call: $*" >&2; exit 64 ;;
esac
`;
const SECURITY_SSH_STUB = `#!/usr/bin/env bash
cat >/dev/null
case "\${!#}" in
*"ss -ltnH"*) echo "10.64.1.4:8443,127.0.0.1:8080,0.0.0.0:22" ;;
*) echo '{"withTokenAndCa":"200","withoutToken":"401","plainHttpToTlsPort":"400","curlWithoutRunCaExit":60,"sqldBackendPort8080Exit":7,"atomicClient":{"withTokenAndCa":"ok","withoutToken":{"rejected":true},"plainHttpWithoutTls":{"rejected":true}},"atomicClientWithoutRunCa":{"withTokenAndCa":{"rejected":true}}}' ;;
esac
`;

const inboundRule = (name: string, access: "Allow" | "Deny", source: string) => ({
	name,
	direction: "Inbound",
	access,
	priority: 100,
	sourceAddressPrefix: source,
	destinationPortRange: "22",
});
const vmAddresses = (...vms: readonly [string, string][]) =>
	JSON.stringify(
		vms.map(([name, ip]) => ({
			virtualMachine: { name, network: { privateIpAddresses: [ip], publicIpAddresses: [] } },
		})),
	);

function securityFixture(faults: readonly string[], manifest?: object) {
	const root = makeTempDirectory("fork-chaos-security-");
	temporary.push(root);
	const stub = join(root, "stub");
	const bin = join(root, "bin");
	const state = join(root, "state");
	for (const directory of [stub, bin, state]) mkdirSync(directory);
	for (const [name, script] of [
		["az", SECURITY_AZ_STUB],
		["ssh", SECURITY_SSH_STUB],
		// The control host's own probe of sqld:8443 is refused.
		["timeout", "#!/usr/bin/env bash\nexit 1\n"],
	] as const) {
		writeFileSync(join(bin, name), script);
		chmodSync(join(bin, name), 0o755);
	}
	writeFileSync(
		join(state, "manifest.json"),
		JSON.stringify(
			manifest ?? {
				regions: [
					{ region: "westus3", resourceGroup: "rg-west" },
					{ region: "centralus", resourceGroup: "rg-central" },
				],
				nodes: [
					{ role: "sqld", name: "sqld", resourceGroup: "rg-west", ip: "10.64.1.4" },
					{ role: "worker", name: "a", resourceGroup: "rg-west", ip: "10.64.2.4" },
					{ role: "worker", name: "b", resourceGroup: "rg-central", ip: "10.65.2.4" },
				],
			},
		),
	);
	writeFileSync(join(stub, "calls.log"), "");
	writeFileSync(join(stub, "vm-rg-west.json"), vmAddresses(["vm-sqld", "10.64.1.4"], ["vm-a", "10.64.2.4"]));
	writeFileSync(join(stub, "vm-rg-central.json"), vmAddresses(["vm-b", "10.65.2.4"]));
	writeFileSync(join(stub, "nics-rg-west.tsv"), "nic-sqld\nnic-a\n");
	writeFileSync(join(stub, "nics-rg-central.tsv"), faults.includes("no-nic-rg-central") ? "" : "nic-b\n");
	writeFileSync(
		join(stub, "effective.json"),
		JSON.stringify({
			value: [
				{
					effectiveSecurityRules: [
						inboundRule("fc-deny-internet-in", "Deny", "Internet"),
						inboundRule("fc-deny-vnet-in", "Deny", "VirtualNetwork"),
						inboundRule("fc-deny-lb-in", "Deny", "AzureLoadBalancer"),
						inboundRule("fc-allow-ssh-from-control", "Allow", "10.200.0.0/24"),
					],
				},
			],
		}),
	);
	for (const fault of faults) if (fault.startsWith("fail-")) writeFileSync(join(stub, fault), "");
	const result = spawnSyncCollect(["bash", join(harness, "verify-security.sh")], {
		env: {
			...process.env,
			PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
			AZ_STUB_DIR: stub,
			RUN_ID: "demo",
			STATE_DIR: state,
			ARTIFACT_DIR: "",
		},
	});
	const calls = readFileSync(join(stub, "calls.log"), "utf8").split("\n").filter(Boolean);
	const reportFile = join(state, "security-verification.json");
	const report = () =>
		JSON.parse(readFileSync(reportFile, "utf8")) as {
			passed: boolean;
			failures: string[];
			effectiveNsg: { nics: unknown[] };
		};
	return { result, calls, report };
}

describe("fork chaos security verification (#4321)", () => {
	unixTest("passes a topology whose every query answered and whose NICs match the manifest", () => {
		const { result, report } = securityFixture([]);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.equal(report().passed, true);
		assert.deepEqual(report().failures, []);
		assert.equal(report().effectiveNsg.nics.length, 3);
	});

	const faults: readonly [string, readonly string[], readonly string[]][] = [
		["the NIC list fails", ["fail-nic-rg-central"], ["listing NICs in rg-central failed"]],
		[
			"a group has fewer NICs than VMs",
			["no-nic-rg-central"],
			["found 0 NICs in rg-central, expected 1 (one per VM in the manifest)"],
		],
		[
			"a NIC's effective rules cannot be read",
			["fail-nsg-nic-b"],
			["reading the effective NSG rules of NIC nic-b in rg-central failed"],
		],
		[
			"the VM address list fails",
			["fail-vm-rg-central"],
			["listing VM addresses in rg-central failed", "found 2 VMs in the run groups, expected 3 from the manifest"],
		],
		["the public IP count fails", ["fail-public-ip-rg-west"], ["listing public IPs in rg-west failed"]],
	];
	for (const [name, injected, expected] of faults)
		unixTest(`fails closed when ${name}`, () => {
			const { result, report } = securityFixture(injected);
			assert.equal(result.exitCode, 1);
			assert.equal(report().passed, false);
			assert.deepEqual(report().failures, expected);
		});

	unixTest("stops before any Azure query when the manifest lists no VMs", () => {
		const { result, calls } = securityFixture([], {
			regions: [{ region: "westus3", resourceGroup: "rg-west" }],
			nodes: [],
		});
		assert.equal(result.exitCode, 2);
		assert.match(result.stderr.toString(), /lists no regions or no VMs\. Run provision\.sh for RUN_ID=demo first\./);
		assert.deepEqual(calls, []);
	});
});

const sourceNotFound = {
	fork: true,
	name: "ForkSourceNotFoundError",
	code: "source-not-found",
	retryable: false,
	storageScope: "local-only",
	storageAdapter: "node-sqlite",
	hintJoin: true,
	message: "Fork source not found",
};
const passingLocalReport = () => ({
	node: "b",
	mount: "/opt/fork-chaos/localfs",
	localSource: { runId: "run-1", status: "completed" },
	localForkPoints: ["s1", "s2", "child.c1", "child.c2", "child.c3", "child", "s3"],
	localFork: {
		runId: "run-2",
		forkedFrom: { runId: "run-1", stagePath: "child.c2" },
		status: "completed",
		toolsExecutedInFork: ["ct2", "t3", "t4"],
		journalAdapter: "node-sqlite",
	},
	sharedRunViaLocalJournal: { ...sourceNotFound },
	sharedRunPointsViaLocalJournal: { ...sourceNotFound },
	diskFull: { freeBeforeFill: 4096, fallocateExit: 0, ddExit: 1, freeAfterFill: 0 },
	diskFullFork: {
		fork: true,
		name: "ForkCopyFailedError",
		code: "copy-failed",
		retryable: true,
		message: "copy failed",
	},
	runsBeforeDiskFull: 2,
	runsAfterDiskFullAttempt: 2,
	afterFreeingDisk: { forked: "run-3", status: "completed" },
	localRuns: 3,
	localPartialRuns: [] as string[],
});
type LocalReport = ReturnType<typeof passingLocalReport>;

function localVerdictOf(text: string | undefined, workloadExitCode?: number | null): ChaosInvariantError {
	try {
		assertLocalSqliteReport(text, { workloadExitCode });
	} catch (error) {
		assert.ok(error instanceof ChaosInvariantError);
		assert.equal(error.code, "local-sqlite-failed");
		return error;
	}
	assert.fail("expected the node-local SQLite scenario to fail");
}

describe("fork chaos node-local SQLite verdict (#4321)", () => {
	test("passes a report that met every expectation from a workload that exited 0", () => {
		assertLocalSqliteReport(JSON.stringify(passingLocalReport()), { workloadExitCode: 0 });
	});

	const misses: readonly [string, (report: LocalReport) => void, string][] = [
		["the local fork failed", (r) => (r.localFork.status = "failed"), "localFork.status is not completed"],
		[
			"the fork came from the wrong point",
			(r) => (r.localFork.forkedFrom.stagePath = "s3"),
			"localFork.forkedFrom is not the local source at child.c2",
		],
		[
			"a tool before the fork point ran again",
			(r) => r.localFork.toolsExecutedInFork.push("t1"),
			"localFork.toolsExecutedInFork did not replay t1, t2 and ct1 and run t3 and t4",
		],
		[
			"a shared-only run was forked",
			(r) => Object.assign(r, { sharedRunViaLocalJournal: "unexpected success" }),
			"sharedRunViaLocalJournal is not a local-only source-not-found fork error with the join hint",
		],
		[
			"listing a shared-only run's points gave no join hint",
			(r) => (r.sharedRunPointsViaLocalJournal.hintJoin = false),
			"sharedRunPointsViaLocalJournal is not a local-only source-not-found fork error with the join hint",
		],
		[
			"the fork on a full disk succeeded",
			(r) => Object.assign(r, { diskFullFork: { forked: "run-9", status: "completed" } }),
			"diskFullFork did not fail with a typed fork error",
		],
		[
			"the failed fork left a run",
			(r) => (r.runsAfterDiskFullAttempt = 3),
			"runsAfterDiskFullAttempt differs from runsBeforeDiskFull",
		],
		[
			"the fork after freeing the disk failed",
			(r) => Object.assign(r, { afterFreeingDisk: { ...sourceNotFound } }),
			"afterFreeingDisk.status is not completed",
		],
		["a partial run remains", (r) => r.localPartialRuns.push("run-9"), "localPartialRuns is not empty"],
	];
	for (const [name, mutate, expected] of misses)
		test(`fails when ${name}`, () => {
			const report = passingLocalReport();
			mutate(report);
			assert.deepEqual(localVerdictOf(JSON.stringify(report), 0).localFailures, [expected]);
		});

	test("fails a passing report from a workload that exited nonzero or was killed, and a missing or unreadable one", () => {
		const passing = JSON.stringify(passingLocalReport());
		const exited = localVerdictOf(passing, 1);
		assert.deepEqual(exited.localFailures, ["workload exit 1"]);
		assert.equal(
			exited.message,
			"Fork chaos round did not pass: node-local SQLite scenario failed (workload exit 1) (local-sqlite-failed). " +
				"Open node-local-sqlite.json and local-stderr.log on node b; each listed expectation names the report field that missed.",
		);
		assert.deepEqual(localVerdictOf(passing, null).localFailures, ["workload ended by a signal"]);
		assert.deepEqual(localVerdictOf("", 1).localFailures, ["workload exit 1", "no report"]);
		const unreadable = localVerdictOf("{ cut", 0);
		assert.deepEqual(unreadable.localFailures, ["report is not JSON"]);
		assert.ok(unreadable.cause instanceof SyntaxError);
		assert.equal(findChaosInvariantError(new Error("controller", { cause: unreadable })), unreadable);
	});

	test("the verdict command exits nonzero for a failing or missing node-local report", () => {
		const directory = makeTempDirectory("fork-chaos-local-verdict-");
		temporary.push(directory);
		const failing = passingLocalReport();
		failing.localPartialRuns.push("run-9");
		writeFileSync(join(directory, "passing.json"), JSON.stringify(passingLocalReport()));
		writeFileSync(join(directory, "failing.json"), JSON.stringify(failing));
		const verdict = (file: string) =>
			spawnSyncCollect([process.execPath, join(harness, "verdict.mjs"), "--local", join(directory, file)]);

		assert.equal(verdict("passing.json").exitCode, 0);
		for (const [file, detail] of [
			["failing.json", "localPartialRuns is not empty"],
			["absent.json", "no report"],
		] as const) {
			const result = verdict(file);
			assert.equal(result.exitCode, 1, file);
			assert.match(result.stderr.toString(), new RegExp(`\\(${detail}\\) \\(local-sqlite-failed\\)`), file);
		}
	});
});
