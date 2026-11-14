import { posix } from "node:path";
import { LineCounter, parseAllDocuments } from "yaml";
import { BLUEPRINT_FILE_NAME, CONFIG_DIR_NAME } from "../../../config.js";
import { BlueprintInvalidError, type BlueprintInvalidReason, type BlueprintScope } from "./errors.ts";
import type {
	BlueprintCacheEntry,
	BlueprintCacheSection,
	BlueprintDocument,
	BlueprintPlatform,
	BlueprintShell,
	BlueprintStep,
	BlueprintWarning,
	IncludedWorkspace,
	KnowledgeItem,
	ParsedBlueprint,
	RunStep,
} from "./types.ts";

type YamlValue = unknown;
type YamlMapping = { readonly [key: string]: YamlValue };

const USES_REFERENCE = /^github\.com\/([^/@\s]+)\/([^/@\s]+)(?:\/([^@\s]+))?@(\S+)$/u;

/** The rule texts Devin words itself, which a blueprint error carries verbatim. */
export const BLUEPRINT_RULES = {
	usesInMaintenance: "'uses' steps are not supported in maintenance sections",
	shell: "shell: must be 'default', 'bash', or 'powershell'",
	documentSequence: "each YAML document must be a mapping, not a sequence; use '---' to separate multiple blocks",
	documentScalar: "each YAML document must be a mapping, not a scalar; use '---' to separate multiple blocks",
} as const;

/** The blueprint `runs-on` platform that a Node.js `process.platform` value names. */
export function blueprintPlatformOf(nodePlatform: NodeJS.Platform): BlueprintPlatform {
	if (nodePlatform === "darwin") return "macos";
	if (nodePlatform === "win32") return "windows";
	return "linux";
}

/** The platform this process runs on, as blueprint `runs-on` labels name it. */
export function hostPlatform(): BlueprintPlatform {
	return blueprintPlatformOf(process.platform);
}

/** The document of `blueprint` that targets `platform`, if any. Other documents are never run or surfaced. */
export function selectDocument(
	blueprint: ParsedBlueprint,
	platform: BlueprintPlatform = hostPlatform(),
): BlueprintDocument | undefined {
	return blueprint.documents.find((document) => document.platforms.includes(platform));
}

/**
 * Parses and validates a blueprint file, in Devin's schema. Throws {@link BlueprintInvalidError} for the first rule it
 * breaks. Validation covers every document, whichever platform it targets, and ignores keys it does not know.
 * `includes` is read in a repository's root blueprint only, ignored in the global one and rejected in a workspace
 * blueprint; `post-build` is accepted in the global blueprint only; `clone` is accepted and reported as ignored.
 */
export function parseBlueprint(source: string, location: { path: string; scope: BlueprintScope }): ParsedBlueprint {
	const invalid = (
		reason: BlueprintInvalidReason,
		rule: string,
		subject: string | null = null,
	): BlueprintInvalidError =>
		new BlueprintInvalidError({ blueprint: location.path, scope: location.scope, reason, rule, subject });
	const warnings: BlueprintWarning[] = [];
	const documents: BlueprintDocument[] = [];
	const owners = new Map<string, number>();
	const lineCounter = new LineCounter();
	for (const [index, parsed] of parseAllDocuments(source, { prettyErrors: false, lineCounter }).entries()) {
		const failure = parsed.errors[0];
		if (failure !== undefined) {
			throw new BlueprintInvalidError(
				{
					blueprint: location.path,
					scope: location.scope,
					reason: "yaml-syntax",
					rule: `YAML syntax error (${failure.code})`,
					subject: `line ${lineCounter.linePos(failure.pos[0]).line}`,
				},
				failure,
			);
		}
		let value: YamlValue;
		try {
			value = parsed.toJS();
		} catch (error) {
			throw new BlueprintInvalidError(
				{
					blueprint: location.path,
					scope: location.scope,
					reason: "yaml-syntax",
					rule: "YAML cannot be read: it has too many aliases",
					subject: `document ${index + 1}`,
				},
				error as Error,
			);
		}
		if (value === null || value === undefined) continue;
		if (Array.isArray(value))
			throw invalid("not-a-mapping", BLUEPRINT_RULES.documentSequence, `document ${index + 1}`);
		if (typeof value !== "object")
			throw invalid("not-a-mapping", BLUEPRINT_RULES.documentScalar, `document ${index + 1}`);
		const document = readDocument(value as YamlMapping, location.scope, invalid, (message) =>
			warnings.push({ code: "clone-ignored", blueprint: location.path, message }),
		);
		for (const platform of document.platforms) {
			if (owners.has(platform)) {
				throw invalid(
					"duplicate-platform",
					"two YAML documents cannot resolve to the same platform; this includes the 'default' and 'linux' aliases",
					platform,
				);
			}
			owners.set(platform, index);
		}
		documents.push(document);
	}
	return { path: location.path, scope: location.scope, documents, warnings };
}

type Invalid = (reason: BlueprintInvalidReason, rule: string, subject?: string | null) => BlueprintInvalidError;

