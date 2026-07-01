// @vitest-environment jsdom
//
// Feature: revolver-roulette, Task 14 — Renderer smoke + integration tests.
//
// These are smoke/integration tests (NOT property tests), so no property tag is
// needed. PixiJS needs a DOM + WebGL; jsdom provides the DOM but no WebGL, so
// every assertion here exercises the renderer's PURE helpers (filter-chain
// descriptor, GameState -> HUD view-model, GameEvent -> feedback descriptor) or
// the injected-app failure path. A real WebGL context is NEVER created:
//   - 14.2 tests the filter-chain *descriptor* and its brightness/flicker params.
//   - 14.3 tests the pure mappings and forces `Application.init` to throw via an
//     injected app factory, so no GPU/WebGL is touched.

import { describe, it, expect } from "vitest";
import {
  Renderer,
  buildFilterChainDescriptor,
  toHudViewModel,
  toFeedbackDescriptor,
  FEEDBACK_MAX_DELAY_MS,
  type PixiAppLike,
} from "../../src/render/renderer";
import {
  MAX_SCENE_BRIGHTNESS,
  FLICKER_PERIOD_MS,
} from "../../src/render/filters";
import { createMatch, DEFAULT_CONFIG } from "../../src/engine/lifecycle";
import { SeededRng } from "../../src/rng/rng";
import type {
  Chamber,
  GameEvent,
  GameState,
  ItemType,
  ParticipantId,
} from "../../src/engine/types";

// ---------------------------------------------------------------------------
// Helpers to build a deterministic GameState with a precisely-known cylinder.
// ---------------------------------------------------------------------------

interface Overrides {
  chambers: Chamber[];
  currentIndex?: number;
  active?: ParticipantId;
  phase?: GameState["phase"];
  playerHp?: number;
  aiHp?: number;
  playerItems?: ItemType[];
  aiItems?: ItemType[];
  winner?: ParticipantId | null;
}

