// Audio System (Requirement 9).
//
// Wraps Howler.js to provide the game's sound layers and one-shot SFX. The
// system subscribes to engine `GameEvent`s and coarse round-count state; it
// owns no game rules. Every sound is created with load/play error handlers that
// swallow failures so a missing or broken asset never interrupts gameplay
// (Requirement 9.8).
//
// The Howl constructor is injected (defaulting to the real Howler `Howl`) so
// tests can supply a mock factory and assert behavior without a real audio
// backend.

import { Howl, type HowlOptions } from "howler";
import type { GameEvent, ItemType } from "../engine/types";
import { tensionVolume } from "./tension";

// ---------------------------------------------------------------------------
// Asset paths and volume constants
// ---------------------------------------------------------------------------

/** Base directory for audio assets (files may not exist yet; that's fine). */
const AUDIO_BASE = "/assets/audio/";

/**
 * Extensions tried (in order) for each sound. mp3 is first because it is the
 * most common and is what the bundled assets use — Howler selects the FIRST
 * source whose format the browser supports, so the real file must come first.
 */
const AUDIO_EXTS = ["mp3", "ogg", "wav", "webm"] as const;

/**
 * Playback volume for the gunshot (Live Round). Defined as an explicit
 * constant and required to be strictly greater than the dry-click volume so a
 * Live Round always sounds louder than a Blank (Requirement 9.4).
 */
export const GUNSHOT_VOLUME = 1.0;

/** Playback volume for the dry click (Blank Round). Quieter than the gunshot. */
export const DRY_CLICK_VOLUME = 0.35;

// ---------------------------------------------------------------------------
// Injectable Howl factory
// ---------------------------------------------------------------------------

/**
 * The minimal surface of a Howl instance this system depends on. Both the real
 * Howler `Howl` and a test mock satisfy this, so the system can run without a
 * real audio backend.
 */
export interface HowlLike {
  play(spriteOrId?: string | number): number;
  stop(id?: number): unknown;
  unload(): unknown;
  volume(volume: number): unknown;
}

/** Creates a Howl-like sound from options. Injectable for tests. */
export type HowlFactory = (options: HowlOptions) => HowlLike;

/** The default factory uses the real Howler `Howl` constructor. */
const defaultHowlFactory: HowlFactory = (options) => new Howl(options);

/** Construction options for {@link AudioSystem}. */
export interface AudioSystemOptions {
  /** Override the Howl constructor. Defaults to the real Howler `Howl`. */
  readonly howlFactory?: HowlFactory;
}

// ---------------------------------------------------------------------------
// AudioSystem
// ---------------------------------------------------------------------------

export class AudioSystem {
  private readonly createHowl: HowlFactory;

  private ambient: HowlLike | undefined;
  private ambient2: HowlLike | undefined;
  private tension: HowlLike | undefined;
  private spinClicks: HowlLike | undefined;
  private gunshot: HowlLike | undefined;
  private dryClick: HowlLike | undefined;
  private uiBlip: HowlLike | undefined;
  private textBlip: HowlLike | undefined;
  private flick: HowlLike | undefined;
  private coinSelect: HowlLike | undefined;
  private coinHover: HowlLike | undefined;
  private coinFlipShimmer: HowlLike | undefined;
  private coinFlipTable: HowlLike | undefined;
  private candleBlow: HowlLike | undefined;
  private hammerCock: HowlLike | undefined;
  private shellFlip: HowlLike | undefined;
  private gunRaise: HowlLike | undefined;
  private magnify: HowlLike | undefined;
  private dealerLaugh: HowlLike | undefined;
  private turnPass: HowlLike | undefined;
  private roundStart: HowlLike | undefined;
  private win: HowlLike | undefined;
  private lose: HowlLike | undefined;
  private chain: HowlLike | undefined;
  private itemSounds: Partial<Record<ItemType, HowlLike>> = {};

  constructor(options: AudioSystemOptions = {}) {
    this.createHowl = options.howlFactory ?? defaultHowlFactory;
  }

