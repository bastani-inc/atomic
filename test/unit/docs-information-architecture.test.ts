import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "vitest";
import { BUILTIN_PACKAGE_DIR_NAMES } from "../../packages/coding-agent/src/core/builtin-install-layout.js";
import { moduleDir } from "../helpers/runtime.js";

/**
 * Information-architecture contract for bastani-inc/atomic#2847.
 *
 * The pinned Mintlify commands cover what they cover and no more:
 * `validate` rejects a navigation entry with no file, `broken-links` resolves
 * page and image targets but not anchors (that needs `--check-anchors`, which
 * CI does not pass), and neither one notices a page that exists on disk but
 * fell out of navigation. This suite checks current navigation, routes, reader
 * anchors, and shipped documentation references without historical artifacts.
 */

const repoRoot = resolve(moduleDir(import.meta.url), "../..");
const docsDir = join(repoRoot, "packages/coding-agent/docs");
const docsJson = JSON.parse(readFileSync(join(docsDir, "docs.json"), "utf8")) as DocsConfig;

// Regression for #2799: exhaustive reader-facing lists must include every shipped builtin.
test("usage and authoring enumerate the shipped builtin bundles", () => {
	const expected = [...BUILTIN_PACKAGE_DIR_NAMES].sort();
	const bundleNames = (enumeration: string): string[] =>
		enumeration
			.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
			.toLowerCase()
			.split(/,\s*(?:and\s+)?|\s+and\s+/u)
			.map((name) => name.trim().replaceAll(" ", "-"))
			.sort();
	const authoring = readFileSync(join(docsDir, "extensions/authoring.md"), "utf8");
	const counts = [...authoring.matchAll(/\b(\w+) fixed installed builtin (?:extension )?bundles\b/gu)];
	assert.equal(counts.length, 2, "authoring retains both builtin bundle count statements");
	assert.equal(expected.length, 6, "update the documented count when the shipped builtin set changes");
	for (const count of counts) assert.equal(count[1], "six", "authoring describes six bundles in both occurrences");
	const authoringList = /fixed installed builtin extension bundles \(([^)\n]+)\)/u.exec(authoring)?.[1];
	assert.ok(authoringList, "authoring names its builtin bundles in the startup-path statement");
	assert.deepEqual(bundleNames(authoringList), expected, "authoring enumerates every shipped builtin exactly once");

	const usage = readFileSync(join(docsDir, "usage.md"), "utf8");
	const usageList = /distribution bundles first-party package extensions for ([^.\n]+)\./u.exec(usage)?.[1];
	assert.ok(usageList, "usage retains its bounded builtin enumeration");
	assert.deepEqual(bundleNames(usageList), expected, "usage enumerates every shipped builtin exactly once");
});

interface NavContainer {
	tabs?: NavTab[];
	anchors?: NavAnchor[];
	groups?: NavGroup[];
	pages?: (string | NavGroup)[];
}
interface NavTab extends NavContainer {
	tab: string;
}
interface NavAnchor extends NavContainer {
	anchor: string;
	href?: string;
}
interface NavGroup extends NavContainer {
	group: string;
}
interface DocsConfig {
	navigation?: NavContainer;
	redirects?: { source: string; destination: string; permanent?: boolean }[];
}
type NavValue = string | NavContainer | NavValue[];
const navChildren = ["tabs", "anchors", "groups", "pages"] as const;

function collectNavPages(value: NavValue | undefined, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) {
		for (const item of value) collectNavPages(item, out);
	} else if (value) {
		for (const key of navChildren) collectNavPages(value[key], out);
	}
	return out;
}

function onDiskSlugs(): string[] {
	return readdirSync(docsDir, { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".md") || name.endsWith(".mdx"))
		.map((name) => name.replaceAll("\\", "/").replace(/\.mdx?$/u, ""))
		.sort();
}

const navPages = collectNavPages(docsJson.navigation);
const diskSlugs = onDiskSlugs();
const pathForSlug = (slug: string): string => (existsSync(join(docsDir, `${slug}.md`)) ? `${slug}.md` : `${slug}.mdx`);
const routeToSlug = new Map(diskSlugs.map((slug) => [`/${slug}`, slug]));

/**
 * Mintlify 4.2.731's heading slugger, established by running the pinned CLI's
 * `broken-links --check-anchors` against probe pages rather than by reading its
 * prose docs, which are wrong about apostrophes and silent about collapsing:
 *
 *   1. strip markdown formatting to plain text, then lowercase
 *   2. `.` becomes `-`
 *   3. apostrophes are deleted outright
 *   4. other punctuation becomes a separator (so `foo(bar)` is `foo-bar`, not `foobar`)
 *   5. `/ & _ + - — –` survive
 *   6. whitespace becomes `-`, runs of `-` collapse to one, and edges are trimmed
 *   7. repeated headings are numbered page-wide: `x`, `x-2`, `x-3`
 *
 * It is NOT github-slugger, which is why several anchors recorded in the
 * released CHANGELOG have never resolved.
 */
