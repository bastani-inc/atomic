/**
 * Cloudflare AI Gateway transport over the Workers AI binding.
 *
 * pi-ai ships this transport (upstream #7901); Atomic re-exports it so SDK users and
 * extension authors can route gateway requests through `env.AI` with **no API token**:
 * binding calls are pre-authenticated in the gateway's own account. The HTTPS route with
 * `CLOUDFLARE_API_KEY` stays the default for everywhere else. See
 * `docs/providers.md` → "Cloudflare AI Gateway" for a working provider-extension example.
 */
export {
	type AiGatewayBinding,
	type AiGatewayBindingGateway,
	type AiGatewayUniversalRequestLike,
	CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
	createGatewayBindingFetch,
	type GatewayBindingFetchOptions,
} from "@earendil-works/pi-ai/api/cloudflare-gateway-binding";
