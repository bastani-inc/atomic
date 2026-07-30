import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import {
	registerRemoteProxyOwnership,
	remoteEngineProxyOwnsInput,
	type RemoteProxyOwnershipSource,
} from "../../packages/coding-agent/src/modes/interactive-engine/remote-input-ownership.ts";

/**
 * Ctrl+C must escape a remote `ctx.ui.custom()` proxy that owns input, and must
 * NOT hijack a native selector, form, picker, or overlay. Visual modal state
 * alone cannot tell those apart, so ownership is reported by the controller that
 * actually mounted the proxies.
 */

const REMOTE_INLINE = { kind: "remote-inline" };
const REMOTE_OVERLAY = { kind: "remote-overlay" };
const NATIVE = { kind: "native-selector" };
const EDITOR = { kind: "editor" };

function makeRuntime(): AgentSessionRuntime {
	return {} as unknown as AgentSessionRuntime;
}

function source(overrides?: Partial<RemoteProxyOwnershipSource>): RemoteProxyOwnershipSource {
	return {
		hasFocusedRemoteOverlay: () => false,
		isRemoteProxy: (component) => component === REMOTE_INLINE || component === REMOTE_OVERLAY,
		...overrides,
	};
}

test("an unregistered runtime never claims remote ownership", () => {
	const runtime = makeRuntime();
	assert.equal(
		remoteEngineProxyOwnsInput(runtime, { hasOverlay: () => false, inlineComponents: () => [REMOTE_INLINE] }),
		false,
	);
});

test("a focused remote overlay owns input", () => {
	const runtime = makeRuntime();
	const dispose = registerRemoteProxyOwnership(runtime, source({ hasFocusedRemoteOverlay: () => true }));
	try {
		assert.equal(
			remoteEngineProxyOwnsInput(runtime, { hasOverlay: () => true, inlineComponents: () => [EDITOR] }),
			true,
		);
	} finally {
		dispose();
	}
});

test("an inline remote proxy owns input only when no overlay is above it", () => {
	const runtime = makeRuntime();
	const dispose = registerRemoteProxyOwnership(runtime, source());
	try {
		assert.equal(
			remoteEngineProxyOwnsInput(runtime, { hasOverlay: () => false, inlineComponents: () => [REMOTE_INLINE] }),
			true,
		);
		// A native overlay above the remote inline mount owns input and keeps its
		// own Ctrl+C-as-cancel.
		assert.equal(
			remoteEngineProxyOwnsInput(runtime, { hasOverlay: () => true, inlineComponents: () => [REMOTE_INLINE] }),
			false,
			"a native overlay above a remote inline mount must not be terminated",
		);
	} finally {
		dispose();
	}
});

test("native components and the editor never claim remote ownership", () => {
	const runtime = makeRuntime();
	const dispose = registerRemoteProxyOwnership(runtime, source());
	try {
		for (const inline of [[EDITOR], [NATIVE], []]) {
			assert.equal(
				remoteEngineProxyOwnsInput(runtime, { hasOverlay: () => false, inlineComponents: () => inline }),
				false,
				`claimed ownership for ${JSON.stringify(inline)}`,
			);
		}
	} finally {
		dispose();
	}
});

test("a widget proxy does not own keyboard input", () => {
	const runtime = makeRuntime();
	// Widgets render above/below the editor and are reported as non-proxies here.
	const dispose = registerRemoteProxyOwnership(runtime, source({ isRemoteProxy: () => false }));
	try {
		assert.equal(
			remoteEngineProxyOwnsInput(runtime, { hasOverlay: () => false, inlineComponents: () => [EDITOR] }),
			false,
		);
	} finally {
		dispose();
	}
});

test("disposing the registration stops claiming ownership", () => {
	const runtime = makeRuntime();
	const dispose = registerRemoteProxyOwnership(runtime, source());
	assert.equal(
		remoteEngineProxyOwnsInput(runtime, { hasOverlay: () => false, inlineComponents: () => [REMOTE_INLINE] }),
		true,
	);
	dispose();
	assert.equal(
		remoteEngineProxyOwnsInput(runtime, { hasOverlay: () => false, inlineComponents: () => [REMOTE_INLINE] }),
		false,
	);
});