function readDocument(
	mapping: YamlMapping,
	scope: BlueprintScope,
	invalid: Invalid,
	warnClone: (message: string) => void,
): BlueprintDocument {
	if (scope !== "global" && "post-build" in mapping) {
		throw invalid("post-build-not-global", "'post-build' is only supported in the global blueprint", "post-build");
	}
	if (scope === "workspace" && "includes" in mapping) {
		throw invalid("nested-includes", "'includes' is not allowed in an included workspace blueprint", "includes");
	}
	if ("clone" in mapping) {
		warnClone("'clone' is ignored: a resume restores the recorded tree instead of cloning the repository");
	}
	const cache = readCache(mapping.cache);
	return {
		platforms: readPlatforms(mapping["runs-on"], invalid),
		shell: readShell(mapping.shell, invalid),
		initialize: readSteps(mapping.initialize, "initialize", invalid),
		maintenance: readMaintenance(mapping.maintenance, invalid),
		knowledge: readKnowledge(mapping.knowledge, invalid),
		postBuild: readSteps(mapping["post-build"], "post-build", invalid),
		includes: scope === "repository" ? readIncludes(mapping.includes, invalid) : [],
		...(cache === undefined ? {} : { cache }),
	};
}

function isMapping(value: YamlValue): value is YamlMapping {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: YamlValue): value is string | number | boolean {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** A YAML value as the string a process receives: scalars as written, `null` as empty, collections as JSON. */
function stringified(value: YamlValue): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (isScalar(value)) return String(value);
	return JSON.stringify(value);
}

function readPlatforms(value: YamlValue, invalid: Invalid): string[] {
	const labels = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
	if (labels.length === 0) return ["linux"];
	const platforms = new Set<string>();
	for (const label of labels) {
		if (typeof label !== "string")
			throw invalid("invalid-field", "'runs-on' must be a string or a list of strings", "runs-on");
		const lowered = label.trim().toLowerCase();
		platforms.add(lowered === "default" ? "linux" : lowered);
	}
	return [...platforms];
}

function readShell(value: YamlValue, invalid: Invalid): BlueprintShell {
	if (value === undefined || value === null) return "default";
	const lowered = typeof value === "string" ? value.trim().toLowerCase() : undefined;
	if (lowered === "default" || lowered === "bash") return "default";
	if (lowered === "powershell") return "powershell";
	throw invalid("invalid-shell", BLUEPRINT_RULES.shell, "shell");
}

function readStringMap(value: YamlValue, subject: string, invalid: Invalid): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (!isMapping(value)) throw invalid("invalid-field", `'${subject.split(".").pop()}' must be a mapping`, subject);
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stringified(entry)]));
}

function readName(value: YamlValue, subject: string, invalid: Invalid): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isScalar(value)) throw invalid("invalid-field", "'name' must be a string", subject);
	return String(value);
}

function readRunText(value: YamlValue, subject: string, invalid: Invalid): string {
	if (!isScalar(value)) throw invalid("invalid-field", "'run' must be a string", subject);
	return String(value);
}

function readStep(value: YamlValue, section: string, subject: string, invalid: Invalid): BlueprintStep {
	if (typeof value === "string") return { kind: "run", name: undefined, run: value, env: {} };
	if (!isMapping(value)) throw invalid("invalid-field", "a step must be a string or a mapping", subject);
	const hasUses = "uses" in value;
	const hasRun = "run" in value;
	if (hasUses && section === "maintenance") {
		throw invalid("uses-in-maintenance", BLUEPRINT_RULES.usesInMaintenance, subject);
	}
	if (hasUses && hasRun) throw invalid("run-and-uses", "a step must define 'run' or 'uses', but not both", subject);
	if (!hasUses && !hasRun) throw invalid("missing-run-or-uses", "a step must define 'run' or 'uses'", subject);
	const name = readName(value.name, subject, invalid);
	const env = readStringMap(value.env, `${subject}.env`, invalid);
	if (hasRun) {
		if ("with" in value) throw invalid("with-without-uses", "'with' is only valid on 'uses' steps", subject);
		return { kind: "run", name, run: readRunText(value.run, subject, invalid), env };
	}
	const uses = value.uses;
	if (typeof uses !== "string" || !USES_REFERENCE.test(uses.trim())) {
		throw invalid(
			"invalid-uses-reference",
			"'uses' must be github.com/<owner>/<repo>[/<subpath>]@<ref>; the 'github.com/' prefix and the '@<ref>' suffix are required",
			subject,
		);
	}
	return { kind: "uses", name, uses: uses.trim(), with: readStringMap(value.with, `${subject}.with`, invalid), env };
}

function readSteps(value: YamlValue, section: string, invalid: Invalid): BlueprintStep[] {
	if (value === undefined || value === null) return [];
	if (typeof value === "string") return [{ kind: "run", name: undefined, run: value, env: {} }];
	const entries = Array.isArray(value) ? value : [value];
	return entries.map((entry, index) =>
		readStep(entry, section, Array.isArray(value) ? `${section}[${index}]` : section, invalid),
	);
}

