import { asyncScope } from "./async-scope.ts";

/** How the messages an extension command queued ended (#6113). */
export interface CommandDeliveryOutcome {
	/**
	 * The commands answered: a message of theirs was saved to the session, or a turn one of their messages started
	 * ended. Their answer is then the newest thing in the session, even when it is not a model reply.
	 */
	answered: boolean;
	/** A message of theirs could not be delivered, or a turn one started failed, and nothing of theirs answered. */
	lost: boolean;
	/** Failures of the turns those messages started that no sender saw, so nothing has reported them yet. */
	unreported: unknown[];
}

/**
 * The messages that extension commands queue while print mode runs one prompt (#6113): their deliveries and the turns
 * those deliveries start, on the sessions the commands run in (and a session they switch to), so print mode can wait
 * for them before it prints the answer and closes the session. Nothing else is collected: a send from outside a
 * command, a background task, or another session keeps main's behaviour.
 */
export class CommandDeliveries {
	/** The sessions the commands own. Weak: a late callback must not keep a retired session alive. */
	private sessions: WeakSet<object> | undefined = new WeakSet<object>();
	private readonly pending = new Set<Promise<unknown>>();
	/** Rejections of sends: their sender reports them (an extension's send reports its own failure). */
	private readonly sendErrors = new Set<unknown>();
	private readonly turnErrors: unknown[] = [];
	private failed = false;
	private answered = false;

	/** Whether a command of this prompt runs in `session` (or was handed it after a switch). */
	owns(session: object): boolean {
		return this.sessions?.has(session) === true;
	}

	adopt(session: object): void {
		this.sessions?.add(session);
	}

	join(work: Promise<unknown>, kind: "send" | "turn"): void {
		if (this.sessions === undefined) return;
		this.pending.add(work);
		void work.then(
			() => {
				this.pending.delete(work);
				if (kind === "turn") this.noteAnswer();
			},
			(error: unknown) => {
				this.pending.delete(work);
				if (this.sessions === undefined) return;
				this.failed = true;
				if (kind === "send") this.sendErrors.add(error);
				else this.turnErrors.push(error);
			},
		);
	}

	noteAnswer(): void {
		if (this.sessions !== undefined) this.answered = true;
	}

	/**
	 * Wait until every delivery joined so far, and every turn those deliveries started, has ended, then close: a timer
	 * or task the command left running afterwards joins nothing more.
	 */
	async settle(): Promise<CommandDeliveryOutcome> {
		while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
		const outcome = {
			answered: this.answered,
			// A command that caught a failed send and answered with another one answered.
			lost: this.failed && !this.answered,
			// A turn that failed before its message was admitted fails that send with the same error, already reported.
			unreported: this.turnErrors.filter((error) => !this.sendErrors.has(error)),
		};
		this.close();
		return outcome;
	}

	/** Joins nothing more and lets go of what was joined: a late callback of the command keeps none of it. */
	close(): void {
		this.sessions = undefined;
		this.pending.clear();
		this.sendErrors.clear();
		this.turnErrors.length = 0;
	}
}

/**
 * Where a send or a turn starts: in a command's handler while it runs (`open` until the handler settles), or in a
 * message the command sent while it ran, which the turns it starts belong to.
 */
type CommandContext =
	| { readonly kind: "handler"; readonly deliveries: CommandDeliveries; open: boolean }
	| { readonly kind: "delivery"; readonly deliveries: CommandDeliveries };

/** Entered by print mode around each prompt. */
const promptScope = asyncScope<CommandDeliveries | undefined>();
/** Entered around an extension command's handler, and around each message it sends, only inside a print-mode prompt. */
const commandScope = asyncScope<CommandContext | undefined>();

/** Runs one print-mode prompt on `session` so that what its extension commands queue joins `deliveries`. */
export function collectCommandDeliveries<T>(
	deliveries: CommandDeliveries,
	session: object,
	prompt: () => Promise<T>,
): Promise<T> {
	deliveries.adopt(session);
	return promptScope.run(deliveries, prompt);
}

/**
 * Runs an extension command's handler for `session`. Inside a print-mode prompt on that session, the messages the
 * handler sends until it settles join that prompt's deliveries; anywhere else (interactive, RPC, SDK, a child session)
 * it just runs. Timers and tasks the handler leaves running keep its context, but what they send after it settled is
 * not waited for.
 */
export function runCommandHandler<T>(session: object, handler: () => Promise<T>): Promise<T> {
	const deliveries = commandScope.getStore()?.deliveries ?? promptScope.getStore();
	if (deliveries?.owns(session) !== true) return handler();
	return runOpenHandler(deliveries, handler);
}

async function runOpenHandler<T>(deliveries: CommandDeliveries, handler: () => Promise<T>): Promise<T> {
	const context: CommandContext = { kind: "handler", deliveries, open: true };
	try {
		return await commandScope.run(context, handler);
	} finally {
		context.open = false;
	}
}

/** A session a command was handed after switching to it (`withSession`): its messages are the command's too. */
export function adoptCommandSession(session: object): void {
	const context = commandScope.getStore();
	if (context?.kind === "handler" && context.open) context.deliveries.adopt(session);
}

/**
 * Sends a message of an extension command to `session` with `send`. A message its handler sends while it runs joins
 * the prompt's deliveries, and runs in its own context so the turns it starts join too; a message sent from the
 * command's context after the handler settled (or from inside a message's turn) runs outside it and is not waited for.
 */
export function joinCommandSend<T>(session: object, send: () => Promise<T>): Promise<T> {
	const context = commandScope.getStore();
	if (context === undefined) return send();
	if (context.kind !== "handler" || !context.open || !context.deliveries.owns(session))
		// Nothing it leads to, not even a command it runs, is waited for.
		return promptScope.run(undefined, () => commandScope.run(undefined, send));
	const delivery = commandScope.run({ kind: "delivery", deliveries: context.deliveries }, send);
	context.deliveries.join(delivery, "send");
	return delivery;
}

function joinable(session: object): CommandDeliveries | undefined {
	const context = commandScope.getStore();
	if (context === undefined || (context.kind === "handler" && !context.open)) return undefined;
	return context.deliveries.owns(session) ? context.deliveries : undefined;
}

/** Notes that a command's message was saved to `session`: the command answered. */
export function noteCommandAnswer(session: object): void {
	joinable(session)?.noteAnswer();
}

/** Joins a turn of `session` that a command's message started and that its delivery does not wait for. */
export function joinCommandTurn<T>(session: object, turn: Promise<T>): Promise<T> {
	joinable(session)?.join(turn, "turn");
	return turn;
}
