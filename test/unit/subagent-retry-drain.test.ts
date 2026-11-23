import assert from "node:assert/strict";
import { test } from "vitest";
import { nextTurnSettled, sessionDrained } from "../../packages/subagents/src/runs/inprocess/runner.js";

interface SyntheticEvent {
	type: string;
	retryPending?: true;
	success?: boolean;
}

function createSyntheticSession() {
	const listeners = new Set<(event: SyntheticEvent) => void>();
	const drainedListeners = new Set<() => void>();
	let streaming = false;
	let retrying = false;
	let sealed = false;

	const session = {
		get isStreaming() {
			return streaming;
		},
		get isRetrying() {
			return retrying;
		},
		_activePromptCount: 0,
		_pendingInterruptDeliveries: 0,
		_sealMessageAdmissionIfDrained() {
			if (streaming || retrying) return false;
			sealed = true;
			return true;
		},
		subscribe(listener: (event: SyntheticEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	const subscribeDrained = (listener: () => void) => {
		drainedListeners.add(listener);
		return () => drainedListeners.delete(listener);
	};

	const emit = (event: SyntheticEvent) => {
		for (const listener of [...listeners]) listener(event);
	};

	const fireDrained = () => {
		for (const listener of [...drainedListeners]) listener();
	};

	return {
		session,
		subscribeDrained,
		emit,
		fireDrained,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
		setRetrying: (value: boolean) => {
			retrying = value;
		},
		isSealed: () => sealed,
	};
}

const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("sessionDrained stays open while isRetrying is true even without _sealMessageAdmissionIfDrained and wakes on auto_retry_end", async () => {
	const synth = createSyntheticSession();
	synth.setStreaming(false);
	synth.setRetrying(true);
	const sessionWithoutSeal = {
		get isStreaming() {
			return synth.session.isStreaming;
		},
		get isRetrying() {
			return synth.session.isRetrying;
		},
		_activePromptCount: 0,
		_pendingInterruptDeliveries: 0,
		subscribe: synth.session.subscribe,
	};

	let done = false;
	const waiting = sessionDrained(
		sessionWithoutSeal as never,
		[new AbortController().signal],
		synth.subscribeDrained,
	).then(() => {
		done = true;
	});

	synth.emit({ type: "agent_end", retryPending: true });
	await nextMacrotask();
	assert.equal(done, false, "sessionDrained must not resolve while retrying even without admission seal");

	// Match real AgentSession order: emit auto_retry_end, then synchronously clear _retryPromise.
	synth.emit({ type: "auto_retry_end", success: false });
	synth.setRetrying(false);

	await Promise.race([
		waiting,
		new Promise<never>((_resolve, reject) =>
			setTimeout(() => reject(new Error("sessionDrained did not wake on auto_retry_end")), 1_000),
		),
	]);
	assert.equal(done, true);
});

test("sessionDrained stays open while isRetrying is true and wakes cleanly on auto_retry_end", async () => {
	const synth = createSyntheticSession();
	synth.setStreaming(false);
	synth.setRetrying(true);

	let done = false;
	const waiting = sessionDrained(synth.session as never, [new AbortController().signal], synth.subscribeDrained).then(
		() => {
			done = true;
		},
	);

	synth.emit({ type: "agent_end", retryPending: true });
	await nextMacrotask();
	assert.equal(done, false, "sessionDrained must not resolve while retrying");
	assert.equal(synth.isSealed(), false, "admission must not seal while retrying");

	// Match real AgentSession order: emit auto_retry_end, then synchronously clear _retryPromise.
	synth.emit({ type: "auto_retry_end", success: false });
	synth.setRetrying(false);

	await Promise.race([
		waiting,
		new Promise<never>((_resolve, reject) =>
			setTimeout(() => reject(new Error("sessionDrained did not wake on auto_retry_end")), 1_000),
		),
	]);
	assert.equal(done, true);
	assert.equal(synth.isSealed(), true);
});

test("nextTurnSettled stays open across agent_end while retrying and wakes cleanly on auto_retry_end", async () => {
	const synth = createSyntheticSession();

	let done = false;
	const waiting = nextTurnSettled(synth.session as never, [new AbortController().signal]).then(() => {
		done = true;
	});

	synth.setStreaming(true);
	synth.emit({ type: "agent_start" });
	synth.setStreaming(false);
	synth.setRetrying(true);

	synth.emit({ type: "agent_end", retryPending: true });
	await nextMacrotask();
	assert.equal(done, false, "must not settle on retryPending agent_end");

	synth.emit({ type: "agent_end" });
	await nextMacrotask();
	assert.equal(done, false, "must not settle on agent_end while isRetrying is true");

	synth.emit({ type: "agent_settled" });
	await nextMacrotask();
	assert.equal(done, false, "must not settle on agent_settled while isRetrying is true");

	// Match real AgentSession order: emit auto_retry_end, then synchronously clear _retryPromise.
	synth.emit({ type: "auto_retry_end", success: false });
	synth.setRetrying(false);

	await Promise.race([
		waiting,
		new Promise<never>((_resolve, reject) =>
			setTimeout(() => reject(new Error("nextTurnSettled did not wake on auto_retry_end")), 1_000),
		),
	]);
	assert.equal(done, true);
});

test("nextTurnSettled with subscribeDrained waits until isRetrying is false", async () => {
	const synth = createSyntheticSession();

	let done = false;
	const waiting = nextTurnSettled(synth.session as never, [new AbortController().signal], {
		waitForStart: true,
		subscribeDrained: synth.subscribeDrained,
	}).then(() => {
		done = true;
	});

	synth.setStreaming(true);
	synth.emit({ type: "agent_start" });
	synth.setStreaming(false);
	synth.setRetrying(true);

	synth.fireDrained();
	await nextMacrotask();
	assert.equal(done, false, "subscribeDrained must not settle while isRetrying is true");

	synth.setRetrying(false);
	synth.fireDrained();

	await Promise.race([
		waiting,
		new Promise<never>((_resolve, reject) =>
			setTimeout(() => reject(new Error("nextTurnSettled did not settle after retry cleared")), 1_000),
		),
	]);
	assert.equal(done, true);
});
