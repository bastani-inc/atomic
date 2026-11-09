import type { BlueprintScope } from "./errors.ts";

/** The machine a step runs on. `default` and `linux` are one platform; `macos` and `windows` are always explicit. */
export type BlueprintPlatform = "linux" | "macos" | "windows";
/** `default` and `bash` run `run` steps in bash; `powershell` does so in PowerShell on Windows only. */
export type BlueprintShell = "default" | "powershell";

export interface RunStep {
	readonly kind: "run";
	readonly name: string | undefined;
	readonly run: string;
	/** Applies to this step only. Every value is a string. */
	readonly env: Readonly<Record<string, string>>;
}

export interface UsesStep {
	readonly kind: "uses";
	readonly name: string | undefined;
	/** `github.com/<owner>/<repo>[/<subpath>]@<ref>`. */
	readonly uses: string;
	/** Every value is a string. */
	readonly with: Readonly<Record<string, string>>;
	readonly env: Readonly<Record<string, string>>;
}

export type BlueprintStep = RunStep | UsesStep;

/** A `knowledge` item: reference information for the agent, never executed. */
export interface KnowledgeItem {
	readonly name: string;
	readonly contents: string;
}

/** A workspace a root blueprint's `includes` names. */
export interface IncludedWorkspace {
	/** The `includes` entry as written. */
	readonly entry: string;
	/** The workspace directory, relative to the repository root, with `/` separators and no trailing slash. */
	readonly directory: string;
	/** The workspace blueprint file, relative to the repository root. */
	readonly file: string;
}

/** One YAML document of a blueprint file: the platforms it targets and its sections. */
export interface BlueprintDocument {
	/** The platform labels of `runs-on`, lower-cased, with `default` resolved to `linux`. */
	readonly platforms: readonly string[];
	readonly shell: BlueprintShell;
	readonly initialize: readonly BlueprintStep[];
	/** Maintenance has `run` steps only. */
	readonly maintenance: readonly RunStep[];
	readonly knowledge: readonly KnowledgeItem[];
	/** Global blueprint only. */
	readonly postBuild: readonly BlueprintStep[];
	/** Root repository blueprint only. */
	readonly includes: readonly IncludedWorkspace[];
}

export interface BlueprintWarning {
	readonly code: "clone-ignored";
	readonly blueprint: string;
	readonly message: string;
}

/** A validated blueprint file. */
export interface ParsedBlueprint {
	readonly path: string;
	readonly scope: BlueprintScope;
	readonly documents: readonly BlueprintDocument[];
	readonly warnings: readonly BlueprintWarning[];
}
