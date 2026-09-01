import type { ToolCallEventResult } from "../../core/extensions/index.ts";
import type { FeedbackSessionFacts } from "./index.js";
import type { FeedbackKind } from "./templates.js";
import type { WorkingTreeDisclosure } from "./working-tree.js";

export const INVESTIGATION_UNAVAILABLE = "Investigation unavailable" as const;

export interface FeedbackInvestigationControllerOptions {
	prompt: string;
	facts: FeedbackSessionFacts;
	debuggerToolAvailable: boolean;
}

export type FeedbackInvestigationAssessment =
	| {
			status: "not-required";
			prompt: string;
			nonBuiltinExtensionsLoaded: boolean;
			workingTree?: WorkingTreeDisclosure;
	  }
	| {
			status: "available";
			prompt: string;
			nonBuiltinExtensionsLoaded: boolean;
			workingTree?: WorkingTreeDisclosure;
	  }
	| {
			status: "unavailable";
			message: typeof INVESTIGATION_UNAVAILABLE;
			prompt: string;
			nonBuiltinExtensionsLoaded: boolean;
			workingTree?: WorkingTreeDisclosure;
	  };

export class FeedbackDebuggerProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FeedbackDebuggerProtocolError";
	}
}

function formatFailedOutcomes(facts: FeedbackSessionFacts): string {
	return facts.recentFailedOutcomes.length > 0
		? facts.recentFailedOutcomes.map((outcome) => `- ${outcome}`).join("\n")
		: "- None";
}

export function buildFeedbackDebuggerObjective(prompt: string, facts: FeedbackSessionFacts): string {
	return `Investigate this Atomic bug for an issue report. This is investigation and report only.

Use the existing debugger agent's normal tools and judgment until you have enough supported information for maintainers to continue, or the user interrupts through Atomic's normal controls. There is no wall-clock or tool-call limit. If you prove a root cause, report concise evidence and supported reproduction steps. Otherwise report observed behavior, reproduction evidence, the likely component, failed hypotheses, and remaining unknowns honestly.

Do not intentionally implement the product fix. Do not reset, clean, stash, or overwrite pre-existing tracked or untracked working-tree changes. Diagnostic writes are allowed, but leave them in place for disclosure. Do not launch a workflow, create or customize another agent, or enter an autonomous review or repair loop. Do not return raw secrets, a raw transcript, repository files, environment dumps, screenshots, or diagnostic artifacts for publication.

Safe parent-session facts:
- Atomic version: ${facts.version}
- OS: ${facts.platform}
- Architecture: ${facts.architecture}
- Runtime: ${facts.runtime}
- Session mode: ${facts.mode}
- Provider: ${facts.provider}
- Model: ${facts.model}
- Non-builtin extensions loaded: ${facts.nonBuiltinExtensionsLoaded ? "yes" : "no"}
- Session error state: ${facts.sessionErrorState}
- Recent failed outcomes:
${formatFailedOutcomes(facts)}

The user's feedback text follows verbatim after this line:
${prompt}`;
}

export class FeedbackInvestigationController {
	readonly #prompt: string;
	readonly #objective: string;
	readonly #debuggerToolAvailable: boolean;
	readonly #nonBuiltinExtensionsLoaded: boolean;
	#debuggerCallId: string | undefined;
	#debuggerOutcome: "pending" | "available" | "unavailable" | undefined;
	#protocolViolation: string | undefined;
	#workingTree: WorkingTreeDisclosure | undefined;

	constructor(options: FeedbackInvestigationControllerOptions) {
		this.#prompt = options.prompt;
		this.#objective = buildFeedbackDebuggerObjective(options.prompt, options.facts);
		this.#debuggerToolAvailable = options.debuggerToolAvailable;
		this.#nonBuiltinExtensionsLoaded = options.facts.nonBuiltinExtensionsLoaded;
	}

	handleSubagentCall(toolCallId: string, input: Record<string, unknown>): ToolCallEventResult | undefined {
		if (!this.#debuggerToolAvailable) {
			return { block: true, reason: INVESTIGATION_UNAVAILABLE };
		}
		if (this.#debuggerCallId !== undefined) {
			this.#protocolViolation = "A feedback request may launch the debugger only once.";
			return { block: true, reason: "Feedback bug investigation already launched." };
		}
		if (input.action !== undefined || input.tasks !== undefined || input.agent !== "debugger") {
			return {
				block: true,
				reason: "Feedback investigation must use one foreground execution of the existing bundled debugger.",
			};
		}

		for (const key of Object.keys(input)) delete input[key];
		input.agent = "debugger";
		input.task = this.#objective;
		this.#debuggerCallId = toolCallId;
		this.#debuggerOutcome = "pending";
		return undefined;
	}

	handleSubagentResult(toolCallId: string, outcome: "completed" | "failed" | "interrupted"): boolean {
		if (this.#debuggerCallId !== toolCallId) return false;
		this.#debuggerOutcome = outcome === "completed" ? "available" : "unavailable";
		return true;
	}

	setWorkingTreeDisclosure(disclosure: WorkingTreeDisclosure): void {
		this.#workingTree = disclosure;
	}

	assess(kind: FeedbackKind): FeedbackInvestigationAssessment {
		if (this.#protocolViolation) throw new FeedbackDebuggerProtocolError(this.#protocolViolation);
		if (kind === "enhancement") {
			if (this.#debuggerCallId !== undefined) {
				throw new FeedbackDebuggerProtocolError("Enhancement feedback must not launch the debugger.");
			}
			return {
				status: "not-required",
				prompt: this.#prompt,
				nonBuiltinExtensionsLoaded: this.#nonBuiltinExtensionsLoaded,
				workingTree: this.#workingTree,
			};
		}
		if (!this.#debuggerToolAvailable || this.#debuggerOutcome === "unavailable") {
			return {
				status: "unavailable",
				message: INVESTIGATION_UNAVAILABLE,
				prompt: this.#prompt,
				nonBuiltinExtensionsLoaded: this.#nonBuiltinExtensionsLoaded,
				workingTree: this.#workingTree,
			};
		}
		if (this.#debuggerCallId === undefined) {
			throw new FeedbackDebuggerProtocolError(
				"Feedback bug submission requires one foreground debugger investigation before preview.",
			);
		}
		if (this.#debuggerOutcome === "pending") {
			throw new FeedbackDebuggerProtocolError("Feedback cannot continue while debugger investigation is active.");
		}
		return {
			status: "available",
			prompt: this.#prompt,
			nonBuiltinExtensionsLoaded: this.#nonBuiltinExtensionsLoaded,
			workingTree: this.#workingTree,
		};
	}
}
