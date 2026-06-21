export type BashCommandRule =
	| string
	| { readonly prefix: string }
	| { readonly glob: string }
	| { readonly regex: string; readonly flags?: string };

export type BashCommandPolicyDefault = "allow" | "deny";
export type BashCommandPolicyMatchMode = "whole" | "segments";

export interface BashCommandPolicy {
	readonly default?: BashCommandPolicyDefault;
	readonly allow?: readonly BashCommandRule[];
	readonly deny?: readonly BashCommandRule[];
	readonly match?: BashCommandPolicyMatchMode;
}

export type BashCommandSegmentSource = "top-level" | "command-substitution" | "process-substitution" | "backtick";

export interface BashCommandSegment {
	readonly raw: string;
	readonly target: string;
	readonly head: string;
	readonly start: number;
	readonly end: number;
	readonly source: BashCommandSegmentSource;
}

export interface BashCommandParseError {
	readonly reason: string;
	readonly offset: number;
	readonly source: BashCommandSegmentSource;
}

export type BashCommandParseResult =
	| { readonly ok: true; readonly segments: readonly BashCommandSegment[] }
	| { readonly ok: false; readonly error: BashCommandParseError };

export type BashCommandPolicyDenialReason =
	| "invalid-policy"
	| "unsupported-shell-syntax"
	| "matched-deny"
	| "default-deny";

export interface BashCommandPolicyRejection {
	readonly reason: BashCommandPolicyDenialReason;
	readonly message: string;
	readonly target?: BashCommandSegment;
	readonly matchedRule?: BashCommandRule;
	readonly parseError?: BashCommandParseError;
}

export type BashCommandPolicyDecision =
	| {
			readonly allowed: true;
			readonly mode: BashCommandPolicyMatchMode;
			readonly targets: readonly BashCommandSegment[];
	  }
	| {
			readonly allowed: false;
			readonly mode: BashCommandPolicyMatchMode;
			readonly targets: readonly BashCommandSegment[];
			readonly rejection: BashCommandPolicyRejection;
	  };

export type CompiledRule =
	| { readonly kind: "exact"; readonly source: BashCommandRule; readonly value: string }
	| { readonly kind: "prefix"; readonly source: BashCommandRule; readonly value: string }
	| { readonly kind: "glob"; readonly source: BashCommandRule; readonly value: RegExp }
	| { readonly kind: "regex"; readonly source: BashCommandRule; readonly value: RegExp };

export interface CompiledBashCommandPolicy {
	readonly defaultDecision: BashCommandPolicyDefault;
	readonly match: BashCommandPolicyMatchMode;
	readonly allow: readonly CompiledRule[];
	readonly deny: readonly CompiledRule[];
}

export type CompileResult =
	| { readonly ok: true; readonly policy: CompiledBashCommandPolicy }
	| { readonly ok: false; readonly message: string };

export type CompileRuleResult =
	| { readonly ok: true; readonly rule: CompiledRule }
	| { readonly ok: false; readonly message: string };

export type CompileRulesResult =
	| { readonly ok: true; readonly rules: readonly CompiledRule[] }
	| { readonly ok: false; readonly message: string };

export type SegmentBuildResult =
	| { readonly ok: true; readonly segment?: BashCommandSegment }
	| { readonly ok: false; readonly error: BashCommandParseError };

export type ClosingParenResult =
	| { readonly ok: true; readonly closeIndex: number }
	| { readonly ok: false; readonly reason: string; readonly offset: number };

export type ClosingBacktickResult =
	| { readonly ok: true; readonly closeIndex: number }
	| { readonly ok: false; readonly reason: string; readonly offset: number };

export type ShellQuoteState = "none" | "single" | "double";

export interface ShellWordMetadata {
	readonly sawSingleQuote: boolean;
	readonly sawDoubleQuote: boolean;
	readonly sawEscape: boolean;
	readonly sawParameterExpansion: boolean;
	readonly sawCommandSubstitution: boolean;
	readonly sawProcessSubstitution: boolean;
	readonly sawBacktick: boolean;
	readonly sawGlobPattern: boolean;
	readonly sawBraceExpansion: boolean;
	readonly sawTildePrefix: boolean;
}

export type ShellWordReadResult =
	| { readonly ok: true; readonly word: string; readonly end: number; readonly metadata: ShellWordMetadata }
	| { readonly ok: false; readonly reason: string; readonly offset: number };
