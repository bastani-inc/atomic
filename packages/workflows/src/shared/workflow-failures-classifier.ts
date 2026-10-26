import type {
	RunFailureClassification,
	WorkflowFailureCode,
	WorkflowFailureDisposition,
	WorkflowFailureKind,
	WorkflowFailureRecoverability,
} from "./store-types.js";
import type { WorkflowFailure } from "./workflow-failures-contract.js";
import {
	authDecision,
	BROAD_AUTH_MESSAGE_REFINEMENT_CODES,
	cancelledDecision,
	canUseLoginClassificationBeforeWrapper401,
	canUseRelatedClassificationBeforeStatus,
	classificationForDecision,
	classificationFromNormalizedCode,
	classifyFallbackProviderAuthMessage,
	decisionFromMessageTokens,
	decisionFromStatus,
	fallbackDecisionFromMessage,
	isClearLocalLoginMessage,
	isRecoverableActiveBlocked,
	providerUnavailableDecision,
	rateLimitDecision,
	STATUS_MESSAGE_REFINEMENT_CODES,
	strongDecisionFromNormalizedCode,
	terminalProviderConfigDecision,
	unknownDecision,
} from "./workflow-failures-decisions.js";
import {
	causeOf,
	codeEvidenceFrom,
	diagnosticErrors,
	errorMessage,
	errorName,
	field,
	hasProcessFailureEvidence,
	nestedProviderError,
	normalizeCode,
	redactSensitiveText,
	selectProcessFailureError,
	structuredSignal,
	tokenize,
	type WorkflowFailureClassification,
	type WorkflowFailureClassificationSource,
	type WorkflowFailureDecision,
} from "./workflow-failures-signals.js";

/**
 * Classifications fixed when an error was made: a wrapper whose message names workflows or stages is
 * classified as the failure it wraps, and never by its own text (#4031).
 */
const preclassified = new WeakMap<object, WorkflowFailureDecision>();

function decisionOfFailure(failure: WorkflowFailure): WorkflowFailureDecision {
	return {
		kind: failure.kind,
		code: failure.code ?? "unknown",
		retryable: failure.retryable,
		resumable: failure.resumable,
		recoverability: failure.recoverability,
		disposition: failure.disposition,
		// Only a decision's own user message, such as login advice; the wrapper keeps its text otherwise.
		...(failure.userMessage !== redactSensitiveText(failure.message) ? { userMessage: failure.userMessage } : {}),
		...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
	};
}

/** The usual decision for a recorded failure code; `unknown` and codes without one fall back to the kind. */
function decisionOfRecordedCode(
	code: WorkflowFailureCode,
	retryAfterMs: number | undefined,
): WorkflowFailureDecision | undefined {
	switch (code) {
		case "login_required":
		case "auth_timeout":
		case "missing_api_key":
		case "invalid_api_key":
			return authDecision(code);
		case "rate_limited":
		case "quota_limited":
			return rateLimitDecision(code, retryAfterMs);
		case "provider_unavailable":
			return providerUnavailableDecision(retryAfterMs);
		case "forbidden_config":
		case "unknown_model":
			return terminalProviderConfigDecision(code);
		case "cancelled":
			return cancelledDecision();
		case "pending_stage_delivery_failed":
			return strongDecisionFromNormalizedCode(code, retryAfterMs);
		case "unknown":
			return undefined;
	}
}

/**
 * The decision a recorded run or stage classification stands for: every field it recorded, and for the
 * rest the usual decision for its code, else for its kind.
 */
