import { type ExtensionAPI, type ExtensionContext, registerExtensionContextRetirementEffect } from "@bastani/atomic";

/** The generation-dependent operations a wake or run-control request can still need after an await. */
export type ChildOwnerAPI = Pick<
	ExtensionAPI,
	"appendEntry" | "events" | "getSessionName" | "getResourceLoaderInheritanceSnapshot"
>;

type Manager = ExtensionContext["sessionManager"];
type Writer = Pick<ExtensionAPI, "appendEntry">;
interface HostWriter {
	readonly scope: object;
	writable(): boolean;
	save(record: object): Promise<void>;
}
const acquireWriter = Symbol.for("atomic.subagents/acquire-child-record-writer@1");
type BuiltinOwnerAPI = ChildOwnerAPI & { [acquireWriter]?: (ownerId: string) => HostWriter };
interface OwnerBinding {
	readonly sessionId: string;
	current?: { readonly pi: ChildOwnerAPI; readonly ctx: ExtensionContext; readonly hostWriter?: HostWriter };
	fallback?: HostWriter["save"];
	readonly writer: Writer;
}

// Reload keeps the session manager even when it reevaluates every module in the extension.
const KEY = Symbol.for("@bastani/subagents/child-owner-bindings@1");
const processState = globalThis as {
	[KEY]?: { owners: WeakMap<object, OwnerBinding>; apis: WeakMap<Writer, OwnerBinding> };
};
processState[KEY] ??= { owners: new WeakMap(), apis: new WeakMap() };
const bindings = processState[KEY];

function createOwnerBinding(sessionId: string): OwnerBinding {
	const append = async (type: string, record: unknown): Promise<void> => {
		const active = binding.current;
		if (active && active.hostWriter?.writable() !== false) return active.pi.appendEntry(type, record);
		try {
			const refusal = `No writable owner for subagent-child record in session ${sessionId}.`;
			if (type !== "subagent-child" || !record || typeof record !== "object") throw new Error(refusal);
			// No generation and no host writer: the owner gave its session up, refused as its closed API refuses it.
			if (!binding.fallback) throw Object.assign(new Error(refusal), { code: "SessionClosed" });
			// During reload use the same manager and mutation queue, never a second writer.
			await binding.fallback(record);
		} catch (error) {
			console.error("Failed to save a subagent-child record through its owner:", error);
			throw error;
		}
	};
	const binding: OwnerBinding = {
		sessionId,
		writer: { appendEntry: append },
	};
	return binding;
}

/** Publish at commit: neither an uncommitted candidate nor cleanup of its predecessor owns pending work. */
export function bindSubagentChildOwner(pi: ChildOwnerAPI, ctx: ExtensionContext): () => void {
	const manager = ctx.sessionManager;
	const sessionId = manager.getSessionId();
	const hostWriter = (pi as BuiltinOwnerAPI)[acquireWriter]?.(sessionId);
	const scope = hostWriter?.scope ?? manager;
	let binding = bindings.owners.get(scope);
	if (binding?.sessionId !== sessionId) {
		binding = createOwnerBinding(sessionId);
		bindings.owners.set(scope, binding);
	}
	bindings.apis.set(pi, binding);
	const generation = { pi, ctx, hostWriter };
	binding.current = generation;
	binding.fallback = hostWriter?.save;
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
	const binding = bindings.apis.get(pi);
	return binding?.sessionId === manager.getSessionId() ? binding.writer : pi;
}

const currentEvents = Symbol.for("@bastani/subagents/current-owner-events@1");
type Events = ChildOwnerAPI["events"];
type OwnerEvents = Events & { [currentEvents]?: () => Events | undefined };

/** A broker request and its eventual reply belong to the generation that sends it. */
export function subagentChildRequestEvents(events: OwnerEvents): Events | undefined {
	return events[currentEvents] ? events[currentEvents]() : events;
}

/** Keep the same owner across a reload, without retaining its old API or context in a suspended restoration. */
export function subagentChildOwnerOperations(
	pi: ChildOwnerAPI,
	ctx: ExtensionContext,
): { pi: ChildOwnerAPI; ctx: ExtensionContext } {
	const binding = bindings.apis.get(pi);
	if (!binding || binding.sessionId !== ctx.sessionManager.getSessionId()) return { pi, ctx };
	const live = () => {
		if (!binding.current) throw new Error("The subagent's owning session is closed.");
		return binding.current;
	};
	const events: OwnerEvents = {
		[currentEvents]: () => binding.current?.pi.events,
		emit: (channel, data) => binding.current?.pi.events.emit(channel, data),
		on: (channel, handler) => binding.current?.pi.events.on(channel, handler) ?? (() => {}),
	};
	return {
		ctx: new Proxy({} as ExtensionContext, { get: (_, key) => Reflect.get(live().ctx, key) }),
		pi: {
			...binding.writer,
			events,
			getSessionName: () => live().pi.getSessionName(),
			get getResourceLoaderInheritanceSnapshot() {
				return live().pi.getResourceLoaderInheritanceSnapshot;
			},
		},
	};
}
