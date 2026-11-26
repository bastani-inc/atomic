/**
 * skill:// resolution against the session's loaded skills.
 *
 * `skill://<name>` is the skill's own file (usually SKILL.md) and `skill://<name>/<path>` is a file inside the skill's
 * directory. `<name>` is a name or qualified selector exactly as the skill catalog lists it, so a bare name is the
 * precedence winner and `<name>@<qualifier>` is one specific skill. Characters that would end the name (`/`, `:`,
 * whitespace and so on) are percent-encoded.
 */
import { resolve } from "node:path";
import { isPathInside } from "../../utils/path-inside.ts";
import type { SkillCatalog } from "../skill-catalog.ts";
import type { InternalResourceRouter } from "./resource-selectors.ts";

const SKILL_SCHEME = "skill://";

/** The `skill://` URI for a skill name or selector. */
export function skillUri(name: string): string {
	const encoded = encodeURIComponent(name)
		.replace(/%40/g, "@")
		.replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
	return `${SKILL_SCHEME}${encoded}`;
}

export interface SkillUriParts {
	/** The decoded skill name or selector. */
	name: string;
	/** The path inside the skill's directory, or "" for the skill's own file. */
	subpath: string;
}

export function parseSkillUri(url: string): SkillUriParts | undefined {
	if (!url.startsWith(SKILL_SCHEME)) return undefined;
	const rest = url.slice(SKILL_SCHEME.length);
	const slash = rest.indexOf("/");
	const encoded = slash === -1 ? rest : rest.slice(0, slash);
	let name = encoded;
	try {
		name = decodeURIComponent(encoded);
	} catch {}
	return { name, subpath: slash === -1 ? "" : rest.slice(slash + 1) };
}

/**
 * Resolves `skill://` URIs to the files of the skills in `catalog`. A name the catalog does not know is left to the
 * workspace fallback; a path that leaves the skill's directory, or a selector naming several skills, is an error.
 */
export function createSkillRouter(catalog: () => SkillCatalog | undefined): InternalResourceRouter {
	return {
		resolve: (url) => {
			const parts = parseSkillUri(url);
			if (!parts) return undefined;
			const resolution = catalog()?.resolve(parts.name);
			if (!resolution) return undefined;
			if (!resolution.ok) {
				if (resolution.kind === "unknown") return undefined;
				const choices = resolution.candidates.map((candidate) => skillUri(candidate.selector)).join(", ");
				throw new Error(`${url} names more than one skill. Use one of: ${choices}`);
			}
			const { skill } = resolution.candidate;
			if (!parts.subpath) return skill.filePath;
			const target = resolve(skill.baseDir, parts.subpath);
			// Lexical only: a link the skill's author placed inside the directory is part of the skill.
			if (!isPathInside(skill.baseDir, target)) throw new Error(`${url} points outside the skill's directory`);
			return target;
		},
	};
}
