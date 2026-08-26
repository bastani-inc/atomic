export const REPLAY_TOPOLOGY_MISMATCH_MESSAGE = "atomic-workflows: insufficient_state: replay topology mismatch";

export function isReplayTopologyMismatchMessage(message: string): boolean {
	return (
		message === REPLAY_TOPOLOGY_MISMATCH_MESSAGE || message.startsWith(`${REPLAY_TOPOLOGY_MISMATCH_MESSAGE} for `)
	);
}