function mintlifyAnchor(heading: string): string {
	return heading
		.replace(/`([^`]*)`/gu, "$1")
		.replace(/\*\*([^*]*)\*\*/gu, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
		.toLowerCase()
		.replaceAll(".", "-")
		.replaceAll("'", "")
		.replaceAll("\u2019", "")
		.replace(/["(),:?!]/gu, "-")
		.replace(/[^\w\s/&+\u2013\u2014-]/gu, "-")
		.trim()
		.replace(/\s+/gu, "-")
		.replace(/-{2,}/gu, "-")
		.replace(/^-+|-+$/gu, "");
}

interface Heading {
	line: number;
	level: number;
	text: string;
	anchor: string;
}

/** Every heading a document declares outside fenced code, with its exact anchor. */
function headingsIn(text: string): Heading[] {
	const out: Heading[] = [];
	const seen = new Map<string, number>();
	let fence: string | undefined;
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const marker = /^\s*(```|~~~)/u.exec(line);
		if (marker) {
			fence = fence ? undefined : marker[1];
			continue;
		}
		if (fence) continue;
		const heading = /^(#{1,6})\s+(.*?)\s*$/u.exec(line);
		if (!heading) continue;
		const text_ = heading[2] ?? "";
		const base = mintlifyAnchor(text_);
		const count = (seen.get(base) ?? 0) + 1;
		seen.set(base, count);
		out.push({
			line: index,
			level: (heading[1] ?? "").length,
			text: text_,
			anchor: count === 1 ? base : `${base}-${count}`,
		});
	}
	return out;
}

/**
 * The 44 routes that existed before the migration. #2847 requires every one of
 * them to keep working, so this list is frozen: a deletion has to fail loudly
 * rather than quietly 404 for readers and for agents reading published docs.
 */
const preMigrationRoutes = [
	"/changelog",
	"/compaction",
	"/containerization",
	"/custom-provider",
	"/development",
	"/environment-variables",
	"/extensions",
	"/index",
	"/intercom",
	"/json",
	"/keybindings",
	"/llama-cpp",
	"/models",
	"/models/artificial-analysis-index",
	"/models/model-selection",
	"/models/pareto-efficiency",
	"/packages",
	"/prompt-templates",
	"/providers",
	"/quickstart",
	"/rpc",
	"/sdk",
	"/security",
	"/session-format",
	"/sessions",
	"/settings",
	"/shell-aliases",
	"/skills",
	"/subagents",
	"/terminal-setup",
	"/termux",
	"/themes",
	"/tmux",
	"/tools",
	"/tools/edit",
	"/tui",
	"/usage",
	"/windows",
	"/workflows",
	"/workflows/api-reference",
	"/workflows/authoring",
	"/workflows/builtins",
	"/workflows/operations",
	"/workflows/reliable-design",
] as const;

/** Every route the issue's proposed structure names, transcribed from #2847. */
const proposedRoutes = [
	"/",
	"/build",
	"/changelog",
	"/compaction",
	"/compaction/reference",
	"/containerization",
	"/custom-provider",
	"/development",
	"/environment-variables",
	"/extensions",
	"/extensions/api-reference",
	"/getting-started/authentication",
	"/getting-started/first-session",
	"/getting-started/installation",
	"/getting-started/project-instructions",
	"/guides",
	"/intercom",
	"/json",
	"/keybindings",
	"/llama-cpp",
	"/models",
	"/models/reference",
	"/packages",
	"/programmatic",
	"/prompt-templates",
	"/providers",
	"/providers/reference",
	"/quickstart",
	"/reference",
	"/reference/cli",
	"/rpc",
	"/rpc/protocol",
	"/sdk",
	"/sdk/reference",
	"/security",
	"/session-format",
	"/sessions",
	"/settings",
	"/shell-aliases",
	"/skills",
	"/subagents",
	"/terminal-setup",
	"/termux",
	"/themes",
	"/tmux",
	"/tools",
	"/tools/edit",
	"/tui",
	"/tui/reference",
	"/usage",
	"/windows",
	"/workflows",
	"/workflows/api-reference",
	"/workflows/authoring",
	"/workflows/builtins",
	"/workflows/operations",
	"/workflows/reliable-design",
] as const;

/**
 * The reader-facing label #2847 gives each route in its proposed tree,
 * transcribed from the issue. Mintlify has no per-page label field in
 * `docs.json` — its navigation reference requires each `pages` entry to be a
 * page path — so a label is supplied by frontmatter `sidebarTitle` or `title`,
 * and otherwise falls back to a title-cased last path segment.
 */
const issueNavigationLabels: Record<string, string> = {
	"/": "Overview",
	"/quickstart": "Quickstart",
	"/getting-started/installation": "Installation",
	"/getting-started/authentication": "Authentication",
	"/getting-started/first-session": "First session",
	"/getting-started/project-instructions": "Project instructions",
	"/guides": "Guides",
	"/usage": "Interactive use",
	"/sessions": "Sessions",
	"/compaction": "Context and compaction",
	"/providers": "Providers",
	"/llama-cpp": "Local models",
	"/security": "Security",
	"/containerization": "Containerization",
	"/build": "Build with Atomic",
	"/skills": "Skills",
	"/subagents": "Subagents",
	"/intercom": "Intercom",
	"/workflows": "Workflows",
	"/workflows/builtins": "Builtins",
	"/workflows/authoring": "Authoring",
	"/workflows/reliable-design": "Reliable design",
	"/workflows/operations": "Operations",
	"/workflows/api-reference": "API reference",
	"/extensions": "Extensions",
	"/prompt-templates": "Prompt templates",
	"/themes": "Themes",
	"/packages": "Atomic packages",
	"/models": "Custom models",
	"/custom-provider": "Custom providers",
	"/programmatic": "Programmatic use",
	"/sdk": "SDK",
	"/rpc": "RPC",
	"/json": "JSON event stream",
	"/tui": "TUI components",
	"/reference": "Reference index",
	"/reference/cli": "CLI reference",
	"/settings": "Settings",
	"/environment-variables": "Environment variables",
	"/keybindings": "Keybindings",
	"/tools": "Built-in tools",
	"/tools/edit": "edit",
	"/session-format": "Session format",
	"/providers/reference": "Provider reference",
	"/models/reference": "Model configuration",
	"/compaction/reference": "Compaction internals",
	"/extensions/api-reference": "Extension API",
	"/sdk/reference": "SDK API",
	"/rpc/protocol": "RPC protocol",
	"/tui/reference": "TUI API",
	"/windows": "Windows",
	"/termux": "Termux",
	"/terminal-setup": "Terminal setup",
	"/tmux": "tmux",
	"/shell-aliases": "Shell aliases",
	"/development": "Development",
	"/changelog": "Changelog",
};

