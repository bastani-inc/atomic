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

/** Entered by print mode around each prompt. */
const promptScope = asyncScope<CommandDeliveries>();
/** Entered around an extension command's handler, only inside a print-mode prompt. */
const commandScope = asyncScope<CommandDeliveries>();

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
 * handler queues join that prompt's deliveries; anywhere else (interactive, RPC, SDK, a child session) it just runs.
 */
export function runCommandHandler<T>(session: object, handler: () => Promise<T>): Promise<T> {
	const deliveries = commandScope.getStore() ?? promptScope.getStore();
	if (deliveries?.owns(session) !== true) return handler();
	return commandScope.run(deliveries, handler);
}

/** A session a command was handed after switching to it (`withSession`): its messages are the command's too. */
export function adoptCommandSession(session: object): void {
	commandScope.getStore()?.adopt(session);
}

/** Joins a message an extension command sends to `session`; returns the delivery unchanged. */
export function joinCommandSend<T>(session: object, delivery: Promise<T>): Promise<T> {
	const deliveries = commandScope.getStore();
	if (deliveries?.owns(session)) deliveries.join(delivery, "send");
	return delivery;
}

/** Notes that a command's message was saved to `session`: the command answered. */
export function noteCommandAnswer(session: object): void {
	const deliveries = commandScope.getStore();
	if (deliveries?.owns(session)) deliveries.noteAnswer();
}

/** Joins a turn of `session` that a command's message started and that its delivery does not wait for. */
export function joinCommandTurn<T>(session: object, turn: Promise<T>): Promise<T> {
	const deliveries = commandScope.getStore();
	if (deliveries?.owns(session)) deliveries.join(turn, "turn");
	return turn;
}
