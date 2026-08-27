import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, test } from "vitest";
import {
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

interface CommandOutput {
	readonly stdout: string;
	readonly stderr: string;
}

interface NpmPackResult {
	readonly filename: string;
}

const repoRoot = resolve(moduleDir(import.meta.url), "../..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const nativePackageDir = join(repoRoot, "packages", "natives");
const piAiPackageDir = join(repoRoot, "packages", "ai");
const tscEntry = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const PACKED_ARTIFACT_TYPECHECK_TIMEOUT_MS = 240_000;
const PACKED_PACKAGE_INPUTS = [
	"package.json",
	"dist",
	"docs",
	"examples",
	"CHANGELOG.md",
	"README.md",
	"npm-shrinkwrap.json",
] as const;
const OMITTABLE_WORKFLOW_DECLARATIONS = [
	"workflow-authoring-types.d.ts",
	"workflow-heartbeat-contract.d.ts",
	"authoring-contract-ui.d.ts",
] as const;
const ROOT_IMPORT_SOURCE = 'import type { ExtensionAPI } from "@bastani/atomic";\nexport type Api = ExtensionAPI;';
const AUTHORING_PROBE_SOURCE = `import type {
	WorkflowHeartbeatEvent,
	WorkflowHeartbeatEventDetails,
	WorkflowHeartbeatIdentity,
	WorkflowInputsFromSchemas,
	WorkflowOutputsFromSchemas,
	WorkflowProvidedInputsFromSchemas,
	WorkflowRunContext,
} from "@bastani/atomic/workflows";
import { goal as barrelGoal } from "@bastani/atomic/workflows/builtin";
import concreteGoal, {
	type GoalWorkflowDefinition,
	type GoalWorkflowInputs,
} from "@bastani/atomic/workflows/builtin/goal";
import { withSteeringPropagationContext } from "@bastani/atomic/workflows/builtin/steering-context";
import type { TLiteral } from "typebox";

type IsAny<T> = 0 extends 1 & T ? true : false;
type ExpectFalse<T extends false> = T;
type ParallelResult = Awaited<ReturnType<WorkflowRunContext["parallel"]>>;
type Stage = ReturnType<WorkflowRunContext["stage"]>;
type PromptResult = Awaited<ReturnType<Stage["prompt"]>>;
type DeclaredInputs = WorkflowInputsFromSchemas<{ readonly value: TLiteral<"input"> }>;
type ProvidedInputs = WorkflowProvidedInputsFromSchemas<{ readonly value: TLiteral<"provided"> }>;
type DeclaredOutputs = WorkflowOutputsFromSchemas<{ readonly value: TLiteral<"output"> }>;

type WorkflowRunContextIsNotAny = ExpectFalse<IsAny<WorkflowRunContext>>;
type ParallelResultIsNotAny = ExpectFalse<IsAny<ParallelResult>>;
type PromptResultIsNotAny = ExpectFalse<IsAny<PromptResult>>;
type DeclaredInputsIsNotAny = ExpectFalse<IsAny<DeclaredInputs>>;
type ProvidedInputsIsNotAny = ExpectFalse<IsAny<ProvidedInputs>>;
type DeclaredOutputsIsNotAny = ExpectFalse<IsAny<DeclaredOutputs>>;
type HeartbeatEventIsNotAny = ExpectFalse<IsAny<WorkflowHeartbeatEvent>>;
type HeartbeatDetailsIsNotAny = ExpectFalse<IsAny<WorkflowHeartbeatEventDetails>>;
type HeartbeatIdentityIsNotAny = ExpectFalse<IsAny<WorkflowHeartbeatIdentity>>;
type BuiltinBarrelGoalIsNotAny = ExpectFalse<IsAny<typeof barrelGoal>>;
type ConcreteGoalIsNotAny = ExpectFalse<IsAny<typeof concreteGoal>>;
type GoalDefinitionIsNotAny = ExpectFalse<IsAny<GoalWorkflowDefinition>>;
type GoalInputsIsNotAny = ExpectFalse<IsAny<GoalWorkflowInputs>>;
type SteeringContextIsNotAny = ExpectFalse<IsAny<typeof withSteeringPropagationContext>>;
type DeclaredInputValueIsNotAny = ExpectFalse<IsAny<DeclaredInputs["value"]>>;
type ProvidedInputValueIsNotAny = ExpectFalse<IsAny<ProvidedInputs["value"]>>;
type DeclaredOutputValueIsNotAny = ExpectFalse<IsAny<DeclaredOutputs["value"]>>;
type HeartbeatCustomTypeIsNotAny = ExpectFalse<IsAny<WorkflowHeartbeatEvent["customType"]>>;
type HeartbeatIntervalIsNotAny = ExpectFalse<IsAny<WorkflowHeartbeatEventDetails["intervalMinutes"]>>;
type HeartbeatRunIdIsNotAny = ExpectFalse<IsAny<WorkflowHeartbeatIdentity["runId"]>>;
type ConcreteGoalInputIsNotAny = ExpectFalse<IsAny<GoalWorkflowInputs["objective"]>>;

// Each declaration-backed surface must reject an invalid value. If its relative
// import disappears under skipLibCheck, TypeScript accepts the assignment and
// reports the now-unused @ts-expect-error directive.
// @ts-expect-error input schema literals must not widen
const invalidDeclaredInput: DeclaredInputs["value"] = "wrong";
// @ts-expect-error provided input schema literals must not widen
const invalidProvidedInput: ProvidedInputs["value"] = "wrong";
// @ts-expect-error output schema literals must not widen
const invalidDeclaredOutput: DeclaredOutputs["value"] = "wrong";
// @ts-expect-error heartbeat custom type is a fixed protocol literal
const invalidHeartbeatType: WorkflowHeartbeatEvent["customType"] = "wrong";
// @ts-expect-error heartbeat interval is numeric
const invalidHeartbeatInterval: WorkflowHeartbeatEventDetails["intervalMinutes"] = "wrong";
// @ts-expect-error heartbeat run ID is textual
const invalidHeartbeatRunId: WorkflowHeartbeatIdentity["runId"] = 1;
// @ts-expect-error concrete builtin inputs keep their authored shape
const invalidGoalObjective: GoalWorkflowInputs["objective"] = 1;
`;

let fixtureRoot: string | undefined;

afterAll(() => {
	if (fixtureRoot !== undefined) removeTempDirectory(fixtureRoot);
});

function run(command: readonly string[], cwd: string): CommandOutput {
	const result = spawnSyncCollect(command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout: PACKED_ARTIFACT_TYPECHECK_TIMEOUT_MS,
	});
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	assert.equal(result.exitCode, 0, `command failed (${command.join(" ")}):\n${stdout}${stderr}`);
	return { stdout, stderr };
}

function npmCommand(...args: readonly string[]): string[] {
	const npmCli = process.env.npm_execpath;
	assert.ok(npmCli, "npm_execpath must be set by the repository's npm/npx test command");
	return [process.execPath, npmCli, ...args];
}

function stagePackedPackage(stagingDir: string): void {
	// CI builds @bastani/atomic before the integration project. Snapshot only the
	// files npm can pack so this test never rebuilds or mutates the shared dist
	// that sibling Vitest files read concurrently.
	mkdirSync(stagingDir, { recursive: true });
	for (const relativePath of PACKED_PACKAGE_INPUTS) {
		const source = join(packageDir, relativePath);
		if (existsSync(source)) cpSync(source, join(stagingDir, relativePath), { recursive: true, dereference: true });
	}
	const omittedDeclaration = process.env.ATOMIC_TEST_OMIT_WORKFLOW_DECLARATION;
	if (omittedDeclaration === undefined) return;
	assert.ok(
		OMITTABLE_WORKFLOW_DECLARATIONS.some((name) => name === omittedDeclaration),
		`unsupported declaration sabotage: ${omittedDeclaration}`,
	);
	rmSync(join(stagingDir, "dist", "builtin", "workflows", "src", "shared", omittedDeclaration));
}

test(
	"packed @bastani/atomic exposes a self-contained workflow SDK type closure",
	async () => {
		fixtureRoot = makeTempDirectory("atomic-packed-workflow-types-");
		const stagingDir = join(fixtureRoot, "package");
		const packDir = join(fixtureRoot, "pack");
		const consumerDir = join(fixtureRoot, "consumer");
		stagePackedPackage(stagingDir);
		await writeFileEnsuringDir(join(packDir, ".keep"), "");
		await writeFileEnsuringDir(
			join(consumerDir, "package.json"),
			`${JSON.stringify({ name: "atomic-workflow-typecheck-fixture", private: true, type: "module" }, null, 2)}\n`,
		);
		await writeFileEnsuringDir(join(consumerDir, "main.ts"), ROOT_IMPORT_SOURCE);
		await writeFileEnsuringDir(join(consumerDir, "authoring-probes.ts"), AUTHORING_PROBE_SOURCE);
		await writeFileEnsuringDir(
			join(consumerDir, "tsconfig.json"),
			`${JSON.stringify(
				{
					compilerOptions: {
						module: "NodeNext",
						moduleResolution: "NodeNext",
						strict: true,
						skipLibCheck: true,
						noEmit: true,
					},
					include: ["main.ts", "authoring-probes.ts"],
				},
				null,
				2,
			)}\n`,
		);

		const packOutput = run(npmCommand("pack", "--json", "--pack-destination", packDir), stagingDir);
		const packResults = JSON.parse(packOutput.stdout) as NpmPackResult[];
		assert.equal(packResults.length, 1, packOutput.stdout);
		const tarball = packResults[0]?.filename;
		assert.equal(typeof tarball, "string", packOutput.stdout);
		run(
			npmCommand(
				"install",
				"--ignore-scripts",
				"--no-package-lock",
				"--omit=optional",
				piAiPackageDir,
				nativePackageDir,
				join(packDir, tarball),
			),
			consumerDir,
		);
		run([process.execPath, tscEntry, "--project", "tsconfig.json", "--pretty", "false"], consumerDir);
	},
	PACKED_ARTIFACT_TYPECHECK_TIMEOUT_MS,
);
