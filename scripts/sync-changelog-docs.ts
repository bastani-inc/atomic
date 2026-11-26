#!/usr/bin/env bun
/**
 * Renders packages/coding-agent/CHANGELOG.md into the docs site's changelog page,
 * packages/coding-agent/docs/changelog.mdx. Each release shows its summary: the prose
 * between its version heading and its first `###`.
 *
 *   bun run scripts/sync-changelog-docs.ts           rewrite changelog.mdx
 *   bun run scripts/sync-changelog-docs.ts --check   fail when changelog.mdx is stale
 *
 * A release PR may change only CHANGELOG.md files (`publish-release.ts check-changelog-diff`),
 * so it can't carry the regenerated page. The page is regenerated after the release, in its
 * own docs PR (step 9 of .agents/skills/publish-release/SKILL.md). Until that PR lands the
 * page is exactly one release behind, which `--check` accepts. A page two releases behind,
 * or edited by hand, fails.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import {
	type ChangelogEntry,
	compareVersions,
	getChangelogHighlights,
	parseChangelog,
} from "../packages/coding-agent/src/utils/changelog.js";

const REPO_URL = "https://github.com/bastani-inc/atomic";
const PACKAGE_DIR = "packages/coding-agent";
const DOCS_DIR = `${PACKAGE_DIR}/docs`;
const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

const HEADER = `---
title: "Changelog"
description: "What's new in Atomic"
---

{/*
  Generated from packages/coding-agent/CHANGELOG.md by scripts/sync-changelog-docs.ts. Don't edit it by hand.
  Every stable release is listed, newest first. Prereleases are listed only for versions newer than the
  newest stable release, so 1.2.0-alpha.N entries show until 1.2.0 ships and then drop out.
  After each release, the publish-release skill regenerates this page in its own docs PR.
*/}
`;

/**
 * Atomic's own releases, newest first. The file continues below them with the upstream Pi
 * history the fork inherited, which starts where the version stream jumps back up.
 */
function atomicReleases(entries: readonly ChangelogEntry[]): ChangelogEntry[] {
	const own: ChangelogEntry[] = [];
	for (const entry of entries) {
		const previous = own.at(-1);
		if (previous && compareVersions(entry, previous) >= 0) break;
		own.push(entry);
	}
	return own;
}

/** Stable releases, plus prereleases of versions newer than the newest stable release. */
function shownReleases(entries: readonly ChangelogEntry[]): ChangelogEntry[] {
	const newestStable = entries.find((entry) => entry.prerelease === null);
	return entries.filter(
		(entry) =>
			entry.prerelease === null ||
			newestStable === undefined ||
			compareVersions({ ...entry, prerelease: null }, newestStable) > 0,
	);
}

/** Releases before 0.8.24 were tagged with a leading `v`. */
function releaseTag(entry: ChangelogEntry): string {
	const unprefixed = { major: 0, minor: 8, patch: 24, prerelease: null };
	return compareVersions({ ...entry, prerelease: null }, unprefixed) < 0 ? `v${entry.version}` : entry.version;
}

function releaseDate(entry: ChangelogEntry): string {
	const match = entry.content.match(/^## \S+ - (\d{4})-(\d{2})-(\d{2})/u);
	if (!match) throw new Error(`The ${entry.version} heading has no YYYY-MM-DD date.`);
	return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

/** A docs page becomes a site route when the site still has it; any other repository path links to GitHub at the release tag. */
function linkTarget(target: string, tag: string, docPages: ReadonlySet<string>): string {
	if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(target)) return target;
	const suffixAt = target.search(/[?#]/u);
	const path = suffixAt === -1 ? target : target.slice(0, suffixAt);
	const suffix = suffixAt === -1 ? "" : target.slice(suffixAt);
	const repoPath = posix.normalize(posix.join(PACKAGE_DIR, path));
	if (repoPath.startsWith("../")) return target;
	const page = repoPath.startsWith(`${DOCS_DIR}/`) ? repoPath.slice(DOCS_DIR.length + 1).replace(/\.mdx?$/u, "") : "";
	if (page && docPages.has(page)) return `/${page}${suffix}`;
	return `${REPO_URL}/blob/${tag}/${repoPath}${suffix}`;
}

/**
 * Escapes what MDX would read as JSX or an expression (`<`, `>`, `{`, `}`), except inside code
 * spans and link targets. HTML entities pass through: MDX decodes them as GitHub does.
 */
function toMdx(markdown: string, tag: string, docPages: ReadonlySet<string>): string {
	let output = "";
	let index = 0;
	while (index < markdown.length) {
		const char = markdown[index];
		if (char === "`") {
			const fence = markdown.slice(index).match(/^`+/u)![0];
			const close = markdown.slice(index + fence.length).search(new RegExp(`(?<!\`)${fence}(?!\`)`, "u"));
			const end = close === -1 ? index + fence.length : index + fence.length * 2 + close;
			output += markdown.slice(index, end);
			index = end;
		} else if (markdown.startsWith("](", index) && markdown.includes(")", index)) {
			const close = markdown.indexOf(")", index);
			const [target, ...title] = markdown.slice(index + 2, close).split(" ");
			output += `](${[linkTarget(target, tag, docPages), ...title].join(" ")})`;
			index = close + 1;
		} else {
			output += { "<": "&lt;", ">": "&gt;", "{": "\\{", "}": "\\}" }[char] ?? char;
			index += 1;
		}
	}
	return output;
}

