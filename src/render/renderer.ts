// Renderer (Requirement 8): a PixiJS-backed 2.5D "paper diorama" renderer for
// Revolver Roulette, rendered dark, grimy and deadly — a Buckshot-Roulette-style
// interrogation table floating in a near-black void under a single dim amber
// lamp. See the `paper-diorama-ui` skill.
//
// Design constraints honoured here:
//   - The renderer is presentation-only. It reads `GameState` and reacts to
//     `GameEvent`s but owns no rules and NEVER mutates the state it is given.
//   - PixiJS v8's `Application.init` is async, so `init` returns a Promise of a
//     Result; on a WebGL/context failure it resolves to a typed error and the
//     caller shows the "rendering unavailable" overlay while the Match state is
//     left intact (Req 8.5).
//   - The Application fills the window and resizes with it: a `layout(w,h)` step
//     positions every element from the CURRENT size, and a window 'resize'
//     handler re-lays-out the scene (guarded so it is inert before init).
//   - A post-processing filter chain (film grain, scanlines, vignette,
//     chromatic aberration, dim-flicker) is attached to the stage root and
//     animated every ticker frame (Req 8.1-8.3). See `./filters`.
//   - Everything animates from the ticker: actors breathe, the amber lamp pool
//     softly pulses, the cylinder slides toward the active participant and idly
//     rotates, shots kick/flash, HP pips pulse, and a subtle camera push-in
//     hits on a live shot.
//   - HUD/feedback are derived from pure mappings in `./viewModel`, which is
//     what lets the renderer be unit-tested without a GPU.
//
// Scene art uses the SVG sprite assets (dealer, player, revolver cylinder, item
// icons, shell tokens) layered into the diorama, with stylized PixiJS
// `Graphics` fallbacks. Asset loading happens only in the real init path, after
// `app.init` succeeds, and never blocks init on failure.

import {
  Application,
  Container,
  Graphics,
  Sprite,
  Text,
  type Texture,
} from "pixi.js";
import type { GameEvent, GameState, ItemType, ParticipantId } from "../engine/types";
import {
  type AssetLoader,
  defaultAssetLoader,
  itemSpriteKey,
  loadSpriteTextures,
  type TextureMap,
} from "./sprites";
import {
  buildFilterChainDescriptor,
  createPostFilters,
  type FilterChainDescriptor,
  type PostFilterChain,
} from "./filters";
import {
  FEEDBACK_MAX_DELAY_MS,
  participantName,
  toFeedbackDescriptor,
  toHudViewModel,
  type FeedbackDescriptor,
  type HudViewModel,
} from "./viewModel";

// Re-export the pure helpers so callers/tests can reach them from one module.
export {
  buildFilterChainDescriptor,
  toHudViewModel,
  toFeedbackDescriptor,
  FEEDBACK_MAX_DELAY_MS,
};
export type { FilterChainDescriptor, HudViewModel, FeedbackDescriptor };

// ---------------------------------------------------------------------------
// Result types (Req 8.5)
// ---------------------------------------------------------------------------

/** A render initialization failure (WebGL/canvas context could not be created). */
export type RenderInitError = { kind: "RENDER_INIT_FAILED"; message: string };

/** A minimal success/failure result type used by `Renderer.init`. */
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// ---------------------------------------------------------------------------
// Palette (Buckshot-inspired, grimy & deadly — NO green)
// ---------------------------------------------------------------------------

const COLOR = {
  /** Near-black void backdrop. */
  bg0: 0x0a0a0b,
  /** Grimy charcoal table body (mid face). */
  tableMid: 0x1c1a14,
  /** Slightly lit charcoal top face (where the lamp pool falls). */
  tableTop: 0x262219,
  /** Thick beveled "cardboard" front edge (darkest). */
  tableEdge: 0x0c0b08,
  /** Heavy black papercraft outline. */
  outline: 0x000000,
  /** Dim amber lamp / active highlight (warm, used sparingly). */
  amber: 0xd9a441,
  /** Accent is amber now — never green. */
  accent: 0xd9a441,
  /** Blood-red danger/HP accent. */
  blood: 0xc1352b,
  /** Dim blood for lost/empty HP. */
  bloodDim: 0x6e1c16,
  /** Bone off-white for text/UI. */
  bone: 0xc9c2b0,
  /** Muted bone for secondary text. */
  muted: 0x5a564e,
} as const;

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 600;

// ---------------------------------------------------------------------------
// Injectable PixiJS Application surface
// ---------------------------------------------------------------------------

/** The minimal Ticker surface the renderer drives. */
export interface TickerLike {
  add(fn: (ticker: unknown) => void): unknown;
  remove(fn: (ticker: unknown) => void): unknown;
  start(): void;
  stop(): void;
  maxFPS: number;
  minFPS: number;
}

/** The minimal stage container surface the renderer touches. */
export interface StageLike {
  filters: unknown;
  addChild(child: unknown): unknown;
  removeChildren(): unknown;
  sortableChildren: boolean;
}