/** Route order within each reader tab, transcribed from #2847's proposed tree. */
const issueNavigationOrder: Record<string, readonly string[]> = {
	Learn: [
		"/",
		"/quickstart",
		"/getting-started/installation",
		"/getting-started/authentication",
		"/getting-started/first-session",
		"/getting-started/project-instructions",
		"/guides",
		"/usage",
		"/sessions",
		"/compaction",
		"/providers",
		"/llama-cpp",
		"/security",
		"/containerization",
	],
	Build: [
		"/build",
		"/skills",
		"/prompt-templates",
		"/themes",
		"/extensions",
		"/workflows",
		"/workflows/builtins",
		"/workflows/authoring",
		"/workflows/reliable-design",
		"/workflows/operations",
		"/workflows/api-reference",
		"/subagents",
		"/intercom",
		"/packages",
		"/models",
		"/custom-provider",
		"/programmatic",
		"/sdk",
		"/rpc",
		"/json",
		"/tui",
	],
	Reference: [
		"/reference",
		"/reference/cli",
		"/settings",
		"/environment-variables",
		"/keybindings",
		"/tools",
		"/tools/edit",
		"/session-format",
		"/providers/reference",
		"/models/reference",
		"/compaction/reference",
		"/extensions/api-reference",
		"/sdk/reference",
		"/rpc/protocol",
		"/tui/reference",
		"/windows",
		"/termux",
		"/terminal-setup",
		"/tmux",
		"/shell-aliases",
		"/development",
		"/changelog",
	],
};

/**
 * Migration and captured-upstream pages not named in the issue's route tree.
 * Each stays immediately after the route whose topic it extends. The reference
 * cluster follows compaction internals because its parents live in Build, and
 * Herdr follows tmux because it is platform setup rather than a reader guide.
 */
const generatedNavigationInsertions: Record<string, readonly string[]> = {
	"/usage": ["/guides/non-interactive"],
	"/compaction": [
		"/guides/configuration",
		"/guides/workflows",
		"/guides/subagents",
		"/background-tasks",
		"/guides/intercom",
		"/computer-use",
	],
	"/skills": ["/skills/authoring"],
	"/subagents": ["/subagents/authoring"],
	"/intercom": ["/intercom/operations"],
	"/extensions": ["/extensions/authoring", "/extensions/events", "/extensions/ui", "/extensions/examples"],
	"/packages": ["/packages/authoring"],
	"/models": ["/models/model-selection", "/models/pareto-efficiency", "/models/evals"],
	"/workflows/reliable-design": ["/workflows/verification"],
	"/tmux": ["/herdr"],
	// Keep web-access beside tools/edit in the Reference group.
	"/tools/edit": ["/web-access"],
	"/changelog": ["/models/artificial-analysis-index"],
	"/custom-provider": [
		"/custom-provider/override",
		"/custom-provider/registration",
		"/custom-provider/oauth",
		"/custom-provider/streaming",
	],
	"/rpc": ["/rpc/extension-ui", "/rpc/examples"],
	"/compaction/reference": [
		"/skills/reference",
		"/subagents/reference",
		"/intercom/reference",
		"/packages/reference",
		"/themes/reference",
	],
	"/extensions/api-reference": ["/custom-provider/api-reference"],
};

/** A page's YAML frontmatter, limited to the scalar fields this suite reads. */
function frontmatterOf(slug: string): { title?: string; sidebarTitle?: string; description?: string } {
	const text = readFileSync(join(docsDir, pathForSlug(slug)), "utf8");
	if (!text.startsWith("---\n")) return {};
	const end = text.indexOf("\n---\n", 3);
	if (end === -1) return {};
	const fields: Record<string, string> = {};
	for (const line of text.slice(4, end).split("\n")) {
		const match = /^(\w+):\s*"?(.*?)"?\s*$/u.exec(line);
		if (match?.[1]) fields[match[1]] = match[2] ?? "";
	}
	return fields;
}

/**
/** Only immutable released-changelog citations may retain broken anchors. */
/** github-slugger shapes the released CHANGELOG recorded that Mintlify never generated. */
const historicalChangelogAnchors = new Set([
	"/extensions#ctxsignal",
	"/extensions#message_start--message_update--message_end",
	"/extensions#pigetcommands",
	"/extensions#tool-call-events",
	"/settings#terminal--images",
	"/tui#working-indicator",
]);