function renderRelease(entry: ChangelogEntry, docPages: ReadonlySet<string>): string {
	const tag = releaseTag(entry);
	const summary = getChangelogHighlights(entry);
	const body = summary
		? toMdx(summary, tag, docPages)
		: `See the [${entry.version} release notes on GitHub](${REPO_URL}/releases/tag/${tag}) for what changed.`;
	return `<Update label="${releaseDate(entry)}" description="${entry.version}">\n\n${body}\n\n</Update>\n`;
}

/** The changelog page for `entries` (CHANGELOG.md order); `docPages` are the site's page slugs, such as `storage`. */
export function renderChangelogPage(entries: readonly ChangelogEntry[], docPages: ReadonlySet<string>): string {
	const blocks = shownReleases(atomicReleases(entries)).map((entry) => renderRelease(entry, docPages));
	return `${HEADER}\n${blocks.join("\n")}`;
}

/**
 * `current` when the page matches CHANGELOG.md; `behind` when it only lacks the newest release,
 * which the post-release docs PR adds; `stale` otherwise.
 */
export function checkChangelogPage(
	page: string,
	entries: readonly ChangelogEntry[],
	docPages: ReadonlySet<string>,
): { status: "current" | "behind" | "stale"; message: string } {
	const fix = "Run `bun run scripts/sync-changelog-docs.ts` and commit packages/coding-agent/docs/changelog.mdx.";
	if (page === renderChangelogPage(entries, docPages))
		return { status: "current", message: "changelog.mdx matches CHANGELOG.md." };
	const [newest, ...older] = atomicReleases(entries);
	if (newest && page === renderChangelogPage(older, docPages))
		return {
			status: "behind",
			message: `changelog.mdx doesn't show ${newest.version} yet. The post-release docs PR adds it. ${fix}`,
		};
	return {
		status: "stale",
		message: `changelog.mdx doesn't match CHANGELOG.md: it was edited by hand, or it is more than one release behind. ${fix}`,
	};
}

function docPageSlugs(repoRoot: string): Set<string> {
	const docsRoot = join(repoRoot, DOCS_DIR);
	return new Set(
		readdirSync(docsRoot, { recursive: true, encoding: "utf8" })
			.filter((file) => /\.mdx?$/u.test(file))
			.map((file) =>
				file
					.split(sep)
					.join("/")
					.replace(/\.mdx?$/u, ""),
			),
	);
}

function main(args: readonly string[]): number {
	const repoRoot = join(import.meta.dirname, "..");
	const pagePath = join(repoRoot, DOCS_DIR, "changelog.mdx");
	const entries = parseChangelog(join(repoRoot, PACKAGE_DIR, "CHANGELOG.md"));
	const docPages = docPageSlugs(repoRoot);
	if (args.includes("--check")) {
		const { status, message } = checkChangelogPage(readFileSync(pagePath, "utf8"), entries, docPages);
		(status === "stale" ? console.error : console.log)(message);
		return status === "stale" ? 1 : 0;
	}
	writeFileSync(pagePath, renderChangelogPage(entries, docPages));
	console.log(`Wrote ${relative(repoRoot, pagePath)}.`);
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
