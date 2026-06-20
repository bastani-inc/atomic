import type {
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
  STATUS_MESSAGE_REFINEMENT_CODES,
  unknownDecision,
} from "./workflow-failures-decisions.js";
import {
  causeOf,
  codeEvidenceFrom,
  diagnosticErrors,
  errorMessage,
  errorName,
  field,
  nestedProviderError,
  normalizeCode,
  redactSensitiveText,
  structuredSignal,
  tokenize,
  type WorkflowFailureClassification,
  type WorkflowFailureClassificationSource,
  type WorkflowFailureDecision,
} from "./workflow-failures-signals.js";

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
  const nativeErrors = error instanceof AggregateError ? error.errors as unknown : undefined;
  const errors = nativeErrors ?? field(error, "errors");
  return Array.isArray(errors) ? errors : [];
}

function fallbackAggregateClassification(innerError: unknown): WorkflowFailureClassification {
  const message = errorMessage(innerError);
  const fallback = fallbackDecisionFromMessage(message, errorName(innerError));
  return classificationForDecision(fallback ?? unknownDecision(), "aggregate", message);
}

function recoverableBlockedClassification(classifications: readonly WorkflowFailureClassification[]): WorkflowFailureClassification {
  return classifications.find((classification) => classification.decision.retryAfterMs !== undefined)
    ?? classifications[0]!;
}

function aggregateClassification(error: unknown, seen: Set<unknown>): WorkflowFailureClassification | undefined {
  const innerErrors = aggregateErrorItems(error);
  if (innerErrors.length === 0) return undefined;

  const classifications = innerErrors.map((innerError) => {
    const branchSeen = new Set(seen);
    return structuredClassification(innerError, "aggregate", branchSeen) ?? fallbackAggregateClassification(innerError);
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

function relatedStructuredClassification(error: unknown, seen: Set<unknown>): WorkflowFailureClassification | undefined {
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

  const signal = structuredSignal(error);
  const signalMessage = signal.message ?? (typeof error === "string" ? error : undefined);
  if (signal.stopReason?.toLowerCase() === "aborted") {
    return classificationForDecision(cancelledDecision(), source, signalMessage, "strong_signal");
  }

  const retryAfterMs = signal.retryAfterMs;
  let weakClassification: WorkflowFailureClassification | undefined;

  const codeEvidence = codeEvidenceFrom(signal.code);
  if (codeEvidence?.kind === "semantic_code") {
    const codeClassification = classificationFromNormalizedCode(codeEvidence.normalized, retryAfterMs, source, signalMessage);
    if (codeClassification.strong !== undefined) return codeClassification.strong;
    weakClassification = codeClassification.weak ?? weakClassification;
  }

  const nameClassification = classificationFromNormalizedCode(normalizeCode(signal.name), retryAfterMs, source, signalMessage);
  if (nameClassification.strong !== undefined) return nameClassification.strong;
  weakClassification = nameClassification.weak ?? weakClassification;

  const messageTokens = signalMessage !== undefined ? tokenize(signalMessage) : undefined;
  const messageDecision = messageTokens !== undefined
    ? decisionFromMessageTokens(messageTokens, signal.name, retryAfterMs)
    : undefined;
  const providerAuthMessageDecision = signalMessage !== undefined && messageTokens !== undefined
    ? classifyFallbackProviderAuthMessage(signalMessage, messageTokens)
    : undefined;
  if (
    weakClassification !== undefined &&
    messageDecision !== undefined &&
    BROAD_AUTH_MESSAGE_REFINEMENT_CODES.has(messageDecision.code)
  ) {
    return classificationForDecision(messageDecision, source, signalMessage);
  }

  const relatedClassification = relatedStructuredClassification(error, seen);
  const effectiveStatus = signal.status ?? (codeEvidence?.kind === "wrapper_http_status" ? codeEvidence.status : undefined);
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
  const message = errorMessage(error);
  const structured = structuredClassification(error);
  if (structured !== undefined) {
    const structuredMessage = structured.message ?? message;
    return failureForDecision(structured.decision, structuredMessage, error);
  }

  const fallback = fallbackDecisionFromMessage(message, errorName(error));
  if (fallback !== undefined) return failureForDecision(fallback, message, error);

  return failureForDecision(unknownDecision(), message, error);
}
