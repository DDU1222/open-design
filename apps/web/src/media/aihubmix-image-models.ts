// Live AIHubMix image-model catalogue for the media pickers.
//
// The static IMAGE_MODELS registry only seeds a couple of AIHubMix entries.
// AIHubMix actually exposes ~50 image models that change over time, so the
// pickers fetch the live list from the daemon
// (GET /api/media/providers/aihubmix/models?type=image_generation, which
// proxies AIHubMix's public catalogue and prefixes ids `aihubmix-`). The
// fetched ids render through the same OpenAI-compatible AIHubMix renderer, so
// no per-model wiring is needed.
//
// The result is cached at module scope (one fetch per page load) and exposed
// via a hook so every image picker shows the same list without each surface
// issuing its own request.
import { useEffect, useState } from 'react';
import type { MediaModel } from './models';

type FetchedModel = { id: string; label: string };

function toMediaModel(m: FetchedModel): MediaModel {
  return {
    id: m.id,
    label: m.label,
    hint: 'AIHubMix',
    provider: 'aihubmix',
    caps: ['t2i', 'i2i'],
  };
}

export async function fetchAIHubMixImageModels(
  signal?: AbortSignal,
): Promise<MediaModel[]> {
  const res = await fetch(
    '/api/media/providers/aihubmix/models?type=image_generation',
    { signal },
  );
  if (!res.ok) throw new Error(`aihubmix image catalog ${res.status}`);
  const payload = (await res.json()) as { models?: FetchedModel[] };
  const rows = Array.isArray(payload?.models) ? payload.models : [];
  return rows
    .filter((m) => typeof m?.id === 'string' && m.id)
    .map(toMediaModel);
}

/**
 * Merge the live AIHubMix image list into a base IMAGE_MODELS array: drop the
 * static `aihubmix` seeds and append the fetched list. When the fetch hasn't
 * resolved (or failed), `dynamic` is empty and the base seeds are kept, so the
 * picker is never empty for AIHubMix.
 */
export function mergeAihubmixImageModels(
  base: MediaModel[],
  dynamic: MediaModel[],
): MediaModel[] {
  if (!dynamic.length) return base;
  const withoutSeeds = base.filter((m) => m.provider !== 'aihubmix');
  return [...withoutSeeds, ...dynamic];
}

// Module-scope cache so multiple pickers mounting in the same session share one
// network request. The promise is memoized; a failed fetch resets it so a later
// mount can retry.
let cachedModels: MediaModel[] = [];
let inFlight: Promise<MediaModel[]> | null = null;

function loadOnce(): Promise<MediaModel[]> {
  if (cachedModels.length) return Promise.resolve(cachedModels);
  if (!inFlight) {
    inFlight = fetchAIHubMixImageModels()
      .then((models) => {
        cachedModels = models;
        return models;
      })
      .catch((err) => {
        inFlight = null; // allow retry on next mount
        throw err;
      });
  }
  return inFlight;
}

/**
 * Hook returning the live AIHubMix image models (empty until the first fetch
 * resolves). Safe to call from any image picker; the underlying request is
 * shared across mounts.
 */
export function useAIHubMixImageModels(): MediaModel[] {
  const [models, setModels] = useState<MediaModel[]>(cachedModels);
  useEffect(() => {
    let active = true;
    loadOnce()
      .then((fetched) => {
        if (active) setModels(fetched);
      })
      .catch(() => {
        // Non-fatal: pickers fall back to the static seed models.
      });
    return () => {
      active = false;
    };
  }, []);
  return models;
}
