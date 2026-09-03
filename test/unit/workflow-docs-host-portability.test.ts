import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { moduleDir, readText } from "../helpers/runtime.js";

const repositoryRoot = resolve(moduleDir(import.meta.url), "../..");

/**
 * The pages a reader copies workflow code out of. Prose that names a Bun API is
 * fine anywhere; this contract governs only the fenced examples, because those
 * are what lands in a `.atomic/workflows/*.ts` file and runs in the active host.
 */
const publishedWorkflowDocs = [
	"packages/coding-agent/docs/workflows.md",
	"packages/coding-agent/docs/workflows/builtins.md",
	"packages/coding-agent/docs/workflows/authoring.md",
	"packages/coding-agent/docs/workflows/reliable-design.md",
	"packages/coding-agent/docs/workflows/operations.md",
	"packages/coding-agent/docs/workflows/api-reference.md",
	"packages/coding-agent/docs/quickstart.md",
	"packages/workflows/README.md",
	"docs/workflow-playbook.md",
] as const;

/** The escape hatch for an example that deliberately demonstrates one host. */
const hostSpecificMarker = /host-specific:[^\n]*\b(?:bun|node)\b/iu;

const codeFence = /^```(\w[\w+-]*)\n([\s\S]*?)^```/gmu;
const bunGlobal = /(?<![\w.$])Bun\.\w+/gu;
const executableLanguages = new Set(["ts", "typescript", "tsx", "js", "javascript", "jsx", "mjs"]);

/**
 * A floor rather than an exact count, so ordinary doc edits do not touch this
 * file. It exists because a broken fence pattern or a renamed page would
 * otherwise scan nothing and pass — the one failure mode a lint-shaped test
 * cannot afford.
 */
const MINIMUM_SCANNED_EXAMPLES = 100;

interface CodeExample {
	readonly doc: string;
	readonly line: number;
	readonly code: string;
}

async function readRepositoryFile(path: string): Promise<string> {
	return (await readText(resolve(repositoryRoot, path))).replaceAll("\r\n", "\n");
}

function codeExamples(doc: string, content: string): CodeExample[] {
	const examples: CodeExample[] = [];
	for (const match of content.matchAll(codeFence)) {
		const language = (match[1] ?? "").toLowerCase();
		if (!executableLanguages.has(language)) continue;
		examples.push({ doc, line: content.slice(0, match.index).split("\n").length, code: match[2] ?? "" });
	}
	return examples;
}

function unguardedBunUse(example: CodeExample): string[] {
	if (hostSpecificMarker.test(example.code)) return [];
	return [...new Set(example.code.match(bunGlobal) ?? [])];
}

function soleExample(markdown: string): CodeExample {
	const [example] = codeExamples("sample.md", markdown);
	if (!example) throw new Error("sample markdown produced no code example");
	return example;
}

async function publishedExamples(): Promise<CodeExample[]> {
	const collected: CodeExample[] = [];
	for (const doc of publishedWorkflowDocs) collected.push(...codeExamples(doc, await readRepositoryFile(doc)));
	return collected;
}

describe("published workflow examples stay host-portable", () => {
	test("no example reaches for a Bun global without naming the host", async () => {
		const violations = (await publishedExamples()).flatMap((example) => {
			const globals = unguardedBunUse(example);
			return globals.length === 0 ? [] : [`${example.doc}:${example.line} uses ${globals.join(", ")}`];
		});

		expect(
			violations,
			"npm-installed Atomic runs under Node, where these fail with `Bun is not defined`. Use the node: " +
				"builtins, or mark the example with a `host-specific:` comment naming the host it requires.",
		).toEqual([]);
	});

	test("scans the examples it claims to scan", async () => {
		const examples = await publishedExamples();

		expect(examples.length).toBeGreaterThan(MINIMUM_SCANNED_EXAMPLES);
		expect(examples.some((example) => example.code.includes("node:child_process"))).toBe(true);
	});

	test("still fails on an unmarked Bun global, and the marker is the only way out", () => {
		const unmarked = '```ts\nconst probe = Bun.spawnSync(["git", "status"]);\n```\n';
		const marked = '```ts\n// host-specific: bun\nconst probe = Bun.spawnSync(["git", "status"]);\n```\n';
		const prose = "Under the hood the binary calls `Bun.spawnSync`, which is why it needs Bun.\n";

		expect(unguardedBunUse(soleExample(unmarked))).toEqual(["Bun.spawnSync"]);
		expect(unguardedBunUse(soleExample(marked))).toEqual([]);
		expect(codeExamples("sample.md", prose)).toEqual([]);
	});

	test("states the both-hosts rule where workflows are authored", async () => {
		const workflows = await readRepositoryFile("packages/coding-agent/docs/workflows/authoring.md");
		const quickstart = await readRepositoryFile("packages/coding-agent/docs/quickstart.md");

		for (const phrase of [
			"executes inside whichever host is running Atomic",
			"Bun is not defined",
			"node:child_process",
		]) {
			expect(workflows, "workflows/authoring.md").toContain(phrase);
		}

		for (const phrase of ["a package-manager install runs under Node", "Bun is not defined"]) {
			expect(quickstart, "quickstart.md").toContain(phrase);
		}
	});
});