/**
 * The minimal PixiJS `Application` surface the renderer depends on. The real
 * `Application` structurally satisfies this; tests inject a fake whose `init`
 * throws to exercise the failure path (Req 8.5) without ever creating WebGL.
 *
 * `renderer` is optional (the real Application exposes it for window resizing);
 * it is only ever touched on the real, successfully-initialized path.
 */
export interface PixiAppLike {
  init(options?: Record<string, unknown>): Promise<void>;
  readonly stage: StageLike;
  readonly canvas: HTMLCanvasElement;
  readonly ticker: TickerLike;
  readonly renderer?: { resize(width: number, height: number): void };
  destroy(rendererDestroyOptions?: unknown, options?: unknown): void;
}

/** Factory producing a fresh (un-initialized) Application-like object. */
export type PixiAppFactory = () => PixiAppLike;

const defaultAppFactory: PixiAppFactory = () =>
  new Application() as unknown as PixiAppLike;

/** Construction options for {@link Renderer}. */
export interface RendererOptions {
  /** Override the Application constructor (tests inject a failing/mock app). */
  readonly appFactory?: PixiAppFactory;
  /** Canvas width in pixels (default: window width, falling back to 960). */
  readonly width?: number;
  /** Canvas height in pixels (default: window height, falling back to 600). */
  readonly height?: number;
  /** Time source (ms); defaults to performance.now/Date.now. Injectable for tests. */
  readonly now?: () => number;
  /**
   * Override the texture loader (tests can stub it). Defaults to PixiJS
   * `Assets.load`. Only ever invoked in the real init path, after a successful
   * `app.init()`.
   */
  readonly assetLoader?: AssetLoader;
}

// ---------------------------------------------------------------------------
// The Renderer interface (from the design)
// ---------------------------------------------------------------------------

