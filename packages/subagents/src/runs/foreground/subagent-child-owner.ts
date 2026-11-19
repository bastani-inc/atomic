import {
	type ExtensionAPI,
	type ExtensionContext,
	registerExtensionContextRetirementEffect,
	SessionManager,
} from "@bastani/atomic";

/** The generation-dependent operations a wake or run-control request can still need after an await. */
export type ChildOwnerAPI = Pick<
	ExtensionAPI,
	"appendEntry" | "events" | "getSessionName" | "getResourceLoaderInheritanceSnapshot"
>;

type Manager = ExtensionContext["sessionManager"];
type Writer = Pick<ExtensionAPI, "appendEntry">;
interface OwnerBinding {
	readonly sessionId: string;
	current?: { readonly pi: ChildOwnerAPI; readonly ctx: ExtensionContext };
	readonly writer: Writer;
}

// Reload keeps the session manager even when it reevaluates every module in the extension.
const KEY = Symbol.for("@bastani/subagents/child-owner-bindings@1");
const processState = globalThis as { [KEY]?: WeakMap<Manager, OwnerBinding> };
processState[KEY] ??= new WeakMap();
const bindings = processState[KEY];

function createOwnerBinding(manager: Manager, sessionId: string): OwnerBinding {
	const store = manager.getSessionStore();
	const binding: OwnerBinding = {
		sessionId,
		writer: {
			async appendEntry(type, record) {
				const active = () => binding.current?.pi;
				const writer = active();
				if (writer) return writer.appendEntry(type, record);
				// The owner closed before an accepted task could save. Never append to the session that replaced it.
				const stored = await SessionManager.open(store, sessionId, undefined, { history: "tail" });
				const successor = active();
				if (successor) return successor.appendEntry(type, record);
				await stored.appendCustomEntry(type, record);
			},
		},
	};
	return binding;
}

/** Publish at commit: neither an uncommitted candidate nor cleanup of its predecessor owns pending work. */
export function bindSubagentChildOwner(pi: ChildOwnerAPI, ctx: ExtensionContext): () => void {
	const manager = ctx.sessionManager;
	const sessionId = manager.getSessionId();
	let binding = bindings.get(manager);
	if (binding?.sessionId !== sessionId) {
		binding = createOwnerBinding(manager, sessionId);
		bindings.set(manager, binding);
	}
	const generation = { pi, ctx };
	binding.current = generation;
	const retire = () => {
		if (binding.current === generation) binding.current = undefined;
	};
	const unregister = registerExtensionContextRetirementEffect(ctx, retire);
	return () => {
		unregister();
		retire();
	};
}

/** Long-lived sinks choose the writer when their turn in the owner's append queue actually arrives. */
export function subagentChildOwnerWriter(pi: Writer, manager: Manager): Writer {
	const binding = bindings.get(manager);
	return binding?.current?.pi === pi ? binding.writer : pi;
}

/** Keep the same owner across a reload, without retaining its old API or context in a suspended restoration. */
export function subagentChildOwnerOperations(
	pi: ChildOwnerAPI,
	ctx: ExtensionContext,
): { pi: ChildOwnerAPI; ctx: ExtensionContext } {
	const binding = bindings.get(ctx.sessionManager);
	if (!binding?.current || binding.sessionId !== ctx.sessionManager.getSessionId()) return { pi, ctx };
	const live = () => {
		if (!binding.current) throw new Error("The subagent's owning session is closed.");
		return binding.current;
	};
	return {
		ctx: new Proxy({} as ExtensionContext, { get: (_, key) => Reflect.get(live().ctx, key) }),
		pi: {
			...binding.writer,
			events: {
				emit: (channel, data) => live().pi.events.emit(channel, data),
				on: (channel, handler) => live().pi.events.on(channel, handler),
			},
			getSessionName: () => live().pi.getSessionName(),
			get getResourceLoaderInheritanceSnapshot() {
				return live().pi.getResourceLoaderInheritanceSnapshot;
			},
		},
	};
}
