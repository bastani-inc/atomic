const mutations = new WeakMap<object, Promise<void>>();

/** Keep each choice's compare, commit and state publication together, in call order. */
export function serializeSessionMutation<T>(session: object, operation: () => Promise<T>): Promise<T> {
	const previous = mutations.get(session);
	const result = previous ? previous.then(operation) : operation();
	const settled = result.then(
		() => {},
		() => {},
	);
	mutations.set(session, settled);
	void settled.then(() => {
		if (mutations.get(session) === settled) mutations.delete(session);
	});
	return result;
}
