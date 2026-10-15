import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import { loadAgentsFromDirWithDiagnostics } from "../../packages/subagents/src/agents/agent-loaders.js";
import { withBuiltinContext } from "../../packages/workflows/builtin/builtin-context.js";
import * as builtins from "../../packages/workflows/builtin/index.js";
import { withSteeringPropagationContext } from "../../packages/workflows/builtin/steering-context.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

for (const models of [undefined, [], ["provider/model:high", "provider/model:high"]]) {
	test(`tournament defaults route and explicit ordered assignments survive: ${JSON.stringify(models)}`, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-auto-defaults-"));
		dirs.push(cwd);
		const ctx = makeMockCtx(
			{
				prompt: "Compare solutions",
				num_attempts: 2,
				max_concurrency: 2,
				n_evaluations: 1,
				pivots: 1,
				seed: 0,
				models,
			},
			{ cwd },
		);
		const output = await builtins.tournament.run(ctx);
		for (const [name, entries] of Object.entries(ctx.calls.taskOptions)) {
			for (const options of entries) {
				assert.equal(options.model, name.startsWith("attempt-") && models?.length ? models[0] : "auto", name);
			}
		}
		assert.ok(Object.keys(ctx.calls.taskOptions).length > 0);
		const comparisons = JSON.parse(readFileSync(output.comparisons_path, "utf8"));
		assert.deepEqual(
			comparisons.model_assignment,
			models === undefined
				? undefined
				: models.length === 0
					? {}
					: { "attempt-1": models[0], "attempt-2": models[1] },
		);
	});
}

test("builtin task, chain and parallel defaults preserve caller models, efforts, constraints and raw prompts", async () => {
	const ctx = makeMockCtx({});
	const wrapped = withBuiltinContext(ctx);
	const constraints = { allowedEfforts: ["high" as const] };
	await wrapped.task("auto", { prompt: "  task  ", modelConstraints: constraints });
	await wrapped.task("explicit", { prompt: "task", model: "provider/model:low" });
	await wrapped.chain([{ name: "chain-auto", prompt: "task" }]);
	await wrapped.parallel([{ name: "parallel-auto", prompt: "task" }]);
	await wrapped.parallel(
		[
			{ name: "shared", prompt: "task" },
			{ name: "step", prompt: "task", model: "provider/step:off" },
		],
		{ model: "provider/shared:high" },
	);
	assert.equal(ctx.calls.taskOptions.auto?.[0]?.model, "auto");
	assert.equal(ctx.calls.taskOptions.auto?.[0]?.modelConstraints, constraints);
	assert.ok(ctx.calls.taskOptions.auto?.[0]?.prompt?.startsWith("  task  "));
	assert.equal(ctx.calls.taskOptions.explicit?.[0]?.model, "provider/model:low");
	assert.equal(ctx.calls.taskOptions["chain-auto"]?.[0]?.model, "auto");
	assert.equal(ctx.calls.taskOptions["parallel-auto"]?.[0]?.model, "auto");
	assert.equal(ctx.calls.taskOptions.shared?.[0]?.model, "provider/shared:high");
	assert.equal(ctx.calls.taskOptions.step?.[0]?.model, "provider/step:off");
});

test("user-authored steering contexts keep omitted model inheritance", async () => {
	const ctx = makeMockCtx({});
	await withSteeringPropagationContext(ctx).task("custom", { prompt: "User task" });
	assert.equal(ctx.calls.taskOptions.custom?.[0]?.model, undefined);
});

test("every manifest builtin uses the builtin-only context and none pins model fallback chains", () => {
	assert.equal(Object.keys(builtins).length, 9);
	for (const definition of Object.values(builtins)) {
		const source = readFileSync(resolve("packages/workflows/builtin", `${definition.name}.ts`), "utf8");
		assert.match(source, /withBuiltinContext\(ctx\)/, definition.name);
	}
	for (const file of readdirSync(resolve("packages/workflows/builtin"))) {
		if (!file.endsWith(".ts")) continue;
		const source = readFileSync(resolve("packages/workflows/builtin", file), "utf8");
		assert.doesNotMatch(source, /fallbackModels\s*:/, file);
		for (const match of source.matchAll(/\bmodel:\s*["']([^"']+)["']/g)) assert.equal(match[1], "auto", file);
	}
});

test("every shipped builtin agent routes automatically without pinned fallback chains", () => {
	const { agents, diagnostics } = loadAgentsFromDirWithDiagnostics(resolve("packages/subagents/agents"), "builtin");
	assert.deepEqual(diagnostics, []);
	assert.equal(agents.length, 9);
	for (const agent of agents) {
		assert.equal(agent.model, "auto", agent.name);
		assert.equal(agent.fallbackModels?.length ?? 0, 0, agent.name);
	}
});

test("provider guidance distinguishes main-chat defaults from automatic builtin selection", () => {
	const guide = readFileSync(resolve("packages/coding-agent/docs/providers.md"), "utf8");
	for (const obsolete of [
		"Built-in workflow and subagent fallback chains use",
		"agents use GPT-5.6 Luna",
		"Goal and Ralph orchestration, Ralph research, and the debugger use GPT-6 Astra",
		"Open Claude Design starts with Anthropic Fable",
		"Built-in workflow and subagent chains include",
	])
		assert.ok(!guide.includes(obsolete), `Obsolete builtin policy: ${obsolete}`);
	assert.match(guide, /Builtin workflows and subagents default to `model: "auto"`/);
	assert.ok(guide.includes("Atomic defaults xAI sessions to `grok-4.7`"));
	assert.ok(guide.includes("Z.AI and Z.AI Coding Plan (China) default to `glm-5.3`"));
});
