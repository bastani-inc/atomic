#!/usr/bin/env bun
/**
 * Builds the GitHub Release notes body for a version by merging every
 * `packages/*\/CHANGELOG.md` section for that version into one flat set of
 * `###` sections.
 *
 * A changelog may open a version with a human-readable summary: prose between
 * the `## [x.y.z]` heading and its first `###` section. When any package has
 * one, the notes lead with the summary (stated once when packages repeat it)
 * and the merged sections move into a collapsed "Full changelog" block, so the
 * release page reads as highlights first with the complete list one click
 * away. A version with no summary keeps the flat merged sections unchanged.
 *
 * Five packages (workflows, subagents, mcp, web-access, intercom) ship bundled
 * inside `@bastani/atomic` rather than being published independently, so their
 * entries are user-facing for anyone installing it. Reading only
 * `packages/coding-agent/CHANGELOG.md` silently drops them: Atomic
 * 0.9.16-alpha.7 changed only subagents and workflows and published a release
 * page whose entire body was the commit subject.
 *
 * Packages that share a change used to describe it in each of their summaries
 * and sections, so one change appeared two or three times (#4799). The merge
 * therefore lists each change once within the summary and once within each
 * `###` section, but never deduplicates across the summary and the full
 * changelog: a change belongs in both. See `isSameChange` for the rule.
 *
 * There is deliberately no empty-notes fallback. A version that no changelog
 * describes is a preparation mistake, and failing here costs a re-cut, whereas
 * a contentless page is only fixable after users have already seen it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

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

function extractHeadingLabel(line: string): string | null {
	if (!line.startsWith("## [")) return null;
	const close = line.indexOf("]", 4);
	return close > 4 ? line.slice(4, close) : null;
}

/**
 * Extracts one version's body, or null when the file has no such section in its
 * current descending release stream. Stopping when the descending semver stream
 * passes `version` or jumps upward into older pre-monorepo / pre-fork history
 * prevents collisions with standalone package versions (such as web-access's
 * May 2026 `0.10.7` below `0.8.15`).
 */
export function extractVersionSection(content: string, version: string): VersionSection | null {
	const lines = content.split("\n");
	const targetSemver = semver.valid(version);
	let previousSemver: string | null = null;
	let start = -1;
	for (let index = 0; index < lines.length; index += 1) {
		const label = extractHeadingLabel(lines[index]);
		if (label === null) continue;
		if (label === version) {
			start = index;
			break;
		}
		if (label === "Unreleased" || targetSemver === null) continue;
		const headingSemver = semver.valid(label);
		if (headingSemver === null) continue;
		if (previousSemver !== null && semver.gt(headingSemver, previousSemver)) return null;
		if (semver.lt(headingSemver, targetSemver)) return null;
		previousSemver = headingSemver;
	}
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
 * Two bullets citing nested link sets are one change only when the smaller set
 * holds at least this many links. One shared issue is weak evidence: an issue
 * that spans packages gets a distinct entry per package (0.9.86's #4738 fixed
 * the workflow resume and, separately, the coding-agent restore API), while a
 * summary bullet cites the issue and its PR together.
 */
const MIN_SHARED_LINKS = 2;

const GITHUB_REFERENCE_RE = /https:\/\/github\.com\/([^/\s)]+\/[^/\s)]+)\/(?:issues|pull)\/(\d+)/g;

/** One bullet with its continuation lines, or a run of other lines. */
interface Item {
	/** The item's lines with trailing blank lines removed. */
	readonly lines: readonly string[];
	/** Blank lines that followed the item where it appeared. */
	readonly trailingBlankLines: number;
	readonly bullet: boolean;
}

interface Bullet {
	readonly lines: readonly string[];
	/** `owner/repo#number`; issues and pull requests share one number space. */
	readonly links: ReadonlySet<string>;
	/** Whitespace-normalized text, for verbatim-repeat detection and length. */
	readonly text: string;
}

/** One rendered position: an item kept as written, or a bullet identified by its index in input order. */
interface Slot {
	readonly item: Item;
	readonly bullet?: number;
}

function isBulletStart(line: string): boolean {
	return line.startsWith("- ") || line.startsWith("* ");
}

/**
 * Splits markdown into bullets and runs of other lines. A bullet keeps its
 * indented and lazy continuation lines; an unindented line after a blank line
 * ends it, so a closing paragraph such as "**Breaking change:**" stays prose.
 */
function splitItems(text: string): Item[] {
	const items: Item[] = [];
	let lines: string[] = [];
	let bullet = false;
	const flush = (): void => {
		if (lines.length === 0) return;
		const kept = trimBlankEdges(lines);
		items.push({ lines: kept, trailingBlankLines: lines.length - kept.length, bullet });
		lines = [];
	};
	for (const line of text.split("\n")) {
		const afterBlank = lines.length > 0 && lines[lines.length - 1].trim() === "";
		if (isBulletStart(line)) {
			flush();
			bullet = true;
		} else if (bullet && afterBlank && line.trim() !== "" && !/^\s/.test(line)) {
			flush();
			bullet = false;
		}
		lines.push(line);
	}
	flush();
	return items;
}

function toBullet(lines: readonly string[]): Bullet {
	const text = lines.join("\n");
	const links = new Set<string>();
	for (const match of text.matchAll(GITHUB_REFERENCE_RE)) links.add(`${match[1].toLowerCase()}#${match[2]}`);
	return { lines, links, text: text.replace(/\s+/g, " ").trim() };
}

