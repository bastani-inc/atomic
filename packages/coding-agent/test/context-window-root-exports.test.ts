import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

function bunExecutable(): string {
	const npmExecPath = process.env.npm_execpath;
	if (npmExecPath?.endsWith("bun") || npmExecPath?.endsWith("bun.exe")) {
		return npmExecPath;
	}
	return "bun";
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");

function writeConsumerFixture(tempDir: string): string {
	const consumerPath = join(tempDir, "consumer.mts");
	writeFileSync(
		consumerPath,
		`import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
	formatContextWindow,
	getModelDefaultContextWindow,
	getSupportedContextWindows,
	normalizeContextWindowOptions,
	parseContextWindowValue,
	selectContextWindow,
	validateContextWindowValue,
	withContextWindowOptions,
	type ContextWindowParseResult,
	type ContextWindowSelection,
	type ContextWindowSelectionError,
} from "@bastani/atomic";

const model: Model<Api> = {
	id: "root-context-window-consumer",
	name: "Root context-window consumer",
	api: "openai-responses",
	provider: "custom",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	defaultContextWindow: 400_000,
	contextWindowOptions: [1_000_000] as const,
	maxTokens: 4096,
};

const parseResult: ContextWindowParseResult = parseContextWindowValue("1m");
if (parseResult.value === undefined) {
	throw new Error(parseResult.error ?? "parse failed");
}

const options: readonly number[] | undefined = model.contextWindowOptions;
const defaultWindow: number | undefined = model.defaultContextWindow;
const validation: string | undefined = validateContextWindowValue(parseResult.value);
const normalized: number[] = normalizeContextWindowOptions([400_000, 1_000_000, 1_000_000]);
const withOptions: Model<Api> = withContextWindowOptions(model, normalized);
const supported: number[] = getSupportedContextWindows(withOptions);
const selected = selectContextWindow(withOptions, parseResult.value);

if ("error" in selected) {
	const selectionError: ContextWindowSelectionError = selected;
	throw new Error(selectionError.error);
}

const selection: ContextWindowSelection = selected;
const formatted: string = formatContextWindow(selection.contextWindow);
const modelDefault: number = getModelDefaultContextWindow(selection.model);

void [options, defaultWindow, validation, supported, formatted, modelDefault];
`,
	);
	return consumerPath;
}

function writeTsconfig(tempDir: string, consumerPath: string): string {
	const tsconfigPath = join(tempDir, "tsconfig.json");
	writeFileSync(
		tsconfigPath,
		JSON.stringify(
			{
				extends: resolve(REPO_ROOT, "tsconfig.base.json"),
				compilerOptions: {
					baseUrl: tempDir,
					ignoreDeprecations: "6.0",
					noEmit: true,
					typeRoots: [resolve(REPO_ROOT, "node_modules/@types")],
					paths: {
						"@bastani/atomic": ["dist/index.d.ts"],
						"@earendil-works/pi-agent-core": [
							resolve(REPO_ROOT, "node_modules/@earendil-works/pi-agent-core/dist/index.d.ts"),
						],
						"@earendil-works/pi-agent-core/*": [
							resolve(REPO_ROOT, "node_modules/@earendil-works/pi-agent-core/dist/*.d.ts"),
						],
						"@earendil-works/pi-ai": [resolve(REPO_ROOT, "node_modules/@earendil-works/pi-ai/dist/index.d.ts")],
						"@earendil-works/pi-ai/*": [
							resolve(REPO_ROOT, "node_modules/@earendil-works/pi-ai/dist/*.d.ts"),
							resolve(REPO_ROOT, "node_modules/@earendil-works/pi-ai/dist/providers/*.d.ts"),
						],
						"@earendil-works/pi-tui": [resolve(REPO_ROOT, "node_modules/@earendil-works/pi-tui/dist/index.d.ts")],
						"@earendil-works/pi-tui/*": [
							resolve(REPO_ROOT, "node_modules/@earendil-works/pi-tui/dist/*.d.ts"),
							resolve(REPO_ROOT, "node_modules/@earendil-works/pi-tui/dist/components/*.d.ts"),
						],
					},
				},
				files: [consumerPath],
			},
			null,
			2,
		),
	);
	return tsconfigPath;
}

function runTsc(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync(bunExecutable(), ["x", "--bun", "--no-install", "tsc", ...args, "--pretty", "false"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			NO_COLOR: "1",
		},
		encoding: "utf8",
		input: "",
	});
}

function expectTscSuccess(result: ReturnType<typeof spawnSync>): void {
	expect(result.error).toBeUndefined();
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function emitPackageDeclarations(tempDir: string): void {
	const result = runTsc([
		"-p",
		resolve(PACKAGE_ROOT, "tsconfig.build.json"),
		"--emitDeclarationOnly",
		"--outDir",
		join(tempDir, "dist"),
		"--declarationMap",
		"false",
	]);
	expectTscSuccess(result);
}

describe("context-window package root exports", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		tempDir = undefined;
	});

	test("typechecks a consumer importing helpers and Model<Api> augmentation from emitted package-root declarations", () => {
		tempDir = join(tmpdir(), `atomic-context-window-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		emitPackageDeclarations(tempDir);
		const consumerPath = writeConsumerFixture(tempDir);
		const tsconfigPath = writeTsconfig(tempDir, consumerPath);

		expectTscSuccess(runTsc(["-p", tsconfigPath]));
	}, 30_000);
});
