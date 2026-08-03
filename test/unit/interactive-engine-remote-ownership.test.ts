import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import {
	type RemoteProxyOwnershipSource,
	registerRemoteProxyOwnership,
	remoteEngineProxyOwner,
} from "../../packages/coding-agent/src/modes/interactive-engine/remote-input-ownership.ts";

/**
 * Ctrl+C must be able to escape a remote `ctx.ui.custom()` proxy that owns
 * input, and must not hijack a native selector, form, picker, or overlay.
 * Visual modal state alone cannot tell those apart, so ownership is reported by
 * the controller that actually mounted the proxies — and it reports identity,
 * so the route can tell a repeat press on the same trapped component from a
 * first press on a new one.
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
		focusedRemoteOverlay: () => undefined,
		remoteProxyOwner: (component: unknown) =>
			component === REMOTE_INLINE || component === REMOTE_OVERLAY ? component : undefined,
		remoteProxyHandlesCtrlC: () => false,
		dismissRemoteProxy: () => true,
		...overrides,
	};
}

test("an unregistered runtime never reports a remote owner", () => {
	const runtime = makeRuntime();
	assert.equal(
		remoteEngineProxyOwner(runtime, { hasOverlay: () => false, inlineComponents: () => [REMOTE_INLINE] }),
		undefined,
	);
});

test("a focused remote overlay is the owner", () => {
	const runtime = makeRuntime();
	const dispose = registerRemoteProxyOwnership(runtime, source({ focusedRemoteOverlay: () => REMOTE_OVERLAY }));
	try {
		assert.equal(
			remoteEngineProxyOwner(runtime, { hasOverlay: () => true, inlineComponents: () => [EDITOR] }),
			REMOTE_OVERLAY,
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
			remoteEngineProxyOwner(runtime, { hasOverlay: () => false, inlineComponents: () => [REMOTE_INLINE] }),
			REMOTE_INLINE,
		);
		// A native overlay above the remote inline mount owns input and keeps its
		// own Ctrl+C-as-cancel.
		assert.equal(
			remoteEngineProxyOwner(runtime, { hasOverlay: () => true, inlineComponents: () => [REMOTE_INLINE] }),
			undefined,
			"a native overlay above a remote inline mount must not be terminated",
		);
	} finally {
		dispose();
	}
});

test("native components and the editor never report a remote owner", () => {
	const runtime = makeRuntime();
	const dispose = registerRemoteProxyOwnership(runtime, source());
	try {
		for (const inline of [[EDITOR], [NATIVE], []]) {
			assert.equal(
				remoteEngineProxyOwner(runtime, { hasOverlay: () => false, inlineComponents: () => inline }),
				undefined,
				`claimed ownership for ${JSON.stringify(inline)}`,
			);
		}
	} finally {
		dispose();
	}
});

test("a widget proxy does not own keyboard input", () => {
	const runtime = makeRuntime();
	// Widgets render above/below the editor; the controller reports them as
	// non-owners even though they are RemoteComponents.
	const dispose = registerRemoteProxyOwnership(runtime, source({ remoteProxyOwner: () => undefined }));
	try {
		assert.equal(
			remoteEngineProxyOwner(runtime, { hasOverlay: () => false, inlineComponents: () => [EDITOR] }),
			undefined,
		);
	} finally {
		dispose();
	}
});

test("disposing the registration stops reporting an owner", () => {
	const runtime = makeRuntime();
	const dispose = registerRemoteProxyOwnership(runtime, source());
	assert.equal(
		remoteEngineProxyOwner(runtime, { hasOverlay: () => false, inlineComponents: () => [REMOTE_INLINE] }),
		REMOTE_INLINE,
	);
	dispose();
	assert.equal(
		remoteEngineProxyOwner(runtime, { hasOverlay: () => false, inlineComponents: () => [REMOTE_INLINE] }),
		undefined,
	);
});