export interface IRenderer {
  init(canvasOrContainer: HTMLCanvasElement | HTMLElement): Promise<Result<void, RenderInitError>>;
  render(state: GameState): void;
  playActionFeedback(event: GameEvent): void;
  start(): void;
  stop(): void;
  showRenderUnavailable(): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Internal scene-graph handles
// ---------------------------------------------------------------------------

interface SceneHandles {
  readonly bgLayer: Container;
  readonly dioramaLayer: Container;
  readonly lampLayer: Container;
  readonly actorLayer: Container;
  readonly hudLayer: Container;
  // Graphics redrawn on layout (size-dependent):
  readonly bg: Graphics;
  readonly table: Graphics;
  readonly shadows: Graphics;
  readonly lampGlow: Graphics;
  // Actors:
  readonly dealer: Container;
  readonly player: Container;
  readonly cylinderSlide: Container; // position (slides toward active turn)
  readonly cylinderSpin: Container; // rotation + recoil
  readonly muzzleFlash: Graphics;
  // HUD text:
  readonly title: Text;
  readonly banner: Text;
  readonly winner: Text;
  readonly gunLabel: Text;
  // On-table HP + items (Buckshot-style, drawn on the surface):
  readonly playerHp: Graphics;
  readonly dealerHp: Graphics;
  readonly playerItems: Container;
  readonly dealerItems: Container;
  readonly shells: Container;
}

/** Cached geometry produced by {@link Renderer.layout}; drives animations. */
interface LayoutData {
  w: number;
  h: number;
  cx: number;
  tableTop: number;
  tableW: number;
  tableH: number;
  actorScale: number;
  dealerBaseY: number;
  playerBaseY: number;
  cylX: number;
  cylPlayerY: number;
  cylDealerY: number;
  cylCenterY: number;
}

/** A running visual effect keyed by name (start time + duration). */
interface Fx {
  start: number;
  dur: number;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class Renderer implements IRenderer {
  private readonly createApp: PixiAppFactory;
  private readonly optWidth: number | undefined;
  private readonly optHeight: number | undefined;
  private width: number;
  private height: number;
  private readonly now: () => number;
  private readonly assetLoader: AssetLoader;

  private app: PixiAppLike | undefined;
  private scene: SceneHandles | undefined;
  private post: PostFilterChain | undefined;
  private textures: TextureMap = {};
  private running = false;
  private startMs = 0;
  private overlay: HTMLElement | undefined;

  // Layout + animation state.
  private L: LayoutData | undefined;
  private activeSide: ParticipantId = "PLAYER";
  private cylCurX = 0;
  private cylCurY = 0;
  private cylInit = false;
  private readonly fx: Record<string, Fx | undefined> = {};

  // Bound once so the same reference can be removed from the ticker later.
  private readonly tick = (_ticker: unknown): void => this.onTick();
  private readonly onResize = (): void => this.handleResize();

  constructor(options: RendererOptions = {}) {
    this.createApp = options.appFactory ?? defaultAppFactory;
    this.optWidth = options.width;
    this.optHeight = options.height;
    const { w, h } = this.resolveSize();
    this.width = w;
    this.height = h;
    this.now = options.now ?? defaultNow;
    this.assetLoader = options.assetLoader ?? defaultAssetLoader;
  }

  /** Resolve the target canvas size, preferring explicit options then window. */
  private resolveSize(): { w: number; h: number } {
    const ww = typeof window !== "undefined" ? window.innerWidth : 0;
    const wh = typeof window !== "undefined" ? window.innerHeight : 0;
    return {
      w: this.optWidth ?? (ww || DEFAULT_WIDTH),
      h: this.optHeight ?? (wh || DEFAULT_HEIGHT),
    };
  }

  /**
   * Initialize PixiJS (async in v8). On any failure constructing the WebGL/
   * canvas context, resolve to a typed error result; the caller stops the loop
   * and calls {@link showRenderUnavailable}. The provided GameState (if any) is
   * never touched here (Req 8.5).
   */
  async init(
    canvasOrContainer: HTMLCanvasElement | HTMLElement,
  ): Promise<Result<void, RenderInitError>> {
    try {
      const app = this.createApp();
      const isCanvas =
        typeof HTMLCanvasElement !== "undefined" &&
        canvasOrContainer instanceof HTMLCanvasElement;

      const { w, h } = this.resolveSize();
      this.width = w;
      this.height = h;

      const options: Record<string, unknown> = {
        width: w,
        height: h,
        background: COLOR.bg0,
        antialias: false,
        autoStart: false,
      };
      if (isCanvas) {
        options.canvas = canvasOrContainer;
      }

      await app.init(options);

      // When given a container (not a canvas), attach the created canvas to it.
      if (!isCanvas) {
        try {
          (canvasOrContainer as HTMLElement).appendChild(app.canvas);
        } catch {
          // Non-fatal: the renderer can still run headless-ish for tests.
        }
      }

      this.app = app;

      // Load the SVG sprite textures now that the WebGL context exists. Fully
      // guarded: any/all failures leave `textures` partial (or empty) and the
      // scene falls back to Graphics placeholders. Runs only AFTER a successful
      // `app.init()`, so the injected-failing-app test never reaches here and no
      // asset/WebGL work happens on the failure path.
      try {
        this.textures = await loadSpriteTextures(this.assetLoader);
      } catch {
        this.textures = {};
      }

      this.buildScene(app);
      this.layout(this.width, this.height);

      // Fill the window and re-lay-out on resize. Guarded so it never throws.
      if (typeof window !== "undefined") {
        window.addEventListener("resize", this.onResize);
      }

      return { ok: true, value: undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { kind: "RENDER_INIT_FAILED", message } };
    }
  }

  /**
   * Update the visuals from `state`. Pure-read with respect to the engine:
   * never mutates `state`. No-op if init has not succeeded (Req 8.5 keeps state
   * intact even when rendering is unavailable).
   */
  render(state: GameState): void {
    if (!this.scene) return;
    const vm = toHudViewModel(state);
    // The cylinder slides toward whoever's turn it is (lerped in the ticker).
    this.activeSide = vm.activeParticipant;
    this.drawHud(this.scene, vm);
  }

  /**
   * Trigger a short visual response for an engine event. Each effect is latched
   * with a start time and applied on the very next ticker frame, so the first
   * visible change lands well within 200 ms (Req 8.4).
   */
  playActionFeedback(event: GameEvent): void {
    const d = toFeedbackDescriptor(event);
    switch (d.kind) {
      case "muzzle-flash":
        // Brief, bright flash + recoil + a subtle camera push-in on a live shot.
        this.startFx("muzzle", 200);
        this.startFx("recoil", 180);
        this.startFx("camera", 350);
        break;
      case "recoil":
        this.startFx("recoil", 160);
        break;
      case "cylinder-spin":
        this.startFx("spin", 650);
        break;
      case "hud-pulse":
        if (d.participant) this.startFx(`hp_${d.participant}`, 360);
        break;
      default:
        // turn-pass / reload / match-over / none have no transient transform.
        break;
    }
  }

  private startFx(key: string, dur: number): void {
    this.fx[key] = { start: this.now(), dur: Math.max(1, dur) };
  }

  /** Begin the >=30 FPS ticker loop with the filter chain attached (Req 8.1-8.3). */
  start(): void {
    const app = this.app;
    if (!app || this.running) return;
    if (this.post) {
      app.stage.filters = this.post.filters;
    }
    app.ticker.minFPS = 30;
    app.ticker.maxFPS = 60;
    app.ticker.add(this.tick);
    app.ticker.start();
    this.running = true;
    this.startMs = this.now();
  }

  /** Stop the ticker loop. Safe to call when not running. */
  stop(): void {
    const app = this.app;
    if (!app || !this.running) return;
    app.ticker.remove(this.tick);
    app.ticker.stop();
    this.running = false;
  }

  /**
   * Present a simple DOM text overlay indicating rendering is unavailable
   * (Req 8.5). Never throws even if no DOM is present; never touches GameState.
   */
  showRenderUnavailable(): void {
    if (typeof document === "undefined" || !document.body) return;
    if (this.overlay) return;
    try {
      const el = document.createElement("div");
      el.setAttribute("data-render-unavailable", "true");
      el.textContent = "RENDERING UNAVAILABLE";
      el.style.position = "fixed";
      el.style.inset = "0";
      el.style.display = "flex";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.background = "#0a0a0b";
      el.style.color = "#c1352b";
      el.style.fontFamily = "'Courier New', monospace";
      el.style.letterSpacing = "4px";
      el.style.zIndex = "9999";
      document.body.appendChild(el);
      this.overlay = el;
    } catch {
      // Swallow: showing the overlay must never throw.
    }
  }

  /** Tear down the ticker, the Pixi application, the resize handler and overlay. */
  destroy(): void {
    this.stop();
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", this.onResize);
    }
    if (this.app) {
      try {
        this.app.destroy();
      } catch {
        // ignore teardown errors
      }
      this.app = undefined;
    }
    this.scene = undefined;
    this.post = undefined;
    this.L = undefined;
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    this.overlay = undefined;
  }

