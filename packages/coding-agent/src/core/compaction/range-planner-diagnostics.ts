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

import { uuidv7 } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai/compat";
import { chmodSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

/**
 * Write one private sidecar, never replacing an existing record.
 *
 * Names were previously millisecond-only, so two attempts inside the same
 * millisecond — easy to hit across overflow trims or a fast fallback walk —
 * selected the same path and the second write silently replaced the first.
 * A `uuidv7()` discriminator plus exclusive creation (`flag: "wx"`) keeps one
 * durable record per attempt. Retry on collision; every other failure stays
 * best-effort and never changes the planner outcome.
 */
function writeSidecar(sessionFilePath: string, kind: string, payload: unknown): string | undefined {
	const dir = dirname(sessionFilePath);
	const base = basename(sessionFilePath, ".jsonl");
	const timestamp = Date.now();
	const body = JSON.stringify(payload, null, 2);
	for (let attempt = 0; attempt < 4; attempt++) {
		const filePath = join(dir, `${base}-compaction-${kind}-${timestamp}-${uuidv7()}.json`);
		try {
			writeFileSync(filePath, body, { encoding: "utf-8", mode: 0o600, flag: "wx" });
			try {
				chmodSync(filePath, 0o600);
			} catch {
				/* best-effort on non-POSIX */
			}
			return filePath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "EEXIST") continue;
			return undefined;
		}
	}
	return undefined;
}

/** Failure categories emitted in diagnostic sidecars. */
export type DiagnosticFailureCategory =
	| "malformed_output"
	| "no_usable_ranges"
	| "provider_error"
	| "stream_error"
	/** Length stop, no usable record, and billed reasoning tokens. */
	| "starved"
	/** Transient throttling, whether or not a retry was actually scheduled. */
	| "rate_limited"
	/** Quota, billing, or usage-limit exhaustion; never spends backoff. */
	| "quota"
	/** The planner request itself exceeded the model's context window. */
	| "context_overflow";

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
	 * Whether a retry was actually scheduled before the final failure. It records
	 * retry activity, not the failure identity: a `rate_limited` record with retry
	 * disabled is `false`, and `quota` is always `false`.
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
	/** Retry activity for a limit failure; see CompactionDiagnostic. */
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
	// Includes a per-attempt discriminator so two attempts inside one millisecond
	// cannot select the same path; see `writeSidecar`.
	return join(dir, `${base}-compaction-diagnostic-${Date.now()}-${uuidv7()}.json`);
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

	return writeSidecar(ctx.sessionFilePath, "diagnostic", buildDiagnosticPayload(ctx));
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

	return writeSidecar(ctx.sessionFilePath, "recovery", buildRecoveryPayload(ctx));
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

	return writeSidecar(ctx.sessionFilePath, "success", buildSuccessPayload(ctx));
}

export { buildSuccessPayload };
