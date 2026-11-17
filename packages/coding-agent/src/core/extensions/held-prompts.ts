import type { ActivityReport, PromptRoute } from "../tasks/contracts.js";
import type { QuestionnaireResult, QuestionParams } from "../tools/ask-user-question/tool/types.js";
import { type HostInput, type HostInputOptions, validQuestionnaire } from "./host-input.js";
import type { ExtensionUIContext } from "./ui-types.js";

export type HeldPromptKind = "questionnaire" | "confirm" | "select" | "input" | "editor";

export interface HeldPrompt {
	readonly sessionId: string;
	readonly promptId: string;
	readonly kind: HeldPromptKind;
	readonly question: string;
	readonly title: string;
	readonly message?: string;
	readonly choices?: readonly string[];
	readonly placeholder?: string;
	readonly initial?: string;
	readonly params?: QuestionParams;
	readonly createdAt: number;
	readonly expiresAt?: number;
}

export type HeldPromptValue = boolean | string | QuestionnaireResult | undefined;

export type HeldPromptAnswer = { readonly value: HeldPromptValue };

export type HeldPromptResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

interface Entry {
	readonly prompt: HeldPrompt;
	readonly settle: (value: HeldPromptValue) => void;
	readonly cancelValue: HeldPromptValue;
}

export function routeNamesPrompt(route: PromptRoute, prompt: Pick<HeldPrompt, "sessionId" | "promptId">): boolean {
	return route.sessionId === prompt.sessionId && route.promptId === prompt.promptId;
}

export class HeldPrompts {
	private readonly bySession = new Map<string, Entry[]>();
	private readonly listeners = new Set<(sessionId: string) => void>();

	hold(
		prompt: Omit<HeldPrompt, "createdAt">,
		signal: AbortSignal,
		cancelValue: HeldPromptValue,
	): Promise<HeldPromptValue> {
		if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Held prompt aborted"));
		if (this.find(prompt) !== undefined)
			return Promise.reject(new Error(`Prompt ${prompt.promptId} is already held for session ${prompt.sessionId}`));
		return new Promise<HeldPromptValue>((resolve, reject) => {
			const held: HeldPrompt = { ...prompt, createdAt: Date.now() };
			const onAbort = (): void => {
				if (this.remove(held)) reject(signal.reason ?? new Error("Held prompt aborted"));
			};
			const entry: Entry = {
				prompt: held,
				cancelValue,
				settle: (value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
			};
			const queue = this.bySession.get(held.sessionId);
			if (queue === undefined) this.bySession.set(held.sessionId, [entry]);
			else queue.push(entry);
			signal.addEventListener("abort", onAbort, { once: true });
			this.notify(held.sessionId);
		});
	}

	current(sessionId: string): HeldPrompt | undefined {
		return this.bySession.get(sessionId)?.[0]?.prompt;
	}

	isCurrent(route: PromptRoute): boolean {
		const current = this.current(route.sessionId);
		return current !== undefined && routeNamesPrompt(route, current);
	}

	answer(route: PromptRoute, answer: HeldPromptAnswer): HeldPromptResult {
		const entry = this.bySession.get(route.sessionId)?.[0];
		if (entry === undefined || !routeNamesPrompt(route, entry.prompt))
			return { ok: false, reason: "This question was already answered or is no longer waiting." };
		const value = readValue(entry.prompt, answer.value);
		if (!value.ok) return value;
		this.remove(entry.prompt);
		entry.settle(value.value);
		return { ok: true };
	}

	cancel(route: PromptRoute): boolean {
		const entry = this.bySession.get(route.sessionId)?.[0];
		if (entry === undefined || !routeNamesPrompt(route, entry.prompt)) return false;
		this.remove(entry.prompt);
		entry.settle(entry.cancelValue);
		return true;
	}

	subscribe(listener: (sessionId: string) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private find(prompt: Pick<HeldPrompt, "sessionId" | "promptId">): Entry | undefined {
		return this.bySession.get(prompt.sessionId)?.find((entry) => routeNamesPrompt(prompt, entry.prompt));
	}

	private remove(prompt: HeldPrompt): boolean {
		const queue = this.bySession.get(prompt.sessionId);
		const index = queue?.findIndex((entry) => entry.prompt === prompt) ?? -1;
		if (queue === undefined || index < 0) return false;
		queue.splice(index, 1);
		if (queue.length === 0) this.bySession.delete(prompt.sessionId);
		this.notify(prompt.sessionId);
		return true;
	}

	private notify(sessionId: string): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(sessionId);
			} catch {}
		}
	}
}

const HELD_PROMPTS = Symbol.for("atomic-coding-agent/held-prompts@1");

export function heldPrompts(): HeldPrompts {
	const global = globalThis as { [HELD_PROMPTS]?: HeldPrompts };
	global[HELD_PROMPTS] ??= new HeldPrompts();
	return global[HELD_PROMPTS];
}

const HELD_INPUT = Symbol.for("atomic-coding-agent/held-input@1");
const TASK_PROMPT_HOST = Symbol.for("atomic-coding-agent/task-prompt-host@1");
const PRESENTATION_INPUT = Symbol.for("atomic-coding-agent/presentation-input@1");
const CHILD_PRESENTATION_INPUT = Symbol.for("atomic-coding-agent/child-presentation-input@1");

export function childPresentationInput(ui: ExtensionUIContext | undefined): HostInput | undefined {
	return (ui as (ExtensionUIContext & { [CHILD_PRESENTATION_INPUT]?: HostInput }) | undefined)?.[
		CHILD_PRESENTATION_INPUT
	];
}

