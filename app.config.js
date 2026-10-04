/**
 * Dynamic app config.
 *
 * `app.json` stays the single source of truth for everything. This file exists
 * for exactly one reason: the authenticated dashboard has to be exported under
 * `/app` so it can live on sellflow-site.vercel.app *beside* the marketing site
 * rather than replacing it, and `experiments.baseUrl` cannot be expressed in a
 * static app.json.
 *
 * Expo hands the normalised `app.json` (minus its `expo:` wrapper) to this
 * function, and uses the return value as the final config.
 *
 * Set `EXPO_ROUTER_BASE_PATH=/app` for the web export only -- that is what
 * `website/build-dashboard.mjs` does. Left unset, which is every Android build
 * and every `expo start`, the field is absent entirely and the APK is unaffected.
 * That matters: a base path baked into a native build would be a silently wrong
 * deep link on a device, so it must never leak out of the web export.
 */
module.exports = ({ config }) => {
  const basePath = (process.env.EXPO_ROUTER_BASE_PATH ?? '').trim();

  if (!basePath) return config;

  return {
    ...config,
    experiments: {
      ...config.experiments,
      // Leading slash is required: without it assets resolve relative to
      // whatever document requested them, which is how a dashboard mounted at
      // /app ends up 404ing its own bundle on a hard refresh.
      baseUrl: basePath.startsWith('/') ? basePath : `/${basePath}`,
    },
  };
};
