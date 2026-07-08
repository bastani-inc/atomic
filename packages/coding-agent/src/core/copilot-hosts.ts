/** Shared strict host predicates for GitHub Copilot CAPI endpoints. */

const GITHUB_COPILOT_HOST = "githubcopilot.com";
const GHE_COPILOT_API_HOST_PREFIX = "copilot-api.";
const GHE_HOST_SUFFIX = ".ghe.com";
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function hasValidDnsLabels(hostFragment: string): boolean {
  return hostFragment.split(".").every((label) => DNS_LABEL_PATTERN.test(label));
}

/**
 * Whether the URL targets a GitHub Copilot CAPI gateway.
 *
 * Accepts the public/enterprise githubcopilot.com gateway family and the GHE
 * tenant routing shape Atomic derives from *.ghe.com server URLs:
 * copilot-api.<enterprise>.ghe.com. The suffix checks are label-aware so
 * look-alikes such as githubcopilot.com.evil.test or
 * copilot-api.company.ghe.com.evil.test are rejected.
 */
export function isCopilotApiHost(url: URL | string): boolean {
  let host: string;
  try {
    host = (typeof url === "string" ? new URL(url).hostname : url.hostname).toLowerCase();
  } catch {
    return false;
  }

  if (host === GITHUB_COPILOT_HOST || host.endsWith(`.${GITHUB_COPILOT_HOST}`)) return true;
  if (!host.startsWith(GHE_COPILOT_API_HOST_PREFIX) || !host.endsWith(GHE_HOST_SUFFIX)) return false;

  const enterpriseHost = host.slice(GHE_COPILOT_API_HOST_PREFIX.length, -GHE_HOST_SUFFIX.length);
  return enterpriseHost.length > 0 && hasValidDnsLabels(enterpriseHost);
}
