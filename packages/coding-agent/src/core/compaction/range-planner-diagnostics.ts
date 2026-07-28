/**
 * Diagnostic sidecar writer for compaction planner output.
 *
 * When the one-pass range planner returns malformed output or no usable ranges,
 * this module writes a private diagnostic file next to the persisted session
 * file. The sidecar is never written for in-memory sessions.
 *
 * Additionally, successful partial recovery from length-truncated responses
 * writes a private recovery diagnostic sidecar for operational observability.
 */

import { chmodSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai/compat";

/** Failure categories emitted in diagnostic sidecars. */
export type DiagnosticFailureCategory =
	| "malformed_output"
	| "no_usable_ranges"
	| "provider_error"
	| "stream_error"
	/** Length stop, no usable record, and billed reasoning tokens. */
	| "starved"
	/** Transient throttling after the retry budget, or quota/billing exhaustion. */
	| "rate_limited";

/** Recovery categories emitted in recovery diagnostic sidecars. */
export type DiagnosticRecoveryCategory = "partial_length_recovery";

/** Safe model metadata subset (no credentials, no headers). */
export interface DiagnosticModelMeta {
	provider: string;
	id: string;
	api: string;
	contextWindow: number;
	maxTokens: number;
}

/** Full diagnostic payload written as the sidecar JSON file. */
export interface CompactionDiagnostic {
	version: 1;
	timestamp: string;
	failureCategory: DiagnosticFailureCategory;
	failureMessage: string;
	rawResponse: string;
	stopReason: string | undefined;
	providerError: string | undefined;
	usage: Usage | undefined;
	/** Undefined since the planner sends no output cap. */
	requestMaxTokens: number | undefined;
	/**
	 * For `rate_limited` only: `true` when transient throttling spent the retry
	 * budget, `false` for quota/billing exhaustion returned without backoff.
	 */
	rateLimitExhausted?: boolean;
	model: DiagnosticModelMeta;
}

/** Recovery diagnostic payload written on successful partial recovery. */
export interface RecoveryDiagnostic {
	version: 1;
	timestamp: string;
	recoveryCategory: DiagnosticRecoveryCategory;
	rawResponse: string;
	stopReason: string | undefined;
	usage: Usage | undefined;
	requestMaxTokens: number | undefined;
	model: DiagnosticModelMeta;
	recoveredRangeCount: number;
}

export interface DiagnosticContext {
	/** Absolute path to the persisted session file, or undefined for in-memory sessions. */
	sessionFilePath: string | undefined;
	/** The model used for the planner request. */
	model: Model<Api>;
	/** The maxTokens value sent in the planner request; undefined when no cap is sent. */
	requestMaxTokens: number | undefined;
	/** The full assistant response message, if one was received. */
	response: AssistantMessage | undefined;
	/** The full raw text extracted from the response. */
	rawResponseText: string;
	/** The failure category. */
	failureCategory: DiagnosticFailureCategory;
	/** The user-facing failure message. */
	failureMessage: string;
	/** Only meaningful for `rate_limited`; see CompactionDiagnostic. */
	rateLimitExhausted?: boolean;
}

function buildDiagnosticPayload(ctx: DiagnosticContext): CompactionDiagnostic {
	return {
		version: 1,
		timestamp: new Date().toISOString(),
		failureCategory: ctx.failureCategory,
		failureMessage: ctx.failureMessage,
		rawResponse: ctx.rawResponseText,
		stopReason: ctx.response?.stopReason,
		providerError: ctx.response?.errorMessage,
		usage: ctx.response?.usage,
		requestMaxTokens: ctx.requestMaxTokens,
		...(ctx.rateLimitExhausted === undefined ? {} : { rateLimitExhausted: ctx.rateLimitExhausted }),
		model: {
			provider: ctx.model.provider,
			id: ctx.model.id,
			api: ctx.model.api,
			contextWindow: ctx.model.contextWindow,
			maxTokens: ctx.model.maxTokens,
		},
	};
}

/**
 * Derive the sidecar file path from a session file path and current timestamp.
 * The sidecar sits alongside the session file with a `-compaction-diagnostic-<ts>.json` suffix.
 */
export function diagnosticSidecarPath(sessionFilePath: string): string {
	const dir = dirname(sessionFilePath);
	const base = basename(sessionFilePath, ".jsonl");
	const ts = Date.now();
	return join(dir, `${base}-compaction-diagnostic-${ts}.json`);
}

/**
 * Attempt to write a diagnostic sidecar file. Returns the written path on
 * success, or undefined if the session is in-memory or writing fails.
 *
 * The file is written with mode 0o600 (owner-only read/write) on platforms
 * that support POSIX permissions.
 */
export function writeDiagnosticSidecar(ctx: DiagnosticContext): string | undefined {
	if (!ctx.sessionFilePath) return undefined;

	const payload = buildDiagnosticPayload(ctx);
	const filePath = diagnosticSidecarPath(ctx.sessionFilePath);

	try {
		writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
		try { chmodSync(filePath, 0o600); } catch { /* best-effort on non-POSIX */ }
		return filePath;
	} catch {
		return undefined;
	}
}

/**
 * Build the diagnostic payload without writing. Exported for testing.
 */
export { buildDiagnosticPayload };

/** Context for writing a recovery diagnostic sidecar. */
export interface RecoveryDiagnosticContext {
	sessionFilePath: string | undefined;
	model: Model<Api>;
	requestMaxTokens: number | undefined;
	response: AssistantMessage;
	rawResponseText: string;
	recoveryCategory: DiagnosticRecoveryCategory;
	recoveredRangeCount: number;
}

function buildRecoveryPayload(ctx: RecoveryDiagnosticContext): RecoveryDiagnostic {
	return {
		version: 1,
		timestamp: new Date().toISOString(),
		recoveryCategory: ctx.recoveryCategory,
		rawResponse: ctx.rawResponseText,
		stopReason: ctx.response.stopReason,
		usage: ctx.response.usage,
		requestMaxTokens: ctx.requestMaxTokens,
		model: {
			provider: ctx.model.provider,
			id: ctx.model.id,
			api: ctx.model.api,
			contextWindow: ctx.model.contextWindow,
			maxTokens: ctx.model.maxTokens,
		},
		recoveredRangeCount: ctx.recoveredRangeCount,
	};
}

/**
 * Write a recovery diagnostic sidecar on successful partial recovery.
 * Returns the written path on success, or undefined if write fails or session is in-memory.
 * Write failures are silently swallowed — recovery success is never affected.
 */
export function writeRecoveryDiagnosticSidecar(ctx: RecoveryDiagnosticContext): string | undefined {
	if (!ctx.sessionFilePath) return undefined;

	const payload = buildRecoveryPayload(ctx);
	const dir = dirname(ctx.sessionFilePath);
	const base = basename(ctx.sessionFilePath, ".jsonl");
	const ts = Date.now();
	const filePath = join(dir, `${base}-compaction-recovery-${ts}.json`);

	try {
		writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
		try { chmodSync(filePath, 0o600); } catch { /* best-effort on non-POSIX */ }
		return filePath;
	} catch {
		return undefined;
	}
}

export { buildRecoveryPayload };

/** Success categories emitted in success diagnostic sidecars. */
export type DiagnosticSuccessCategory = "borrowed_planner";

/**
 * Success diagnostic payload written when a *borrowed* fallback model ranked
 * the lines. The RFC requires the borrowed identity to appear in diagnostics but
 * defines no payload; this is the chosen shape, and it carries only safe data —
 * no key, headers, auth, prompt, or transcript.
 */
export interface SuccessDiagnostic {
	version: 1;
	timestamp: string;
	successCategory: DiagnosticSuccessCategory;
	/** Effective reasoning level of the successful planner request, when it had one. */
	thinkingLevel?: string;
	/** Undefined since the planner sends no output cap. */
	requestMaxTokens: number | undefined;
	model: DiagnosticModelMeta;
}

export interface SuccessDiagnosticContext {
	sessionFilePath: string | undefined;
	/** The model that actually produced the accepted ranking. */
	model: Model<Api>;
	successCategory: DiagnosticSuccessCategory;
	thinkingLevel?: string;
}

function buildSuccessPayload(ctx: SuccessDiagnosticContext): SuccessDiagnostic {
	return {
		version: 1,
		timestamp: new Date().toISOString(),
		successCategory: ctx.successCategory,
		...(ctx.thinkingLevel === undefined ? {} : { thinkingLevel: ctx.thinkingLevel }),
		requestMaxTokens: undefined,
		model: {
			provider: ctx.model.provider,
			id: ctx.model.id,
			api: ctx.model.api,
			contextWindow: ctx.model.contextWindow,
			maxTokens: ctx.model.maxTokens,
		},
	};
}

/**
 * Write a success sidecar naming the borrowed model that ranked the lines.
 *
 * Best-effort: an in-memory session or a write failure never changes compaction
 * success. The filename uses a distinct `-compaction-success-<ts>.json` suffix so
 * it cannot collide with the primary model's failure sidecar.
 */
export function writeSuccessDiagnosticSidecar(ctx: SuccessDiagnosticContext): string | undefined {
	if (!ctx.sessionFilePath) return undefined;

	const payload = buildSuccessPayload(ctx);
	const dir = dirname(ctx.sessionFilePath);
	const base = basename(ctx.sessionFilePath, ".jsonl");
	const filePath = join(dir, `${base}-compaction-success-${Date.now()}.json`);

	try {
		writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
		try { chmodSync(filePath, 0o600); } catch { /* best-effort on non-POSIX */ }
		return filePath;
	} catch {
		return undefined;
	}
}

export { buildSuccessPayload };
