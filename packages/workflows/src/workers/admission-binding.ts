import { randomUUID } from "node:crypto";
import { type ResourceAdmission, withResourceAdmission } from "@bastani/atomic";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { JournalDurableBackend } from "../durable/journal/journal-backend.js";
import { createAgentSessionAdapter } from "../extension/wiring.js";
import type { RunOpts } from "../runs/foreground/executor-types.js";
import type { AgentSessionAdapter } from "../runs/foreground/stage-runner.js";
import {
	agentSessionAdapterDefaultCwd,
	setAgentSessionAdapterDefaultCwd,
} from "../runs/foreground/stage-runner-session-options.js";
import { type AdmissionConfiguration, SqlResourceAdmission } from "./resource-admission.js";

export const workflowResourceAdmission = new WeakMap<DurableWorkflowBackend, AdmissionConfiguration>();

export function admittedSessionAdapter(
	adapter: AgentSessionAdapter,
	admission: ResourceAdmission,
): AgentSessionAdapter {
	const wrapped: AgentSessionAdapter = {
		create: (options, meta) =>
			adapter.create(
				{ ...options, resourceAdmission: admission, resourceAdmissionSignal: meta?.startupSignal ?? meta?.signal },
				meta,
			),
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
	const config = workflowResourceAdmission.get(rootBackend);
	if (!config) return callback(opts);
	if (!(rootBackend instanceof JournalDurableBackend))
		throw new Error("Resource admission requires a journal backend");
	const admission = await SqlResourceAdmission.open(rootBackend.journal, {
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
				),
			},
		}),
	);
}