function decisionOfRecorded(recorded: RecordedFailure): WorkflowFailureDecision {
	const code = recorded.code;
	const canonical =
		(code === undefined ? undefined : decisionOfRecordedCode(code, recorded.retryAfterMs)) ??
		strongDecisionFromNormalizedCode(recorded.kind, recorded.retryAfterMs);
	// Every recorded field wins over the derived one; only what the failure did not record is derived.
	return {
		...(canonical ?? unknownDecision()),
		kind: recorded.kind,
		...(code !== undefined ? { code } : {}),
		...(recorded.recoverability !== undefined ? { recoverability: recorded.recoverability } : {}),
		...(recorded.disposition !== undefined ? { disposition: recorded.disposition } : {}),
		...(recorded.retryAfterMs !== undefined ? { retryAfterMs: recorded.retryAfterMs } : {}),
		...(recorded.retryable !== undefined ? { retryable: recorded.retryable } : {}),
		...(recorded.resumable !== undefined ? { resumable: recorded.resumable } : {}),
	};
}

/** A recorded failure, before or after its retry and resume flags were derived. */
type RecordedFailure = Omit<RunFailureClassification, "retryable" | "resumable"> &
	Partial<Pick<RunFailureClassification, "retryable" | "resumable">>;

/** A run's recorded failure as a full classification, with the retry and resume flags its code or kind implies. */
export function runFailureClassification(recorded: RecordedFailure): RunFailureClassification {
	const decision = decisionOfRecorded(recorded);
	return { ...recorded, retryable: decision.retryable, resumable: decision.resumable };
}

/**
 * Classify `error` as `source` classifies: by the failure's own codes and the text its failing component
 * produced, so names and identifiers in `error`'s message never decide it. Returns `error`.
 */
export function classifyFailureFrom<T extends object>(error: T, source: unknown): T {
	preclassified.set(error, decisionOfFailure(classifyWorkflowFailure(source)));
	return error;
}

/** Classify `error` as a failure a run or stage already recorded. Returns `error`. */
export function classifyFailureAsRecorded<T extends object>(error: T, recorded: RunFailureClassification): T {
	preclassified.set(error, decisionOfRecorded(recorded));
	return error;
}

function makeWorkflowFailure(
	kind: WorkflowFailureKind,
	message: string,
	opts: {
		readonly retryable: boolean;
		readonly resumable: boolean;
		readonly recoverability: WorkflowFailureRecoverability;
		readonly disposition: WorkflowFailureDisposition;
		readonly cause: unknown;
		readonly code?: WorkflowFailureCode;
		readonly retryAfterMs?: number;
		readonly userMessage?: string;
	},
): WorkflowFailure {
	return {
		kind,
		...(opts.code !== undefined ? { code: opts.code } : {}),
		message,
		userMessage: opts.userMessage ?? redactSensitiveText(message),
		retryable: opts.retryable,
		resumable: opts.resumable,
		recoverability: opts.recoverability,
		disposition: opts.disposition,
		...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
		cause: opts.cause,
	};
}

function aggregateErrorItems(error: unknown): readonly unknown[] {
	const nativeErrors = error instanceof AggregateError ? (error.errors as unknown) : undefined;
	const errors = nativeErrors ?? field(error, "errors");
	return Array.isArray(errors) ? errors : [];
}

function fallbackAggregateClassification(innerError: unknown): WorkflowFailureClassification {
	const message = errorMessage(innerError);
	const fallback = fallbackDecisionFromMessage(message, errorName(innerError));
	return classificationForDecision(fallback ?? unknownDecision(), "aggregate", message);
}

function recoverableBlockedClassification(
	classifications: readonly WorkflowFailureClassification[],
): WorkflowFailureClassification {
	return (
		classifications.find((classification) => classification.decision.retryAfterMs !== undefined) ??
		classifications[0]!
	);
}

function aggregateClassification(error: unknown, seen: Set<unknown>): WorkflowFailureClassification | undefined {
	const innerErrors = aggregateErrorItems(error);
	if (innerErrors.length === 0) return undefined;

	const classifications = innerErrors.map((innerError) => {
		const branchSeen = new Set(seen);
		return (
			structuredClassification(innerError, "aggregate", branchSeen) ?? fallbackAggregateClassification(innerError)
		);
	});

	const terminalKilled = classifications.find(
		(classification) => classification.decision.disposition === "terminal_killed",
	);
	if (terminalKilled !== undefined) return terminalKilled;

	const allRecoverableBlocked = classifications.every(isRecoverableActiveBlocked);
	if (allRecoverableBlocked) return recoverableBlockedClassification(classifications);

	return classificationForDecision(unknownDecision(), "aggregate", errorMessage(error));
}