function makeState(seed: number, o: Overrides): GameState {
  const base = createMatch(DEFAULT_CONFIG, new SeededRng(seed)).state;
  return {
    ...base,
    phase: o.phase ?? base.phase,
    winner: o.winner ?? null,
    cylinder: {
      chambers: o.chambers.slice(),
      currentIndex: o.currentIndex ?? 0,
      size: o.chambers.length,
    },
    activeParticipant: o.active ?? "PLAYER",
    participants: {
      PLAYER: {
        ...base.participants.PLAYER,
        hp: o.playerHp ?? base.participants.PLAYER.hp,
        items: o.playerItems ?? base.participants.PLAYER.items,
      },
      AI: {
        ...base.participants.AI,
        hp: o.aiHp ?? base.participants.AI.hp,
        items: o.aiItems ?? base.participants.AI.items,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 14.2 — smoke: filter chain contents + brightness/flicker bounds
// _Requirements: 8.1, 8.2, 8.3_
// ---------------------------------------------------------------------------

describe("Renderer — 14.2 filter chain smoke (Req 8.1-8.3)", () => {
  it("includes film grain, scanlines, vignette, and chromatic aberration", () => {
    const { names } = buildFilterChainDescriptor();
    expect(names).toContain("film-grain");
    expect(names).toContain("scanlines");
    expect(names).toContain("vignette");
    expect(names).toContain("chromatic-aberration");
  });

  it("exposes the same descriptor through the Renderer instance", () => {
    const renderer = new Renderer();
    const names = renderer.getFilterChainDescriptor().names;
    expect(names).toEqual([
      "film-grain",
      "scanlines",
      "vignette",
      "chromatic-aberration",
      "dim-flicker",
    ]);
  });

  it("keeps scene brightness within full and the flicker subtle (Req 8.3)", () => {
    const { params } = buildFilterChainDescriptor();
    expect(params.brightness).toBeLessThanOrEqual(1.0);
    expect(params.brightness).toBe(MAX_SCENE_BRIGHTNESS);
    expect(params.minBrightness).toBeLessThanOrEqual(params.brightness);
    // The lamp is a steady dim amber pool, not a strobe: tiny flicker amplitude.
    expect(params.brightness - params.minBrightness).toBeLessThanOrEqual(0.2);
  });

  it("keeps the flicker period within [100, 1000] ms (Req 8.3)", () => {
    const { params } = buildFilterChainDescriptor();
    expect(params.flickerPeriodMs).toBeGreaterThanOrEqual(100);
    expect(params.flickerPeriodMs).toBeLessThanOrEqual(1000);
    expect(params.flickerPeriodMs).toBe(FLICKER_PERIOD_MS);
  });
});

// ---------------------------------------------------------------------------
// 14.3 — integration: GameState -> HUD view-model, feedback timing, init failure
// _Requirements: 8.4, 8.5_
// ---------------------------------------------------------------------------

describe("Renderer — 14.3 HUD view-model mapping (Req 2.6, 5.11, 7.4)", () => {
  it("maps HP pip counts for both participants (Req 2.6)", () => {
    const state = makeState(1, {
      chambers: ["LIVE", "BLANK", "LIVE"],
      playerHp: 2,
      aiHp: 4,
    });
    const vm = toHudViewModel(state);

    expect(vm.player.hp.current).toBe(2);
    expect(vm.player.hp.max).toBe(DEFAULT_CONFIG.startingHp);
    expect(vm.dealer.hp.current).toBe(4);
    expect(vm.dealer.hp.max).toBe(DEFAULT_CONFIG.startingHp);
  });

  it("maps the item belts from each participant's items (Req 5.11)", () => {
    const playerItems: ItemType[] = ["MAGNIFYING_GLASS", "MEDKIT"];
    const aiItems: ItemType[] = ["HANDCUFFS"];
    const state = makeState(2, {
      chambers: ["LIVE", "BLANK"],
      playerItems,
      aiItems,
    });
    const vm = toHudViewModel(state);

    expect(vm.player.items).toEqual(playerItems);
    expect(vm.dealer.items).toEqual(aiItems);
  });

  it("maps the visible round counts from the cylinder", () => {
    const state = makeState(3, {
      // Two unfired live, three unfired blank; one already fired (null).
      chambers: [null, "LIVE", "LIVE", "BLANK", "BLANK", "BLANK"],
      currentIndex: 1,
    });
    const vm = toHudViewModel(state);

    expect(vm.liveRemaining).toBe(2);
    expect(vm.blankRemaining).toBe(3);
    expect(vm.roundsRemaining).toBe(5);
  });

  it("surfaces the winner only when the Match is over (Req 7.4)", () => {
    const inProgress = toHudViewModel(
      makeState(4, { chambers: ["LIVE", "BLANK"] }),
    );
    expect(inProgress.matchOver).toBe(false);
    expect(inProgress.winner).toBeNull();

    const over = toHudViewModel(
      makeState(4, {
        chambers: ["LIVE", "BLANK"],
        phase: "MATCH_OVER",
        winner: "PLAYER",
        aiHp: 0,
      }),
    );
    expect(over.matchOver).toBe(true);
    expect(over.winner).toBe("PLAYER");
    expect(over.banner).toContain("WINS");
  });
});

describe("Renderer — 14.3 feedback timing (Req 8.4)", () => {
  it("maps every GameEvent to a descriptor whose first frame lands within 200 ms", () => {
    const events: GameEvent[] = [
      { type: "ROUND_SET_LOADED", live: 2, blank: 3, total: 5, roundNumber: 1 },
      { type: "SPUN" },
      { type: "SHOT_STARTED", target: "AI" },
      { type: "LIVE_FIRED", target: "PLAYER", damage: 1 },
      { type: "BLANK_FIRED", target: "AI" },
      { type: "ITEM_USED", by: "PLAYER", item: "MEDKIT" },
      { type: "TURN_PASSED", to: "AI" },
      { type: "TURN_SKIPPED", participant: "PLAYER" },
      { type: "HP_CHANGED", participant: "PLAYER", hp: 1 },
      { type: "MATCH_OVER", winner: "AI" },
    ];

    for (const event of events) {
      const fb = toFeedbackDescriptor(event);
      // The <=200ms contract is encoded as a property of the descriptor.
      expect(fb.delayMs).toBeLessThanOrEqual(FEEDBACK_MAX_DELAY_MS);
      expect(fb.delayMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("maps a live shot to a muzzle-flash and an HP change to a HUD pulse", () => {
    const muzzle = toFeedbackDescriptor({ type: "LIVE_FIRED", target: "AI", damage: 1 });
    expect(muzzle.kind).toBe("muzzle-flash");
    expect(muzzle.target).toBe("AI");

    const pulse = toFeedbackDescriptor({ type: "HP_CHANGED", participant: "PLAYER", hp: 0 });
    expect(pulse.kind).toBe("hud-pulse");
    expect(pulse.participant).toBe("PLAYER");
  });
});

describe("Renderer — 14.3 init failure keeps state intact (Req 8.5)", () => {
  it("returns ok:false when Application.init throws and leaves GameState unchanged", async () => {
    // A fake app whose async init rejects, simulating a WebGL/context failure.
    const failingAppFactory = (): PixiAppLike =>
      ({
        init: async () => {
          throw new Error("WebGL context could not be created");
        },
        stage: {
          filters: null,
          addChild: () => undefined,
          removeChildren: () => undefined,
          sortableChildren: false,
        },
        canvas: document.createElement("canvas"),
        ticker: {
          add: () => undefined,
          remove: () => undefined,
          start: () => undefined,
          stop: () => undefined,
          maxFPS: 0,
          minFPS: 0,
        },
        destroy: () => undefined,
      }) satisfies PixiAppLike;

    const renderer = new Renderer({ appFactory: failingAppFactory });

    const state = makeState(7, { chambers: ["LIVE", "BLANK"], playerHp: 3, aiHp: 3 });
    const snapshot = structuredClone(state);
    const container = document.createElement("div");

    const result = await renderer.init(container);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("RENDER_INIT_FAILED");
      expect(result.error.message).toContain("WebGL");
    }

    // The caller can show the unavailable overlay without throwing.
    expect(() => renderer.showRenderUnavailable()).not.toThrow();
    expect(document.querySelector("[data-render-unavailable]")).not.toBeNull();

    // render() after a failed init is a safe no-op and does not mutate state.
    expect(() => renderer.render(state)).not.toThrow();
    expect(state).toEqual(snapshot);

    renderer.destroy();
  });

  it("start() is a no-op when init never succeeded", () => {
    const renderer = new Renderer();
    expect(() => renderer.start()).not.toThrow();
    expect(renderer.isRunning()).toBe(false);
  });
});