// Workflow content/references now follow the reconciled upstream contracts.
// None of its formerly broken live citations remains exempt.
const brokenBeforeMigration = new Set(historicalChangelogAnchors);

/** Shipped prompts and prompt guidance that name repository docs paths. */
const promptSources = [
	"packages/coding-agent/src/core/system-prompt.ts",
	"packages/subagents/src/extension/prompt-guidance.ts",
	"packages/workflows/src/extension/workflow-prompts.ts",
] as const;

/** Reader-visible anchors, including explicit HTML IDs outside fenced examples. */
function readerAnchors(text: string): Set<string> {
	const anchors = new Set<string>();
	const seen = new Map<string, number>();
	let fence: { character: string; length: number } | undefined;
	for (const line of text.split("\n")) {
		const marker = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
		if (marker) {
			const delimiter = marker[1] ?? "";
			if (!fence) fence = { character: delimiter[0] ?? "", length: delimiter.length };
			else if (delimiter[0] === fence.character && delimiter.length >= fence.length && !marker[2]?.trim())
				fence = undefined;
			continue;
		}
		if (fence) continue;
		const heading = /^#{1,4}\s+(.*?)\s*$/u.exec(line);
		if (heading) {
			const base = mintlifyAnchor(heading[1] ?? "");
			const count = (seen.get(base) ?? 0) + 1;
			seen.set(base, count);
			anchors.add(count === 1 ? base : `${base}-${count}`);
		}
		// Parse quoted attributes as tokens: data-id and an id inside a title are not IDs.
		const tag = /^ {0,3}<[a-z][\w-]*\b(?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*\s*\/?>/u.exec(line);
		if (tag) {
			for (const attribute of tag[0].matchAll(/\s+([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
				const id = attribute[2] ?? attribute[3];
				if (attribute[1] === "id" && id) anchors.add(id);
			}
		}
	}
	return anchors;
}

function anchorResolves(route: string, anchor: string): boolean {
	const slug = routeToSlug.get(route);
	if (slug === undefined) return false;
	return readerAnchors(readFileSync(join(docsDir, pathForSlug(slug)), "utf8")).has(anchor);
}

describe("docs information architecture (#2847)", () => {
	// #2847: sample markup, forged attributes, and guessed suffixes are not reader targets.
	test("reader anchors require exact explicit HTML IDs outside fenced examples", () => {
		const text = [
			'<a id="precise" />',
			"<div id='other'></div>",
			'<a data-id="forged-data" />',
			`<a title='id="forged-title"' />`,
			'`<a id="inline-code" />`',
			'<!-- <a id="commented" /> -->',
			"````md",
			"```html",
			'<a id="fenced" />',
			"```",
			'<a id="still-fenced" />',
			"````",
			"~~~html",
			'<a id="tilde-fenced" />',
			"~~~",
			"##### precise",
			"###### other",
		].join("\n");
		assert.deepEqual([...readerAnchors(text)], ["precise", "other"]);
		assert.equal(readerAnchors(text).has("precise-999"), false);
		assert.equal(readerAnchors(text.replace('<a id="precise" />', "")).has("precise"), false);
		assert.equal(readerAnchors(text.replace('id="precise"', 'id="forged"')).has("precise"), false);
	});

	// #2847 / PR #2971: pinned Mintlify generates IDs for h1–h4, never implicit h5/h6.
	test("reader anchors exclude implicit h5/h6 IDs without changing source heading identity", () => {
		const text = "# Guide\n##### Hidden\n###### Deeper\n## Hidden\n### Middle\n#### Last\n## Hidden\n";
		assert.deepEqual([...readerAnchors(text)], ["guide", "hidden", "middle", "last", "hidden-2"]);
		assert.equal(readerAnchors("##### Hidden\n###### Deeper\n").size, 0);
		assert.deepEqual(
			headingsIn(text).map((heading) => heading.anchor),
			["guide", "hidden", "deeper", "hidden-2", "middle", "last", "hidden-3"],
		);
	});

	// #2847: exercise the actual repaired reader page, not only a parser fixture.
	test("all four deep workflow links depend on their precise standalone reader anchors", () => {
		const slug = "workflows/reliable-design";
		const text = readFileSync(join(docsDir, pathForSlug(slug)), "utf8");
		for (const [id, title] of [
			["3-adversarial-verification", "3. Adversarial verification"],
			["5-tournament", "5. Tournament"],
			["6-loop-until-done", "6. Loop until done"],
			["stacked-implementation-slices-starter-pattern", "Stacked implementation slices starter pattern"],
		] as const) {
			const anchor = `<a id="${id}" />`;
			assert.equal(text.split(`${anchor}\n\n##### ${title}\n`).length, 2);
			assert.ok(text.includes(`](#${id})`), `${id} retains its precise link`);
			assert.ok(anchorResolves(`/${slug}`, id));
			assert.equal(readerAnchors(text.replace(anchor, "")).has(id), false);
			assert.equal(readerAnchors(text.replace(anchor, '<a id="forged" />')).has(id), false);
		}
	});

	// #2847 / PR #2971: a Reference-tab entry cannot replace the guide's own handoff.
	for (const [slug, targets] of [
		["skills/authoring", ["/skills/reference#frontmatter", "/skills/reference#validation"]],
		["extensions/authoring", ["/extensions/events", "/extensions/api-reference"]],
		["extensions/events", ["/extensions/ui", "/extensions/api-reference#extensioncontext"]],
		["extensions/ui", ["/extensions/examples", "/extensions/api-reference"]],
		["extensions/examples", ["/extensions/api-reference"]],
	] as const) {
		test(`${slug} ends with direct next-step and reference links`, () => {
			const text = readFileSync(join(docsDir, pathForSlug(slug)), "utf8");
			assert.ok(readerAnchors(text).has("next-steps"), `${slug} needs a reader-visible next step`);
			const nextSteps = text.split("\n## Next steps\n")[1];
			assert.ok(nextSteps, `${slug} must link from its article, not only the navigation shell`);
			for (const target of targets) {
				assert.ok(nextSteps.includes(`](${target})`), `${slug} must link directly to ${target}`);
				const [route, anchor] = target.split("#");
				assert.ok(route && routeToSlug.has(route), `${target} needs a real destination`);
				if (anchor) assert.ok(anchorResolves(route, anchor), `${target} needs a real reference heading`);
			}
		});
	}

	test("every navigation entry resolves to a page on disk", () => {
		assert.ok(navPages.length > 40, "docs.json navigation was discovered, not hardcoded");
		const slugs = new Set(diskSlugs);
		for (const page of navPages) {
			assert.ok(slugs.has(page), `docs.json lists "${page}", which has no .md or .mdx file on disk`);
		}
	});

	test("every page on disk appears in navigation exactly once", () => {
		// A page that is routable but absent from navigation silently drops out of
		// the sidebar, search, the sitemap, and llms.txt, and neither Mintlify
		// command reports it.
		const counts = new Map<string, number>();
		for (const page of navPages) counts.set(page, (counts.get(page) ?? 0) + 1);
		for (const slug of diskSlugs) {
			assert.equal(counts.get(slug) ?? 0, 1, `${slug} must appear in docs.json navigation exactly once`);
		}
	});

	test("navigation uses the three reader-centered tabs", () => {
		const navigation = docsJson.navigation;
		assert.ok(Array.isArray(navigation?.tabs), "navigation must use the tabs shape");
		assert.deepEqual(
			navigation?.tabs?.map((tab) => tab.tab),
			["Learn", "Build", "Reference"],
		);
	});

	test("each reader tab keeps the route order specified by the issue", () => {
		const navigation = docsJson.navigation;
		assert.ok(Array.isArray(navigation?.tabs), "navigation must use the tabs shape");
		for (const tab of navigation?.tabs ?? []) {
			const name = tab.tab ?? "";
			const expected = issueNavigationOrder[name];
			assert.ok(expected, `${name} has no issue-order contract`);
			const expectedSet = new Set(expected);
			const projection = collectNavPages(tab)
				.map((slug) => (slug === "index" ? "/" : `/${slug}`))
				.filter((route) => expectedSet.has(route));
			assert.deepEqual(projection, expected, `${name} routes must follow #2847's proposed order`);
		}
		assert.equal(Object.values(issueNavigationOrder).flat().length, 57, "all 57 issue routes have an order");
	});

	test("every generated page keeps its recorded insertion point", () => {
		const navigation = docsJson.navigation;
		assert.ok(Array.isArray(navigation?.tabs), "navigation must use the tabs shape");
		const tabRoutes = (navigation?.tabs ?? []).map((tab) =>
			collectNavPages(tab).map((slug) => (slug === "index" ? "/" : `/${slug}`)),
		);
		const enumerated = new Set(Object.values(issueNavigationOrder).flat());
		const generated = tabRoutes
			.flat()
			.filter((route) => !enumerated.has(route))
			.sort();
		const expectedGenerated = Object.values(generatedNavigationInsertions).flat().sort();
		assert.equal(
			expectedGenerated.length,
			34,
			"24 migration routes, all six upstream additions, and the four reader-path orientation pages have insertion points",
		);
		assert.deepEqual(generated, expectedGenerated, "no generated page may fall outside the insertion contract");

		for (const [anchor, inserted] of Object.entries(generatedNavigationInsertions)) {
			const routes = tabRoutes.find((tab) => tab.includes(anchor));
			assert.ok(routes, `${anchor} is not present in a reader tab`);
			const at = routes.indexOf(anchor);
			assert.deepEqual(
				routes.slice(at + 1, at + 1 + inserted.length),
				inserted,
				`${inserted.join(", ")} must stay immediately after ${anchor}`,
			);
		}
	});

	test("every pre-migration route still resolves", () => {
		const routes = new Set(diskSlugs.map((slug) => `/${slug}`));
		for (const route of preMigrationRoutes) {
			assert.ok(routes.has(route), `${route} existed before #2847 and must keep working`);
		}
	});

	test("every route the issue proposes exists", () => {
		const routes = new Set(diskSlugs.map((slug) => `/${slug}`));
		routes.add("/"); // the canonical route, served by index.md
		for (const route of proposedRoutes) {
			assert.ok(routes.has(route), `#2847 proposes ${route}, which has no page`);
		}
	});

	test("every navigation entry is a bare page path", () => {
		// Mintlify's navigation reference requires each `pages` entry to reference a
		// page file. An object entry carrying a label is silently accepted by
		// `validate` but is not a documented shape, so reject it here.
		const walk = (value: NavValue | undefined, path: string): void => {
			if (typeof value === "string") return;
			if (Array.isArray(value)) {
				for (const [index, item] of value.entries()) walk(item, `${path}[${index}]`);
				return;
			}
			assert.ok(value && typeof value === "object", `${path} must be a page path or a group`);
			const record = value;
			assert.ok(
				"group" in record || "tab" in record || "anchor" in record || "tabs" in record || "groups" in record,
				`${path} is an object without a group or tab; a page entry must be a bare path string`,
			);
			for (const key of navChildren) {
				if (record[key] !== undefined) walk(record[key], `${path}.${key}`);
			}
		};
		walk(docsJson.navigation, "navigation");
	});

	test("every route the issue enumerates renders its specified label", () => {
		// Mintlify resolves a page's navigation label as sidebarTitle, then title,
		// then a path-derived fallback that title-cases the last segment. That
		// fallback is what rendered `Sdk`, `Rpc`, `Json`, and `Llama cpp`, none of
		// which is the label #2847 specifies.
		const wrong: string[] = [];
		for (const [route, expected] of Object.entries(issueNavigationLabels)) {
			const slug = route === "/" ? "index" : route.slice(1);
			assert.ok(routeToSlug.has(`/${slug}`), `${route} has no page`);
			const frontmatter = frontmatterOf(slug);
			const derived = (): string => {
				const last = (slug.split("/").pop() ?? "").replaceAll("-", " ").replaceAll("_", " ");
				return last.charAt(0).toUpperCase() + last.slice(1);
			};
			const effective = frontmatter.sidebarTitle ?? frontmatter.title ?? derived();
			if (effective !== expected) wrong.push(`${route}: renders "${effective}", #2847 specifies "${expected}"`);
		}
		assert.equal(Object.keys(issueNavigationLabels).length, 57, "all 57 enumerated routes are checked");
		assert.deepEqual(wrong, [], "navigation labels must match the issue's enumerated tree exactly");
	});
});

describe("docs public entry points (#2847)", () => {
	test("the canonical route and /index are both backed by index.md", () => {
		assert.ok(routeToSlug.has("/index"));
	});

	test("both redirects survive in docs.json with exact, resolving destinations", () => {
		const configured = new Map((docsJson.redirects ?? []).map((entry) => [entry.source, entry.destination]));
		const recorded = [
			{ source: "/session", destination: "/session-format" },
			{ source: "/tree", destination: "/sessions" },
		];
		for (const route of recorded) {
			assert.ok(
				configured.has(route.source),
				`redirect source ${route.source} existed at baseline and must stay in docs.json`,
			);
			assert.equal(
				configured.get(route.source),
				route.destination,
				`redirect ${route.source} must keep its exact destination`,
			);
			assert.ok(
				routeToSlug.has(route.destination ?? ""),
				`redirect ${route.source} points at ${route.destination}, which has no page`,
			);
		}
		// Mintlify rejects a fragment in a redirect source, which is why moved
		// fragments are covered by compatibility headings instead.
		for (const entry of docsJson.redirects ?? []) {
			assert.ok(!entry.source.includes("#"), `${entry.source}: Mintlify redirect sources cannot carry a fragment`);
		}
	});
});

describe("docs reader anchors (#2847)", () => {
	test("every docs anchor cited anywhere in the repository resolves", () => {
		const unresolved = new Set<string>();
		let checked = 0;
		const record = (route: string, anchor: string): void => {
			checked += 1;
			const citation = `${route}#${anchor}`;
			if (brokenBeforeMigration.has(citation)) return;
			if (!anchorResolves(route, anchor)) unresolved.add(citation);
		};

		for (const slug of diskSlugs) {
			const text = readFileSync(join(docsDir, pathForSlug(slug)), "utf8");
			for (const match of text.matchAll(/\]\((\/[A-Za-z0-9._/-]*)#([^)\s]+)\)/gu)) {
				record(match[1] ?? "", match[2] ?? "");
			}
			for (const match of text.matchAll(/\]\(#([^)\s]+)\)/gu)) {
				record(`/${slug}`, match[1] ?? "");
			}
		}
		const sources = execFileSync(
			"git",
			["-C", repoRoot, "ls-files", "*.md", "*.mdx", "*.ts", "*.tsx", "*.mjs", "*.js", "*.json", "*.txt"],
			{ encoding: "utf8" },
		)
			.trim()
			.split("\n");
		for (const source of sources) {
			if (/^(research|specs)\//u.test(source)) continue;
			if (!existsSync(join(repoRoot, source))) continue;
			const text = readFileSync(join(repoRoot, source), "utf8");
			for (const match of text.matchAll(/docs\/([\w./-]+)\.mdx?#([\w./&+_\u2013\u2014-]+)/gu)) {
				const relative = match[1] ?? "";
				if (!routeToSlug.has(`/${relative}`)) continue;
				record(`/${relative}`, match[2] ?? "");
			}
			for (const match of text.matchAll(/https:\/\/docs\.bastani\.ai(\/[\w./-]*)#([\w./&+_-]+)/gu)) {
				record(match[1] ?? "", match[2] ?? "");
			}
		}

		assert.ok(checked > 200, `citations were discovered, not hardcoded (checked ${checked})`);
		assert.deepEqual(
			[...unresolved].sort(),
			[],
			"these docs anchors are cited somewhere in the repository but no longer resolve",
		);
	});

	test("the pre-existing broken-anchor list stays honest", () => {
		// Every entry must still be genuinely unresolvable. When one starts
		// resolving, delete it here rather than letting the exclusion mask a
		// future regression at the same anchor.
		for (const citation of brokenBeforeMigration) {
			const [route = "", anchor = ""] = citation.split("#");
			assert.ok(!anchorResolves(route, anchor), `${citation} now resolves; remove it from brokenBeforeMigration`);
		}
	});

	test("every exempt anchor is cited only by the provenance that exempts it", () => {
		// Only immutable released-changelog provenance earns an exemption.
		// Workflow references are live reader citations and must resolve.
		const exempt = [...brokenBeforeMigration];
		const anchors = exempt.map((citation) => citation.split("#")[1] ?? "");
		const pattern = new RegExp(`\\]\\(([^)\\s]*)#(${anchors.join("|")})\\)`, "gu");
		const routeOf = (written: string, ownRoute: string | undefined): string | undefined => {
			if (written === "") return ownRoute;
			// The published site is the same page under a different spelling; a
			// docs.bastani.ai citation is a live reader citation like any other.
			if (URL.canParse(written)) {
				const url = new URL(written);
				if (url.origin !== "https://docs.bastani.ai") return undefined;
				const route = url.pathname.replace(/\/$/u, "");
				return route === "" ? "/" : route;
			}
			if (written.startsWith("/")) return written;
			const [, tail] = written.split("docs/");
			return tail === undefined ? undefined : `/${tail.replace(/\.mdx?$/u, "")}`;
		};
		// Regression coverage for code-scanning alert 199: compare parsed origins,
		// not prefixes, and never reinterpret external URLs as relative docs paths.
		for (const written of [
			"https://docs.bastani.ai.evil.example/docs/workflows",
			"https://docs.bastani.ai@evil.example/docs/workflows",
			"https://evil.example/docs/workflows",
			"http://docs.bastani.ai/workflows",
			"https://docs.bastani.ai:444/workflows",
		]) {
			assert.equal(routeOf(written, undefined), undefined, written);
		}
		for (const [written, expected] of [
			["https://docs.bastani.ai", "/"],
			["https://docs.bastani.ai/", "/"],
			["https://docs.bastani.ai/workflows/", "/workflows"],
			["https://docs.bastani.ai/workflows?source=guide", "/workflows"],
			["https://DOCS.BASTANI.AI:443/workflows", "/workflows"],
			["/workflows", "/workflows"],
			["../docs/workflows.md", "/workflows"],
			["../docs/workflows.mdx", "/workflows"],
		] as const) {
			assert.equal(routeOf(written, undefined), expected, written);
		}
		assert.equal(routeOf("", "/workflows"), "/workflows");
		assert.equal(routeOf("", undefined), undefined);
		const citers = new Map<string, Set<string>>();
		const collect = (file: string, ownRoute: string | undefined, text: string): void => {
			for (const match of text.matchAll(pattern)) {
				const route = routeOf(match[1] ?? "", ownRoute);
				if (route === undefined) continue;
				const citation = `${route}#${match[2]}`;
				if (!brokenBeforeMigration.has(citation)) continue;
				const seen = citers.get(citation) ?? new Set<string>();
				seen.add(file);
				citers.set(citation, seen);
			}
		};
		// The docs tree includes pages the migration created, which git does not
		// track yet, so it is scanned directly rather than through git grep.
		for (const slug of diskSlugs) {
			const page = pathForSlug(slug);
			collect(`packages/coding-agent/docs/${page}`, `/${slug}`, readFileSync(join(docsDir, page), "utf8"));
		}
		let grepped = "";
		try {
			grepped = execFileSync(
				"git",
				[
					"-C",
					repoRoot,
					"grep",
					"-I",
					"-n",
					"-E",
					`\\]\\([^)]*#(${anchors.join("|")})\\)`,
					"--",
					":!research",
					":!specs",
					":!docs/migrations",
				],
				{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
			);
		} catch {
			grepped = ""; // git grep exits 1 when nothing matches
		}
		for (const line of grepped.split("\n")) {
			if (!line) continue;
			const [file = "", , ...rest] = line.split(":");
			const own = file.startsWith("packages/coding-agent/docs/")
				? `/${file.slice("packages/coding-agent/docs/".length).replace(/\.mdx?$/u, "")}`
				: undefined;
			collect(file, own, rest.join(":"));
		}

		const wrong: string[] = [];
		for (const citation of exempt) {
			const found = [...(citers.get(citation) ?? [])].sort();
			assert.ok(found.length > 0, `${citation} is exempt but nothing cites it; drop the exemption`);
			for (const file of found) {
				const allowed = file === "packages/coding-agent/CHANGELOG.md";
				if (!allowed) wrong.push(`${citation} is cited by ${file}, which is a live reader citation`);
			}
		}
		assert.deepEqual(wrong, [], "a live citation cannot be exempted; correct the anchor instead");
	});
});

describe("docs references and assets (#2847)", () => {
	test("every docs path a shipped prompt names exists", () => {
		const pattern = /(?:[\w./-]*)docs\/([\w./-]+\.mdx?)/gu;
		let checked = 0;
		for (const source of promptSources) {
			const text = readFileSync(join(repoRoot, source), "utf8");
			for (const match of text.matchAll(pattern)) {
				const relative = match[1] ?? "";
				if (relative.startsWith("foo.")) continue; // the template placeholder in system-prompt.ts
				assert.ok(
					existsSync(join(docsDir, relative)),
					`${source} names packages/coding-agent/docs/${relative}, which does not exist`,
				);
				checked += 1;
			}
		}
		assert.ok(checked > 10, "the prompt sources were scanned, not silently skipped");
	});

	test("Intercom operations maps observable states to recovery actions", () => {
		const text = readFileSync(join(docsDir, "intercom/operations.md"), "utf8");
		const h2s = headingsIn(text)
			.filter((heading) => heading.level === 2)
			.map((heading) => heading.text);
		assert.deepEqual(
			h2s,
			[
				"Connection states and recovery",
				"How Connection Works",
				"How It Works",
				"Workflow and Subagent Notifications",
				"Keyboard Shortcuts",
				"Limitations",
			],
			"the runbook must lead with state and recovery, then connection internals and delivery contracts",
		);

		const lines = text.split("\n");
		const start = lines.indexOf("## Connection states and recovery");
		const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
		assert.ok(start >= 0 && end > start, "the state table must be a bounded H2 section");
		const rows = lines
			.slice(start, end)
			.filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
			.map((line) =>
				line
					.split("|")
					.slice(1, -1)
					.map((cell) => cell.trim()),
			);
		assert.deepEqual(rows.shift(), ["State", "What you see", "What to do"]);
		assert.deepEqual(
			rows.map((row) => row[0]),
			[
				"Not connected or waiting for lazy admission",
				"Recoverable disconnect",
				"Reconnect backoff",
				"Exhausted workflow-stage warm-up",
				"Terminal stage delivery failure",
				"Destination-side admission failure",
				"Broker restart or concurrent startup",
				"Broker does not start",
				"Half-closed peer or undeliverable send",
			],
			"the runbook must cover every observable lifecycle state named by the Intercom contracts",
		);
		for (const [state, symptom, recovery] of rows) {
			assert.ok(symptom && symptom.length > 20, `${state} needs an observable symptom`);
			assert.ok(recovery && recovery.length > 20, `${state} needs a recovery action`);
			assert.match(recovery, /See \[[^\]]+\]\(#[^)]+\)\.$/u, `${state} must link to its detailed contract`);
		}
	});

	test("the first-session expected result names only documented default tools", () => {
		// The expected result and the default-tool list are two halves of one page.
		// When the sentence named `find` or `bash` only, a session that answered
		// correctly with `read` on a directory failed a criterion the same page
		// contradicts three sections later.
		const lines = readFileSync(join(docsDir, "getting-started/first-session.md"), "utf8").split("\n");
		const sentence = lines.find((line) => line.startsWith("Expected result: Atomic streams a response"));
		assert.ok(sentence, "first-session.md must state the expected result of its runnable task");
		// Only the enumerated clause, not the recovery advice that follows it.
		const clause = /calls (.+?) at least once —/u.exec(sentence ?? "")?.[1];
		assert.ok(clause, "the expected result must enumerate the tools that satisfy it");
		const named = [...(clause ?? "").matchAll(/`([a-z_]+)`/gu)].map((match) => match[1] ?? "");
		const documented = new Set(
			lines.map((line) => /^- `([a-z_]+)` - /u.exec(line)?.[1]).filter((tool): tool is string => tool !== undefined),
		);
		assert.ok(documented.size > 5, `the default-tool list was read, not skipped (${documented.size})`);
		for (const tool of named) {
			assert.ok(documented.has(tool), `the expected result names \`${tool}\`, which the page never documents`);
		}
		// The exact set that can answer "list the top-level directories": `read`
		// accepts a directory and returns a tree (see
		// packages/coding-agent/src/core/tools/read.ts and its directory-read
		// parity test), `find` discovers paths, and `bash` runs a shell command.
		// Dropping one makes a correct session fail the documented criterion.
		assert.deepEqual(
			[...named].sort(),
			["bash", "find", "read"],
			"the expected result must accept exactly the default tools that can answer the task",
		);
		// A tool named outside a code span is invisible to that check, so the
		// clause may not smuggle one in as plain prose.
		const prose = (clause ?? "").replaceAll(/`[^`]*`/gu, " ");
		const shellNames = new Set([...documented, "ls", "grep", "cat", "tree", "dir", "rg", "fd"]);
		for (const word of prose.match(/[a-z_]{2,}/gu) ?? []) {
			assert.ok(!shellNames.has(word), `the expected result names ${word} outside a code span`);
		}
	});

	test("every relative image reference resolves from its page", () => {
		let checked = 0;
		for (const slug of diskSlugs) {
			const path = pathForSlug(slug);
			const text = readFileSync(join(docsDir, path), "utf8");
			for (const match of text.matchAll(/<img\s+[^>]*src="([^"]+)"/gu)) {
				const src = match[1] ?? "";
				if (src.startsWith("http") || src.startsWith("/")) continue;
				assert.ok(
					existsSync(resolve(dirname(join(docsDir, path)), src)),
					`${path} references ${src}, which does not resolve from that page's directory`,
				);
				checked += 1;
			}
		}
		assert.equal(checked, 6, "all six relative image references must still be checked");
	});
});
