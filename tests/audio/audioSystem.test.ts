// Feature: revolver-roulette, Task 13 — Audio_System integration + smoke tests.
//
// These are example/integration/smoke tests (NOT property tests). They use an
// injected mock Howl factory so no real audio backend is required; the Vitest
// environment stays "node".

import { describe, it, expect, vi } from "vitest";
import type { HowlOptions } from "howler";
import type { GameEvent } from "../../src/engine/types";
import {
  AudioSystem,
  GUNSHOT_VOLUME,
  DRY_CLICK_VOLUME,
  type HowlLike,
} from "../../src/audio/audioSystem";

// A mock Howl that records the options it was created with and the volumes it
// was told to play at, and exposes spies for play/stop/unload.
interface MockHowl extends HowlLike {
  readonly options: HowlOptions;
  readonly volumeCalls: number[];
  readonly play: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly unload: ReturnType<typeof vi.fn>;
  readonly volume: ReturnType<typeof vi.fn>;
}

interface Harness {
  readonly system: AudioSystem;
  /** All created mock Howls, in creation order. */
  readonly howls: MockHowl[];
  /** Find a created Howl by a substring of its first src path. */
  bySrc(fragment: string): MockHowl;
}

function makeHarness(): Harness {
  const howls: MockHowl[] = [];

  const factory = (options: HowlOptions): HowlLike => {
    const volumeCalls: number[] = [];
    const mock: MockHowl = {
      options,
      volumeCalls,
      play: vi.fn(() => 1),
      stop: vi.fn(),
      unload: vi.fn(),
      volume: vi.fn((v: number) => {
        volumeCalls.push(v);
        return undefined;
      }),
    };
    howls.push(mock);
    return mock;
  };

  const system = new AudioSystem({ howlFactory: factory });

  const bySrc = (fragment: string): MockHowl => {
    const found = howls.find((h) => {
      const src = h.options.src;
      const list = Array.isArray(src) ? src : [src];
      return list.some((s) => s.includes(fragment));
    });
    if (!found) throw new Error(`No Howl created with src containing "${fragment}"`);
    return found;
  };

  return { system, howls, bySrc };
}

describe("AudioSystem — 13.2 integration (Req 9.2-9.8)", () => {
  it("triggers the correct sound for each GameEvent", () => {
    const { system, bySrc } = makeHarness();
    system.init();

    const spin = bySrc("revolverspin");
    const gunshot = bySrc("gunshot");
    const dryClick = bySrc("emptygunshot");

    const events: GameEvent[] = [
      { type: "SPUN" }, // Req 9.2 -> revolver spin
      { type: "LIVE_FIRED", target: "PLAYER", damage: 1 }, // Req 9.4 -> gunshot
      { type: "BLANK_FIRED", target: "PLAYER" }, // Req 9.5 -> empty gunshot
    ];
    system.handleEvents(events);

    expect(spin.play).toHaveBeenCalledTimes(1);
    expect(gunshot.play).toHaveBeenCalledTimes(1);
    expect(dryClick.play).toHaveBeenCalledTimes(1);
  });

  it("plays the UI blip via playUiBlip (Req 9.6)", () => {
    const { system, bySrc } = makeHarness();
    system.init();

    const blip = bySrc("uiblip");
    system.playUiBlip();

    expect(blip.play).toHaveBeenCalledTimes(1);
  });

  it("configures the gunshot louder than the dry click (Req 9.4)", () => {
    const { system, bySrc } = makeHarness();
    system.init();

    expect(GUNSHOT_VOLUME).toBeGreaterThan(DRY_CLICK_VOLUME);
    expect(bySrc("gunshot").options.volume).toBe(GUNSHOT_VOLUME);
    expect(bySrc("emptygunshot").options.volume).toBe(DRY_CLICK_VOLUME);
    expect(bySrc("gunshot").options.volume!).toBeGreaterThan(bySrc("emptygunshot").options.volume!);
  });

  it("raises the tension volume monotonically as rounds deplete (Req 9.7)", () => {
    const { system, bySrc } = makeHarness();
    system.init();

    const tension = bySrc("tension-layer");
    const total = 6;
    for (let remaining = total; remaining >= 1; remaining--) {
      system.setTension(remaining, total);
    }

    const calls = tension.volumeCalls;
    expect(calls.length).toBe(total);
    // Non-decreasing as remaining decreases.
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]!).toBeGreaterThanOrEqual(calls[i - 1]!);
    }
    // Peaks at 1 when a single round remains.
    expect(calls[calls.length - 1]).toBe(1);
  });

  it("swallows load and play errors so gameplay continues (Req 9.8)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { system, bySrc } = makeHarness();
    system.init();

    const gunshot = bySrc("gunshot");

    // The injected error handlers must not throw when invoked.
    expect(() => {
      gunshot.options.onloaderror?.(1, "load failed");
      gunshot.options.onplayerror?.(1, "play failed");
    }).not.toThrow();

    // A play() that throws must not propagate out of handleEvents.
    gunshot.play.mockImplementationOnce(() => {
      throw new Error("audio backend exploded");
    });
    expect(() => {
      system.handleEvents([{ type: "LIVE_FIRED", target: "PLAYER", damage: 1 }]);
    }).not.toThrow();

    warn.mockRestore();
  });
});

describe("AudioSystem — 13.3 smoke (Req 9.1)", () => {
  it("configures the ambient drone to loop and plays it on startAmbient", () => {
    const { system, bySrc } = makeHarness();
    system.init();

    const ambient = bySrc("bgmusic");
    expect(ambient.options.loop).toBe(true);

    system.startAmbient();
    expect(ambient.play).toHaveBeenCalledTimes(1);
  });
});
