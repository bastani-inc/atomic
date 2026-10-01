import { DEFAULT_RADIUS_GATEWAY, normalizeRadiusGatewayUrl } from "@bastani/pi-ai/providers/radius-config";

export const RADIUS_PROVIDER_ID = "radius";
export const RADIUS_MCP_URL = `${normalizeRadiusGatewayUrl(DEFAULT_RADIUS_GATEWAY)}/mcp`;
