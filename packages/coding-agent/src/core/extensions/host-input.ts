import { randomUUID } from "node:crypto";
import type { QuestionnaireResult, QuestionParams } from "../tools/ask-user-question/tool/types.js";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "./ui-types.js";

export type {
	QuestionAnswer,
	QuestionnaireError,
	QuestionnaireResult,
	QuestionParams,
} from "../tools/ask-user-question/tool/types.js";

export interface HostDiagnostic {
	level: "info" | "warning" | "error";
	source: string;
	message: string;
	sessionId: string;
}

export interface HostInputOptions {
	signal: AbortSignal;
	requestId: string;
	sessionId: string;
	timeout?: number;
	workflowRunId?: string;
	workflowStageId?: string;
}

export interface HostInput {
	confirm(title: string, message: string, options: HostInputOptions): Promise<boolean>;
	select(title: string, choices: string[], options: HostInputOptions): Promise<string | undefined>;
	input(title: string, placeholder: string | undefined, options: HostInputOptions): Promise<string | undefined>;
	editor(title: string, initial: string | undefined, options: HostInputOptions): Promise<string | undefined>;
	questionnaire(params: QuestionParams, options: HostInputOptions): Promise<QuestionnaireResult>;
}

export function hostInputError(
	code: "HumanInputUnavailable" | "HumanInputCancelled" | "InvalidHostInput" | "SessionClosed",
): Error & { code: string } {
	return Object.assign(new Error(code), { code });
}

type QuestionnairePresentation = (signal: AbortSignal) => Promise<QuestionnaireResult>;
const questionnaires = new WeakMap<
	ExtensionUIContext,
	(params: QuestionParams, signal?: AbortSignal, present?: QuestionnairePresentation) => Promise<QuestionnaireResult>
>();
export function getHostQuestionnaire(ui: ExtensionUIContext) {
	return questionnaires.get(ui);
}
export function copyHostQuestionnaire(source: ExtensionUIContext, target: ExtensionUIContext): void {
	const questionnaire = questionnaires.get(source);
	if (questionnaire) questionnaires.set(target, questionnaire);
}

// Private runner/builtin seam. Symbol identity survives the separately bundled
// workflow extension; no request minting or host adapter is exposed publicly.
const WORKFLOW_INPUT = Symbol.for("atomic-coding-agent/workflow-input@1");
type WorkflowIdentity = Pick<HostInputOptions, "workflowRunId" | "workflowStageId"> & { sessionId?: string };
/** One runner owns request settlement; host promises cannot revive a retired request. */
export class HostInputBridge {
	private adapter: HostInput | undefined;
	private configuredInput: HostInput | null | undefined;
	private bindingRevision = 0;
	private closed = false;
	private readonly pending = new Set<AbortController>();
	private readonly bindingListeners = new Set<() => void>();

	private readonly sessionId: () => string;
	private readonly signal: () => AbortSignal | undefined;
	constructor(sessionId: () => string, signal: () => AbortSignal | undefined) {
		this.sessionId = sessionId;
		this.signal = signal;
	}

	bind(adapter: HostInput | undefined, configuredInput?: HostInput | null, bindingRevision = 0): void {
		if (
			adapter !== undefined &&
			["confirm", "select", "input", "editor", "questionnaire"].some(
				(key) => typeof adapter[key as keyof HostInput] !== "function",
			)
		) {
			throw hostInputError("InvalidHostInput");
		}
		const bindingChanged = this.configuredInput !== configuredInput || this.bindingRevision !== bindingRevision;
		this.bindingRevision = bindingRevision;
		this.configuredInput = configuredInput;
		if (adapter === this.adapter && !bindingChanged) return;
		this.cancel();
		this.adapter = adapter;
		for (const listener of this.bindingListeners) queueMicrotask(listener);
	}

	get available(): boolean {
		return !this.closed && this.adapter !== undefined;
	}

	cancel(): void {
		for (const request of this.pending) request.abort();
	}

	close(): void {
		this.closed = true;
		this.cancel();
		for (const listener of this.bindingListeners) queueMicrotask(listener);
	}

	wrap(ui: ExtensionUIContext, presentationHost?: HostInput, scope: WorkflowIdentity = {}): ExtensionUIContext {
		const hostOptions = (
			host: HostInput,
			identity: HostInputOptions,
			options: ExtensionUIDialogOptions | undefined,
		): HostInputOptions =>
			host === presentationHost && options?.timeout !== undefined
				? { ...identity, timeout: options.timeout }
				: identity;
		const wrapped: ExtensionUIContext = {
			...ui,
			confirm: (title, message, options) =>
				this.request(
					(host, identity) => host.confirm(title, message, hostOptions(host, identity, options)),
					(value) => typeof value === "boolean",
					{ ...options, ...scope, sessionId: scope.sessionId },
					() => false,
				),
			select: (title, choices, options) =>
				this.request(
					(host, identity) => host.select(title, choices, hostOptions(host, identity, options)),
					(value) => value === undefined || (typeof value === "string" && choices.includes(value)),
					{ ...options, ...scope, sessionId: scope.sessionId },
					() => undefined,
				),
			input: (title, placeholder, options) =>
				this.request(
					(host, identity) => host.input(title, placeholder, hostOptions(host, identity, options)),
					validText,
					{
						...options,
						...scope,
						sessionId: scope.sessionId,
					},
					() => undefined,
				),
			editor: (title, initial, options) =>
				this.request(
					(host, identity) => host.editor(title, initial, hostOptions(host, identity, options)),
					validText,
					{
						...options,
						...scope,
						sessionId: scope.sessionId,
					},
					() => undefined,
				),
		};
		questionnaires.set(wrapped, (params, signal, present) =>
			this.request(
				(host, identity) =>
					host === presentationHost && present ? present(identity.signal) : host.questionnaire(params, identity),
				(value) => validQuestionnaire(value, params),
				{ signal, ...scope },
			),
		);
		Object.assign(wrapped, {
			[WORKFLOW_INPUT]: {
				active: () => !this.closed,
				available: () => this.available,
				bindingRevision: () => this.bindingRevision,
				subscribe: (listener: () => void) => {
					this.bindingListeners.add(listener);
					return () => this.bindingListeners.delete(listener);
				},
				scope: (workflowRunId: string, workflowStageId: string, sessionId?: string) => {
					const scoped = this.wrap(ui, presentationHost, {
						workflowRunId,
						workflowStageId,
						...(sessionId === undefined ? {} : { sessionId }),
					});
					return { ui: scoped, questionnaire: getHostQuestionnaire(scoped)! };
				},
			},
		});
		return wrapped;
	}

