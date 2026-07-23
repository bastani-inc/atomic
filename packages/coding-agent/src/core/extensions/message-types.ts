import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { CustomMessage } from "../messages.ts";
import type { CustomEntry } from "../session-manager.ts";

export type CustomMessageDelivery = "steer" | "followUp" | "nextTurn" | "interrupt";

export interface SendMessageOptions {
	triggerTurn?: boolean;
	deliverAs?: CustomMessageDelivery;
	/** Render/persist the custom message without including it in LLM context. */
	excludeFromContext?: boolean;
	/** Stable producer identity used for exactly-once workflow-stage admission. */
	stageAdmissionKey?: string;
	/**
	 * Holds an already-admitted workflow-stage delivery behind producer-specific
	 * coordination. The generation boundary tracks this promise so stage close
	 * cannot overtake the eventual queue insertion.
	 *
	 * @internal
	 */
	stageAdmissionBarrier?: () => Promise<void>;
	/**
	 * When the parent chat is streaming, persist the custom message to the
	 * transcript (visible and durable) instead of only queueing a transient
	 * steer that can be dropped when the queue is cleared or the turn aborts.
	 * Use for status notices that must not be silently lost.
	 */
	persistWhenStreaming?: boolean;

	/**
	 * Optional replacement text for generic abort tool/assistant results when
	 * `deliverAs: "interrupt"` aborts an active turn. Use this when the abort is
	 * caused by a meaningful external event and the model/user should see that
	 * event instead of a bare `Operation aborted`.
	 */
	interruptAbortMessage?: string;
}

export type SendMessagesOptions = Omit<SendMessageOptions, "deliverAs" | "interruptAbortMessage"> & {
	deliverAs?: "steer" | "followUp" | "nextTurn";
};

export interface MessageRenderOptions {
	expanded: boolean;
}

export interface EntryRenderOptions {
	expanded: boolean;
}

export type EntryRenderer<T = unknown> = (
	entry: CustomEntry<T>,
	options: EntryRenderOptions,
	theme: Theme,
) => Component | undefined;

/**
 * Custom message renderer.
 *
 * Return value semantics:
 * - `Component`: mount this component (the renderer owns its styling).
 * - `null`: the renderer handled the message but wants to render nothing —
 *   the entry occupies zero rows (no leading spacer, no default box). Use this
 *   to suppress a rehydrated entry whose backing state is gone (e.g. the
 *   workflows input form on `/resume`).
 * - `undefined`: the renderer did not handle the message; fall back to the
 *   default boxed `[customType]` rendering.
 */
export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | null | undefined;