  // -------------------------------------------------------------------------
  // Testing accessors
  // -------------------------------------------------------------------------

  /** The pure descriptor of the filter chain (names + brightness/flicker). */
  getFilterChainDescriptor(): FilterChainDescriptor {
    return buildFilterChainDescriptor();
  }

  /** Whether the ticker loop is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Resize -> re-layout (guarded; inert before a successful init)
  // -------------------------------------------------------------------------

  private handleResize(): void {
    if (typeof window === "undefined") return;
    const w = window.innerWidth || this.width;
    const h = window.innerHeight || this.height;
    this.width = w;
    this.height = h;
    const app = this.app;
    if (app && app.renderer && typeof app.renderer.resize === "function") {
      try {
        app.renderer.resize(w, h);
      } catch {
        // ignore resize errors
      }
    }
    if (this.scene) this.layout(w, h);
  }

  // -------------------------------------------------------------------------
  // Per-frame loop
  // -------------------------------------------------------------------------

  private onTick(): void {
    const elapsed = this.now() - this.startMs;
    if (this.post) {
      this.post.update(elapsed);
    }
    this.animate(elapsed);
  }

  private animate(elapsedMs: number): void {
    const scene = this.scene;
    const L = this.L;
    if (!scene || !L) return;
    const t = elapsedMs / 1000;

    // --- Idle breathing/sway for both actors (subtle sin on y + scale) ----
    const bD = Math.sin(t * 1.5);
    const bP = Math.sin(t * 1.5 + 1.1);
    scene.dealer.y = L.dealerBaseY + bD * 2.5;
    scene.dealer.scale.set(L.actorScale * (1 + bD * 0.012));
    scene.player.y = L.playerBaseY + bP * 2.5;
    scene.player.scale.set(L.actorScale * (1 + bP * 0.012));

    // --- Amber lamp pool: a very slow, gentle pulse (never harsh) ---------
    scene.lampGlow.alpha = 0.9 + 0.1 * Math.sin(t * 0.5);

    // --- Cylinder slides toward the active participant --------------------
    const targetX = L.cylX;
    const targetY = this.activeSide === "AI" ? L.cylDealerY : L.cylPlayerY;
    this.cylCurX += (targetX - this.cylCurX) * 0.12;
    this.cylCurY += (targetY - this.cylCurY) * 0.12;
    scene.cylinderSlide.x = this.cylCurX;
    scene.cylinderSlide.y = this.cylCurY;
    scene.cylinderSlide.zIndex = Math.round(this.cylCurY);

    // --- Cylinder idle rotation + fast SPUN spin --------------------------
    let rotation = t * 0.25; // slow continuous idle rotation
    const spin = this.fxProgress("spin");
    if (spin !== null) {
      // Three fast revolutions, eased out; ends on a whole-turn multiple so the
      // return to idle is seamless (3 * 2π ≡ 0 mod 2π).
      rotation += easeOutCubic(spin) * Math.PI * 2 * 3;
    }
    scene.cylinderSpin.rotation = rotation;

    // --- Recoil kick (settles back over the tween) ------------------------
    const recoil = this.fxProgress("recoil");
    scene.cylinderSpin.y = recoil !== null ? -Math.sin(recoil * Math.PI) * 10 : 0;

    // --- Muzzle flash: brief and bright -----------------------------------
    const muzzle = this.fxProgress("muzzle");
    if (muzzle !== null) {
      scene.muzzleFlash.visible = true;
      scene.muzzleFlash.alpha = (1 - muzzle) * 0.95;
      scene.muzzleFlash.scale.set(L.actorScale * (0.7 + muzzle * 0.6));
    } else {
      scene.muzzleFlash.visible = false;
    }

    // --- HP pip pulse on the affected participant -------------------------
    applyPulse(scene.playerHp, this.fxProgress("hp_PLAYER"));
    applyPulse(scene.dealerHp, this.fxProgress("hp_AI"));

    // --- Subtle camera push-in on a live shot -----------------------------
    const camera = this.fxProgress("camera");
    const stage = this.stageNode();
    if (stage) {
      const s = camera !== null ? 1 + Math.sin(camera * Math.PI) * 0.04 : 1;
      stage.scale.set(s);
    }
  }

  /**
   * Progress [0,1] of a running effect, or null if inactive/finished. Clears
   * the effect once complete so transforms reset to rest on the next frame.
   */
  private fxProgress(key: string): number | null {
    const f = this.fx[key];
    if (!f) return null;
    const p = (this.now() - f.start) / f.dur;
    if (p >= 1) {
      this.fx[key] = undefined;
      return null;
    }
    return p < 0 ? 0 : p;
  }

