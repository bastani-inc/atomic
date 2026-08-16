import { createHash } from "node:crypto";
import { basename, dirname, sep } from "node:path";
import { canonicalizePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import type { ResourceLoader } from "./resource-loader-types.ts";
import type { Skill } from "./skills.ts";

export interface SkillCandidate {
	readonly id: string;
	readonly skill: Skill;
	readonly selector: string;
}

export interface SkillCatalogCommand {
	readonly name: string;
	readonly description: string;
	readonly sourceInfo: Skill["sourceInfo"];
	readonly candidateId: string;
	readonly skill: Skill;
}

export type SkillResolution =
	| { readonly ok: true; readonly candidate: SkillCandidate }
	| {
			readonly ok: false;
			readonly kind: "unknown" | "ambiguous";
			readonly selector: string;
			readonly message: string;
			readonly candidates: readonly SkillCandidate[];
	  };

export interface SkillCatalog {
	readonly candidates: readonly SkillCandidate[];
	readonly commands: readonly SkillCatalogCommand[];
	resolve(selector: string): SkillResolution;
	modelSkills(): Skill[];
}

type CandidateDraft = {
	id: string;
	skill: Skill;
	selector: string;
};

function candidateId(skill: Skill): string {
	return `skill_${createHash("sha256").update(canonicalizePath(skill.filePath)).digest("hex").slice(0, 20)}`;
}

function sourceFamily(skill: Skill): string {
	if (skill.sourceInfo.configurationOrigin === "bundled") return "builtin";
	if (skill.sourceInfo.scope === "project") return "project";
	if (skill.sourceInfo.scope === "user") return "user";
	return sourceLabel(skill);
}

function npmPackageName(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice(4);
	if (!spec) return undefined;
	if (spec.startsWith("@")) {
		const separator = spec.indexOf("@", spec.indexOf("/") + 1);
		return (separator === -1 ? spec : spec.slice(0, separator)).slice(1);
	}
	const separator = spec.indexOf("@");
	return separator === -1 ? spec : spec.slice(0, separator);
}

function readableToken(value: string): string {
	return value.replace(/^[./\\]+|[./\\]+$/g, "").replace(/[^a-zA-Z0-9._/\\-]+/g, "-") || "source";
}

function sourceLabel(skill: Skill): string {
	const npmName = npmPackageName(skill.sourceInfo.source);
	if (npmName) return readableToken(npmName);
	const source = skill.sourceInfo.source;
	if (source.startsWith("git:")) {
		const withoutRef = source.slice(4).split(/[?#]/, 1)[0] ?? source.slice(4);
		const parts = withoutRef
			.replace(/\.git$/, "")
			.split(/[/:\\]/)
			.filter(Boolean);
		return readableToken(parts.slice(-2).join("/"));
	}
	if (source !== "local" && source !== "auto" && source !== "path") {
		return readableToken(basename(source));
	}
	const pathParts = canonicalizePath(skill.filePath).split(sep).filter(Boolean);
	const configPart = [...pathParts]
		.reverse()
		.find((part) => part === ".atomic" || part === ".pi" || part === ".agents");
	return configPart
		? configPart.slice(1)
		: readableToken(basename(skill.sourceInfo.baseDir ?? dirname(skill.filePath)));
}

function uniquePathLabels(candidates: readonly CandidateDraft[]): Map<string, string> {
	const labels = new Map(candidates.map((candidate) => [candidate.id, sourceLabel(candidate.skill)]));
	const byLabel = new Map<string, CandidateDraft[]>();
	for (const candidate of candidates) {
		const label = labels.get(candidate.id) ?? "source";
		const matching = byLabel.get(label) ?? [];
		matching.push(candidate);
		byLabel.set(label, matching);
	}
	for (const [label, matching] of byLabel) {
		if (matching.length === 1) continue;
		const pathParts = matching.map((candidate) =>
			canonicalizePath(dirname(candidate.skill.filePath)).split(sep).filter(Boolean),
		);
		for (let depth = 1; depth <= Math.max(...pathParts.map((parts) => parts.length)); depth++) {
			const suffixes = pathParts.map((parts) => parts.slice(-depth).join("/"));
			if (new Set(suffixes).size !== suffixes.length) continue;
			for (let index = 0; index < matching.length; index++) {
				const candidate = matching[index];
				const suffix = suffixes[index];
				if (candidate && suffix) labels.set(candidate.id, readableToken(suffix));
			}
			break;
		}
		if (matching.some((candidate) => labels.get(candidate.id) === label)) {
			for (const candidate of matching) {
				labels.set(candidate.id, readableToken(`${sourceFamily(candidate.skill)}-${candidate.id.slice(-8)}`));
			}
		}
	}
	return labels;
}

function buildQualifiedSelectors(group: readonly CandidateDraft[]): {
	selectors: Map<string, string>;
	ambiguousAliases: Map<string, CandidateDraft[]>;
} {
	const byFamily = new Map<string, CandidateDraft[]>();
	for (const candidate of group) {
		const family = sourceFamily(candidate.skill);
		const familyCandidates = byFamily.get(family) ?? [];
		familyCandidates.push(candidate);
		byFamily.set(family, familyCandidates);
	}
	const qualifiers = new Map<string, string>();
	const ambiguousAliases = new Map<string, CandidateDraft[]>();
	for (const [family, familyCandidates] of byFamily) {
		if (familyCandidates.length === 1) {
			const candidate = familyCandidates[0];
			if (candidate) qualifiers.set(candidate.id, family);
			continue;
		}
		ambiguousAliases.set(family, familyCandidates);
		const labels = uniquePathLabels(familyCandidates);
		for (const candidate of familyCandidates) qualifiers.set(candidate.id, labels.get(candidate.id) ?? family);
	}
	for (const candidate of group) {
		const qualifier = qualifiers.get(candidate.id);
		if (qualifier && ambiguousAliases.has(qualifier)) {
			qualifiers.set(candidate.id, `${sourceLabel(candidate.skill)}/${qualifier}`);
		}
	}

	const byQualifier = new Map<string, CandidateDraft[]>();
	for (const candidate of group) {
		const qualifier = qualifiers.get(candidate.id) ?? sourceFamily(candidate.skill);
		const matching = byQualifier.get(qualifier) ?? [];
		matching.push(candidate);
		byQualifier.set(qualifier, matching);
	}
	for (const [qualifier, matching] of byQualifier) {
		if (matching.length === 1) continue;
		for (const candidate of matching) qualifiers.set(candidate.id, `${sourceFamily(candidate.skill)}/${qualifier}`);
	}
	return { selectors: qualifiers, ambiguousAliases };
}

export function buildSkillCatalog(allSkills: readonly Skill[], winners?: readonly Skill[]): SkillCatalog {
	const candidateSkills: Skill[] = [];
	const candidateIndexByPath = new Map<string, number>();
	for (const skill of allSkills) {
		const canonicalPath = canonicalizePath(skill.filePath);
		if (candidateIndexByPath.has(canonicalPath)) continue;
		candidateIndexByPath.set(canonicalPath, candidateSkills.length);
		candidateSkills.push(skill);
	}
	for (const winner of winners ?? []) {
		const canonicalPath = canonicalizePath(winner.filePath);
		const candidateIndex = candidateIndexByPath.get(canonicalPath);
		if (candidateIndex === undefined) {
			candidateIndexByPath.set(canonicalPath, candidateSkills.length);
			candidateSkills.push(winner);
		} else {
			candidateSkills[candidateIndex] = winner;
		}
	}
	const drafts: CandidateDraft[] = candidateSkills.map((skill) => ({
		id: candidateId(skill),
		skill,
		selector: skill.name,
	}));
	const groups = new Map<string, CandidateDraft[]>();
	for (const candidate of drafts) {
		const group = groups.get(candidate.skill.name) ?? [];
		group.push(candidate);
		groups.set(candidate.skill.name, group);
	}
	const winnerList =
		winners ??
		[...groups.values()]
			.map((group) => group[0])
			.filter(Boolean)
			.map((candidate) => candidate.skill);
	const resolutions = new Map<string, CandidateDraft[]>();
	const commands: SkillCatalogCommand[] = [];

	for (const winner of winnerList) {
		const group = groups.get(winner.name);
		if (!group?.length) continue;
		const winnerCandidate = group.find(
			(candidate) => canonicalizePath(candidate.skill.filePath) === canonicalizePath(winner.filePath),
		);
		if (!winnerCandidate) {
			throw new Error(`Skill catalog winner "${winner.name}" is not represented by a candidate`);
		}
		resolutions.set(winner.name, [winnerCandidate]);
		commands.push({
			name: winner.name,
			description: winnerCandidate.skill.description,
			sourceInfo: winnerCandidate.skill.sourceInfo,
			candidateId: winnerCandidate.id,
			skill: winnerCandidate.skill,
		});
		if (group.length === 1) continue;
		const qualified = buildQualifiedSelectors(group);
		for (const [family, candidates] of qualified.ambiguousAliases) {
			resolutions.set(`${winner.name}@${family}`, candidates);
		}
		for (const candidate of group) {
			const qualifier = qualified.selectors.get(candidate.id) ?? sourceFamily(candidate.skill);
			candidate.selector = `${candidate.skill.name}@${qualifier}`;
			resolutions.set(candidate.selector, [candidate]);
			commands.push({
				name: candidate.selector,
				description: candidate.skill.description,
				sourceInfo: candidate.skill.sourceInfo,
				candidateId: candidate.id,
				skill: candidate.skill,
			});
		}
	}

	const candidates: SkillCandidate[] = drafts;
	return {
		candidates,
		commands,
		resolve(selector: string): SkillResolution {
			const matches = resolutions.get(selector) ?? [];
			if (matches.length === 1) return { ok: true, candidate: matches[0] as SkillCandidate };
			if (matches.length > 1) {
				return {
					ok: false,
					kind: "ambiguous",
					selector,
					message: `Skill selector "${selector}" is ambiguous. Use ${matches.map((candidate) => `/skill:${candidate.selector}`).join(", ")}.`,
					candidates: matches,
				};
			}
			const name = selector.slice(0, selector.indexOf("@") === -1 ? selector.length : selector.indexOf("@"));
			const available = groups.get(name) ?? [];
			return {
				ok: false,
				kind: "unknown",
				selector,
				message:
					available.length > 0
						? `Unknown skill selector "${selector}". Available selectors: ${available.map((candidate) => `/skill:${candidate.selector}`).join(", ")}.`
						: `Unknown skill selector "${selector}".`,
				candidates: available,
			};
		},
		modelSkills(): Skill[] {
			return candidates.map((candidate) =>
				candidate.selector === candidate.skill.name
					? candidate.skill
					: { ...candidate.skill, name: candidate.selector },
			);
		},
	};
}

export function getSkillCatalog(loader: ResourceLoader): SkillCatalog {
	return loader.getSkillCatalog?.() ?? buildSkillCatalog(loader.getSkills().skills);
}

export function decorateSkillDiagnostics(
	diagnostics: readonly ResourceDiagnostic[],
	catalog: SkillCatalog,
): ResourceDiagnostic[] {
	const byPath = new Map(
		catalog.candidates.map((candidate) => [canonicalizePath(candidate.skill.filePath), candidate]),
	);
	return diagnostics.map((diagnostic) => {
		if (diagnostic.type !== "collision" || diagnostic.collision?.resourceType !== "skill") return diagnostic;
		const winner = byPath.get(canonicalizePath(diagnostic.collision.winnerPath));
		const loser = byPath.get(canonicalizePath(diagnostic.collision.loserPath));
		return {
			...diagnostic,
			collision: {
				...diagnostic.collision,
				winnerCandidateId: winner?.id,
				loserCandidateId: loser?.id,
				winnerSelector: winner?.selector,
				loserSelector: loser?.selector,
			},
		};
	});
}
