// Only presentation code belongs here. The published CLI bundles these workspace modules beside the export code.
import {
	renderContactSupervisorCall,
	renderContactSupervisorResult,
	renderIntercomCall,
	renderIntercomResult,
} from "../../../../intercom/result-renderers.js";
import { savedSubagentToolRenderers } from "../../../../subagents/src/extension/tool-rendering.js";
import {
	renderCodeSearchCall,
	renderCodeSearchResult,
	renderFetchContentCall,
	renderFetchContentResult,
	renderGetSearchContentResult,
	renderWebSearchCall,
	renderWebSearchResult,
} from "../../../../web-access/result-renderers.js";
import { workflowToolRenderers } from "../../../../workflows/src/extension/workflow-tool-registration.js";
import { createMcpToolRenderers, savedMcpToolLabel } from "../../extensions/mcp/tools.ts";

const extensionCards = new Map([
	["subagent", savedSubagentToolRenderers],
	["workflow", workflowToolRenderers()],
	["intercom", { renderCall: renderIntercomCall, renderResult: renderIntercomResult }],
	["contact_supervisor", { renderCall: renderContactSupervisorCall, renderResult: renderContactSupervisorResult }],
	["web_search", { renderCall: renderWebSearchCall, renderResult: renderWebSearchResult }],
	["code_search", { renderCall: renderCodeSearchCall, renderResult: renderCodeSearchResult }],
	["fetch_content", { renderCall: renderFetchContentCall, renderResult: renderFetchContentResult }],
	["get_search_content", { renderResult: renderGetSearchContentResult }],
]);

export function extensionCard(name) {
	return name.startsWith("mcp__") ? createMcpToolRenderers(savedMcpToolLabel(name)) : extensionCards.get(name);
}
