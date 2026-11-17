/**
 * Prompts held in the session that raised them.
 *
 * A session with no presentation of its own (an in-process subagent) that runs under an interactive launcher holds its
 * human-input prompts here: its `ask_user_question` and its extensions' confirm, select, input and editor dialogs.
 * A held prompt is never shown in another session's chat and never blocks another session's input. It is shown in
 * the asking session's own view, and the launcher's `/tasks` lists it as needing input, attributed to that session,
 * through the task's attention (`input-needed` with route `{ sessionId, promptId }`).
 *
 * An answer names the prompt it answers by route, and resolves it only while it is that session's pending prompt with
 * that id: an answer meant for an earlier prompt never reaches a later one, and a prompt is resolved at most once.
 * Navigating between views never answers or cancels a prompt; leaving a view keeps it pending, with the form as it
 * was left. A prompt ends with its asking session's request: cancelled when that session closes, never moved to
 * another session.
 */
import type { ActivityReport, PromptRoute } from "../tasks/contracts.js";
import type { QuestionnaireResult, QuestionParams } from "../tools/ask-user-question/tool/types.js";
import type { HostInput, HostInputOptions } from "./host-input.js";

export type HeldPromptKind = "questionnaire" | "confirm" | "select" | "input" | "editor";

/** What a held prompt asks: enough for a row, a peek card, an inline reply and the asking session's own view. */
export interface HeldPrompt {
	/** The session that raised it, and only it. */
	readonly sessionId: string;
	readonly promptId: string;
	readonly kind: HeldPromptKind;
	/** The question on one line: a dialog's title, or a questionnaire's first question. */
	readonly question: string;
	/** A dialog's title. */
	readonly title: string;
	/** A confirmation's message. */
	readonly message?: string;
	/** The choices a reply names, numbered from 1: a selection's, a confirmation's Yes and No, a one-question questionnaire's options. */
	readonly choices?: readonly string[];
	readonly placeholder?: string;
	/** An editor's starting text. */
	readonly initial?: string;
	readonly params?: QuestionParams;
	readonly createdAt: number;
}

/** What a held prompt resolves to: the value its asking request returns. */
export type HeldPromptValue = boolean | string | QuestionnaireResult | undefined;

/** A reply: `text` typed in a reply box (an option's number or label, yes or no, free text), or the form's own value. */
export type HeldPromptAnswer = { readonly text: string } | { readonly value: HeldPromptValue };

export type HeldPromptResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

interface Entry {
	readonly prompt: HeldPrompt;
	readonly settle: (value: HeldPromptValue) => void;
	readonly cancelValue: HeldPromptValue;
}

/** Whether `route` names `prompt`: the same asking session and the same prompt id. */
export function routeNamesPrompt(route: PromptRoute, prompt: Pick<HeldPrompt, "sessionId" | "promptId">): boolean {
	return route.sessionId === prompt.sessionId && route.promptId === prompt.promptId;
}

/** The held prompts of every session in this process, each kept by the session that raised it. */
export class HeldPrompts {
	/** Pending prompts per asking session, oldest first; the first is the one shown and answered. */
	private readonly bySession = new Map<string, Entry[]>();
	private readonly listeners = new Set<(sessionId: string) => void>();

	/**
	 * Holds `prompt` in its own session until it is answered, cancelled, or `signal` aborts (its session closed or its
	 * request was withdrawn). Resolves with the answer's value, or with `cancelValue` on Esc.
	 */
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

	/** The prompt `sessionId` waits on now: the one its view shows and its launcher's `/tasks` lists. */
	current(sessionId: string): HeldPrompt | undefined {
		return this.bySession.get(sessionId)?.[0]?.prompt;
	}

	/** Whether `route` names the prompt its session waits on now. */
	isCurrent(route: PromptRoute): boolean {
		const current = this.current(route.sessionId);
		return current !== undefined && routeNamesPrompt(route, current);
	}

	/**
	 * Answers the prompt `route` names, once, only while it is its session's current prompt. A reply's `text` is read
	 * against the prompt's kind; a reply that does not fit (an unknown choice, a several-part questionnaire) is
	 * refused with the reason and leaves the prompt pending.
	 */
	answer(route: PromptRoute, answer: HeldPromptAnswer): HeldPromptResult {
		const entry = this.bySession.get(route.sessionId)?.[0];
		if (entry === undefined || !routeNamesPrompt(route, entry.prompt))
			return { ok: false, reason: "This question was already answered or is no longer waiting." };
		const value =
			"value" in answer ? { ok: true as const, value: answer.value } : readReply(entry.prompt, answer.text);
		if (!value.ok) return value;
		this.remove(entry.prompt);
		entry.settle(value.value);
		return { ok: true };
	}

	/** Cancels the prompt `route` names (Esc in its form), once, only while it is its session's current prompt. */
	cancel(route: PromptRoute): boolean {
		const entry = this.bySession.get(route.sessionId)?.[0];
		if (entry === undefined || !routeNamesPrompt(route, entry.prompt)) return false;
		this.remove(entry.prompt);
		entry.settle(entry.cancelValue);
		return true;
	}

	/** Calls `listener` with the session whose held prompts changed. */
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
			} catch {
				// A viewer's failure never settles or loses a prompt.
			}
		}
	}
}

