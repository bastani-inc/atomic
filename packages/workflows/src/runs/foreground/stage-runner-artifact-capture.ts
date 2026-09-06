import type { StageSessionEvent, StageSessionRuntime } from "./stage-runner-types.js";

type Message = StageSessionRuntime["messages"][number];

/** Bounded answer capture, independent of the session's compactable context. */
export class StageArtifactCapture {
	private session: StageSessionRuntime | undefined;
	private seen = new WeakSet<Message>();
	private accepted: Message[] = [];
	private provisional: Message[] | undefined;

	reset(): void {
		this.session = undefined;
		this.seen = new WeakSet();
		this.accepted = [];
		this.provisional = undefined;
	}

	beginAttempt(session: StageSessionRuntime): void {
		if (this.session === session) this.scan();
		else {
			this.session = session;
			this.rememberContext();
		}
		this.provisional = [];
	}

	settleAttempt(success: boolean): void {
		this.scan();
		if (success) this.accepted.push(...(this.provisional ?? []));
		this.provisional = undefined;
	}

	onEvent(session: StageSessionRuntime, event: StageSessionEvent): void {
		if (session !== this.session) return;
		if (event.type === "message_end") this.capture(event.message);
		// Retained context can be reconstructed with new objects by compaction.
		// Those objects are context, not newly produced answers.
		if (event.type === "compaction_end") this.rememberContext();
	}

	messages(): Message[] {
		this.scan();
		return this.accepted;
	}

	private rememberContext(): void {
		for (const message of this.session?.messages ?? []) this.seen.add(message);
	}

	private scan(): void {
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
