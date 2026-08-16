/**
 * The one place that builds the `/live.js` URL the browser loads.
 *
 * Every injection path needs it (the generic script tag, the Nuxt client
 * plugin, the SvelteKit root component, the TanStack mount component), and a
 * separate module keeps that shared leaf free of import cycles: the framework
 * entries import it, and nothing here imports a framework entry.
 */

/**
 * When a token is supplied it rides as a `?token=...` query param so the
 * server's token-gated /live.js handler authorizes the fetch.
 */
export function buildLiveScriptSrc(port, token) {
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    throw new Error('live script port must be an integer from 1 to 65535');
  }
  if (token !== undefined && token !== null) {
    if (typeof token !== 'string' || token.length === 0 || token.length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(token)) {
      throw new Error('live script token must be a non-empty bounded string without control characters');
    }
  }
  const base = `http://localhost:${parsedPort}/live.js`;
  return token ? `${base}?token=${encodeURIComponent(token).replaceAll("'", '%27')}` : base;
}