function isSubset(small: ReadonlySet<string>, large: ReadonlySet<string>): boolean {
	for (const link of small) if (!large.has(link)) return false;
	return true;
}

/**
 * Two bullets describe the same change when they read the same, or when one
 * cites every issue/PR link the other does (equal sets included) and the
 * smaller set has at least `MIN_SHARED_LINKS` links. Partly overlapping sets
 * are distinct changes, as are bullets that share a single link.
 */
function isSameChange(left: Bullet, right: Bullet): boolean {
	if (left.text === right.text) return true;
	const [small, large] = left.links.size <= right.links.size ? [left, right] : [right, left];
	return small.links.size >= MIN_SHARED_LINKS && isSubset(small.links, large.links);
}

/**
 * Whether `candidate` is the more complete wording of a change than `current`:
 * more links, then longer text, then the text that sorts first, so the choice
 * never depends on input order. Identical text keeps the earlier bullet.
 */
function ranksAbove(candidate: Bullet, candidateIndex: number, current: Bullet, currentIndex: number): boolean {
	if (candidate.links.size !== current.links.size) return candidate.links.size > current.links.size;
	if (candidate.text.length !== current.text.length) return candidate.text.length > current.text.length;
	if (candidate.text !== current.text) return candidate.text < current.text;
	return candidateIndex < currentIndex;
}

/**
 * Lists each change once across `blocks`, keeping their order. Every bullet
 * that no more complete wording of the same change covers is kept, so two
 * distinct changes are never merged through a third bullet that both cover
 * (#4835). A covered bullet is removed. When exactly one kept bullet covers
 * it, that kept bullet moves to the first place its change appeared; a bullet
 * that several kept bullets cover anchors none of them. A block that had
 * bullets and lost all of them also loses the theme line before them; any
 * prose after its bullets, such as a "**Breaking change:**" note, stays.
 * Returns the blocks left with content.
 */
function dedupeBlocks(blocks: readonly string[]): string[] {
	const bullets: Bullet[] = [];
	const placed: { slots: Slot[]; hadBullets: boolean }[] = [];
	for (const block of blocks) {
		const slots: Slot[] = [];
		let hadBullets = false;
		for (const item of splitItems(block)) {
			if (!item.bullet) {
				slots.push({ item });
				continue;
			}
			hadBullets = true;
			slots.push({ item, bullet: bullets.length });
			bullets.push(toBullet(item.lines));
		}
		placed.push({ slots, hadBullets });
	}

	const kept = bullets
		.map((_, index) => index)
		.filter(
			(index) =>
				!bullets.some(
					(other, otherIndex) =>
						otherIndex !== index &&
						isSameChange(bullets[index], other) &&
						ranksAbove(other, otherIndex, bullets[index], index),
				),
		);
	// Each kept bullet renders at the earliest of its own position and the
	// positions of the bullets only it covers.
	const anchors = new Map<number, number>(kept.map((index) => [index, index]));
	for (const [index, bullet] of bullets.entries()) {
		if (anchors.has(index)) continue;
		const covering = kept.filter((keptIndex) => isSameChange(bullet, bullets[keptIndex]));
		if (covering.length === 1) anchors.set(covering[0], Math.min(anchors.get(covering[0]) ?? index, index));
	}
	const renderedAt = new Map<number, Bullet>();
	for (const [keptIndex, anchor] of anchors) renderedAt.set(anchor, bullets[keptIndex]);

	const rendered: string[] = [];
	for (const { slots, hadBullets } of placed) {
		const isKept = (slot: Slot): boolean => slot.bullet === undefined || renderedAt.has(slot.bullet);
		const firstBullet = slots.findIndex((slot) => slot.item.bullet);
		const orphanedTheme = hadBullets && !slots.some((slot) => slot.item.bullet && isKept(slot));
		const lines: string[] = [];
		// Blank lines are emitted before the next kept item, so a removed item's
		// separation survives and the block never ends with blanks.
		let blanks = 0;
		for (const [index, slot] of slots.entries()) {
			const drop = !isKept(slot) || (orphanedTheme && index < firstBullet);
			if (drop) {
				blanks = Math.max(blanks, slot.item.trailingBlankLines);
				continue;
			}
			if (lines.length > 0) for (let line = 0; line < blanks; line += 1) lines.push("");
			const bullet = slot.bullet === undefined ? undefined : renderedAt.get(slot.bullet);
			lines.push(...(bullet ? bullet.lines : slot.item.lines));
			blanks = slot.item.trailingBlankLines;
		}
		if (lines.length > 0) rendered.push(lines.join("\n"));
	}
	return rendered;
}

/**
 * Merges every source's section for `version` into one flat notes body.
 *
 * @throws when no source documents the version, so a contentless release page
 * can never be staged.
 */
export function buildReleaseNotes(sources: readonly ChangelogSource[], version: string): string {
	let preambles: string[] = [];
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

	preambles = dedupeBlocks(preambles);
	const sectionBlocks: string[] = [];
	for (const title of orderSectionTitles([...merged.keys()])) {
		const entries = dedupeBlocks(merged.get(title) ?? []);
		if (entries.length > 0) sectionBlocks.push(`### ${title}\n\n${entries.join("\n")}`);
	}

	const blocks: string[] = [...preambles];
	if (preambles.length > 0 && sectionBlocks.length > 0) {
		// Blank lines inside the element keep GitHub rendering the markdown within it.
		blocks.push(`<details>\n<summary>Full changelog</summary>\n\n${sectionBlocks.join("\n\n")}\n\n</details>`);
	} else {
		blocks.push(...sectionBlocks);
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
