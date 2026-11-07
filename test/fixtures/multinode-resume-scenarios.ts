/**
 * The seven acceptance scenarios of #4329 ("resume anywhere"), each with the invariants it checks, the chaos it
 * survives, the dependency exports it needs, and the test that runs it once written. The scenario list test keeps
 * this list complete and fails until every scenario is implemented.
 */

/** A public export a scenario drives, and the dependency issue that ships it. */
export interface ScenarioPrerequisite {
	/** Repository-relative source of the public entry point that exports it. */
	readonly module: "packages/coding-agent/src/index.ts" | "packages/workflows/src/sdk-surface.ts";
	readonly name: string;
	/** A method the export must have, such as `rehydrate` on `AgentSessionRuntime.prototype`. */
	readonly prototypeMember?: string;
	readonly dependency: string;
}

export interface AcceptanceScenario {
	readonly id: number;
	readonly title: string;
	readonly invariants: readonly string[];
	readonly chaos: readonly string[];
	readonly prerequisites: readonly ScenarioPrerequisite[];
	/** Scenarios whose chaos variants this one is made of. */
	readonly scenarios?: readonly number[];
	/** The test that runs this scenario end to end on separate processes; absent until it is written. */
	readonly implementedBy?: { readonly file: string; readonly test: string };
}

const ATOMIC = "packages/coding-agent/src/index.ts" as const;
const WORKFLOWS = "packages/workflows/src/sdk-surface.ts" as const;

export const MULTINODE_RESUME_SCENARIOS: readonly AcceptanceScenario[] = [
	{
		id: 1,
		title:
			"an interactive session with uncommitted, untracked and unpushed work is killed on node A and resumed on node B",
		invariants: [
			"byte-identical tree and HEAD",
			"the conversation continues",
			"node A's absolute paths resolve on node B",
			"the setup hook runs once",
		],
		chaos: ["Git missing", "database partition during the lookup", "SIGKILL right after `git worktree add`"],
		prerequisites: [{ module: ATOMIC, name: "resumeSessionWorktree", dependency: "#4245" }],
		implementedBy: {
			file: "test/integration/multinode-resume.test.ts",
			test: "scenario 1: a session killed on node A resumes on node B in a byte-identical tree, with chaos on the way",
		},
	},
	{
		id: 2,
		title: "a workflow with two worktrees in two repositories is killed mid-stage on node A and resumed on node B",
		invariants: ["no replay against the wrong tree", "completed ctx.tool effects are not repeated"],
		chaos: ["SIGKILL mid-stage", "SIGKILL mid-restore of the second repository"],
		prerequisites: [
			{ module: ATOMIC, name: "workspace", dependency: "#3109" },
			{ module: ATOMIC, name: "restoreWorkspace", dependency: "#3109" },
		],
		implementedBy: {
			file: "test/integration/multinode-resume-runs.test.ts",
			test: "scenario 2: a workflow bound to two repositories is killed mid-step on node A and resumed on node B without repeating or misplacing work",
		},
	},
	{
		id: 3,
		title: "a pooled campaign with children on three nodes loses one node",
		invariants: [
			"the lost node's children are reclaimed and restored elsewhere",
			"bound work never runs on a host that cannot restore",
		],
		chaos: ["SIGKILL of a worker host", "database partition of one host"],
		prerequisites: [{ module: WORKFLOWS, name: "startWorkflowWorkerHost", dependency: "#4310" }],
		implementedBy: {
			file: "test/integration/multinode-resume-pool.test.ts",
			test: "scenario 3: a pooled campaign over three nodes loses one node: its child is reclaimed and restored elsewhere, and bound work never runs on a host that cannot restore",
		},
	},
	{
		id: 4,
		title: "forkRun from an earlier stage on a third node",
		invariants: ["the fork's worktrees are materialized from that stage's boundary snapshot"],
		chaos: ["SIGKILL mid-restore of the fork"],
		prerequisites: [
			{ module: WORKFLOWS, name: "forkRun", dependency: "#4321" },
			{ module: WORKFLOWS, name: "listForkPoints", dependency: "#4321" },
		],
		implementedBy: {
			file: "test/integration/multinode-resume-runs.test.ts",
			test: "scenario 4: forkRun from an earlier stage on a third node materializes that stage's snapshot, also after a SIGKILL mid-restore",
		},
	},
	{
		id: 5,
		title: "a released subagent wakes on a different node from the one that released it",
		invariants: ["its binding is restored before it continues"],
		chaos: ["database partition during the wake"],
		prerequisites: [
			{ module: ATOMIC, name: "AgentSessionRuntime", prototypeMember: "rehydrate", dependency: "#4326 / #4309" },
		],
		implementedBy: {
			file: "test/integration/multinode-resume-released.test.ts",
			test: "scenario 5: a released session wakes on a different node from the one that released it: its worktree is restored before it continues, and a partition during the wake ends in a retryable typed error before a retry succeeds",
		},
	},
	{
		id: 6,
		title: "a git-less node provisions Git and takes part",
		invariants: ["Git is provisioned automatically", "an impossible provision is a typed GitUnavailableError"],
		chaos: ["provisioning download fails"],
		prerequisites: [{ module: ATOMIC, name: "resolveGit", dependency: "#4322" }],
		implementedBy: {
			file: "test/integration/multinode-resume.test.ts",
			test: "scenario 6: a git-less node provisions Git to restore and continue a session; a failed download is a typed precondition error that writes nothing",
		},
	},
	{
		id: 7,
		title: "chaos during each of the above ends in a typed error or a successful retry",
		invariants: ["never a half-restored worktree", "typed errors", "recovery with no manual step"],
		chaos: ["SIGKILL mid-restore", "database partition during the catalog lookup"],
		prerequisites: [],
		scenarios: [1, 2, 3, 4, 5, 6],
		implementedBy: {
			file: "test/integration/multinode-resume-runs.test.ts",
			test: "scenario 7: a database partition during the run lookup and a SIGKILL mid-restore end typed or in a retry that succeeds, never in a half-restored worktree",
		},
	},
];
