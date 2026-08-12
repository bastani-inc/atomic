import type { SessionAdapterSelector } from "../../shared/types.js";
import type { AgentSessionAdapter, StageAdapters } from "./stage-runner-types.js";

export const SESSION_ADAPTER_PROTOCOL_VERSION = 1 as const;
export const SESSION_ADAPTER_REGISTER_EVENT = "atomic:workflows:session-adapter:register";
export const SESSION_ADAPTER_DISCOVER_EVENT = "atomic:workflows:session-adapter:discover";

export interface SessionAdapterRegistration {
	readonly version: typeof SESSION_ADAPTER_PROTOCOL_VERSION;
	readonly name: string;
	readonly adapter: AgentSessionAdapter;
	/** Stable extension identity used when a resource reload creates a new adapter object. */
	readonly source?: string;
}

export interface SessionAdapterEventBus {
	emit(channel: string, data: Record<string, unknown>): void;
	on(channel: string, handler: (data: unknown) => void): unknown;
}

export class SessionAdapterRegistry {
	private readonly registrations = new Map<
		string,
		{ readonly adapter: AgentSessionAdapter; readonly source?: string }
	>();
	private discoveryRequest?: () => void;

	/** Ask registered extensions to publish their adapters again. */
	discover(): void {
		this.discoveryRequest?.();
	}

	/** @internal Wired by installSessionAdapterDiscovery for late-loaded extensions. */
	setDiscoveryRequest(request: () => void): void {
		this.discoveryRequest = request;
	}

	register(registration: SessionAdapterRegistration): void {
		if (registration.version !== SESSION_ADAPTER_PROTOCOL_VERSION) {
			throw new Error(
				`atomic-workflows: unsupported session adapter protocol version ${String(registration.version)}; expected ${SESSION_ADAPTER_PROTOCOL_VERSION}`,
			);
		}
		const name = registration.name.trim();
		if (name.length === 0) throw new Error("atomic-workflows: session adapter name must not be empty");
		const source = registration.source?.trim() || undefined;
		const existing = this.registrations.get(name);
		if (existing?.adapter === registration.adapter) return;
		if (existing !== undefined && source !== undefined && existing.source === source) {
			// Resource reloads construct a fresh adapter object. Keep the stable
			// name while replacing the implementation with the newly loaded one.
			this.registrations.set(name, { adapter: registration.adapter, source });
			return;
		}
		if (existing !== undefined) {
			throw new Error(`atomic-workflows: conflicting session adapter registration for name "${name}"`);
		}
		this.registrations.set(name, { adapter: registration.adapter, ...(source === undefined ? {} : { source }) });
	}

	get(name: string): AgentSessionAdapter | undefined {
		return this.registrations.get(name)?.adapter;
	}

	names(): readonly string[] {
		return [...this.registrations.keys()].sort();
	}
}

function isRegistration(value: unknown): value is SessionAdapterRegistration {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Partial<SessionAdapterRegistration>;
	return (
		candidate.version === SESSION_ADAPTER_PROTOCOL_VERSION &&
		typeof candidate.name === "string" &&
		candidate.adapter !== null &&
		typeof candidate.adapter === "object" &&
		(candidate.source === undefined || typeof candidate.source === "string") &&
		typeof candidate.adapter.create === "function"
	);
}

export function installSessionAdapterDiscovery(
	events: SessionAdapterEventBus | undefined,
	registry: SessionAdapterRegistry = new SessionAdapterRegistry(),
): { readonly registry: SessionAdapterRegistry; readonly dispose: () => void } {
	if (events === undefined) return { registry, dispose: () => undefined };
	const unsubscribe = events.on(SESSION_ADAPTER_REGISTER_EVENT, (payload) => {
		if (isRegistration(payload)) registry.register(payload);
	});
	registry.setDiscoveryRequest(() => {
		events.emit(SESSION_ADAPTER_DISCOVER_EVENT, { version: SESSION_ADAPTER_PROTOCOL_VERSION });
	});
	registry.discover();
	return { registry, dispose: typeof unsubscribe === "function" ? () => unsubscribe() : () => undefined };
}

export function resolveSessionAdapter(
	adapters: StageAdapters,
	selector: SessionAdapterSelector | undefined,
): AgentSessionAdapter | undefined {
	if (selector === undefined) return adapters.agentSession;
	const namedAdapters = adapters.sessionAdapters;
	let adapter = namedAdapters?.get(selector.name);
	if (adapter === undefined) {
		namedAdapters?.discover?.();
		adapter = namedAdapters?.get(selector.name);
	}
	if (adapter !== undefined) return adapter;
	const available = namedAdapters?.names() ?? [];
	const suffix =
		available.length > 0 ? ` Available adapters: ${available.join(", ")}.` : " No named adapters are registered.";
	throw new Error(`atomic-workflows: unknown session adapter "${selector.name}".${suffix}`);
}
