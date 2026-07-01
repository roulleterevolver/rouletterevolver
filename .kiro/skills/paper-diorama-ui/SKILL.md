---
name: paper-diorama-ui
description: >
  Design and build 2.5D "paper diorama" game UIs in PixiJS — flat 2D sprites
  arranged to read as a tilted 3D pop-up scene, adapted here to a dark, deadly
  horror palette. Use when working on the Revolver Roulette renderer, HUD,
  scene composition, lighting, or visual style decisions.
keywords:
  - paper diorama
  - 2.5D
  - papercraft
  - UI design
  - pixijs
  - renderer
  - scene
  - HUD
  - visual style
  - dark theme
  - dioarama
---

# Paper Diorama UI Skill

A practical guide for building a **2.5D paper-diorama** look in PixiJS for
Revolver Roulette. The reference inspiration is the cozy floating-island
diorama style (e.g. "Island Harvest"), but the target mood here is **dark,
grimy, and deadly** — cute-game *structure*, horror *lighting and palette*.

The whole point of this style: every object is a **flat 2D sprite**, yet the
scene reads as a 3D pop-up book. You never need real 3D. You fake depth with a
handful of repeatable tricks.

## The Five Core Tricks

Each trick is cheap and composable. Apply all five and the scene "pops."

1. **Tilted diorama platform.** The play surface sits on an angled platform
   with a visible **thick beveled edge** (the dark "cardboard" side). This
   single thick edge does most of the work selling 3D. Render it as: top face
   (the table surface) + a darker front/side face beneath it.

2. **Drop shadows under everything.** Each standing object casts a soft,
   slightly offset (down + toward camera) elliptical shadow onto the surface.
   Cheap, huge payoff, grounds every sprite.

3. **Layered depth + slight parallax.** Separate `Container` layers for
   background, mid-ground, and foreground. A tiny camera sway moves them at
   different speeds. Sort sprites within a layer by their base `y` so nearer
   objects overlap farther ones.

4. **Thick outlines + soft cel shading.** Bold dark borders around every
   sprite, two-tone (light/shadow) shading. This is the "papercraft / sticker"
   signature. In a dark palette the heavy outlines look *more* sinister.

5. **Billboard sprites.** Objects are flat cards standing upright on the
   surface, like a pop-up book. They face the camera and never rotate in 3D.

## Dark & Deadly Reskin

Keep the diorama *structure*, invert the *mood*:

- **Backdrop:** dim void or faint blood-red grid instead of bright teal water.
  The diorama is an interrogation table floating in darkness.
- **Lighting:** a single harsh **overhead spotlight** with a slow dim flicker
  (see the engine's flicker spec: brightness <= 50%, period 100-1000 ms). Deep
  shadows everywhere else.
- **Palette (Buckshot-inspired, NO green):** grimy desaturated charcoal/black
  base (`#0a0a0b`–`#1c1a14`), **bone** off-white for text/skin (`#c9c2b0`),
  **blood red** as the danger/HP accent (`#9e2a22`/`#c1352b`), and a single
  **dim amber lamp** as the only warm light (`#d9a441`, used sparingly). Avoid
  green entirely. Restraint reads as "deadly."
- **Lighting must be STEADY:** a dim amber overhead lamp with only a faint, slow
  waver (barely perceptible) — never a fast strobe. The scene should read clear,
  not murky or seizure-inducing.
- **Outlines:** keep them thick and black; they anchor the papercraft feel.
- **Post-processing:** layer the retro filter chain on top — film grain,
  scanlines, vignette, chromatic aberration — to bind everything into one
  grimy image.

## PixiJS Implementation Notes

- **Scene graph:** one root `Container` (the "stage") with child layer
  containers: `bgLayer`, `dioramaLayer`, `actorLayer`, `hudLayer`. Apply the
  post-processing filter chain to the stage root so it covers every frame.
- **Depth sorting:** enable `sortableChildren = true` on `actorLayer` and set
  each sprite's `zIndex` from its base-line `y`. This gives correct overlap as
  the revolver slides across the table.
- **Shadows:** a separate flattened dark ellipse sprite per actor, placed just
  below the actor's feet/base, with reduced alpha and a slight blur.
- **Billboards:** standard `Sprite`s; just never apply 3D rotation. A subtle
  scale-on-hover or bob tween keeps them feeling alive.
- **Filters:** custom GLSL `Filter`s for grain/scanline/vignette/chromatic,
  each animated by a `time` uniform updated every tick. Brightness/flicker is
  a separate multiply filter.
- **Animation (optional GSAP):** use tweens for the juicy beats — cylinder
  spin, revolver sliding to the active participant, recoil kick, camera
  push-in when the gun points at someone, HUD pulse on HP change. Keep the
  first visible frame of any action feedback within ~200 ms.

## HUD / UI Composition

The reference's HUD ideas map directly, just darkened:

- **Player ID card** (top-left): portrait + name + HP, styled as a grimy,
  worn identity card rather than a cheerful avatar frame.
- **Item belt** (bottom-center toolbar): the six items as slotted cards
  (magnifier, speed loader, medkit, handcuffs, inverter, hollow-point). Reuse
  the classic toolbar pattern; dark frames, accent glow on usable items.
- **Shell tokens on the table:** physical props showing remaining live/blank
  counts (you know the count, not the order).
- **Expressions:** swap papercraft faces for tension — sweat, flinch, relief
  on a blank, a grin when handing over the gun.

## Hard Rules (do not violate)

- **Renderer-only.** Everything in this skill lives in the presentation layer.
  Never let `engine/`, `ai/`, `rng/`, or the tension mapping import PixiJS,
  reference sprites, or depend on visual state. The rules engine stays pure.
- **Performance:** target >= 30 FPS. Keep filters as GPU shaders; batch
  sprites; avoid per-frame allocations in the ticker loop.
- **Graceful failure:** if the WebGL/canvas context fails to init, stop the
  loop and show a "rendering unavailable" overlay while keeping game state
  intact.

## Quick Build Order (when implementing the renderer)

1. Static diorama platform (top + beveled edge) on a dark backdrop.
2. Add drop shadows + billboard actors (dealer, player, revolver).
3. Layer containers + y-sorting + subtle parallax sway.
4. Spotlight + flicker, then the retro filter chain.
5. HUD: ID card, item belt, shell tokens.
6. Action-feedback tweens (spin, slide, recoil, camera push-in, HUD pulse).
