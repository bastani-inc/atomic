import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "vitest";
import { getDocsPath } from "../../packages/coding-agent/src/config.js";
import { buildSystemPrompt } from "../../packages/coding-agent/src/core/system-prompt.js";
import { moduleDir } from "../helpers/runtime.js";
import { stripSystemPromptEnvironmentPaths } from "../helpers/system-prompt-paths.js";

const ROOT = join(moduleDir(import.meta.url), "..", "..");

/** Text that only the removed model benchmark docs, their generator and automatic routing used. */
const REMOVED_REFERENCES = [
	"evals.md",
	"model-selection.md",
	"models/evals",
	"models/model-selection",
	"artificialanalysis.ai",
	"extract-aa-benchmarks",
] as const;

/** Shipped sources, prompts, docs, builtin agents and workflows, and repository scripts; released changelogs excluded. */
const SCANNED = [
	"packages/coding-agent/src",
	"packages/coding-agent/docs",
	"packages/coding-agent/examples",
	"packages/coding-agent/README.md",
	"packages/coding-agent/package.json",
	"packages/subagents",
	"packages/mcp",
	"packages/web-access",
	"packages/intercom",
	"scripts",
] as const;

function* files(path: string): Generator<string> {
	if (!existsSync(path)) return;
	if (statSync(path).isFile()) {
		yield path;
		return;
	}
	for (const entry of readdirSync(path)) {
		if (entry === "node_modules" || entry === "CHANGELOG.md") continue;
		yield* files(join(path, entry));
	}
}

test("the model benchmark docs are gone", () => {
	assert.equal(existsSync(join(getDocsPath(), "models", "evals.md")), false);
	assert.equal(existsSync(join(getDocsPath(), "models", "model-selection.md")), false);
	assert.equal(existsSync(join(getDocsPath(), "models", "reference.md")), true, "the model reference stays");
	assert.equal(existsSync(join(ROOT, "scripts", "extract-aa-benchmarks.ts")), false);
});

interface DocsRedirect {
	readonly source: string;
	readonly destination: string;
}

function docsRedirects(): DocsRedirect[] {
	const docs = JSON.parse(readFileSync(join(ROOT, "packages/coding-agent/docs/docs.json"), "utf8")) as {
		readonly redirects?: DocsRedirect[];
	};
	return docs.redirects ?? [];
}

/** The site's redirects from a removed page to a surviving one are the only place a removed path may still appear. */
function withoutRemovedPageRedirects(file: string, text: string): string {
	if (!file.endsWith(join("docs", "docs.json"))) return text;
	const docs = JSON.parse(text) as { redirects?: DocsRedirect[] };
	docs.redirects = (docs.redirects ?? []).filter(
		(redirect) => !REMOVED_REFERENCES.some((reference) => redirect.source.endsWith(reference)),
	);
	return JSON.stringify(docs);
}

test("links to the removed model benchmark pages redirect to the models page", () => {
	const redirects = new Map(docsRedirects().map((redirect) => [redirect.source, redirect.destination]));
	for (const source of [
		"/models/evals",
		"/models/model-selection",
		"/models/artificial-analysis-index",
		"/models/pareto-efficiency",
	])
		assert.equal(redirects.get(source), "/models", source);
});

test("nothing reads or links to the removed model benchmark docs", () => {
	const hits: string[] = [];
	for (const scanned of SCANNED) {
		for (const file of files(join(ROOT, scanned))) {
			if (!/\.(ts|tsx|js|mjs|cjs|md|mdx|json|yaml|yml|sh)$/.test(file)) continue;
			const text = withoutRemovedPageRedirects(file, readFileSync(file, "utf8"));
			for (const reference of REMOVED_REFERENCES) {
				if (text.includes(reference)) hits.push(`${relative(ROOT, file)}: ${reference}`);
			}
		}
	}
	assert.deepEqual(hits, []);
});

test("the system prompt sends no one to benchmark docs or sites", () => {
	const check = (cwd: string, agentDir?: string) => {
		const prompt = stripSystemPromptEnvironmentPaths(buildSystemPrompt({ cwd, selectedTools: ["read", "bash"] }), {
			cwd,
			agentDir,
		});
		for (const reference of REMOVED_REFERENCES) assert.equal(prompt.includes(reference), false, reference);
		assert.doesNotMatch(prompt, /benchmark/i);
		assert.doesNotMatch(prompt, /model choice/);
	};
	check(ROOT);

	const seededRoot = mkdtempSync(join(tmpdir(), "atomic-benchmark-evals.md-"));
	const seededAgentDir = join(seededRoot, "agent");
	mkdirSync(seededAgentDir, { recursive: true });
	const previous = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = seededAgentDir;
	try {
		check(seededRoot, seededAgentDir);
	} finally {
		if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previous;
		rmSync(seededRoot, { recursive: true, force: true });
	}
});