function readMaintenance(value: YamlValue, invalid: Invalid): RunStep[] {
	return readSteps(value, "maintenance", invalid).map((step) => step as RunStep);
}

function readKnowledge(value: YamlValue, invalid: Invalid): KnowledgeItem[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value))
		throw invalid("invalid-field", "'knowledge' must be a list of { name, contents } items", "knowledge");
	return value.map((item, index) => {
		if (!isMapping(item)) {
			throw invalid("invalid-field", "a knowledge item must be { name, contents }", `knowledge[${index}]`);
		}
		return { name: stringified(item.name), contents: stringified(item.contents) };
	});
}

/** A path whose text a cache path or key file may not contain: control characters such as a newline. */
const CONTROL_CHARACTER = /\p{Cc}/u;
/**
 * Characters a cache action reads as a glob or an exclusion (`!`), which could match paths the credential checks never
 * saw, such as `~/.ss[h]`. A cache path is a plain path.
 */
const GLOB_CHARACTER = /[*?[\]{}]|^\s*!/u;

/**
 * Reads the Atomic-only `cache:` section leniently: an invalid entry, or a section that is not a list, is left out with
 * a message and never fails the blueprint, so a resume never depends on it.
 */
function readCache(value: YamlValue): BlueprintCacheSection | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) {
		return { entries: [], ignored: ["'cache' must be a list of paths or { path, kind, key-files } items; ignored"] };
	}
	const entries: BlueprintCacheEntry[] = [];
	const ignored: string[] = [];
	for (const [index, item] of value.entries()) {
		const read = readCacheEntry(item);
		if (typeof read === "string") ignored.push(`cache[${index}]: ${read}; entry ignored`);
		else entries.push(read);
	}
	return { entries, ignored };
}

function readCacheEntry(item: YamlValue): BlueprintCacheEntry | string {
	const mapping: YamlMapping | undefined =
		typeof item === "string" ? { path: item } : isMapping(item) ? item : undefined;
	if (mapping === undefined) return "an entry must be a path or a { path, kind, key-files } mapping";
	const path = mapping.path;
	if (typeof path !== "string" || path.trim() === "" || CONTROL_CHARACTER.test(path)) {
		return "'path' must be a non-empty single-line string";
	}
	if (GLOB_CHARACTER.test(path)) return "'path' must be a plain path, without glob characters or a leading '!'";
	const kind = mapping.kind === undefined || mapping.kind === null ? "store" : mapping.kind;
	if (kind !== "store" && kind !== "build") return "'kind' must be 'store' or 'build'";
	const declared = mapping["key-files"];
	if (declared === undefined || declared === null) return { path: path.trim(), kind, keyFiles: undefined };
	const keyFiles = Array.isArray(declared) ? declared : [declared];
	if (keyFiles.length === 0 || !keyFiles.every(isRelativeFile)) {
		return "'key-files' must be a file or a list of files relative to the repository root, without '..'";
	}
	return { path: path.trim(), kind, keyFiles: keyFiles.map((file) => file.replaceAll("\\", "/")) };
}

function isRelativeFile(value: YamlValue): value is string {
	if (typeof value !== "string" || value === "" || CONTROL_CHARACTER.test(value)) return false;
	const segments = value.replaceAll("\\", "/").split("/");
	return !posix.isAbsolute(value.replaceAll("\\", "/")) && !/^[A-Za-z]:/.test(value) && !segments.includes("..");
}

function readIncludes(value: YamlValue, invalid: Invalid): IncludedWorkspace[] {
	if (value === undefined || value === null) return [];
	const entries = Array.isArray(value) ? value : [value];
	const workspaces: IncludedWorkspace[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (typeof entry !== "string")
			throw invalid("invalid-field", "'includes' must be a string or a list of strings", "includes");
		const normalized = entry
			.replaceAll("\\", "/")
			.split("/")
			.filter((segment) => segment !== "" && segment !== ".");
		if (normalized.includes(".."))
			throw invalid("include-parent-path", "'includes' paths cannot contain '..'", entry);
		const workspace = includedWorkspace(entry, normalized);
		if (workspace.directory === "" || seen.has(workspace.directory)) {
			throw invalid("duplicate-include", "each workspace path can appear only once in 'includes'", entry);
		}
		seen.add(workspace.directory);
		workspaces.push(workspace);
	}
	return workspaces;
}

function includedWorkspace(entry: string, segments: readonly string[]): IncludedWorkspace {
	const path = segments.join("/");
	const isBlueprintFile = segments.at(-1) === BLUEPRINT_FILE_NAME && segments.at(-2) === CONFIG_DIR_NAME;
	if (!isBlueprintFile) {
		return { entry, directory: path, file: posix.join(path, CONFIG_DIR_NAME, BLUEPRINT_FILE_NAME) };
	}
	const workspace = posix.dirname(posix.dirname(path));
	return { entry, directory: workspace === "." ? "" : workspace, file: path };
}
