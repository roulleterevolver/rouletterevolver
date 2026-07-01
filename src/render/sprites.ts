// Sprite asset wiring for the Revolver Roulette renderer.
//
// This module owns the URL map for the SVG art served from Vite's `public/`
// folder (so they resolve at `/assets/sprites/<name>.svg` at runtime) and a
// guarded loader that turns those URLs into PixiJS textures.
//
// Design constraints (see renderer.ts and the renderer tests):
//   - NOTHING here touches WebGL or PixiJS `Assets` at module load. The default
//     loader calls `Assets.load` lazily, only when invoked from the real init
//     path AFTER `app.init()` has resolved successfully.
//   - Loading is graceful per-asset: a failed/missing asset resolves to no
//     texture for that key, and the renderer falls back to its Graphics
//     placeholder for that element (consistent with the Req 8.5 philosophy of
//     keeping the renderer working even when art is unavailable).

import { Assets, type Texture } from "pixi.js";
import type { ItemType } from "../engine/types";

/** Root path the sprites are served from (Vite serves `public/` at `/`). */
export const SPRITE_BASE = "/assets/sprites";

/**
 * The complete set of sprite keys the renderer can use, mapped to the URL the
 * SVG is served from. Item keys use the engine's uppercase `ItemType` while the
 * on-disk file name is the lowercased type (e.g. `item-magnifying_glass.svg`).
 */
export const SPRITE_URLS = {
  dealer: `${SPRITE_BASE}/dealer.svg`,
  player: `${SPRITE_BASE}/player.svg`,
  cylinder: `${SPRITE_BASE}/cylinder.svg`,
  "item-MAGNIFYING_GLASS": `${SPRITE_BASE}/item-magnifying_glass.svg`,
  "item-SPEED_LOADER": `${SPRITE_BASE}/item-speed_loader.svg`,
  "item-MEDKIT": `${SPRITE_BASE}/item-medkit.svg`,
  "item-HANDCUFFS": `${SPRITE_BASE}/item-handcuffs.svg`,
  "item-INVERTER": `${SPRITE_BASE}/item-inverter.svg`,
  "item-HOLLOW_POINT": `${SPRITE_BASE}/item-hollow_point.svg`,
  "shell-live": `${SPRITE_BASE}/shell-live.svg`,
  "shell-blank": `${SPRITE_BASE}/shell-blank.svg`,
} as const;

/** A key into {@link SPRITE_URLS}. */
export type SpriteKey = keyof typeof SPRITE_URLS;

/** Map an engine `ItemType` to its sprite key. */
export function itemSpriteKey(item: ItemType): SpriteKey {
  return `item-${item}` as SpriteKey;
}

/**
 * A function that resolves a URL to a PixiJS texture. Injectable so tests can
 * stub asset loading without a GPU; defaults to PixiJS `Assets.load`.
 */
export type AssetLoader = (url: string) => Promise<Texture>;

/** The default loader, backed by PixiJS `Assets`. Called lazily, never at import. */
export const defaultAssetLoader: AssetLoader = (url) => Assets.load<Texture>(url);

/** The textures successfully loaded, keyed by {@link SpriteKey}. Missing = fallback. */
export type TextureMap = Partial<Record<SpriteKey, Texture>>;

/**
 * Load every sprite texture using `loader`, guarding each load independently.
 * A failed or missing asset is simply omitted from the returned map so the
 * renderer can fall back to its Graphics placeholder for that element. This
 * never rejects.
 */
export async function loadSpriteTextures(
  loader: AssetLoader = defaultAssetLoader,
): Promise<TextureMap> {
  const out: TextureMap = {};
  const entries = Object.entries(SPRITE_URLS) as ReadonlyArray<[SpriteKey, string]>;
  await Promise.all(
    entries.map(async ([key, url]) => {
      try {
        const texture = await loader(url);
        if (texture) out[key] = texture;
      } catch {
        // Graceful degradation: leave this key unset; renderer uses a placeholder.
      }
    }),
  );
  return out;
}
