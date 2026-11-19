import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@bastani/atomic-ai/compat";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { readSessionAccountModel } from "./session-account-model.ts";
import { sessionGenerationClosing, sessionLifetime } from "./session-lifecycle-work.ts";

interface FirstPromptSelection {
	id: string;
	original: Model<Api>;
	fallbackMessage: string;
	caller?: AbortSignal;
	thinking?: ThinkingLevel;
	print: boolean;
	ready: boolean;
	controller?: AbortController;
	pending?: Promise<string | undefined>;
}

// A cold session owns its one attempt. Working sessions need neither an entry nor a promise.
let selections: WeakMap<object, FirstPromptSelection> | undefined;

export function deferFirstPromptModel(session: object, selection: FirstPromptSelection): void {
	selections ??= new WeakMap();
	selections.set(session, selection);
}

/** A print host binds extensions only after checking its fatal startup diagnostics. */
export function hasPrintModelSelection(session: object): boolean {
	return selections?.get(session)?.print === true;
}

export function enablePrintModelSelection(session: object): void {
	const selection = selections?.get(session);
	if (selection?.print) selection.ready = true;
}

export function cancelFirstPromptModel(session: object): void {
	const selection = selections?.get(session);
	if (!selection) return;
	selections!.delete(session);
	selection.controller?.abort();
}

export function selectFirstPromptModel(session: AgentSession): Promise<string | undefined> | undefined {
	const selection = selections?.get(session);
	if (!selection?.ready) return;
	if (selection.pending) return selection.pending;
	if (session.model !== selection.original) {
		selections!.delete(session);
		return;
	}
	const controller = new AbortController();
	selection.controller = controller;
	selection.pending = resolveFirstModel(session, selection, controller.signal);
	return selection.pending;
}

async function resolveFirstModel(
	session: AgentSession,
	selection: FirstPromptSelection,
	owner: AbortSignal,
): Promise<string | undefined> {
	try {
		const ownsSelection = () =>
			!session._disposed && !sessionGenerationClosing.has(session) && session.model === selection.original;
		let signal = owner;
		let model: Model<Api> | null | undefined;
		try {
			const lifetime = sessionLifetime(session);
			signal = AbortSignal.any(selection.caller ? [lifetime, owner, selection.caller] : [lifetime, owner]);
			model = await session._modelRuntime[readSessionAccountModel](
				selection.id,
				signal,
				() =>
					ownsSelection() &&
					!session._resourceLoader
						.getExtensions()
						.runtime.pendingProviderRegistrations.some(
							(registration) =>
								("provider" in registration ? registration.provider.id : registration.name) ===
								"github-copilot",
						),
			);
		} catch {
			// The optional lookup could not establish a current source. Keep the existing local failure.
			model = undefined;
		}
		if (!ownsSelection()) return;
		if (model && !signal.aborted) {
			const level =
				selection.thinking ??
				session.settingsManager.getModelThinkingLevel(model.provider, model.id) ??
				session.settingsManager.getDefaultThinkingLevel() ??
				DEFAULT_THINKING_LEVEL;
			session.agent.state.model = model;
			session.agent.state.thinkingLevel = clampThinkingLevel(model, level);
			session._refreshBaseSystemPromptFromActiveTools();
			return;
		}
		const advice =
			model === null && !signal.aborted
				? `The GitHub Copilot account model list does not offer ${selection.id}. Choose another model with /model.`
				: undefined;
		// SDK prompts keep their ordinary fallback chain; print used to report the startup diagnostic directly.
		if (selection.print) throw new Error(advice ?? selection.fallbackMessage);
		return advice;
	} finally {
		selections!.delete(session);
	}
}