	private request<T>(
		invoke: (host: HostInput, identity: HostInputOptions) => Promise<T>,
		valid: (value: T) => boolean,
		options?: ExtensionUIDialogOptions & WorkflowIdentity,
		onCallerCancel?: () => T,
	): Promise<T> {
		if (this.closed) return Promise.reject(hostInputError("SessionClosed"));
		const host = this.adapter;
		if (!host) return Promise.reject(hostInputError("HumanInputUnavailable"));
		const controller = new AbortController();
		const ownerSignal = this.signal();
		let callerCancelled = false;
		const abort = () => {
			if (!controller.signal.aborted && options?.signal?.aborted) callerCancelled = true;
			controller.abort();
		};
		const cancelCaller = () => {
			if (controller.signal.aborted) return;
			callerCancelled = true;
			abort();
		};
		options?.signal?.addEventListener("abort", cancelCaller, { once: true });
		ownerSignal?.addEventListener("abort", abort, { once: true });
		this.pending.add(controller);
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (options?.timeout !== undefined) timer = setTimeout(cancelCaller, options.timeout);
		let onAbort: (() => void) | undefined;
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			options?.signal?.removeEventListener("abort", cancelCaller);
			ownerSignal?.removeEventListener("abort", abort);
			if (onAbort) controller.signal.removeEventListener("abort", onAbort);
			this.pending.delete(controller);
		};
		if (options?.signal?.aborted || ownerSignal?.aborted) {
			if (options?.signal?.aborted) cancelCaller();
			else abort();
			cleanup();
			return callerCancelled && onCallerCancel
				? Promise.resolve(onCallerCancel())
				: Promise.reject(hostInputError("HumanInputCancelled"));
		}
		let response: Promise<T>;
		try {
			response = Promise.resolve(
				invoke(host, {
					signal: controller.signal,
					requestId: randomUUID(),
					sessionId: options?.sessionId ?? this.sessionId(),
					...(options?.workflowRunId !== undefined ? { workflowRunId: options.workflowRunId } : {}),
					...(options?.workflowStageId !== undefined ? { workflowStageId: options.workflowStageId } : {}),
				}),
			);
		} catch (error) {
			cleanup();
			throw error;
		}
		const result = new Promise<T>((resolve, reject) => {
			onAbort = () => {
				if (callerCancelled && onCallerCancel) resolve(onCallerCancel());
				else reject(hostInputError("HumanInputCancelled"));
			};
			controller.signal.addEventListener("abort", onAbort, { once: true });
			if (controller.signal.aborted) onAbort();
			response.then((value) => {
				if (controller.signal.aborted) return;
				try {
					if (!valid(value)) reject(hostInputError("InvalidHostInput"));
					else resolve(value);
				} catch {
					reject(hostInputError("InvalidHostInput"));
				}
			}, reject);
		});
		return result.finally(cleanup);
	}
}

function validText(value: string | undefined): boolean {
	return value === undefined || typeof value === "string";
}

function validQuestionnaire(value: QuestionnaireResult, params: QuestionParams): boolean {
	if (!value || typeof value !== "object" || typeof value.cancelled !== "boolean" || !Array.isArray(value.answers))
		return false;
	if (
		value.error !== undefined &&
		![
			"no_ui",
			"no_questions",
			"empty_options",
			"too_many_questions",
			"duplicate_question",
			"duplicate_option_label",
			"reserved_label",
		].includes(value.error)
	)
		return false;
	const seen = new Set<number>();
	return Array.from(value.answers).every((answer) => {
		if (
			!answer ||
			typeof answer !== "object" ||
			!Number.isInteger(answer.questionIndex) ||
			seen.has(answer.questionIndex)
		)
			return false;
		seen.add(answer.questionIndex);
		const question = params.questions[answer.questionIndex];
		if (!question || answer.question !== question.question) return false;
		if (answer.answer !== null && typeof answer.answer !== "string") return false;
		if (answer.notes !== undefined && typeof answer.notes !== "string") return false;
		if (answer.preview !== undefined && typeof answer.preview !== "string") return false;
		if (
			answer.selected !== undefined &&
			(!Array.isArray(answer.selected) ||
				Array.from(answer.selected).some(
					(label) => typeof label !== "string" || !question.options.some((option) => option.label === label),
				))
		)
			return false;
		switch (answer.kind) {
			case "option":
				return !question.multiSelect && question.options.some((option) => option.label === answer.answer);
			case "multi":
				return question.multiSelect === true && answer.answer === null && Array.isArray(answer.selected);
			case "custom":
				return !question.multiSelect && !question.options.some((option) => option.preview);
			case "chat":
				return true;
			default:
				return false;
		}
	});
}
