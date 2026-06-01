// AIHubMix BYOK provider — shared identity + outbound header helper.
//
// AIHubMix (https://aihubmix.com) is an OpenAI-wire-compatible aggregator
// gateway: a single API key fronts OpenAI / Anthropic / Gemini models, routed
// by model name on the upstream side (`claude*` → Anthropic, `gemini*/imagen*`
// → Gemini, everything else → OpenAI). Because the wire shape is identical to
// OpenAI's, the chat proxy, connection test, model discovery and media
// renderers all reuse the OpenAI call shape — the ONLY thing that differs is
// the outbound headers, which is why every outbound call point funnels through
// `aihubmixHeaders()` rather than hand-building `Authorization` inline.
//
// The distinctive AIHubMix detail is the `APP-Code` attribution header: a
// fixed per-integration code that grants a usage discount (the same mechanism
// cherry-studio and the dify plugin use). Injecting it in one helper keeps the
// invariant "every AIHubMix request carries our APP-Code" enforceable in one
// place instead of being re-derived at each call site.

// Fixed App Code for this integration (from https://aihubmix.com/appstore).
// Sent as the APP-Code attribution header on every AIHubMix request to grant
// the integration's usage discount. When empty, the header is omitted and the
// integration still works (just without the discount).
export const AIHUBMIX_APP_CODE = 'DMCY9912';

// Default base URL the daemon assumes when the BYOK form leaves the field
// blank. Kept here as the single source of truth so the chat proxy, media
// renderers and connection test all default to the same origin.
export const AIHUBMIX_DEFAULT_BASE_URL = 'https://aihubmix.com/v1';

/**
 * Build the outbound header set for an AIHubMix request: Bearer auth plus the
 * fixed `APP-Code` attribution header (omitted when unset). Callers spread the
 * result into their `fetch` headers and may add `content-type` etc. on top.
 */
export function aihubmixHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
  };
  if (AIHUBMIX_APP_CODE) {
    headers['APP-Code'] = AIHUBMIX_APP_CODE;
  }
  return headers;
}

/**
 * The APP-Code attribution header on its own (no auth). For the Anthropic /
 * Gemini routes, which carry their own auth header (`x-api-key` /
 * `x-goog-api-key`) — spread this alongside it so every AIHubMix request,
 * whatever the wire protocol, still carries APP-Code.
 */
export function aihubmixAppCodeHeader(): Record<string, string> {
  return AIHUBMIX_APP_CODE ? { 'APP-Code': AIHUBMIX_APP_CODE } : {};
}

// Model-name → upstream protocol routing (AIHubMix integration guide §4.3).
// AIHubMix dispatches by model name on its side, but for native fidelity
// (claude thinking, gemini-specific features, imagen) the recommended client
// pattern is to call each family on its native wire/endpoint rather than the
// unified OpenAI endpoint. We classify here and route in the chat proxy +
// media renderer.
export type AIHubMixProtocol = 'openai' | 'anthropic' | 'gemini';

export function classifyAIHubMixModel(model: string): AIHubMixProtocol {
  const m = (model || '').trim().toLowerCase();
  // Gemini: gemini*/imagen*, excluding the `-nothink`/`-search` suffixes and
  // any embedding model (those stay on the OpenAI-compatible path per §4.1).
  if (
    (m.startsWith('gemini') || m.startsWith('imagen'))
    && !/-(nothink|search)$/.test(m)
    && !m.includes('embedding')
  ) {
    return 'gemini';
  }
  if (m.startsWith('claude')) return 'anthropic';
  return 'openai';
}

/**
 * Origin of the configured AIHubMix base URL — the three protocol clients all
 * derive their endpoint from it:
 *   openai    → `${origin}/v1`
 *   anthropic → `${origin}` (+ /v1/messages)
 *   gemini    → `${origin}/gemini` (+ /v1beta/models/{model}:...)
 */
export function aihubmixOriginFromBase(baseUrl: string): string {
  try {
    return new URL(baseUrl || AIHUBMIX_DEFAULT_BASE_URL).origin;
  } catch {
    return 'https://aihubmix.com';
  }
}

// Catalogue ids vs wire names. The media registry requires globally-unique
// model ids, but `gpt-image-1` / `dall-e-3` / `tts-1` are already owned by the
// `openai` provider. So AIHubMix's models are registered with an `aihubmix-`
// prefix and mapped back to the real upstream name here. A plain prefix strip
// is the fallback so adding a new `aihubmix-<wire>` entry needs no edit here.
const AIHUBMIX_WIRE_MODELS: Record<string, string> = {
  'aihubmix-gpt-image-1': 'gpt-image-1',
  'aihubmix-dall-e-3': 'dall-e-3',
  'aihubmix-tts-1': 'tts-1',
};

export function aihubmixWireModel(catalogId: string): string {
  return AIHUBMIX_WIRE_MODELS[catalogId] ?? catalogId.replace(/^aihubmix-/, '');
}

// AIHubMix publishes its catalogue on a NON-OpenAI endpoint:
//   GET https://aihubmix.com/api/v1/models?type=llm
//   GET https://aihubmix.com/api/v1/models?type=image_generation
// (public, no auth required) returning `{ data: [{ model_id, model_name,
// types, ... }] }` — note `model_id`/`model_name`, not the OpenAI `id`. This
// lives under the host's `/api/v1` path, not the chat base's `/v1`, so we
// derive the origin from the configured base URL and append the catalogue path.
export type AIHubMixCatalogType = 'llm' | 'image_generation' | 'tts' | 'video';

export function aihubmixCatalogUrl(baseUrl: string, type: AIHubMixCatalogType): string {
  let origin: string;
  try {
    origin = new URL(baseUrl || AIHUBMIX_DEFAULT_BASE_URL).origin;
  } catch {
    origin = 'https://aihubmix.com';
  }
  return `${origin}/api/v1/models?type=${type}`;
}

export interface AIHubMixCatalogModel {
  id: string;
  label: string;
}

/** Parse the AIHubMix catalogue envelope into { id, label } options. Reads
 *  `model_id` (the wire name sent as `model`) and `model_name` (display). */
export function parseAIHubMixCatalog(data: unknown): AIHubMixCatalogModel[] {
  const rows = (data as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const out: AIHubMixCatalogModel[] = [];
  for (const row of rows) {
    const id = typeof (row as { model_id?: unknown })?.model_id === 'string'
      ? (row as { model_id: string }).model_id
      : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof (row as { model_name?: unknown })?.model_name === 'string'
      ? (row as { model_name: string }).model_name
      : '';
    out.push({ id, label: name || id });
  }
  return out;
}

// Aspect → pixel size for the chat `generate_image` tool. Tuned for the
// default model (gpt-image-1, which accepts 1024×1024 / 1536×1024 /
// 1024×1536). The CLI/media renderer path uses media.ts's model-aware
// `openaiSizeFor` instead; this conservative table keeps the tool call from
// 400-ing on an unsupported size.
export const AIHUBMIX_IMAGE_ASPECT_TO_SIZE: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:3': '1536x1024',
  '3:4': '1024x1536',
};