  /** The real stage as a full Container (only touched post-init). */
  private stageNode(): Container | undefined {
    return this.app ? (this.app.stage as unknown as Container) : undefined;
  }

  // -------------------------------------------------------------------------
  // Scene construction (build once; positions come from layout())
  // -------------------------------------------------------------------------

  private buildScene(app: PixiAppLike): void {
    const bgLayer = new Container();
    const dioramaLayer = new Container();
    const lampLayer = new Container();
    const actorLayer = new Container();
    actorLayer.sortableChildren = true;
    const hudLayer = new Container();

    const bg = new Graphics();
    bgLayer.addChild(bg);

    const table = new Graphics();
    const shadows = new Graphics();
    dioramaLayer.addChild(table);
    dioramaLayer.addChild(shadows);

    // Soft amber lamp pool above/behind the table (additive warm light).
    const lampGlow = new Graphics();
    setAdditive(lampGlow);
    lampLayer.addChild(lampGlow);

    // Actors: billboard dealer + player, revolver cylinder.
    const dealer = makeActor(this.textures.dealer, "THE DEALER");
    const player = makeActor(this.textures.player, "YOU");

    const cylinderSlide = new Container();
    const cylinderSpin = new Container();
    const cylinder = makeCylinderVisual(this.textures.cylinder);
    cylinderSpin.addChild(cylinder);
    // A small shadow that travels with the sliding cylinder.
    const cylShadow = new Graphics();
    cylShadow.ellipse(0, 30, 40, 12).fill({ color: 0x000000, alpha: 0.45 });
    cylinderSlide.addChild(cylShadow);
    cylinderSlide.addChild(cylinderSpin);

    const muzzleFlash = new Graphics();
    muzzleFlash.circle(0, 0, 40).fill({ color: 0xfff2c0, alpha: 0.95 });
    muzzleFlash.circle(0, 0, 22).fill({ color: 0xffffff, alpha: 0.9 });
    setAdditive(muzzleFlash);
    muzzleFlash.visible = false;
    cylinderSlide.addChild(muzzleFlash);

    actorLayer.addChild(dealer);
    actorLayer.addChild(player);
    actorLayer.addChild(cylinderSlide);

    // HUD text (title + turn banner at the very top; winner centered).
    const title = makeText("REVOLVER ROULETTE", 18, COLOR.bone);
    title.anchor.set(0.5, 0);
    const banner = makeText("", 14, COLOR.amber);
    banner.anchor.set(0.5, 0);
    const winner = makeText("", 30, COLOR.amber);
    winner.anchor.set(0.5, 0.5);
    winner.visible = false;
    const gunLabel = makeText("", 11, COLOR.bone);
    gunLabel.anchor.set(0.5, 0);

    // On-table HP + items, centered around their container origins.
    const playerHp = new Graphics();
    const dealerHp = new Graphics();
    const playerItems = new Container();
    const dealerItems = new Container();
    const shells = new Container();

    hudLayer.addChild(title);
    hudLayer.addChild(banner);
    hudLayer.addChild(winner);
    hudLayer.addChild(gunLabel);
    hudLayer.addChild(playerHp);
    hudLayer.addChild(dealerHp);
    hudLayer.addChild(playerItems);
    hudLayer.addChild(dealerItems);
    hudLayer.addChild(shells);

    app.stage.addChild(bgLayer);
    app.stage.addChild(dioramaLayer);
    app.stage.addChild(lampLayer);
    app.stage.addChild(actorLayer);
    app.stage.addChild(hudLayer);

    // Build and attach the post-processing filter chain to the stage root.
    this.post = createPostFilters();
    app.stage.filters = this.post.filters;

    this.scene = {
      bgLayer,
      dioramaLayer,
      lampLayer,
      actorLayer,
      hudLayer,
      bg,
      table,
      shadows,
      lampGlow,
      dealer,
      player,
      cylinderSlide,
      cylinderSpin,
      muzzleFlash,
      title,
      banner,
      winner,
      gunLabel,
      playerHp,
      dealerHp,
      playerItems,
      dealerItems,
      shells,
    };
  }