export function presentationHostInput(input: HostInput): HostInput {
	return Object.assign(input, { [PRESENTATION_INPUT]: true });
}

export function isPresentationHostInput(input: HostInput | null | undefined): input is HostInput {
	return input != null && (input as HostInput & { [PRESENTATION_INPUT]?: boolean })[PRESENTATION_INPUT] === true;
}

export function taskPromptHost(ui: ExtensionUIContext): ExtensionUIContext {
	return Object.assign(ui, { [TASK_PROMPT_HOST]: true });
}

export function hasTaskPromptHost(ui: ExtensionUIContext | undefined): boolean {
	return ui !== undefined && (ui as ExtensionUIContext & { [TASK_PROMPT_HOST]?: boolean })[TASK_PROMPT_HOST] === true;
}

function holdRequest(
	prompt: Omit<HeldPrompt, "createdAt" | "sessionId" | "promptId">,
	options: HostInputOptions,
	cancelValue: HeldPromptValue,
): Promise<HeldPromptValue> {
	return heldPrompts().hold(
		{
			...prompt,
			sessionId: options.sessionId,
			promptId: options.requestId,
			...(options.timeout === undefined ? {} : { expiresAt: Date.now() + options.timeout }),
		},
		options.signal,
		cancelValue,
	);
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim() !== "") ?? text;
}

export const heldPromptInput: HostInput = Object.freeze({
	[HELD_INPUT]: true,
	confirm: (title: string, message: string, options: HostInputOptions) =>
		holdRequest(
			{ kind: "confirm", question: firstLine(title), title, message, choices: ["Yes", "No"] },
			options,
			false,
		) as Promise<boolean>,
	select: (title: string, choices: string[], options: HostInputOptions) =>
		holdRequest(
			{ kind: "select", question: firstLine(title), title, choices: [...choices] },
			options,
			undefined,
		) as Promise<string | undefined>,
	input: (title: string, placeholder: string | undefined, options: HostInputOptions) =>
		holdRequest(
			{
				kind: "input",
				question: firstLine(title),
				title,
				...(placeholder === undefined ? {} : { placeholder }),
			},
			options,
			undefined,
		) as Promise<string | undefined>,
	editor: (title: string, initial: string | undefined, options: HostInputOptions) =>
		holdRequest(
			{ kind: "editor", question: firstLine(title), title, ...(initial === undefined ? {} : { initial }) },
			options,
			undefined,
		) as Promise<string | undefined>,
	questionnaire: (params: QuestionParams, options: HostInputOptions) => {
		const first = params.questions[0];
		return holdRequest(
			{
				kind: "questionnaire",
				question: firstLine(first?.question ?? ""),
				title: first?.header ?? "",
				params,
				...(params.questions.length === 1 && first !== undefined
					? { choices: first.options.map((option) => option.label) }
					: {}),
			},
			options,
			{ answers: [], cancelled: true },
		) as Promise<QuestionnaireResult>;
	},
});

export function isHeldPromptInput(input: HostInput | null | undefined): boolean {
	return input != null && (input as { [HELD_INPUT]?: boolean })[HELD_INPUT] === true;
}

export function watchHeldPromptAttention(sessionId: string, report: (activity: ActivityReport) => void): () => void {
	const prompts = heldPrompts();
	let reported: HeldPrompt | undefined;
	const send = (activity: ActivityReport): void => {
		try {
			report(activity);
		} catch {}
	};
	const clear = (): void => {
		if (reported === undefined) return;
		const { promptId } = reported;
		reported = undefined;
		send({
			reportId: `held-prompt:${sessionId}:${promptId}:clear`,
			change: { kind: "attention-clear", requestId: promptId },
		});
	};
	const sync = (): void => {
		const current = prompts.current(sessionId);
		if (current === reported) return;
		clear();
		if (current === undefined) return;
		reported = current;
		send({
			reportId: `held-prompt:${sessionId}:${current.promptId}:set`,
			change: {
				kind: "attention-set",
				attention: {
					kind: "input-needed",
					requestId: current.promptId,
					prompt: current.question,
					route: { sessionId, promptId: current.promptId },
				},
			},
		});
	};
	const unsubscribe = prompts.subscribe((changed) => {
		if (changed === sessionId) sync();
	});
	sync();
	return () => {
		unsubscribe();
		clear();
	};
}

type ValidatedValue =
	| { readonly ok: true; readonly value: HeldPromptValue }
	| { readonly ok: false; readonly reason: string };

function readValue(prompt: HeldPrompt, value: HeldPromptValue): ValidatedValue {
	switch (prompt.kind) {
		case "confirm":
			return typeof value === "boolean" ? { ok: true, value } : { ok: false, reason: "Answer yes or no." };
		case "select":
			return typeof value === "string" && (prompt.choices ?? []).includes(value)
				? { ok: true, value }
				: {
						ok: false,
						reason: `Select one of the ${prompt.choices?.length ?? 0} choices.`,
					};
		case "input":
		case "editor":
			return typeof value === "string" ? { ok: true, value } : { ok: false, reason: "Type an answer." };
		case "questionnaire":
			return validQuestionnaireAnswer(prompt.params, value)
				? { ok: true, value }
				: { ok: false, reason: "Invalid questionnaire answer." };
	}
}

function validQuestionnaireAnswer(
	params: QuestionParams | undefined,
	value: HeldPromptValue,
): value is QuestionnaireResult {
	if (
		!value ||
		typeof value !== "object" ||
		typeof value.cancelled !== "boolean" ||
		value.cancelled ||
		value.error !== undefined ||
		!Array.isArray(value.answers)
	)
		return false;
	return params === undefined || validQuestionnaire(value, params);
}
