#!/usr/bin/env bun
/**
 * Builds the GitHub Release notes body for a version by merging every
 * `packages/*\/CHANGELOG.md` section for that version into one flat set of
 * `###` sections.
 *
 * Five packages (workflows, subagents, mcp, web-access, intercom) ship bundled
 * inside `@bastani/atomic` rather than being published independently, so their
 * entries are user-facing for anyone installing it. Reading only
 * `packages/coding-agent/CHANGELOG.md` silently drops them: Atomic
 * 0.9.16-alpha.7 changed only subagents and workflows and published a release
 * page whose entire body was the commit subject.
 *
 * There is deliberately no empty-notes fallback. A version that no changelog
 * describes is a preparation mistake, and failing here costs a re-cut, whereas
 * a contentless page is only fixable after users have already seen it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Subsection headings in the order AGENTS.md documents them. */
const CANONICAL_SECTIONS: readonly string[] = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"];

/**
 * Packages whose entries lead each merged section. `coding-agent` is the
 * package users install, so its notes read first; every other package follows
 * in a stable alphabetical order.
 */
const LEAD_PACKAGES: readonly string[] = ["coding-agent"];

export interface ChangelogSource {
	/** Directory name under `packages/`, used only for ordering. */
	readonly name: string;
	readonly content: string;
}

export interface VersionSection {
	/** Prose appearing under the version heading before the first `###`. */
	readonly preamble: string;
	/** Section title to its entry lines, in first-appearance order. */
	readonly sections: ReadonlyMap<string, string>;
}

function trimBlankEdges(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start += 1;
	while (end > start && lines[end - 1].trim() === "") end -= 1;
	return lines.slice(start, end);
}

/**
 * Extracts one version's body, or null when the file has no such section. The
 * closing bracket in the heading keeps `0.9.1` from matching `0.9.15`.
 */
export function extractVersionSection(content: string, version: string): VersionSection | null {
	const lines = content.split("\n");
	const heading = `## [${version}]`;
	const start = lines.findIndex((line) => line.startsWith(heading));
	if (start < 0) return null;

	const body: string[] = [];
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.startsWith("## ")) break;
		body.push(line);
	}

	const preamble: string[] = [];
	const collected = new Map<string, string[]>();
	let current: string[] | null = null;
	for (const line of body) {
		if (line.startsWith("### ")) {
			const title = line.slice(4).trim();
			let bucket = collected.get(title);
			if (!bucket) {
				bucket = [];
				collected.set(title, bucket);
			}
			current = bucket;
			continue;
		}
		(current ?? preamble).push(line);
	}

	const sections = new Map<string, string>();
	for (const [title, entryLines] of collected) {
		const text = trimBlankEdges(entryLines).join("\n");
		if (text.length > 0) sections.set(title, text);
	}
	return { preamble: trimBlankEdges(preamble).join("\n"), sections };
}

function orderSources(sources: readonly ChangelogSource[]): ChangelogSource[] {
	return [...sources].sort((left, right) => {
		const leftLead = LEAD_PACKAGES.indexOf(left.name);
		const rightLead = LEAD_PACKAGES.indexOf(right.name);
		if (leftLead !== rightLead) {
			if (leftLead < 0) return 1;
			if (rightLead < 0) return -1;
			return leftLead - rightLead;
		}
		return left.name.localeCompare(right.name);
	});
}

/** Canonical sections first, then any others in first-appearance order. */
function orderSectionTitles(titles: readonly string[]): string[] {
	const known = CANONICAL_SECTIONS.filter((title) => titles.includes(title));
	return [...known, ...titles.filter((title) => !CANONICAL_SECTIONS.includes(title))];
}

/**
 * Merges every source's section for `version` into one flat notes body.
 *
 * @throws when no source documents the version, so a contentless release page
 * can never be staged.
 */
export function buildReleaseNotes(sources: readonly ChangelogSource[], version: string): string {
	const preambles: string[] = [];
	const merged = new Map<string, string[]>();

	for (const source of orderSources(sources)) {
		const section = extractVersionSection(source.content, version);
		if (!section) continue;
		// Packages that share a release often repeat one identical summary
		// paragraph; a merged body states it once.
		if (section.preamble.length > 0 && !preambles.includes(section.preamble)) preambles.push(section.preamble);
		for (const [title, entries] of section.sections) {
			const bucket = merged.get(title);
			if (bucket) bucket.push(entries);
			else merged.set(title, [entries]);
		}
	}

	const blocks: string[] = [...preambles];
	for (const title of orderSectionTitles([...merged.keys()])) {
		blocks.push(`### ${title}\n\n${(merged.get(title) ?? []).join("\n")}`);
	}

	if (blocks.length === 0) {
		throw new Error(
			`No packages/*/CHANGELOG.md documents version ${version}. ` +
				`Add the release notes under a "## [${version}]" heading and re-cut the release.`,
		);
	}
	return `${blocks.join("\n\n")}\n`;
}

/** Reads every `packages/*\/CHANGELOG.md` that exists. */
export function readChangelogSources(packagesDir: string): ChangelogSource[] {
	const sources: ChangelogSource[] = [];
	for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const path = join(packagesDir, entry.name, "CHANGELOG.md");
		if (!existsSync(path)) continue;
		sources.push({ name: entry.name, content: readFileSync(path, "utf-8") });
	}
	return sources;
}

function usage(): never {
	process.stderr.write("usage: build-release-notes.ts <version> [--out <path>] [--packages-dir <path>]\n");
	process.exit(2);
}

function main(argv: readonly string[]): void {
	let version = "";
	let out = "";
	let packagesDir = "";

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--out" || arg === "--packages-dir") {
			const value = argv[index + 1];
			if (value === undefined) usage();
			if (arg === "--out") out = value;
			else packagesDir = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("-") || version !== "") usage();
		version = arg;
	}
	if (version === "") usage();

	if (packagesDir === "") {
		packagesDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "packages");
	}

	const notes = buildReleaseNotes(readChangelogSources(packagesDir), version);
	if (out === "") process.stdout.write(notes);
	else writeFileSync(out, notes);
}

if (import.meta.main) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
}
