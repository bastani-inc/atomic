import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { test } from "vitest";
import { npmSpawnPrefix, spawnSyncCollect } from "../helpers/runtime.js";

const builtTest = existsSync("packages/coding-agent/dist/index.js") ? test : test.skip;
/** One `npm pack --dry-run` child lists the nine published packages. */
const NPM_PACK_DRY_RUN_TIMEOUT_MS = 120_000;
const PUBLISHED_PACKAGE_DIRS = [
	"packages/coding-agent",
	"packages/ai",
	"packages/agent",
	"packages/codemode",
	"packages/schema",
	"packages/telemetry",
	"packages/tui",
	"packages/storage-postgres",
] as const;

interface PackDryRunResult {
	readonly name: string;
	readonly files: readonly { readonly path: string }[];
}

/** The link targets of a Markdown document, outside code blocks and code spans. */
function linkTargets(markdown: string): string[] {
	const prose = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gmu, "").replace(/`[^`\n]*`/gu, "");
	return [...prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|\b(?:href|src)="([^"]+)"/gu)].map(
		(match) => match[1] ?? match[2] ?? "",
	);
}

builtTest(
	"documents in the published packages link only to files those packages ship, or by URL",
	() => {
		const pack = spawnSyncCollect(
			[
				...npmSpawnPrefix(),
				"pack",
				"--dry-run",
				"--json",
				"--ignore-scripts",
				...PUBLISHED_PACKAGE_DIRS.map((directory) => `./${directory}`),
			],
			{ timeout: NPM_PACK_DRY_RUN_TIMEOUT_MS },
		);
		assert.equal(pack.exitCode, 0, pack.stderr.toString());
		const results = JSON.parse(pack.stdout.toString()) as PackDryRunResult[];
		assert.equal(results.length, PUBLISHED_PACKAGE_DIRS.length);
		const broken: string[] = [];
		let checked = 0;
		for (const [index, { name, files }] of results.entries()) {
			const shipped = new Set(files.map((file) => file.path));
			const directories = new Set(
				[...shipped].flatMap((path) =>
					path
						.split("/")
						.slice(0, -1)
						.map((_, end, parts) => parts.slice(0, end + 1).join("/")),
				),
			);
			for (const document of shipped) {
				// Released changelog sections never change; they keep the links they were released with.
				if (!/\.mdx?$/u.test(document) || posix.basename(document) === "CHANGELOG.md") continue;
				const markdown = readFileSync(join(PUBLISHED_PACKAGE_DIRS[index]!, document), "utf8");
				for (const target of linkTargets(markdown)) {
					// A URL, a route of the documentation site, an anchor on the same page, or a word standing in for a link
					// in a template.
					if (/^[a-z][a-z\d+.-]*:|^[/#]/iu.test(target) || !/[./]/u.test(target)) continue;
					checked += 1;
					const path = posix
						.normalize(posix.join(posix.dirname(document), target.split("#")[0]!))
						.replace(/\/$/u, "");
					if (!shipped.has(path) && !directories.has(path)) broken.push(`${name}: ${document} links ${target}`);
				}
			}
		}
		assert.ok(checked > 100, `relative links were discovered (checked ${checked})`);
		assert.deepEqual(broken, []);
	},
	NPM_PACK_DRY_RUN_TIMEOUT_MS,
);
