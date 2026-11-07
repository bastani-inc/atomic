/**
 * #4538: a session that cannot have its routing verified by the running Intercom broker, while no multi-node storage
 * is configured, uses that broker on this machine only, and says so once. Host-free.
 */
import type { IntercomRoutingUnavailableError } from "@bastani/atomic";

/** The warning for a session that uses a broker it cannot verify as single-machine; `reason` is why. */
export function localOnlyBrokerWarning(reason: IntercomRoutingUnavailableError): string {
	const failure = reason.cause instanceof Error ? ` Replacing it failed: ${reason.cause.message}` : "";
	return `The running Intercom broker cannot verify how it routes (${reason.phase}: ${reason.reason}). No multi-node storage is configured, so this session uses it on this machine only; run \`atomic intercom restart\` to replace it with this version's broker.${failure}`;
}

let headlessWarningWritten = false;

/**
 * Write {@link localOnlyBrokerWarning} to stderr for a session without a UI, at most once per process. Print and JSON
 * runs, workflow stages and subagents have no place to show a notice, and stdout stays the answer's.
 */
export function warnLocalOnlyBrokerWithoutUi(
	reason: IntercomRoutingUnavailableError,
	write: (line: string) => void = (line) => console.error(line),
): void {
	if (headlessWarningWritten) return;
	headlessWarningWritten = true;
	write(`Warning: ${localOnlyBrokerWarning(reason)}`);
}

/** Allow {@link warnLocalOnlyBrokerWithoutUi} to write again, for tests that share one process. */
export function resetLocalOnlyBrokerWarningWithoutUi(): void {
	headlessWarningWritten = false;
}
