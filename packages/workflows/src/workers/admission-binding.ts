import { randomUUID } from "node:crypto";
import { type ResourceAdmission, type ResourcePermit, withResourceAdmission } from "@bastani/atomic";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { JournalDurableBackend } from "../durable/journal/journal-backend.js";
import { createAgentSessionAdapter } from "../extension/wiring.js";
import type { RunOpts } from "../runs/foreground/executor-types.js";
import type { AgentSessionAdapter } from "../runs/foreground/stage-runner.js";
import {
	agentSessionAdapterDefaultCwd,
	setAgentSessionAdapterDefaultCwd,
} from "../runs/foreground/stage-runner-session-options.js";
import { poolJournalFor } from "./pool-journal.js";
import { type AdmissionConfiguration, SqlResourceAdmission } from "./resource-admission.js";

export const workflowResourceAdmission = new WeakMap<DurableWorkflowBackend, AdmissionConfiguration>();

class SessionCapacitySlot {
	private owners = 0;
	private releasing: Promise<void> | undefined;

	constructor(private readonly release: ResourcePermit) {}

	join(): ResourcePermit {
		this.owners++;
		let counted = true;
		return async () => {
			if (counted) {
				counted = false;
				this.owners--;
			}
			if (this.owners > 0) return;
			this.releasing ??= this.release().catch((error: unknown) => {
				this.releasing = undefined;
				throw error;
			});
			await this.releasing;
		};
	}

	get released(): boolean {
		return this.releasing !== undefined;
	}
}

export function admittedSessionAdapter(
	adapter: AgentSessionAdapter,
	admission: ResourceAdmission,
	validateInheritedCapacity?: (signal?: AbortSignal) => Promise<void>,
): AgentSessionAdapter {
	const slots = new WeakMap<object, SessionCapacitySlot>();
	const wrapped: AgentSessionAdapter = {
		create: async (options, meta) => {
			const predecessor = meta?.replacesSession === undefined ? undefined : slots.get(meta.replacesSession);
			let slot: SessionCapacitySlot | undefined;
			let claimed = false;
			const scoped: ResourceAdmission = {
				async acquire(kind, signal, request) {
					if (kind !== "session" || claimed) return admission.acquire(kind, signal, request);
					claimed = true;
					if (predecessor !== undefined && !predecessor.released) {
						signal?.throwIfAborted();
						await validateInheritedCapacity?.(signal);
						signal?.throwIfAborted();
						if (!predecessor.released) {
							slot = predecessor;
							return predecessor.join();
						}
					}
					const permit = await admission.acquire(kind, signal, request);
					slot = new SessionCapacitySlot(permit);
					return slot.join();
				},
			};
			const created = await adapter.create(
				{ ...options, resourceAdmission: scoped, resourceAdmissionSignal: meta?.startupSignal ?? meta?.signal },
				meta,
			);
			if (slot !== undefined) slots.set("session" in created ? created.session : created, slot);
			return created;
		},
	};
	const cwd = agentSessionAdapterDefaultCwd(adapter);
	if (cwd !== undefined) setAgentSessionAdapterDefaultCwd(wrapped, cwd);
	return wrapped;
}

export async function admitWorkflowSessions(
	backend: DurableWorkflowBackend,
	opts: RunOpts & { runId: string },
	callback: (options: RunOpts) => Promise<import("../runs/foreground/executor-types.js").RunResult>,
): Promise<import("../runs/foreground/executor-types.js").RunResult> {
	const rootBackend = opts.durableRootBackend ?? backend;
	const config = opts.admission ?? workflowResourceAdmission.get(rootBackend);
	if (!config) return callback(opts);
	if (!(rootBackend instanceof JournalDurableBackend))
		throw new Error("Resource admission requires a journal backend");
	const admission = await SqlResourceAdmission.open(poolJournalFor(rootBackend.journal), {
		...config,
		root: opts.parentRun?.rootRunId ?? opts.runId,
		holder: randomUUID(),
	});
	return withResourceAdmission(admission, () =>
		callback({
			...opts,
			adapters: {
				...opts.adapters,
				agentSession: admittedSessionAdapter(
					opts.adapters?.agentSession ?? createAgentSessionAdapter({ cwd: opts.cwd }),
					admission,
					(signal) => admission.validate(signal),
				),
			},
		}),
	);
}
