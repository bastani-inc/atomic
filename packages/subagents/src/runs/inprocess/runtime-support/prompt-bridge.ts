import * as fs from "node:fs";
import { createStructuredOutputTool, type ExtensionAPI, getEnvValue } from "@bastani/atomic";
import type { JsonSchemaObject } from "../../../shared/types.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "../../shared/structured-output.ts";
import {
	CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	rewriteSubagentPrompt,
	stripInheritedSkills,
	stripParentOnlySubagentMessages as stripParentOnlySubagentMessagesForPolicy,
	stripProjectContext,
	stripSubagentOrchestrationSkill,
} from "../prompt-behavior.ts";
import {
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV,
	SUBAGENT_INHERIT_SKILLS_ENV,
	SUBAGENT_INTERCOM_SESSION_NAME_ENV,
} from "./process-args.ts";

export { SUBAGENT_INTERCOM_SESSION_NAME_ENV } from "./process-args.ts";
export {
	CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	rewriteSubagentPrompt,
	stripInheritedSkills,
	stripProjectContext,
	stripSubagentOrchestrationSkill,
};

function readBooleanEnv(name: string): boolean | undefined {
	const value = getEnvValue(name);
	if (value === undefined) return undefined;
	return value !== "0";
}

/**
 * Legacy extension-facing adapter. In-process children use the typed policy
 * overload in runs/inprocess/prompt-behavior.ts instead of reading this env key.
 */
export function stripParentOnlySubagentMessages(messages: unknown[]): unknown[] {
	return stripParentOnlySubagentMessagesForPolicy(messages, process.env[SUBAGENT_FANOUT_CHILD_ENV] === "1");
}

/**
 * Legacy process-extension entry point. The prompt and context behavior itself
 * lives in the in-process construction module; this adapter remains until the
 * later clean-break deletion move removes the extension injection path.
 */
export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
	const structuredOutputPath = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
	const structuredSchemaPath = process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
	if (structuredOutputPath && structuredSchemaPath) {
		const schema = JSON.parse(fs.readFileSync(structuredSchemaPath, "utf-8")) as JsonSchemaObject;
		pi.registerTool(
			createStructuredOutputTool({
				schema,
				output: { outputPath: structuredOutputPath },
			}),
		);
	}

	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: unknown) => unknown) => void;
	onRuntimeEvent("context", (event) => {
		const contextEvent = event as { messages?: unknown[] };
		if (!Array.isArray(contextEvent.messages)) return undefined;
		const messages = stripParentOnlySubagentMessages(contextEvent.messages);
		if (messages === contextEvent.messages) return undefined;
		return { messages };
	});

	pi.on("before_agent_start", async (event) => {
		const intercomSessionName = getEnvValue(SUBAGENT_INTERCOM_SESSION_NAME_ENV)?.trim();
		if (intercomSessionName && typeof pi.setSessionName === "function") {
			pi.setSessionName(intercomSessionName);
		}

		const inheritProjectContext = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV);
		const inheritSkills = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV);
		const fanoutChild = readBooleanEnv(SUBAGENT_FANOUT_CHILD_ENV);
		if (inheritProjectContext === undefined && inheritSkills === undefined && fanoutChild === undefined) return;
		const rewritten = rewriteSubagentPrompt(event.systemPrompt, {
			inheritProjectContext: inheritProjectContext ?? true,
			inheritSkills: inheritSkills ?? true,
			fanoutChild: fanoutChild === true,
		});
		if (rewritten === event.systemPrompt) return;
		return { systemPrompt: rewritten };
	});
}
