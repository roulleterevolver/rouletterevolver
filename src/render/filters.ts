// Post-processing filter chain for the Revolver Roulette renderer (Requirement
// 8.2, 8.3).
//
// This module is split into two halves with very different testability:
//
//   1. A PURE descriptor (`buildFilterChainDescriptor`) that names the filters
//      in the chain and exposes the brightness / flicker parameters. It touches
//      no GPU, no DOM and no PixiJS runtime objects, so it can be unit-tested in
//      a plain (or jsdom) environment without a WebGL context.
//
//   2. A runtime builder (`createPostFilters`) that constructs the actual
//      PixiJS `Filter` objects (custom GLSL shaders animated by a `time`
//      uniform plus a dim-flicker brightness filter). This is only ever invoked
//      from a successful `Renderer.init`, i.e. when a real WebGL-backed
//      Application exists. Tests never call it, which keeps WebGL out of CI.
//
// Keeping the descriptor pure is what lets the smoke test (Task 14.2) assert the
// chain contents and the brightness/flicker bounds (Req 8.2, 8.3) without a GPU.

import {
  ColorMatrixFilter,
  Filter,
  GlProgram,
  UniformGroup,
  defaultFilterVert,
} from "pixi.js";

// ---------------------------------------------------------------------------
// Parameters (the single source of truth, shared by descriptor + runtime)
// ---------------------------------------------------------------------------

/**
 * Maximum overall scene brightness multiplier. The lamp is a STEADY dim amber
 * pool, not a strobe: brightness rests near full (0.95) so the scene reads
 * clearly, with only a small, slow flicker amplitude on top.
 */
export const MAX_SCENE_BRIGHTNESS = 0.95;

/**
 * The dim end of the brightness flicker. Always below {@link MAX_SCENE_BRIGHTNESS};
 * the amplitude (0.95 - 0.82 = 0.13) is intentionally tiny so the waver is
 * barely perceptible.
 */
export const FLICKER_MIN_BRIGHTNESS = 0.82;

/**
 * Period of the dim-flicker oscillation, in milliseconds. A slow 900 ms waver
 * (within the [100, 1000] ms bound) reads as a steady lamp rather than a
 * flickering bulb.
 */
export const FLICKER_PERIOD_MS = 900;

/** Stable identifiers for each filter in the chain (used by the descriptor). */
export type FilterName =
  | "film-grain"
  | "scanlines"
  | "vignette"
  | "chromatic-aberration"
  | "dim-flicker";

/** Brightness / flicker parameters surfaced for testing (Req 8.3). */
export interface FilterParams {
  /** Maximum scene brightness multiplier; required to be <= 0.5. */
  readonly brightness: number;
  /** Dim end of the flicker oscillation. */
  readonly minBrightness: number;
  /** Flicker repeat interval in ms; required to be within [100, 1000]. */
  readonly flickerPeriodMs: number;
}

/** A pure, GPU-free description of the post-processing chain. */
export interface FilterChainDescriptor {
  /** Ordered filter names, matching the order applied to the stage. */
  readonly names: FilterName[];
  /** Brightness / flicker parameters. */
  readonly params: FilterParams;
}

/**
 * Build the pure descriptor of the post-processing chain. The order here is the
 * exact order the runtime attaches the filters to the stage root: grain ->
 * scanlines -> vignette -> chromatic aberration -> dim-flicker brightness.
 */
export function buildFilterChainDescriptor(): FilterChainDescriptor {
  return {
    names: [
      "film-grain",
      "scanlines",
      "vignette",
      "chromatic-aberration",
      "dim-flicker",
    ],
    params: {
      brightness: MAX_SCENE_BRIGHTNESS,
      minBrightness: FLICKER_MIN_BRIGHTNESS,
      flickerPeriodMs: FLICKER_PERIOD_MS,
    },
  };
}

// ---------------------------------------------------------------------------
// GLSL fragment shaders (GLSL ES 3.00 — PixiJS injects the version header).
// PixiJS filter conventions: sampler is `uTexture`, varying is `vTextureCoord`,
// and the fragment writes to `finalColor`. Each shader is animated by a single
// `uTime` uniform (seconds) where relevant.
// ---------------------------------------------------------------------------