  /**
   * Build all Howl instances. Looping layers (ambient drone, tension layer)
   * use `loop: true`; one-shot SFX are fire-and-forget. Every sound gets
   * load/play error handlers that log and swallow the failure (Requirement
   * 9.8). Safe to call once before playback.
   */
  init(): void {
    // Looping ambience: a low room tone bed + the main music track.
    this.ambient = this.makeHowl("roomtone", { loop: true, volume: 0.4 });
    this.ambient2 = this.makeHowl("bgmusic2", { loop: true, volume: 0.55 });

    // Looping tension layer; starts silent and rises via setTension (Req 9.7).
    this.tension = this.makeHowl("tension-layer", { loop: true, volume: 0 });

    // One-shot SFX mapped to the provided assets.
    this.spinClicks = this.makeHowl("revolverspin", { volume: 0.9 });
    this.gunshot = this.makeHowl("gunshot", { volume: GUNSHOT_VOLUME });
    this.dryClick = this.makeHowl("emptygunshot", { volume: DRY_CLICK_VOLUME });
    this.uiBlip = this.makeHowl("uiblip", { volume: 0.5 });
    this.textBlip = this.makeHowl("textblip", { volume: 1.5 });
    this.flick = this.makeHowl("flicklight", { volume: 0.5 });
    this.coinSelect = this.makeHowl("coinselect", { volume: 0.9 });
    this.coinHover = this.makeHowl("coinhover", { volume: 0.5, preload: true });
    this.coinFlipShimmer = this.makeHowl("coinflipshimmer", { volume: 0.9, preload: true });
    this.coinFlipTable = this.makeHowl("coinfliptable", { volume: 0.9, preload: true });
    this.candleBlow = this.makeHowl("candleblow", { volume: 0.8 });
    this.hammerCock = this.makeHowl("hammercock", { volume: 0.85 });
    this.shellFlip = this.makeHowl("shellflip", { volume: 0.7 });
    this.gunRaise = this.makeHowl("gunraise", { volume: 0.7 });
    this.magnify = this.makeHowl("magnify", { volume: 0.6 });
    this.dealerLaugh = this.makeHowl("dealerlaugh", { volume: 0.7 });
    this.turnPass = this.makeHowl("turnpass", { volume: 0.7 });
    this.roundStart = this.makeHowl("roundstart", { volume: 0.8 });
    this.chain = this.makeHowl("chain", { 
      volume: 0.9,
      sprite: { drop: [0, 2500] } // Only play the first 2.5 seconds to cut out the other gameplay sounds!
    });
    this.win = this.makeHowl("win", { volume: 0.9 });
    this.lose = this.makeHowl("lose", { volume: 0.9 });

    // Per-item use sounds.
    this.itemSounds = {
      MAGNIFYING_GLASS: this.magnify!,
      MEDKIT: this.makeHowl("drinkhealth", { volume: 0.8 }),
      HANDCUFFS: this.makeHowl("handcuff", { volume: 0.8 }),
      INVERTER: this.makeHowl("glassbreaking", { volume: 0.7 }),
      HOLLOW_POINT: this.makeHowl("glassbreaking", { volume: 0.7 }),
      SPEED_LOADER: this.makeHowl("revolverspin", { volume: 0.7 }),
    };
  }

  /** Start the looping ambience layers + silent tension bed. */
  startAmbient(): void {
    this.safePlay(this.ambient);
    this.safePlay(this.ambient2);
    this.safePlay(this.tension);
  }

