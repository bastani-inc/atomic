/**
 * The display records (notice lines and their prompt order) a session is still saving (#6128). No turn, prompt or model
 * decision waits for them, but they are the session's own writes: closing the session waits for them, so nothing the
 * session started still writes to its store once `dispose()` has resolved.
 */
const saving = new WeakMap<object, Set<Promise<void>>>();

/** `save` never rejects: a display record that cannot be saved is dropped where it is saved. */
export function trackChatRecordSave(session: object, save: Promise<void> | undefined): void {
	if (save === undefined) return;
	let saves = saving.get(session);
	if (saves === undefined) {
		saves = new Set();
		saving.set(session, saves);
	}
	const pending = saves;
	pending.add(save);
	void save.finally(() => pending.delete(save));
}

export async function chatRecordSavesSettled(session: object): Promise<void> {
	const saves = saving.get(session);
	while (saves?.size) await Promise.all(saves);
}
