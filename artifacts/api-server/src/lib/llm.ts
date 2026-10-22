import OpenAI from "openai";

/**
 * Which model provider the API talks to, and with what credentials.
 *
 * Previously the base URL and the model name were string literals duplicated in
 * two files — `routes/routes.ts` and `replit_integrations/chat/routes.ts` — each
 * with its own copy of the same lazy accessor. Switching provider meant editing
 * two files and hoping neither was missed, and the duplication is why a provider
 * outage could not be routed around at all: there was nothing to set.
 *
 * Three environment variables now decide it, with defaults that reproduce the
 * previous behaviour exactly:
 *
 *   LLM_API_KEY   the credential. Falls back to MISTRAL_API_KEY when unset, so
 *                 rolling this change back needs no code change and no env edit.
 *   LLM_BASE_URL  the OpenAI-compatible endpoint. Default api.mistral.ai/v1.
 *   LLM_MODEL     the model id. Default mistral-small-latest.
 *
 * Read at call time, not at import. `/api/version` reads RENDER_GIT_COMMIT the
 * same way and for the same reason: the bundle is built once, and what the
 * platform actually set is what should take effect. A module-level const would
 * freeze the config at the first import and make a provider switch require a
 * rebuild rather than a restart.
 *
 * Lazy, deliberately. The client is constructed on first use, so a missing key
 * fails the AI requests and nothing else — the server still boots and
 * `/api/healthz` still answers. Making this fail fast at boot would turn a
 * degraded AI feature into a dead container, which is a worse failure for a
 * service whose calculator does not need a model at all.
 */

const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
const DEFAULT_MODEL = "mistral-small-latest";

/** Trim and treat whitespace-only as absent: a blank env var is not a value. */
function env(name: string): string | undefined {
  const raw = process.env[name];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The API key, `LLM_API_KEY` first and `MISTRAL_API_KEY` second.
 *
 * The fallback is the rollback path. Reverting this commit leaves a deployment
 * whose only key is `MISTRAL_API_KEY` working, and a deployment that has already
 * moved to `LLM_API_KEY` keeps working after the revert only if the old name is
 * still set — which is why the ruling for this change has to say so.
 */
export function llmApiKey(): string | undefined {
  return env("LLM_API_KEY") ?? env("MISTRAL_API_KEY");
}

export function llmBaseUrl(): string {
  return env("LLM_BASE_URL") ?? DEFAULT_BASE_URL;
}

export function llmModel(): string {
  return env("LLM_MODEL") ?? DEFAULT_MODEL;
}

let _client: OpenAI | null = null;

/**
 * The shared OpenAI-compatible client.
 *
 * Named for what it is rather than for one provider: `getMistral` was accurate
 * only while the endpoint was hardcoded, and a name that says Mistral while the
 * env says something else is the kind of comment-shaped lie this repository has
 * been removing.
 */
export function getLlmClient(): OpenAI {
  if (_client) return _client;

  const apiKey = llmApiKey();
  if (!apiKey) {
    throw new Error(
      "No LLM API key configured. Set LLM_API_KEY (or MISTRAL_API_KEY).",
    );
  }

  _client = new OpenAI({ apiKey, baseURL: llmBaseUrl() });
  return _client;
}

/**
 * Drop the memoised client.
 *
 * A test seam, and the only reason it is exported. The client caches the key and
 * base URL it was built with, so a test that changes the environment has to
 * discard it or it asserts against the previous configuration. Production never
 * calls this: a running container's provider does not change under it.
 */
export function resetLlmClient(): void {
  _client = null;
}