  // -------------------------------------------------------------------------
  // Layout: position EVERYTHING from the current size (fullscreen-friendly)
  // -------------------------------------------------------------------------

  private layout(width: number, height: number): void {
    const scene = this.scene;
    if (!scene) return;

    const w = Math.max(320, width);
    const h = Math.max(240, height);
    const cx = w / 2;

    // Table sized relative to the viewport, clamped to sane bounds.
    const tableW = clamp(w * 0.66, 480, 1100);
    const tableH = clamp(h * 0.5, 260, 560);
    const tableCenterY = h * 0.54;
    const tableTop = tableCenterY - tableH / 2;
    const actorScale = clamp(tableH / 280, 0.7, 2.0);

    const L: LayoutData = {
      w,
      h,
      cx,
      tableTop,
      tableW,
      tableH,
      actorScale,
      dealerBaseY: tableTop + 2,
      playerBaseY: tableTop + tableH - 2,
      cylX: cx,
      cylPlayerY: tableTop + tableH * 0.62,
      cylDealerY: tableTop + tableH * 0.38,
      cylCenterY: tableTop + tableH * 0.5,
    };
    this.L = L;

    // Background + faint blood grid.
    drawBackground(scene.bg, w, h);

    // Table top + thick bevel + highlight + reflection gradient.
    drawTable(scene.table, cx, tableTop, tableW, tableH);

    // Stronger drop shadows beneath the two billboards.
    scene.shadows.clear();
    drawSoftShadow(scene.shadows, cx, tableTop + 8, tableW * 0.14, tableH * 0.05);
    drawSoftShadow(scene.shadows, cx, tableTop + tableH - 8, tableW * 0.16, tableH * 0.05);

    // Amber lamp pool, centered over the table, sized to the surface.
    drawLamp(scene.lampGlow, Math.max(tableW, tableH) * 0.72);
    scene.lampLayer.x = cx;
    scene.lampLayer.y = tableTop + tableH * 0.32;

    // Actors.
    scene.dealer.x = cx;
    scene.dealer.y = L.dealerBaseY;
    scene.dealer.scale.set(actorScale);
    scene.dealer.zIndex = Math.round(L.dealerBaseY);

    scene.player.x = cx;
    scene.player.y = L.playerBaseY;
    scene.player.scale.set(actorScale);
    scene.player.zIndex = Math.round(L.playerBaseY);

    scene.cylinderSpin.scale.set(actorScale);
    scene.muzzleFlash.scale.set(actorScale);
    if (!this.cylInit) {
      this.cylCurX = L.cylX;
      this.cylCurY = L.cylCenterY;
      this.cylInit = true;
    } else {
      this.cylCurX = L.cylX;
    }
    scene.cylinderSlide.x = this.cylCurX;
    scene.cylinderSlide.y = this.cylCurY;

    // HUD text at the very top.
    scene.title.x = cx;
    scene.title.y = 12;
    scene.banner.x = cx;
    scene.banner.y = 38;
    scene.winner.x = cx;
    scene.winner.y = h * 0.5;
    scene.gunLabel.x = cx;
    scene.gunLabel.y = tableTop + tableH * 0.5 + 26;

    // On-table HP + items: dealer on the far (top) edge, player on the near
    // (bottom) edge, each row centered on cx.
    scene.dealerHp.x = cx;
    scene.dealerHp.y = tableTop + tableH * 0.1;
    scene.dealerItems.x = cx;
    scene.dealerItems.y = tableTop + tableH * 0.2;

    scene.playerHp.x = cx;
    scene.playerHp.y = tableTop + tableH * 0.9;
    scene.playerItems.x = cx;
    scene.playerItems.y = tableTop + tableH * 0.8;

    // Shell tokens stay near the center of the table.
    scene.shells.x = cx;
    scene.shells.y = tableTop + tableH * 0.5;

    // Centered camera transform so the push-in zooms about the screen center.
    const stage = this.stageNode();
    if (stage) {
      stage.pivot.set(cx, h / 2);
      stage.position.set(cx, h / 2);
    }
  }

