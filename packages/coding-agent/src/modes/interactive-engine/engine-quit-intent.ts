import { parseEngineExplicitQuitCommand, serializeInteractiveEngineMessage } from "./protocol.ts";

/**
 * Child-side record of whether the host is quitting on purpose.
 *
 * The host stops the engine by closing stdin and then sending SIGTERM, and a host
 * that was itself signalled stops it the same way, so the child cannot infer the cause
 * from how it was stopped. The host announces an explicit quit first and waits for the
 * acknowledgement, which makes the flag visible before any stop signal can arrive.
 */
export class EngineQuitIntent {
	private explicit = false;

	private readonly send: (line: string) => void;

	constructor(send: (line: string) => void) {
		this.send = send;
	}

	get explicitQuitRequested(): boolean {
		return this.explicit;
	}

	handleLine(line: string): boolean {
		if (!parseEngineExplicitQuitCommand(line)) return false;
		this.explicit = true;
		this.send(serializeInteractiveEngineMessage({ type: "engine_explicit_quit_ack" }));
		return true;
	}
}
