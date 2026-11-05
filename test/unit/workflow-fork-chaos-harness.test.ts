import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "vitest";
import {
	assertChaosInvariants,
	CHAOS_ERROR_CAUSE_DEPTH,
	CHAOS_INVARIANTS,
	ChaosInvariantError,
	findChaosInvariantError,
	isChaosInvariantError,
	readChaosReport,
} from "../distributed/fork-chaos/verdict.mjs";
import { makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const harness = fileURLToPath(new URL("../distributed/fork-chaos/", import.meta.url));
const unixTest = process.platform === "win32" ? test.skip : test;
const temporary: string[] = [];
afterEach(() => {
	for (const directory of temporary.splice(0)) removeTempDirectory(directory);
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
	if [ -n "$(arg --resource-type "$@")" ]; then cut -f1 "$d/flowlogs.tsv"; else cat "$d/resources.tsv"; fi ;;
"resource show") awk -F'\\t' -v id="$(arg --ids "$@")" '$1 == id { print $2 }' "$d/flowlogs.tsv" ;;
"resource delete") drop flowlogs.tsv "$(arg --ids "$@")" 1 ;;
*) echo "unexpected az call: $*" >&2; exit 64 ;;
esac
`;

function teardownFixture(leftoverResources: readonly (readonly string[])[] = []) {
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

describe("fork chaos teardown", () => {
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

describe("fork chaos verdict", () => {
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