  /**
   * Map engine events to sounds (Requirements 9.2-9.5). UI interactions are
   * not GameEvents and are handled by {@link playUiBlip}.
   */
  handleEvents(events: readonly GameEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "SPUN":
          this.safePlay(this.spinClicks); // Req 9.2
          break;
        case "LIVE_FIRED":
          this.safePlay(this.gunshot); // Req 9.4 (louder than dry click)
          break;
        case "BLANK_FIRED":
          this.safePlay(this.dryClick); // Req 9.5
          break;
        case "ITEM_USED":
          this.safePlay(this.itemSounds[event.item]);
          break;
        case "ROUND_SET_LOADED":
          this.safePlay(this.roundStart);
          this.safePlay(this.shellFlip);
          if (this.chain) this.chain.play("drop");
          break;
        case "TURN_PASSED":
          this.safePlay(this.turnPass);
          break;
        case "MATCH_OVER":
          if (event.winner === "PLAYER") {
            this.safePlay(this.win);
          } else {
            this.safePlay(this.lose);
            this.safePlay(this.dealerLaugh);
          }
          break;
        default:
          // SHOT_STARTED / HP_CHANGED / TURN_SKIPPED: no sound here.
          break;
      }
    }
  }

  /** Play the UI blip for a user-interface interaction (Requirement 9.6). */
  playUiBlip(): void {
    this.safePlay(this.uiBlip);
  }

  /** Play the light-flicker sound (driven by the renderer's bulb blink). */
  playFlick(): void {
    this.safePlay(this.flick);
  }

  /** Play one typewriter blip (driven by the caption typing out). */
  playTextBlip(): void {
    this.safePlay(this.textBlip);
  }

  /** Stop the typewriter blip (when a caption finishes animating). */
  stopTextBlip(): void {
    if (!this.textBlip) return;
    try {
      this.textBlip.stop();
    } catch (err) {
      console.warn("[audio] stop text blip threw", err);
    }
  }

  /** Set all music volumes (ambient + tension). 0–1. */
  setMusicVolume(v: number): void {
    if (this.ambient) try { this.ambient.volume(v * 0.4); } catch { /* */ }
    if (this.ambient2) try { this.ambient2.volume(v * 0.55); } catch { /* */ }
    if (this.tension) try { this.tension.volume(v); } catch { /* */ }
  }

  /** Set all SFX volumes. 0–1. */
  setSfxVolume(v: number): void {
    const set = (h: HowlLike | undefined, base: number): void => {
      if (h) try { h.volume(v * base); } catch { /* */ }
    };
    set(this.spinClicks, 0.9);
    set(this.gunshot, 1.0);
    set(this.dryClick, 0.35);
    set(this.flick, 0.5);
    set(this.turnPass, 0.7);
    set(this.roundStart, 0.8);
    set(this.win, 0.9);
    set(this.lose, 0.9);
    for (const h of Object.values(this.itemSounds)) {
      set(h, 0.8);
    }
  }

  /** Set text blip volume. 0–1. */
  setBlipVolume(v: number): void {
    if (this.textBlip) try { this.textBlip.volume(v * 0.4); } catch { /* */ }
    if (this.uiBlip) try { this.uiBlip.volume(v * 0.5); } catch { /* */ }
  }

  /**
   * Set the tension-layer volume from the remaining/total round counts using
   * the pure {@link tensionVolume} mapping (Requirement 9.7). The volume rises
   * as rounds deplete and peaks when one Round remains.
   */
  setTension(roundsRemaining: number, roundsTotal: number): void {
    const volume = tensionVolume(roundsRemaining, roundsTotal);
    if (!this.tension) return;
    try {
      this.tension.volume(volume);
    } catch (err) {
      console.warn("[audio] failed to set tension volume", err);
    }
  }

  /** Play the coin-select sound when a bet is chosen. */
  playCoinSelect(): void {
    this.safePlay(this.coinSelect);
  }

  /** Play the coin-hover sound starting from 1s into the clip. */
  playCoinHover(): void {
    if (!this.coinHover) return;
    try {
      const id = this.coinHover.play();
      (this.coinHover as any).seek(1.0, id);
    } catch (err) {
      console.warn("[audio] play coin hover threw", err);
    }
  }

  /** Play when a candle blows out (life lost). */
  playCandleBlow(): void {
    this.safePlay(this.candleBlow);
  }

  /** Play when the gun is raised (hammer cocked). */
  playHammerCock(): void {
    this.safePlay(this.hammerCock);
  }

  /** Play when shells flip into the table during round start. */
  playShellFlip(): void {
    this.safePlay(this.shellFlip);
  }

  /** Play when the gun is picked up / raised into hand. */
  playGunRaise(): void {
    this.safePlay(this.gunRaise);
  }

  /** Play when magnifying glass is used. */
  playMagnify(): void {
    this.safePlay(this.magnify);
  }

  /** Play a dealer laugh (on dealer win or menacing action). */
  playDealerLaugh(): void {
    this.safePlay(this.dealerLaugh);
  }

  /** Play the coin flip shimmer (while spinning in air). */
  playCoinFlipShimmer(): void {
    this.safePlay(this.coinFlipShimmer);
  }

  /** Play the coin landing on table sound. */
  playCoinFlipTable(): void {
    this.safePlay(this.coinFlipTable);
  }

  /** Stop and unload every sound, releasing all audio resources. */
  stopAll(): void {
    for (const howl of [
      this.ambient,
      this.ambient2,
      this.tension,
      this.spinClicks,
      this.gunshot,
      this.dryClick,
      this.uiBlip,
      this.textBlip,
      this.flick,
      this.coinSelect,
      this.coinHover,
      this.coinFlipShimmer,
      this.coinFlipTable,
      this.candleBlow,
      this.hammerCock,
      this.shellFlip,
      this.gunRaise,
      this.magnify,
      this.dealerLaugh,
      this.turnPass,
      this.roundStart,
      this.win,
      this.lose,
      ...Object.values(this.itemSounds),
    ]) {
      this.safeStopAndUnload(howl);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Create a Howl with shared error handlers. The `onloaderror`/`onplayerror`
   * handlers log a warning and swallow the failure so a missing or broken
   * asset never interrupts gameplay (Requirement 9.8).
   */
  private makeHowl(base: string, extra: Omit<HowlOptions, "src">): HowlLike {
    const src = AUDIO_EXTS.map((ext) => `${AUDIO_BASE}${base}.${ext}`);
    return this.createHowl({
      src,
      preload: true,
      ...extra,
      onloaderror: (_id, error) => {
        console.warn(`[audio] failed to load ${base}`, error);
      },
      onplayerror: (_id, error) => {
        console.warn(`[audio] failed to play ${base}`, error);
      },
    });
  }

  /** Play a sound, swallowing any synchronous error (Requirement 9.8). */
  private safePlay(howl: HowlLike | undefined): void {
    if (!howl) return;
    try {
      howl.play();
    } catch (err) {
      console.warn("[audio] play threw", err);
    }
  }

  /** Stop a sound, swallowing any error. */
  private safeStopAndUnload(howl: HowlLike | undefined): void {
    if (!howl) return;
    try {
      howl.stop();
      howl.unload();
    } catch (err) {
      console.warn("[audio] stop/unload threw", err);
    }
  }
}
