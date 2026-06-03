// Video request builder (layer ②) — pure, transport-free.
//
// Mirrors aihubmix-video's lib/server/video/create-task.ts family branching:
//   • seedance (apiModel starts `doubao-seedance-`) → JSON with a multimodal
//     `content[]` array (text + image_url{url,role:first_frame}); duration/ratio/resolution.
//   • everything else (generic: wan / sora / happyhorse / …) → flat JSON
//     { model, prompt, seconds, aspect_ratio?, size?, input_reference? } with the
//     reference image as a data URL.
// The caller resolves the reference image to a data URL beforehand and attaches
// auth + base URL afterward; this module only shapes the body.

import type {
  BuiltVideoRequest,
  MediaFamily,
  ModelCapability,
  VideoBuildInput,
} from './types.js';

/** Resolve the upstream model name: i2v variant when a reference image is present. */
export function resolveWireModel(cap: ModelCapability, hasReference: boolean): string {
  return hasReference && cap.apiModelI2V ? cap.apiModelI2V : cap.apiModel;
}

/** Derive the request family from the resolved upstream model name (or explicit override). */
export function deriveVideoFamily(wireModel: string, cap?: ModelCapability): MediaFamily {
  if (cap?.family) return cap.family;
  return wireModel.startsWith('doubao-seedance-') ? 'seedance' : 'generic';
}

/**
 * Snap a requested duration to the model's allowed set (e.g. Veo 4/6/8, wan 5/10).
 * Falls back to a 3–12 clamp when the model declares no constraint. Ties prefer
 * the shorter value.
 */
export function snapDuration(cap: ModelCapability, requested: number | undefined): number {
  const req = Number.isFinite(requested) ? (requested as number) : 5;
  const allowed = cap.supportedDurations;
  if (!allowed || allowed.length === 0) {
    return Math.min(12, Math.max(3, Math.round(req)));
  }
  return allowed.reduce(
    (best, v) => (Math.abs(v - req) < Math.abs(best - req) ? v : best),
    allowed[0]!,
  );
}

/** Apply extraBodyDefaults, then overlay caller passthrough filtered by the whitelist. */
function mergeExtraBody(
  body: Record<string, unknown>,
  cap: ModelCapability,
  passthrough: Record<string, unknown> | undefined,
): void {
  for (const def of cap.extraBodyDefaults ?? []) {
    if (def.default !== undefined) body[def.name] = def.default;
  }
  if (passthrough && cap.allowedPassthroughParameters?.length) {
    const allow = new Set(cap.allowedPassthroughParameters);
    for (const [k, v] of Object.entries(passthrough)) {
      if (allow.has(k) && v !== undefined) body[k] = v;
    }
  }
}

/** Build the seedance multimodal content array (text + reference images). */
function buildSeedanceContent(input: VideoBuildInput): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }];
  if (input.imageRef?.dataUrl) {
    content.push({
      type: 'image_url',
      image_url: { url: input.imageRef.dataUrl },
      role: 'first_frame',
    });
  }
  for (const ref of input.extraImageRefs ?? []) {
    if (ref?.dataUrl) {
      content.push({
        type: 'image_url',
        image_url: { url: ref.dataUrl },
        role: 'reference_image',
      });
    }
  }
  return content;
}

/**
 * Build the upstream video request body for a model. Pure: no fetch, no auth.
 * Caller: POST `${baseUrl}${pathSuffix}` with auth headers + JSON.stringify(body).
 */
export function buildVideoRequest(cap: ModelCapability, input: VideoBuildInput): BuiltVideoRequest {
  const hasReference = Boolean(input.imageRef?.dataUrl);
  const wireModel = resolveWireModel(cap, hasReference);
  const family = deriveVideoFamily(wireModel, cap);
  const seconds = snapDuration(cap, input.durationSeconds);

  let body: Record<string, unknown>;
  if (family === 'seedance') {
    body = {
      model: wireModel,
      prompt: input.prompt,
      duration: seconds,
      content: buildSeedanceContent(input),
    };
    const resolution = input.resolution || input.size;
    if (resolution) body.resolution = resolution;
    if (input.aspectRatio) body.ratio = input.aspectRatio;
    if (typeof input.generateAudio === 'boolean') body.generate_audio = input.generateAudio;
    if (typeof input.seed === 'number') body.seed = input.seed;
  } else {
    body = {
      model: wireModel,
      prompt: input.prompt,
      seconds: String(seconds),
    };
    if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;
    if (input.size) body.size = input.size;
    if (input.resolution) body.resolution = input.resolution;
    if (hasReference) body.input_reference = input.imageRef!.dataUrl;
    if (typeof input.generateAudio === 'boolean') body.generate_audio = input.generateAudio;
    if (typeof input.seed === 'number') body.seed = input.seed;
  }

  mergeExtraBody(body, cap, input.passthrough);

  return {
    wireModel,
    family,
    pathSuffix: '/videos',
    contentType: 'application/json',
    body,
    hasReference,
  };
}

export interface NormalizedVideoResponse {
  id?: string;
  status?: string;
  /** Inline asset URL when the upstream returns one. */
  url?: string;
  error?: string;
}

/** Best-effort normalization of an async-submit / poll response across families. */
export function normalizeVideoResponse(raw: unknown): NormalizedVideoResponse {
  const d = (raw ?? {}) as Record<string, any>;
  const id = d.id || d.task_id || d.data?.id || d.data?.task_id;
  const status = d.status || d.data?.status;
  const url =
    d.video_url
    || d.url
    || d.output_url
    || d.data?.video_url
    || d.data?.url
    || (Array.isArray(d.data) ? d.data[0]?.url : undefined)
    || (Array.isArray(d.unsigned_urls) ? d.unsigned_urls[0] : undefined);
  const error =
    d.error?.message || (typeof d.error === 'string' ? d.error : undefined) || d.failure_reason || d.message;
  return {
    ...(id ? { id: String(id) } : {}),
    ...(status ? { status: String(status) } : {}),
    ...(url ? { url: String(url) } : {}),
    ...(error ? { error: String(error) } : {}),
  };
}