  private drawHud(scene: SceneHandles, vm: HudViewModel): void {
    scene.banner.text = vm.banner;

    drawHpPips(scene.playerHp, vm.player.hp.current, vm.player.hp.max);
    drawHpPips(scene.dealerHp, vm.dealer.hp.current, vm.dealer.hp.max);

    drawItemRow(scene.playerItems, vm.player.items, this.textures);
    drawItemRow(scene.dealerItems, vm.dealer.items, this.textures);

    drawShells(scene.shells, vm.liveRemaining, vm.blankRemaining, this.textures);
    scene.gunLabel.text = `${vm.liveRemaining} LIVE \u00b7 ${vm.blankRemaining} BLANK`;

    if (vm.matchOver && vm.winner !== null) {
      scene.winner.visible = true;
      scene.winner.text = `${participantName(vm.winner)} WINS`;
    } else {
      scene.winner.visible = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/** Set a Container/Graphics to additive ("screen"-like) blending for glows. */
function setAdditive(node: Container): void {
  (node as unknown as { blendMode: string }).blendMode = "add";
}

function makeText(text: string, size: number, color: number): Text {
  return new Text({
    text,
    style: {
      fontFamily: "Courier New, monospace",
      fontSize: size,
      fill: color,
      letterSpacing: 2,
    },
  });
}

function drawBackground(g: Graphics, w: number, h: number): void {
  g.clear();
  g.rect(0, 0, w, h).fill({ color: COLOR.bg0 });
  const step = 56;
  for (let x = 0; x <= w; x += step) {
    g.moveTo(x, 0).lineTo(x, h);
  }
  for (let y = 0; y <= h; y += step) {
    g.moveTo(0, y).lineTo(w, y);
  }
  g.stroke({ width: 1, color: COLOR.blood, alpha: 0.05 });
}

/**
 * Draw the tilted table: a thick beveled "cardboard" front edge, the top face,
 * a subtle top-edge highlight, and a faint reflection/darkening gradient on the
 * surface (darker toward the near/front edge) to sell 2.5D depth.
 */
function drawTable(
  g: Graphics,
  cx: number,
  tableTop: number,
  tableW: number,
  tableH: number,
): void {
  g.clear();
  const left = cx - tableW / 2;
  const bevel = 40;

  // Thick beveled front/side edge sitting below the top face.
  g.roundRect(left, tableTop + tableH - 12, tableW, bevel + 22, 20)
    .fill({ color: COLOR.tableEdge })
    .stroke({ width: 3, color: COLOR.outline });

  // Top face of the table.
  g.roundRect(left, tableTop, tableW, tableH, 22)
    .fill({ color: COLOR.tableMid })
    .stroke({ width: 3, color: COLOR.outline });

  // Lit pool: a slightly brighter inset region where the lamp falls.
  g.roundRect(left + 14, tableTop + 10, tableW - 28, tableH * 0.5, 18)
    .fill({ color: COLOR.tableTop, alpha: 0.85 });

  // Subtle amber top-edge highlight along the bevel seam.
  g.roundRect(left + 8, tableTop + tableH - 14, tableW - 16, 4, 2)
    .fill({ color: COLOR.amber, alpha: 0.1 });

  // Reflection / darkening gradient: faint dark bands toward the front edge.
  const bands = 6;
  for (let i = 0; i < bands; i++) {
    const frac = i / bands;
    const y = tableTop + tableH * 0.5 + (tableH * 0.5 * frac);
    const bandH = (tableH * 0.5) / bands + 1;
    g.rect(left + 4, y, tableW - 8, bandH).fill({
      color: 0x000000,
      alpha: 0.04 + frac * 0.06,
    });
  }
}

/** A soft drop shadow faked with two stacked ellipses (no blur filter needed). */
function drawSoftShadow(g: Graphics, x: number, y: number, rx: number, ry: number): void {
  g.ellipse(x, y, rx * 1.25, ry * 1.3).fill({ color: 0x000000, alpha: 0.3 });
  g.ellipse(x, y, rx, ry).fill({ color: 0x000000, alpha: 0.55 });
}

/** Concentric amber rings approximating a warm radial lamp pool (additive). */
function drawLamp(g: Graphics, radius: number): void {
  g.clear();
  const steps = 7;
  for (let i = steps; i >= 1; i--) {
    const r = (radius * i) / steps;
    const a = 0.105 * (1 - i / steps) + 0.018;
    g.circle(0, 0, r).fill({ color: COLOR.amber, alpha: a });
  }
}

function makeActorCard(name: string, color: number): Container {
  const c = new Container();
  const card = new Graphics();
  card
    .roundRect(-44, -120, 88, 116, 10)
    .fill({ color })
    .stroke({ width: 3, color: COLOR.outline });
  const plate = makeText(name, 11, COLOR.muted);
  plate.anchor.set(0.5, 0);
  plate.x = 0;
  plate.y = 2;
  c.addChild(card);
  c.addChild(plate);
  return c;
}

/**
 * Build a billboard actor: an upright sprite whose base sits on the container
 * origin. Falls back to a Graphics ID card when the texture is missing.
 */
function makeActor(texture: Texture | undefined, name: string): Container {
  if (!texture) return makeActorCard(name, COLOR.tableTop);
  const c = new Container();
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5, 1); // stand the billboard on its base-line
  const targetHeight = 150;
  const th = sprite.texture.height || targetHeight;
  sprite.scale.set(targetHeight / th);
  c.addChild(sprite);
  return c;
}

/**
 * Build the revolver cylinder visual, centered on its origin so spin (rotation)
 * and recoil (offset) work unchanged. Falls back to a Graphics cylinder.
 */
function makeCylinderVisual(texture: Texture | undefined): Container {
  if (!texture) return makeCylinder();
  const c = new Container();
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5, 0.5);
  const targetDiameter = 96;
  const tw = sprite.texture.width || targetDiameter;
  sprite.scale.set(targetDiameter / tw);
  c.addChild(sprite);
  return c;
}

function makeCylinder(): Container {
  const c = new Container();
  const body = new Graphics();
  body
    .circle(0, 0, 44)
    .fill({ color: COLOR.tableTop })
    .stroke({ width: 4, color: COLOR.outline });
  body.circle(0, 0, 14).fill({ color: COLOR.tableEdge }).stroke({ width: 2, color: COLOR.outline });
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const px = Math.cos(angle) * 28;
    const py = Math.sin(angle) * 28;
    body.circle(px, py, 7).fill({ color: 0x0a0a0b }).stroke({ width: 2, color: COLOR.outline });
  }
  c.addChild(body);
  return c;
}

/**
 * Draw HP as a centered row of red "charge" token pips on the table: filled =
 * remaining, dim = lost. Centered on the Graphics origin so the row can be
 * placed by setting the Graphics x/y. (Req 2.6, Buckshot-style on-table HP.)
 */
function drawHpPips(g: Graphics, current: number, max: number): void {
  g.clear();
  if (max <= 0) return;
  const r = 9;
  const gap = 12;
  const step = r * 2 + gap;
  const start = -((max - 1) * step) / 2;
  for (let i = 0; i < max; i++) {
    const x = start + i * step;
    const filled = i < current;
    // Socket.
    g.circle(x, 0, r + 3).fill({ color: COLOR.tableEdge }).stroke({ width: 2, color: COLOR.outline });
    if (filled) {
      g.circle(x, 0, r).fill({ color: COLOR.blood }).stroke({ width: 1.5, color: COLOR.outline });
      // Warm specular nick.
      g.circle(x - 2.5, -2.5, r * 0.4).fill({ color: COLOR.amber, alpha: 0.35 });
    } else {
      g.circle(x, 0, r).fill({ color: COLOR.bloodDim, alpha: 0.55 });
    }
  }
}

/**
 * Draw a participant's held items as a centered row of icon sprites on the
 * table in front of them (Req 5.11). Uses the SVG icons with a Graphics slot
 * fallback. Centered on the container origin.
 */
function drawItemRow(
  container: Container,
  items: ReadonlyArray<ItemType>,
  textures: TextureMap,
): void {
  container.removeChildren();
  const n = items.length;
  if (n <= 0) return;
  const slot = 38;
  const gap = 10;
  const step = slot + gap;
  const start = -((n - 1) * step) / 2;
  for (let i = 0; i < n; i++) {
    const item = items[i];
    if (item === undefined) continue;
    const x = start + i * step;

    const bg = new Graphics();
    bg.roundRect(x - slot / 2, -slot / 2, slot, slot, 8)
      .fill({ color: COLOR.tableMid, alpha: 0.9 })
      .stroke({ width: 2, color: COLOR.amber });
    container.addChild(bg);

    const texture = textures[itemSpriteKey(item)];
    if (texture) {
      const icon = new Sprite(texture);
      icon.anchor.set(0.5, 0.5);
      const target = slot - 10;
      const size = texture.width || target;
      icon.scale.set(target / size);
      icon.x = x;
      icon.y = 0;
      container.addChild(icon);
    }
  }
}

function drawShells(
  container: Container,
  live: number,
  blank: number,
  textures: TextureMap,
): void {
  container.removeChildren();
  const total = live + blank;
  if (total <= 0) return;
  const shellW = 12;
  const shellH = 22;
  const gap = 7;
  const step = shellW + gap;
  const startX = -((total - 1) * step) / 2 - shellW / 2;
  for (let i = 0; i < total; i++) {
    const x = startX + i * step;
    const isLive = i < live;
    const texture = textures[isLive ? "shell-live" : "shell-blank"];
    if (texture) {
      const shell = new Sprite(texture);
      shell.anchor.set(0, 0.5);
      const size = texture.height || shellH;
      shell.scale.set(shellH / size);
      shell.x = x;
      shell.y = 0;
      container.addChild(shell);
    } else {
      const g = new Graphics();
      g.roundRect(x, -shellH / 2, shellW, shellH, 3)
        .fill({ color: isLive ? COLOR.blood : COLOR.muted })
        .stroke({ width: 2, color: COLOR.outline });
      container.addChild(g);
    }
  }
}

/** Pulse a HUD graphic's scale on an HP change; rest scale 1 when inactive. */
function applyPulse(g: Graphics, progress: number | null): void {
  const s = progress !== null ? 1 + Math.sin(progress * Math.PI) * 0.3 : 1;
  g.scale.set(s);
}

// Re-export ParticipantId is unnecessary; consumers import from engine/types.
export type { ParticipantId };
