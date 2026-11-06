import type { StageSessionEvent, StageSessionRuntime } from "./stage-runner-types.js";

type Message = StageSessionRuntime["messages"][number];

/** Bounded answer capture, independent of the session's compactable context. */
export class StageArtifactCapture {
	private session: StageSessionRuntime | undefined;
	private seen = new WeakSet<Message>();
	private accepted: Message[] = [];
	private provisional: Message[] | undefined;
	private receivesMessageEvents = false;
	private closed = false;

	/** `capturesAnswers` false: the generation writes no output artifact, so nothing is kept for one. */
	reset(capturesAnswers = true): void {
		this.session = undefined;
		this.seen = new WeakSet();
		this.accepted = [];
		this.provisional = undefined;
		this.receivesMessageEvents = false;
		this.closed = !capturesAnswers;
	}

	/** The session was released: keep the answers captured so far, and nothing of the session itself. */
	releaseSession(): void {
		this.scan();
		this.session = undefined;
		this.seen = new WeakSet();
		this.receivesMessageEvents = false;
	}

	beginAttempt(session: StageSessionRuntime): void {
		if (this.closed) return;
		if (this.session === session) this.scan();
		else {
			this.session = session;
			this.receivesMessageEvents = false;
			this.rememberContext();
		}
		this.provisional = [];
	}

	settleAttempt(success: boolean): void {
		if (this.closed) return;
		this.scan();
		if (success) this.accepted.push(...(this.provisional ?? []));
		this.provisional = undefined;
	}

	/** The answer a durably resumed stage finished its call with from the transcript, as this generation's (#4375). */
	adoptAnswer(message: Message): void {
		if (!this.closed) this.capture(message);
	}

	close(): void {
		this.scan();
		this.closed = true;
		this.session = undefined;
		this.seen = new WeakSet();
		this.provisional = undefined;
	}

	onEvent(session: StageSessionRuntime, event: StageSessionEvent): void {
		if (session !== this.session) return;
		if (event.type === "message_end") {
			this.receivesMessageEvents = true;
			this.capture(event.message);
		}
		// Retained context can be reconstructed with new objects by compaction.
		// Those objects are context, not newly produced answers.
		if (event.type === "compaction_end") this.rememberContext();
	}

	messages(): Message[] {
		this.scan();
		return this.accepted;
	}

	rememberContext(session = this.session): void {
		if (session !== this.session) return;
		for (const message of this.session?.messages ?? []) this.seen.add(message);
	}

	private scan(): void {
		// Message events are authoritative when available: navigation can restore
		// unseen historical messages without producing any new answer.
		if (this.receivesMessageEvents) return;
		// Deterministic adapters may expose messages without emitting events.
		for (const message of this.session?.messages ?? []) this.capture(message);
	}

	private capture(message: Message): void {
		if (this.seen.has(message)) return;
		this.seen.add(message);
		if (message.role !== "assistant") return;
		if (message.stopReason !== "stop" && message.stopReason !== "length") return;
		if (message.content.some((block) => block.type === "toolCall")) return;
		// Snapshot completed content before compaction or retry can mutate it.
		(this.provisional ?? this.accepted).push(structuredClone(message));
	}
}