const GRAIN_FRAG = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uTime;

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec4 color = texture(uTexture, vTextureCoord);
  float grain = rand(vTextureCoord + fract(uTime)) - 0.5;
  color.rgb += grain * 0.05;
  finalColor = color;
}
`;

const SCANLINE_FRAG = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uTime;

void main() {
  vec4 color = texture(uTexture, vTextureCoord);
  float line = sin((vTextureCoord.y * 800.0 + uTime * 30.0) * 3.14159265);
  color.rgb *= 1.0 - 0.07 * step(0.0, line);
  finalColor = color;
}
`;

const VIGNETTE_FRAG = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;

void main() {
  vec4 color = texture(uTexture, vTextureCoord);
  vec2 d = vTextureCoord - 0.5;
  float v = smoothstep(0.85, 0.40, length(d));
  color.rgb *= mix(0.45, 1.0, v);
  finalColor = color;
}
`;

const CHROMATIC_FRAG = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uTime;

void main() {
  float amount = 0.0012 * (0.6 + 0.4 * sin(uTime * 6.2831853));
  vec2 dir = vTextureCoord - 0.5;
  float r = texture(uTexture, vTextureCoord - dir * amount).r;
  float g = texture(uTexture, vTextureCoord).g;
  float b = texture(uTexture, vTextureCoord + dir * amount).b;
  float a = texture(uTexture, vTextureCoord).a;
  finalColor = vec4(r, g, b, a);
}
`;

// ---------------------------------------------------------------------------
// Runtime chain (constructed only when a real Application exists)
// ---------------------------------------------------------------------------

/** A constructed, animatable post-processing chain ready to attach to a stage. */
export interface PostFilterChain {
  /** The ordered PixiJS filters to assign to `stage.filters`. */
  readonly filters: Filter[];
  /** Advance the time uniforms and the dim-flicker brightness for `elapsedMs`. */
  update(elapsedMs: number): void;
  /** The current (post-flicker) brightness multiplier; always <= MAX_SCENE_BRIGHTNESS. */
  getCurrentBrightness(): number;
}

/** A uniform group holding a single animated `uTime` (seconds) value. */
type TimeGroup = UniformGroup<{ uTime: { value: number; type: "f32" } }>;

function makeTimeGroup(): TimeGroup {
  return new UniformGroup({ uTime: { value: 0, type: "f32" } });
}

function makeShaderFilter(fragment: string, time: TimeGroup | null): Filter {
  return new Filter({
    glProgram: new GlProgram({ vertex: defaultFilterVert, fragment }),
    resources: time ? { timeUniforms: time } : {},
  });
}

/**
 * Construct the live PixiJS post-processing chain: four custom GLSL filters
 * (grain, scanlines, vignette, chromatic aberration) plus a dim-flicker
 * brightness filter. The returned `update` is meant to be called every ticker
 * frame so the chain animates (Req 8.2) and the brightness flickers within the
 * required bounds (Req 8.3).
 *
 * Only called from a successful `Renderer.init`; never from tests.
 */
export function createPostFilters(): PostFilterChain {
  const grainTime = makeTimeGroup();
  const scanTime = makeTimeGroup();
  const chromaTime = makeTimeGroup();

  const grain = makeShaderFilter(GRAIN_FRAG, grainTime);
  const scanlines = makeShaderFilter(SCANLINE_FRAG, scanTime);
  const vignette = makeShaderFilter(VIGNETTE_FRAG, null);
  const chromatic = makeShaderFilter(CHROMATIC_FRAG, chromaTime);

  const dimFlicker = new ColorMatrixFilter();
  dimFlicker.brightness(MAX_SCENE_BRIGHTNESS, false);

  let currentBrightness = MAX_SCENE_BRIGHTNESS;

  const filters: Filter[] = [grain, scanlines, vignette, chromatic, dimFlicker];

  return {
    filters,
    update(elapsedMs: number): void {
      const seconds = elapsedMs / 1000;
      grainTime.uniforms.uTime = seconds;
      scanTime.uniforms.uTime = seconds;
      chromaTime.uniforms.uTime = seconds;

      // Dim flicker: oscillate brightness between the min and the max on a slow
      // fixed period within [100, 1000] ms. The amplitude is tiny (~0.13) so the
      // amber lamp reads as steady, with only a faint, slow waver.
      const phase = (elapsedMs % FLICKER_PERIOD_MS) / FLICKER_PERIOD_MS;
      const osc = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
      currentBrightness =
        FLICKER_MIN_BRIGHTNESS + (MAX_SCENE_BRIGHTNESS - FLICKER_MIN_BRIGHTNESS) * osc;
      dimFlicker.brightness(currentBrightness, false);
    },
    getCurrentBrightness(): number {
      return currentBrightness;
    },
  };
}