function selectDiagnosticFailureClassification(
	diagnostics: readonly unknown[],
	seen: ReadonlySet<unknown>,
): WorkflowFailureClassification | undefined {
	const classifications: WorkflowFailureClassification[] = [];
	for (const diagnosticError of diagnostics) {
		const diagnosticSeen = new Set(seen);
		const diagnosticClassification = structuredClassification(diagnosticError, "diagnostic", diagnosticSeen);
		if (diagnosticClassification !== undefined) classifications.push(diagnosticClassification);
	}
	if (classifications.length === 0) return undefined;

	const terminalKilled = classifications.find(
		(classification) => classification.decision.disposition === "terminal_killed",
	);
	if (terminalKilled !== undefined) return terminalKilled;

	const terminalFailed = classifications.find(
		(classification) => classification.decision.disposition === "terminal_failed",
	);
	if (terminalFailed !== undefined) return terminalFailed;

	const allRecoverableBlocked = classifications.every(isRecoverableActiveBlocked);
	if (allRecoverableBlocked) return recoverableBlockedClassification(classifications);

	return classifications[0]!;
}

function relatedStructuredClassification(
	error: unknown,
	seen: Set<unknown>,
): WorkflowFailureClassification | undefined {
	const diagnosticClassification = selectDiagnosticFailureClassification(diagnosticErrors(error), seen);
	if (diagnosticClassification !== undefined) return diagnosticClassification;

	const nested = nestedProviderError(error);
	if (nested !== undefined && nested !== error) {
		const nestedClassification = structuredClassification(nested, "nested", seen);
		if (nestedClassification !== undefined) return nestedClassification;
	}

	const causeClassification = structuredClassification(causeOf(error), "cause", seen);
	if (causeClassification !== undefined) return causeClassification;

	return aggregateClassification(error, seen);
}

