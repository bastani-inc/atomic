import type { ResourceLoader } from "./resource-loader-types.ts";
import type { Skill } from "./skills.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";

/**
 * A single skill candidate in a collision group, with a stable source-qualified selector.
 */
export interface SkillCandidate {
	/** The underlying skill. */
	readonly skill: Skill;
	/** Source-qualified selector, e.g. `tdd@user`, `tdd@builtin`, or bare `tdd` for the winner. */
	readonly selector: string;
	/** Short source label: `project`, `user`, `builtin`, `package`, or `path`. */
	readonly sourceLabel: string;
	/** Opaque stable ID for internal identity (transcripts, diagnostics). */
	readonly id: string;
}

/**
 * A command surface entry derived from the catalog.
 * For the winner of a collision group, `name` is the bare skill name.
 * For shadowed candidates, `name` includes the `@source` qualifier.
 */
export interface SkillCatalogCommand {
	readonly name: string;
	readonly description: string;
	readonly sourceInfo: Skill["sourceInfo"];
}

/**
 * Result of resolving a selector through the catalog.
 */
export type ResolveResult = { ok: true; candidate: SkillCandidate } | { ok: false; message: string };

/**
 * The full skill catalog: all candidates across all collision groups,
 * plus resolution and command-surface helpers.
 */
export interface SkillCatalog {
	/** All candidates (winners + shadowed) across all names. */
	readonly allCandidates: readonly SkillCandidate[];
	/** Commands for the slash-command surface (bare winner + qualified shadowed). */
	readonly commands: readonly SkillCatalogCommand[];
	/**
	 * Resolve a selector like `tdd` or `tdd@builtin` to an exact candidate.
	 * Returns a message on unknown or ambiguous selectors; never falls back to the bare winner.
	 */
	resolve(selector: string): ResolveResult;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive a short, stable source label from a skill's SourceInfo.
 * The label is used for `@source` qualifiers and must be unique within a collision group;
 * when it is not, a package/path-derived fallback is used.
 */
function sourceLabelFor(skill: Skill): string {
	const si = skill.sourceInfo;
	// scope takes priority: project/user are always unique within those scopes
	if (si.scope === "project") return "project";
	if (si.scope === "user") return "user";
	// package-provided skills: use the source string if it's not generic
	if (si.source && si.source !== "local" && si.source !== "temporary") return si.source;
	// fallback: path
	return "path";
}

/**
 * A label that is unique within the group. If the short label collides with another
 * candidate's short label in the same group, fall back to a path-derived identifier.
 */
function uniqueLabelInGroup(candidates: Skill[]): Map<string, string> {
	const labelMap = new Map<string, string>();
	const labelCounts = new Map<string, number>();
	// First pass: assign short labels and count collisions
	for (const skill of candidates) {
		const label = sourceLabelFor(skill);
		labelMap.set(skill.filePath, label);
		labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
	}
	// Second pass: disambiguate labels that appear more than once
	if (![...labelCounts.values()].some((c) => c > 1)) return labelMap;
	// Use a path-derived suffix for duplicates
	const used = new Set<string>();
	for (const skill of candidates) {
		const shortLabel = labelMap.get(skill.filePath)!;
		if ((labelCounts.get(shortLabel) ?? 0) <= 1) {
			labelMap.set(skill.filePath, shortLabel);
			used.add(shortLabel);
			continue;
		}
		// Derive a unique label from the base directory name
		const baseName = skill.baseDir.split(/[\\/]/).filter(Boolean).pop() ?? shortLabel;
		let candidate = baseName;
		let suffix = 2;
		while (used.has(candidate)) {
			candidate = `${baseName}-${suffix++}`;
		}
		used.add(candidate);
		labelMap.set(skill.filePath, candidate);
	}
	return labelMap;
}

/**
 * Build a stable opaque ID for a candidate. This is internal identity, not a command name.
 */
function candidateIdFor(skill: Skill, label: string): string {
	return `${skill.name}@${label}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a skill catalog from the resource loader's current skills + shadowed skills.
 */
export function getSkillCatalog(loader: ResourceLoader): SkillCatalog {
	const { skills, shadowedSkills } = loader.getSkills();

	// Group all candidates by name: winners first, then shadowed
	const groups = new Map<string, Skill[]>();
	for (const skill of skills) {
		const group = groups.get(skill.name) ?? [];
		group.push(skill);
		groups.set(skill.name, group);
	}
	for (const skill of shadowedSkills) {
		const group = groups.get(skill.name) ?? [];
		group.push(skill);
		groups.set(skill.name, group);
	}

	const allCandidates: SkillCandidate[] = [];
	const commands: SkillCatalogCommand[] = [];

	for (const [name, group] of groups) {
		const labels = uniqueLabelInGroup(group);
		const hasCollision = group.length > 1;

		for (let i = 0; i < group.length; i++) {
			const skill = group[i];
			const label = labels.get(skill.filePath)!;
			const id = candidateIdFor(skill, label);
			// Winner (first in group) gets bare selector; others get qualified
			const selector = i === 0 ? name : `${name}@${label}`;
			allCandidates.push({ skill, selector, sourceLabel: label, id });

			// Commands: bare name for winner; qualified for shadowed (only if collision)
			if (i === 0) {
				commands.push({
					name,
					description: skill.description,
					sourceInfo: skill.sourceInfo,
				});
			} else if (hasCollision) {
				commands.push({
					name: selector,
					description: skill.description,
					sourceInfo: skill.sourceInfo,
				});
			}
		}
	}

	function resolve(selector: string): ResolveResult {
		// Try exact selector match first (handles `name@label` and bare `name`)
		const exact = allCandidates.find((c) => c.selector === selector);
		if (exact) return { ok: true, candidate: exact };

		// If selector contains `@`, it was an explicit qualified attempt that failed
		if (selector.includes("@")) {
			const atIdx = selector.indexOf("@");
			const bareName = selector.slice(0, atIdx);
			const qualifier = selector.slice(atIdx + 1);
			const groupCandidates = allCandidates.filter((c) => c.skill.name === bareName);
			if (groupCandidates.length === 0) {
				return { ok: false, message: `no skill named "${bareName}" is loaded` };
			}
			// Check if any candidate has this exact label
			const labelMatches = groupCandidates.filter((c) => c.sourceLabel === qualifier);
			if (labelMatches.length === 1) {
				return { ok: true, candidate: labelMatches[0] };
			}
			if (labelMatches.length > 1) {
				const selectors = labelMatches.map((c) => c.selector).join(", ");
				return { ok: false, message: `ambiguous selector "${selector}" — matches: ${selectors}` };
			}
			// No label match: list available selectors for this name
			const available = groupCandidates.map((c) => `\`/skill:${c.selector}\``).join(", ");
			return {
				ok: false,
				message: `no skill candidate "${selector}" — available: ${available}`,
			};
		}

		// Bare name that isn't a winner: unknown skill
		return { ok: false, message: `no skill named "${selector}" is loaded` };
	}

	return { allCandidates, commands, resolve };
}

/**
 * Convert catalog commands to SlashCommandInfo array for command surfaces.
 */
export function catalogToSlashCommands(catalog: SkillCatalog): SlashCommandInfo[] {
	return catalog.commands.map((cmd) => ({
		name: `skill:${cmd.name}`,
		description: cmd.description,
		source: "skill" as const,
		sourceInfo: cmd.sourceInfo,
	}));
}