const HELD_PROMPTS = Symbol.for("atomic-coding-agent/held-prompts@1");

/** This process's held prompts; one set shared by every copy of the package loaded in it. */
export function heldPrompts(): HeldPrompts {
	const global = globalThis as { [HELD_PROMPTS]?: HeldPrompts };
	global[HELD_PROMPTS] ??= new HeldPrompts();
	return global[HELD_PROMPTS];
}

const HELD_INPUT = Symbol.for("atomic-coding-agent/held-input@1");

function holdRequest(
	prompt: Omit<HeldPrompt, "createdAt" | "sessionId" | "promptId">,
	options: HostInputOptions,
	cancelValue: HeldPromptValue,
): Promise<HeldPromptValue> {
	return heldPrompts().hold(
		{ ...prompt, sessionId: options.sessionId, promptId: options.requestId },
		options.signal,
		cancelValue,
	);
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim() !== "") ?? text;
}

/**
 * The input a launcher gives the sessions it launches in place of its own chat: each request is held in the session
 * that asks it, by the session id the request carries. It is never a host: a session with a presentation of its own
 * uses that instead.
 */
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
				question: first?.question ?? "",
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

/** Whether `input` is the held-prompt input, not a host's own adapter. */
export function isHeldPromptInput(input: HostInput | null | undefined): boolean {
	return input != null && (input as { [HELD_INPUT]?: boolean })[HELD_INPUT] === true;
}

/**
 * Reports the prompt `sessionId` waits on as its task's attention, for as long as the task's launcher watches: `input-needed`
 * with the prompt's route while one is held, cleared when it is answered, cancelled or withdrawn. Returns the stop,
 * which clears a prompt still reported.
 */
export function watchHeldPromptAttention(sessionId: string, report: (activity: ActivityReport) => void): () => void {
	const prompts = heldPrompts();
	let reported: HeldPrompt | undefined;
	const send = (activity: ActivityReport): void => {
		try {
			report(activity);
		} catch {
			// A task that no longer takes reports keeps the prompt held all the same.
		}
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

type ReadReply =
	| { readonly ok: true; readonly value: HeldPromptValue }
	| { readonly ok: false; readonly reason: string };

/** The choice `text` names: its number from 1, or its label. */
function choiceOf(choices: readonly string[], text: string): string | undefined {
	const trimmed = text.trim();
	if (/^\d+$/.test(trimmed)) return choices[Number(trimmed) - 1];
	return (
		choices.find((choice) => choice === trimmed) ??
		choices.find((choice) => choice.toLowerCase() === trimmed.toLowerCase())
	);
}

/** Reads a typed reply as the prompt's value. */
export function readReply(prompt: HeldPrompt, text: string): ReadReply {
	switch (prompt.kind) {
		case "input":
		case "editor":
			return { ok: true, value: text };
		case "confirm": {
			const word = text.trim().toLowerCase();
			if (["1", "y", "yes", "true"].includes(word)) return { ok: true, value: true };
			if (["2", "n", "no", "false"].includes(word)) return { ok: true, value: false };
			return { ok: false, reason: "Answer yes or no." };
		}
		case "select": {
			const choice = choiceOf(prompt.choices ?? [], text);
			return choice === undefined
				? { ok: false, reason: `Answer with one of the ${prompt.choices?.length ?? 0} choices, by number or name.` }
				: { ok: true, value: choice };
		}
		case "questionnaire":
			return readQuestionnaireReply(prompt.params, text);
	}
}

function readQuestionnaireReply(params: QuestionParams | undefined, text: string): ReadReply {
	const question = params?.questions[0];
	if (params === undefined || question === undefined || params.questions.length !== 1)
		return { ok: false, reason: "This question has several parts: open it to answer." };
	const labels = question.options.map((option) => option.label);
	if (question.multiSelect === true) {
		const picked = text.split(",").map((part) => choiceOf(labels, part));
		if (picked.length === 0 || picked.some((label) => label === undefined))
			return { ok: false, reason: "Answer with the choices' numbers or names, separated by commas." };
		const selected = [...new Set(picked as string[])];
		return {
			ok: true,
			value: {
				cancelled: false,
				answers: [{ questionIndex: 0, question: question.question, kind: "multi", answer: null, selected }],
			},
		};
	}
	const label = choiceOf(labels, text);
	if (label !== undefined) {
		const preview = question.options.find((option) => option.label === label)?.preview;
		return {
			ok: true,
			value: {
				cancelled: false,
				answers: [
					{
						questionIndex: 0,
						question: question.question,
						kind: "option",
						answer: label,
						...(preview === undefined ? {} : { preview }),
					},
				],
			},
		};
	}
	// A typed answer is allowed where the form offers "Type something.": a single choice without previews.
	if (question.options.some((option) => typeof option.preview === "string" && option.preview.length > 0))
		return { ok: false, reason: `Answer with one of the ${labels.length} choices, by number or name.` };
	if (text.trim() === "") return { ok: false, reason: "Type an answer." };
	return {
		ok: true,
		value: {
			cancelled: false,
			answers: [{ questionIndex: 0, question: question.question, kind: "custom", answer: text }],
		},
	};
}
