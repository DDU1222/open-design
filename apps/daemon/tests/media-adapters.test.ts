import { describe, expect, it } from 'vitest';

import {
  buildVideoRequest,
  createCapabilityRegistry,
  deriveVideoFamily,
  normalizeModelId,
  snapDuration,
  aihubmixMediaRegistry,
  type ModelCapability,
} from '../src/media-adapters/index.js';

const SEEDANCE: ModelCapability = {
  id: 'doubao-seedance-2-0-260128',
  apiModel: 'doubao-seedance-2-0-260128',
  mediaType: 'video',
  family: 'seedance',
  caps: ['t2v', 'i2v'],
};

const VEO: ModelCapability = {
  id: 'veo-3.1-generate-preview',
  apiModel: 'veo-3.1-generate-preview',
  mediaType: 'video',
  family: 'generic',
  caps: ['t2v', 'i2v'],
  supportedDurations: [4, 6, 8],
};

const DATA_URL = 'data:image/png;base64,aGVsbG8=';

describe('media-adapters registry', () => {
  it('normalizes the aihubmix- prefix on lookup', () => {
    expect(normalizeModelId('aihubmix-doubao-seedance-2-0-260128')).toBe('doubao-seedance-2-0-260128');
    const reg = createCapabilityRegistry([SEEDANCE]);
    expect(reg.get('aihubmix-doubao-seedance-2-0-260128')?.id).toBe(SEEDANCE.id);
    expect(reg.get('doubao-seedance-2-0-260128')?.id).toBe(SEEDANCE.id);
  });

  it('default registry is seeded with known video models', () => {
    expect(aihubmixMediaRegistry.get('doubao-seedance-2-0-260128')?.family).toBe('seedance');
    expect(aihubmixMediaRegistry.get('sora-2')?.family).toBe('generic');
  });
});

describe('deriveVideoFamily', () => {
  it('routes doubao-seedance- to seedance, everything else to generic', () => {
    expect(deriveVideoFamily('doubao-seedance-2-0-260128')).toBe('seedance');
    expect(deriveVideoFamily('wan2.5-i2v-preview')).toBe('generic');
    expect(deriveVideoFamily('sora-2')).toBe('generic');
    expect(deriveVideoFamily('happyhorse-1.0-i2v')).toBe('generic');
  });
});

describe('snapDuration', () => {
  it('snaps to the family allowed set (ties → shorter), clamps when unconstrained', () => {
    expect(snapDuration(VEO, 5)).toBe(4); // veo 4/6/8, tie→shorter
    expect(snapDuration(VEO, 7)).toBe(6);
    expect(snapDuration(VEO, 10)).toBe(8);
    expect(snapDuration(SEEDANCE, 5)).toBe(5); // no constraint → clamp 3-12
    expect(snapDuration(SEEDANCE, 99)).toBe(12);
  });
});

describe('buildVideoRequest — seedance family', () => {
  it('t2v: builds a multimodal content array with the prompt', () => {
    const built = buildVideoRequest(SEEDANCE, { prompt: 'a panda', durationSeconds: 5 });
    expect(built.family).toBe('seedance');
    expect(built.pathSuffix).toBe('/videos');
    expect(built.contentType).toBe('application/json');
    expect(built.hasReference).toBe(false);
    expect(built.body.model).toBe('doubao-seedance-2-0-260128');
    expect(built.body.duration).toBe(5);
    expect(built.body.content).toEqual([{ type: 'text', text: 'a panda' }]);
    expect(built.body.input_reference).toBeUndefined();
  });

  it('i2v: adds the reference image as image_url with role first_frame', () => {
    const built = buildVideoRequest(SEEDANCE, {
      prompt: 'animate the panda',
      durationSeconds: 5,
      imageRef: { dataUrl: DATA_URL },
    });
    expect(built.hasReference).toBe(true);
    const content = built.body.content as any[];
    expect(content[0]).toEqual({ type: 'text', text: 'animate the panda' });
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: DATA_URL },
      role: 'first_frame',
    });
  });
});

describe('buildVideoRequest — generic family', () => {
  it('t2v: flat body with seconds string + size, no input_reference', () => {
    const built = buildVideoRequest(VEO, {
      prompt: 'a sunset',
      durationSeconds: 5, // veo → snapped to 4
      aspectRatio: '16:9',
      size: '1280x720',
    });
    expect(built.family).toBe('generic');
    expect(built.body).toMatchObject({
      model: 'veo-3.1-generate-preview',
      prompt: 'a sunset',
      seconds: '4',
      aspect_ratio: '16:9',
      size: '1280x720',
    });
    expect(built.body.input_reference).toBeUndefined();
  });

  it('i2v: attaches input_reference as the data URL', () => {
    const built = buildVideoRequest(VEO, {
      prompt: 'clip',
      durationSeconds: 6,
      imageRef: { dataUrl: DATA_URL },
    });
    expect(built.hasReference).toBe(true);
    expect(built.body.input_reference).toBe(DATA_URL);
    expect(built.body.seconds).toBe('6');
  });
});

describe('buildVideoRequest — apiModelI2V + passthrough', () => {
  it('switches to apiModelI2V when a reference image is present', () => {
    const cap: ModelCapability = {
      id: 'wan2.5',
      apiModel: 'wan2.5-t2v-preview',
      apiModelI2V: 'wan2.5-i2v-preview',
      mediaType: 'video',
      family: 'generic',
      caps: ['t2v', 'i2v'],
    };
    expect(buildVideoRequest(cap, { prompt: 'x' }).wireModel).toBe('wan2.5-t2v-preview');
    expect(buildVideoRequest(cap, { prompt: 'x', imageRef: { dataUrl: DATA_URL } }).wireModel).toBe(
      'wan2.5-i2v-preview',
    );
  });

  it('merges extraBodyDefaults and only whitelisted passthrough keys', () => {
    const cap: ModelCapability = {
      id: 'm',
      apiModel: 'm',
      mediaType: 'video',
      family: 'generic',
      caps: ['t2v'],
      allowedPassthroughParameters: ['mode'],
      extraBodyDefaults: [{ name: 'mode', type: 'string', default: 'std' }],
    };
    const built = buildVideoRequest(cap, {
      prompt: 'x',
      passthrough: { mode: 'pro', not_allowed: 'drop-me' },
    });
    expect(built.body.mode).toBe('pro'); // passthrough overrides default
    expect(built.body.not_allowed).toBeUndefined(); // non-whitelisted dropped
  });
});