function structuredClassification(
	error: unknown,
	source: WorkflowFailureClassificationSource = "top_level",
	seen = new Set<unknown>(),
): WorkflowFailureClassification | undefined {
	if (error === undefined || error === null || seen.has(error)) return undefined;
	if (typeof error === "object") seen.add(error);
	const fixed = typeof error === "object" ? preclassified.get(error) : undefined;
	if (fixed !== undefined) return classificationForDecision(fixed, source, undefined, "strong_signal");

	const signal = structuredSignal(error);
	const signalMessage = signal.message ?? (typeof error === "string" ? error : undefined);
	if (signal.stopReason?.toLowerCase() === "aborted") {
		return classificationForDecision(cancelledDecision(), source, signalMessage, "strong_signal");
	}

	const retryAfterMs = signal.retryAfterMs;
	let weakClassification: WorkflowFailureClassification | undefined;

	const codeEvidence = codeEvidenceFrom(signal.code);
	if (codeEvidence?.kind === "semantic_code") {
		const codeClassification = classificationFromNormalizedCode(
			codeEvidence.normalized,
			retryAfterMs,
			source,
			signalMessage,
		);
		if (codeClassification.strong !== undefined) return codeClassification.strong;
		weakClassification = codeClassification.weak ?? weakClassification;
	}

	const nameClassification = classificationFromNormalizedCode(
		normalizeCode(signal.name),
		retryAfterMs,
		source,
		signalMessage,
	);
	if (nameClassification.strong !== undefined) return nameClassification.strong;
	weakClassification = nameClassification.weak ?? weakClassification;

	const messageTokens = signalMessage !== undefined ? tokenize(signalMessage) : undefined;
	const messageDecision =
		messageTokens !== undefined ? decisionFromMessageTokens(messageTokens, signal.name, retryAfterMs) : undefined;
	const providerAuthMessageDecision =
		signalMessage !== undefined && messageTokens !== undefined
			? classifyFallbackProviderAuthMessage(signalMessage, messageTokens)
			: undefined;
	if (messageDecision?.code === "auth_timeout") {
		return classificationForDecision(messageDecision, source, signalMessage);
	}
	if (
		weakClassification !== undefined &&
		messageDecision !== undefined &&
		BROAD_AUTH_MESSAGE_REFINEMENT_CODES.has(messageDecision.code)
	) {
		return classificationForDecision(messageDecision, source, signalMessage);
	}

	const relatedClassification = relatedStructuredClassification(error, seen);
	const effectiveStatus =
		signal.status ?? (codeEvidence?.kind === "wrapper_http_status" ? codeEvidence.status : undefined);
	const statusDecision = decisionFromStatus(effectiveStatus, retryAfterMs);
	if (statusDecision !== undefined) {
		if (relatedClassification !== undefined && canUseRelatedClassificationBeforeStatus(relatedClassification)) {
			return relatedClassification;
		}
		if (
			signalMessage !== undefined &&
			(effectiveStatus === 401 || effectiveStatus === 403) &&
			messageDecision !== undefined &&
			STATUS_MESSAGE_REFINEMENT_CODES.has(messageDecision.code)
		) {
			return classificationForDecision(messageDecision, source, signalMessage);
		}
		if (effectiveStatus === 401) {
			if (canUseLoginClassificationBeforeWrapper401(relatedClassification)) {
				return relatedClassification;
			}
			if (canUseLoginClassificationBeforeWrapper401(weakClassification)) {
				return weakClassification;
			}
			if (signalMessage !== undefined && isClearLocalLoginMessage(signalMessage)) {
				return classificationForDecision(authDecision("login_required"), source, signalMessage);
			}
		}
		return classificationForDecision(statusDecision, source, signalMessage, "status");
	}

	if (source !== "top_level") {
		if (
			providerAuthMessageDecision !== undefined &&
			(messageDecision === undefined || messageDecision.code === "login_required")
		) {
			return classificationForDecision(providerAuthMessageDecision, source, signalMessage);
		}
		if (messageDecision !== undefined) {
			return classificationForDecision(messageDecision, source, signalMessage);
		}
	}

	if (relatedClassification !== undefined) return relatedClassification;

	return weakClassification;
}

function failureForDecision(decision: WorkflowFailureDecision, message: string, cause: unknown): WorkflowFailure {
	const safeMessage = redactSensitiveText(message);
	return makeWorkflowFailure(decision.kind, safeMessage, {
		code: decision.code,
		retryable: decision.retryable,
		resumable: decision.resumable,
		recoverability: decision.recoverability,
		disposition: decision.disposition,
		cause,
		...(decision.userMessage !== undefined ? { userMessage: decision.userMessage } : {}),
		...(decision.retryAfterMs !== undefined ? { retryAfterMs: decision.retryAfterMs } : {}),
	});
}

export function classifyWorkflowFailure(error: unknown): WorkflowFailure {
	const displayError = selectProcessFailureError(error);
	const message = errorMessage(displayError);
	const hasProcessFailure = displayError !== error || hasProcessFailureEvidence(error);
	const structured = structuredClassification(error);
	if (structured !== undefined && !(hasProcessFailure && structured.decision.code === "cancelled")) {
		const structuredMessage = hasProcessFailure ? message : (structured.message ?? message);
		return failureForDecision(structured.decision, structuredMessage, error);
	}

	const fallback = fallbackDecisionFromMessage(message, errorName(displayError));
	if (fallback !== undefined && !(hasProcessFailure && fallback.code === "cancelled")) {
		return failureForDecision(fallback, message, error);
	}

	return failureForDecision(unknownDecision(), message, error);
}
