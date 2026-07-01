// Renderer3D (Requirement 8): a Three.js-backed full-3D renderer for Revolver
// Roulette, rendered dark, grimy and deadly — a gaunt undertaker Dealer and a
// hooded Player face each other across a felt-topped table in a near-black room
// lit by a single swinging bulb. Real 3D geometry (see `./models3d`), no
// external model files.
//
// Design constraints honoured here:
//   - The renderer is presentation-only. It reads `GameState` and reacts to
//     `GameEvent`s but owns no rules and NEVER mutates the state it is given.
//   - `init` is async and returns a typed Result; on a WebGL context failure it
//     resolves to an error and the caller shows the "rendering unavailable"
//     overlay while the Match state is left intact (Req 8.5).
//   - The canvas fills the window and resizes with it.
//   - Everything animates from a requestAnimationFrame loop at >=30 FPS:
//     figures breathe, the bulb sways, the cylinder slides toward the active
//     participant and idly rotates, shots flash/recoil, HP markers gutter out,
//     and a cinematic camera cuts to dramatic angles during interactions
//     (shots, spins, item use) before easing back to the wide establishing shot.
//   - HUD-ish state (HP, items, shells, turn) is derived from the pure mappings
//     in `./viewModel`, identical to the 2D renderer, so behaviour is testable.

import * as THREE from "three";
import { gsap } from "gsap";
import type { Action, GameEvent, GameState, ItemType, ParticipantId } from "../engine/types";
import {
  participantName,
  toHudViewModel,
} from "./viewModel";
import {
  buildBloodBurst,
  buildBetChip,
  buildBriefcase,
  Briefcase,
  buildRoundBoard,
  updateRoundBoardText,
  buildDealer,
  buildGraveflies,
  buildHpMarker,
  buildItemContents,
  buildItemSlot,
  buildMiniLamp,
  buildPlayer,
  buildRevolver,
  buildRoom,
  buildShell,
  buildTable,
  PAL,
  SURFACE_Y,
  TABLE,
  type BloodBurst,
  type BetChip,
  type FigureHandles,
  type Graveflies,
  type HpMarker,
  type ItemSlot,
  type MiniLamp,
  type RevolverHandles,
  buildPlayerHands,
} from "./models3d";

// ---------------------------------------------------------------------------
// Result types (Req 8.5) — mirror the 2D renderer's surface
// ---------------------------------------------------------------------------

export type RenderInitError = { kind: "RENDER_INIT_FAILED"; message: string };
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface IRenderer {
  init(canvasOrContainer: HTMLCanvasElement | HTMLElement): Promise<Result<void, RenderInitError>>;
  render(state: GameState): void;
  playActionFeedback(event: GameEvent): void;
  start(): void;
  stop(): void;
  showRenderUnavailable(): void;
  destroy(): void;
}

export interface Renderer3DOptions {
  /** Time source (ms). Injectable for tests; defaults to performance.now. */
  readonly now?: () => number;
  /** Submit a player Action from an in-world click (gun, item box, spin). */
  readonly onAction?: (action: Action) => void;
  /** Any in-world interaction (for the UI blip + first-gesture ambient start). */
  readonly onInteract?: () => void;
  /** Called when the overhead bulb blinks out (drives the flicker sound). */
  readonly onBlink?: () => void;
  /** Called when the hovered item changes (null when nothing is hovered). */
  readonly onHoverItem?: (item: ItemType | null) => void;
  /** Called when hovering a bet chip (shows the value). */
  readonly onHoverChip?: (value: number | null) => void;
  /** Called when a bet coin is selected (plays the coin sound). */
  readonly onCoinSelect?: () => void;
  /** Called when the gun is raised into hand. */
  readonly onGunRaise?: () => void;
  /** Called when a candle blows out. */
  readonly onCandleBlow?: () => void;
}

const defaultNow = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/** A running visual effect keyed by name (start time + duration). */
interface Fx {
  start: number;
  dur: number;
}

// ---------------------------------------------------------------------------
// Scene geometry constants (positions reused by layout + camera director)
// ---------------------------------------------------------------------------

const DEALER_Z = -TABLE.depth / 2 - 2.2;
const PLAYER_Z = TABLE.depth / 2 + 2.2;
const HP_ROW_Z = TABLE.depth * 0.44; // candles sit near each figure's edge
const ITEM_ROW_Z = TABLE.depth * 0.25; // item boxes sit nearer the centre
const HP_X = -2.4; // HP candles cluster on the left
const SLOT_COUNT = 8; // on-table item zones per side (== max items)
const SLOT_SPACING = 0.92;
const GUN_REST_Z = 0; // the gun rests in the centre circle
const SHELL_HOLD_MS = 1900; // how long the round composition is shown
const SHELL_FLIP_MS = 1100; // then the shells flip down into the table

// Item -> the colour of its on-use burst effect.
const ITEM_BURST_COLOR: Record<ItemType, number> = {
  MAGNIFYING_GLASS: 0x6fd3ff,
  SPEED_LOADER: 0xc09a3e,
  MEDKIT: 0x6fff8a,
  HANDCUFFS: 0xb0b6c0,
  INVERTER: 0xc56fff,
  HOLLOW_POINT: 0xff3b2f,
};

// Base shot: a high, angled top-down view over the table where the Dealer
// is out of frame. The camera only looks up at the Dealer when aiming.
const CAM_FP = {
  pos: new THREE.Vector3(0, 12.0, 5.0),
  look: new THREE.Vector3(0, SURFACE_Y, 0),
};

/** One framed camera move: where to sit, where to look, hold time, ease rate. */
interface CamShot {
  pos: THREE.Vector3;
  look: THREE.Vector3;
  holdMs: number;
  lerp: number;
}

// ---------------------------------------------------------------------------
// Renderer3D
// ---------------------------------------------------------------------------

export class Renderer3D implements IRenderer {
  private readonly now: () => number;

  private renderer: THREE.WebGLRenderer | undefined;
  private scene: THREE.Scene | undefined;
  private camera: THREE.PerspectiveCamera | undefined;
  private overlay: HTMLElement | undefined;

  private running = false;
  private aiAimingTarget: "PLAYER" | "AI" | null = null;
  private roundPopupToken?: THREE.Mesh;
  private rafId = 0;
  private startMs = 0;
  private aimT = 0;
  private dealerAimT = 0;
  private width = 960;
  private height = 600;

  // Scene actors.
  private dealer: FigureHandles | undefined;
  private player: FigureHandles | undefined;
  private revolver: RevolverHandles | undefined;
  private bulb: THREE.PointLight | undefined;
  private bulbMesh: THREE.Mesh | undefined;
  private miniLamp: MiniLamp | undefined;
  private graveflies: Graveflies | undefined;
  private playerHp: HpMarker[] = [];
  private dealerHp: HpMarker[] = [];
  private playerSlots: ItemSlot[] = [];
  private dealerSlots: ItemSlot[] = [];
  private shellGroup: THREE.Group | undefined;
  private blood: BloodBurst | undefined;
  private playerBox: Briefcase | undefined;
  private dealerBox: Briefcase | undefined;
  private roundBoard: THREE.Group | undefined;

  // Animation/derived state.
  private gunBaseY = SURFACE_Y;
  private gunHoverY = 0;
  private gunHoverRot = 0;
  // aimT is already defined above
  private shellRevealStart = -1;
  private shellItems: THREE.Object3D[] = [];
  private shellSlot: THREE.Mesh | undefined;
  private itemBurst: THREE.Mesh | undefined;
  private itemBurstStart = -1;
  private bloodStart = -1;
  private bloodDurMs = 1100;
  // hideItemsUntil is unused
  private blinkEnd = 0;
  private nextBlink = 0;
  // Delayed candle extinguish so the flame blows out ON the candle camera cut.
  private shownHp: Record<"player" | "dealer", number> = { player: -1, dealer: -1 };
  private candleBlow:
    | {
        markers: HpMarker[];
        index: number;
        max: number;
        side: "player" | "dealer";
        target: number;
        startMs: number;
        dur: number;
        soundPlayed: boolean;
      }
    | null = null;
  private deathPlayerProg: number | null = null;
  // The interactive root currently hovered (drives the item float).
  private hoverRoot: THREE.Object3D | null = null;
  private readonly fx: Record<string, Fx | undefined> = {};

  // Camera director (a small queue of framed shots that ease into one another;
  // when the queue empties the camera returns to the first-person base shot).
  private camPos = CAM_FP.pos.clone();
  private camLook = CAM_FP.look.clone();
  private camTargetPos = CAM_FP.pos.clone();
  private camTargetLook = CAM_FP.look.clone();
  private camHoldUntil = 0;
  private camLerp = 0.1;
  private camQueue: CamShot[] = [];
  private camFocused = false;
  private inMenu = false;
  private transitioning = false;
  private menuAngle = 0;

  public setMenuCamera(): void {
    this.inMenu = true;
    this.transitioning = false;
    this.menuAngle = -Math.PI / 6; // start angle
    // We don't need to set camPos here because updateCamera will compute it 
    // from menuAngle every frame while inMenu is true.
  }

  public transitionToGame(onComplete: () => void): void {
    this.inMenu = false;
    this.transitioning = true;
    // Animate camPos and camLook to CAM_FP
    gsap.to(this.camPos, {
      x: CAM_FP.pos.x,
      y: CAM_FP.pos.y,
      z: CAM_FP.pos.z,
      duration: 2.5,
      ease: "power2.inOut",
    });
    gsap.to(this.camLook, {
      x: CAM_FP.look.x,
      y: CAM_FP.look.y,
      z: CAM_FP.look.z,
      duration: 2.5,
      ease: "power2.inOut",
      onComplete: () => {
        this.transitioning = false; // give control back to regular lerp
        onComplete();
      }
    });
  }

  // Interaction.
  private readonly onAction: (action: Action) => void;
  private readonly onInteract: () => void;
  private readonly onBlink: () => void;
  private readonly onHoverItem: (item: ItemType | null) => void;
  private readonly onHoverChip: (value: number | null) => void;
  private readonly onCoinSelect: () => void;
  private readonly onGunRaise: () => void;
  private readonly onCandleBlow: () => void;
  private lastActive: ParticipantId | null = null;
  private hoverItemKey: ItemType | null = null;
  private betChips: BetChip[] = [];
  private betChipGroup: THREE.Group | undefined;
  private onBetSelected: ((value: number) => void) | null = null;
  private hoverChipValue: number | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private interactives: Array<{ root: THREE.Object3D; hit: () => void }> = [];
  private aiming = false;
  private aimTarget: ParticipantId = "AI"; // which way the raised gun points
  private firing = false; // a target was chosen; markers hidden during the shot
  private gunDropAt = 0; // when to lower the gun back into the circle
  private dealerMarker: THREE.Group | undefined;
  private selfMarker: THREE.Group | undefined;
  private spinToken: THREE.Group | undefined;
  // Live affordance flags, refreshed every render(state).
  private localParticipant: "PLAYER" | "AI" = "PLAYER";
  private playerTurn = false;
  private matchOver = false;
  private roundsRemaining = 0;
  private spinAllowed = false;
  private playerItems: ReadonlyArray<ItemType> = [];

  private readonly onResize = (): void => this.handleResize();
  private readonly onPointerDown = (e: PointerEvent): void => this.handlePointer(e);
  private readonly onPointerMove = (e: PointerEvent): void => this.handleHover(e);

  constructor(options: Renderer3DOptions = {}) {
    this.now = options.now ?? defaultNow;
    this.onAction = options.onAction ?? ((): void => {});
    this.onInteract = options.onInteract ?? ((): void => {});
    this.onBlink = options.onBlink ?? ((): void => {});
    this.onHoverItem = options.onHoverItem ?? ((): void => {});
    this.onHoverChip = options.onHoverChip ?? ((): void => {});
    this.onCoinSelect = options.onCoinSelect ?? ((): void => {});
    this.onGunRaise = options.onGunRaise ?? ((): void => {});
    this.onCandleBlow = options.onCandleBlow ?? ((): void => {});
  }

  // -------------------------------------------------------------------------
  // Init (Req 8.5): graceful failure if WebGL is unavailable
  // -------------------------------------------------------------------------

  async init(
    canvasOrContainer: HTMLCanvasElement | HTMLElement,
  ): Promise<Result<void, RenderInitError>> {
    try {
      const isCanvas =
        typeof HTMLCanvasElement !== "undefined" &&
        canvasOrContainer instanceof HTMLCanvasElement;

      this.resolveSize();

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        canvas: isCanvas ? (canvasOrContainer as HTMLCanvasElement) : undefined,
        powerPreference: "high-performance",
      });
      renderer.setPixelRatio(
        typeof window !== "undefined" ? Math.min(window.devicePixelRatio, 2) : 1,
      );
      renderer.setSize(this.width, this.height, false);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;

      if (!isCanvas) {
        (canvasOrContainer as HTMLElement).appendChild(renderer.domElement);
      }
      this.renderer = renderer;

      this.buildScene();

      if (typeof window !== "undefined") {
        window.addEventListener("resize", this.onResize);
      }
      renderer.domElement.style.touchAction = "none";
      renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
      renderer.domElement.addEventListener("pointermove", this.onPointerMove);

      return { ok: true, value: undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { kind: "RENDER_INIT_FAILED", message } };
    }
  }

  private resolveSize(): void {
    const ww = typeof window !== "undefined" ? window.innerWidth : 0;
    const wh = typeof window !== "undefined" ? window.innerHeight : 0;
    this.width = ww || 960;
    this.height = wh || 600;
  }

  // -------------------------------------------------------------------------
  // Scene construction
  // -------------------------------------------------------------------------

  private buildScene(): void {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PAL.void);
    scene.fog = new THREE.FogExp2(PAL.fog, 0.028);

    const camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 100);
    camera.position.copy(this.camPos);
    camera.lookAt(this.camLook);

    // --- Lighting: dim ambient + swinging bulb + a warm camera-side fill --
    scene.add(new THREE.AmbientLight(0x3a3034, 1.15));

    // A soft warm fill from the camera so the figures' fronts read (no shadow
    // so it never fights the bulb's cast shadows).
    const fill = new THREE.DirectionalLight(0xffd9b0, 0.55);
    fill.position.set(0, 8, 16);
    scene.add(fill);

    const bulb = new THREE.PointLight(0xffb060, 40, 34, 2);
    bulb.position.set(0, 11, 0);
    bulb.castShadow = true;
    bulb.shadow.mapSize.set(2048, 2048);
    bulb.shadow.bias = -0.0005;
    scene.add(bulb);
    this.bulb = bulb;

    const bulbMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 10, 10),
      new THREE.MeshStandardMaterial({
        color: 0xffd9a0,
        emissive: 0xffb060,
        emissiveIntensity: 3,
      }),
    );
    bulbMesh.position.copy(bulb.position);
    scene.add(bulbMesh);
    this.bulbMesh = bulbMesh;
    // The cord.
    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 4, 6),
      new THREE.MeshStandardMaterial({ color: 0x0a0a0a }),
    );
    cord.position.set(0, 13, 0);
    scene.add(cord);

    // A faint cold rim from behind the dealer for separation.
    const rim = new THREE.DirectionalLight(0x33405a, 0.45);
    rim.position.set(-4, 8, -12);
    scene.add(rim);

    // --- Street lamp on the right, gooseneck reaching over the table -----
    const lamp = buildMiniLamp();
    lamp.group.position.set(6.0, 0, 1.4);
    // The arm bends toward -X in local space, so unrotated it reaches left
    // over the table — exactly what we want from the right side.
    scene.add(lamp.group);
    this.miniLamp = lamp;

    // --- Graveflies swarming under the lamp head -------------------------
    const flies = buildGraveflies(22);
    const headWorld = lamp.headOffset.clone().add(lamp.group.position);
    flies.group.position.copy(headWorld);
    scene.add(flies.group);
    this.graveflies = flies;

    // --- World -----------------------------------------------------------
    scene.add(buildRoom());
    scene.add(buildTable());

    // --- Figures ---------------------------------------------------------
    const dealer = buildDealer();
    dealer.group.position.set(0, 0, DEALER_Z);
    scene.add(dealer.group);
    this.dealer = dealer;

    const player = buildPlayer();
    player.group.position.set(0, 0, PLAYER_Z);
    player.group.rotation.y = Math.PI; // face the dealer (away from camera)
    player.group.visible = false; // first-person: we ARE the player
    scene.add(player.group);
    this.player = player;
    
    // Add the First Person Player Hands on the table
    const playerHands = buildPlayerHands();
    scene.add(playerHands);

    // --- Revolver lying flat on the felt, on the player's side ----------
    const revolver = buildRevolver();
    revolver.group.rotation.set(0, -0.5, 0); // diagonal yaw across the felt
    revolver.group.position.set(0, SURFACE_Y, GUN_REST_Z);
    // Compute the resting height so the gun sits ON the felt (no clipping).
    const gunBox = new THREE.Box3().setFromObject(revolver.group);
    this.gunBaseY = SURFACE_Y + (SURFACE_Y - gunBox.min.y);
    revolver.group.position.y = this.gunBaseY;
    scene.add(revolver.group);
    this.revolver = revolver;
    // Clicking the gun toggles aim mode (then click the Dealer or the SELF
    // marker to fire).
    this.interactives.push({
      root: revolver.group,
      hit: (): void => this.onGunClick(),
    });

    // --- HP candles (compact rows near each figure's edge) ---------------
    this.dealerHp = this.spawnHp(scene, -HP_ROW_Z);
    this.playerHp = this.spawnHp(scene, HP_ROW_Z);

    // --- Six item boxes per side (the on-table item belt; == max items) --
    this.dealerSlots = this.spawnSlots(scene, -ITEM_ROW_Z, true);
    this.playerSlots = this.spawnSlots(scene, ITEM_ROW_Z, false);
    // The player's own boxes are clickable to use the item inside.
    this.playerSlots.forEach((slot, i) => {
      this.interactives.push({ root: slot.group, hit: (): void => this.onSlotClick(i) });
    });

    // --- Target markers (shown only while aiming) ------------------------
    const dealerMarker = makeTargetMarker(0xc1352b);
    dealerMarker.position.set(0, 6.9, DEALER_Z + 0.4);
    dealerMarker.visible = false;
    scene.add(dealerMarker);
    this.dealerMarker = dealerMarker;
    this.interactives.push({ root: dealerMarker, hit: (): void => this.onTargetClick("AI") });
    // The Dealer's body is also a valid click target while aiming.
    this.interactives.push({ root: dealer.group, hit: (): void => this.onTargetClick("AI") });

    const selfMarker = makeTargetMarker(0xd9a441);
    selfMarker.position.set(0, SURFACE_Y + 0.7, ITEM_ROW_Z + 1.4);
    selfMarker.visible = false;
    scene.add(selfMarker);
    this.selfMarker = selfMarker;
    this.interactives.push({ root: selfMarker, hit: (): void => this.onTargetClick("PLAYER") });

    // --- Spin control: a small engraved disk on the wood rail (NOT a felt
    // item) — only shown when a spin is actually allowed.
    const spinToken = makeSpinToken();
    spinToken.position.set(TABLE.width / 2 - 0.2, SURFACE_Y + 0.04, HP_ROW_Z);
    spinToken.visible = false;
    scene.add(spinToken);
    this.spinToken = spinToken;
    this.interactives.push({ root: spinToken, hit: (): void => this.onSpinClick() });

    // --- Shell tokens revealed at round start, then flipped into the table
    const shells = new THREE.Group();
    shells.position.set(2.6, SURFACE_Y, 0); // on the right part of the table
    shells.visible = false;
    scene.add(shells);
    this.shellGroup = shells;

    // --- Blood burst emitter (repositioned to the victim on a live hit) --
    const blood = buildBloodBurst(28);
    scene.add(blood.group);
    this.blood = blood;

    // --- Item-use burst: a glowing ring that flares when an item is used --
    const burst = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1.0, 32),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xffffff,
        emissiveIntensity: 2.5,
        transparent: true,
        opacity: 0,
      }),
    );
    burst.rotation.x = Math.PI / 2;
    burst.visible = false;
    scene.add(burst);
    this.itemBurst = burst;

    const tokenGeo = new THREE.BoxGeometry(1.5, 0.4, 1.5);
    const tokenMat = new THREE.MeshStandardMaterial({ 
      color: 0xaa2222, 
      emissive: 0xff4444, 
      emissiveIntensity: 0.8,
      metalness: 0.5,
      roughness: 0.2
    });
    this.roundPopupToken = new THREE.Mesh(tokenGeo, tokenMat);
    this.roundPopupToken.position.set(0, SURFACE_Y - 2, 0); // hidden
    this.roundPopupToken.visible = false;
    scene.add(this.roundPopupToken);

    const playerBox = buildBriefcase();
    playerBox.group.position.set(12, SURFACE_Y, ITEM_ROW_Z); 
    playerBox.group.visible = false;
    scene.add(playerBox.group);
    this.playerBox = playerBox;

    const dealerBox = buildBriefcase();
    dealerBox.group.position.set(-12, SURFACE_Y, -ITEM_ROW_Z); 
    dealerBox.group.visible = false;
    scene.add(dealerBox.group);
    this.dealerBox = dealerBox;

    const roundBoard = buildRoundBoard();
    roundBoard.position.set(0, 15, 0); // Hidden above
    roundBoard.visible = false;
    scene.add(roundBoard);
    this.roundBoard = roundBoard;

    this.scene = scene;
    this.camera = camera;
    this.renderer!.setSize(this.width, this.height, false);
  }

  /** Build a row of up to 5 HP skull markers on the table. */
  private spawnHp(scene: THREE.Scene, z: number): HpMarker[] {
    const out: HpMarker[] = [];
    const spacing = 0.44;
    const max = 5;

    for (let i = 0; i < max; i++) {
      const m = buildHpMarker();
      m.group.position.set(HP_X - i * spacing, SURFACE_Y, z);
      m.group.visible = false;
      scene.add(m.group);
      out.push(m);
    }
    return out;
  }

  /** Build a row of SLOT_COUNT item boxes, centred on x, at depth z. */
  private spawnSlots(scene: THREE.Scene, z: number, reverse: boolean = false): ItemSlot[] {
    const out: ItemSlot[] = [];
    const x0 = -((SLOT_COUNT - 1) * SLOT_SPACING) / 2;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = buildItemSlot();
      const xPos = reverse ? -x0 - i * SLOT_SPACING : x0 + i * SLOT_SPACING;
      slot.group.position.set(xPos, SURFACE_Y, z);
      scene.add(slot.group);
      out.push(slot);
    }
    return out;
  }

  render(state: GameState): void {
    if (!this.scene) return;
    const vm = toHudViewModel(state);

    // Refresh interaction affordances.
    this.matchOver = vm.matchOver;
    this.playerTurn = !vm.matchOver && vm.activeParticipant === this.localParticipant;
    this.roundsRemaining = vm.roundsRemaining;
    this.spinAllowed =
      this.playerTurn &&
      vm.roundsRemaining >= 2 &&
      state.spinsUsedThisTurn < state.config.maxSpinsPerTurn;
    this.playerItems = vm.player.items;
    if (this.matchOver) {
      this.aiming = false;
      this.firing = false;
    }
    // When it becomes the Dealer's turn, hold the camera on him so the player
    // watches his moves (the AI acts after a slow think-delay).
    if (this.lastActive !== vm.activeParticipant) {
      this.lastActive = vm.activeParticipant;
      if (vm.activeParticipant === "AI" && !this.matchOver) {
        this.cutToDealerTurn();
      }
    }
    this.updateMarkers();

    this.applyHpDisplay("player", this.playerHp, vm.player.hp.current, vm.player.hp.max);
    this.applyHpDisplay("dealer", this.dealerHp, vm.dealer.hp.current, vm.dealer.hp.max);

    this.updateSlots(this.playerSlots, vm.player.items, false);
    this.updateSlots(this.dealerSlots, vm.dealer.items, true);
  }

  /** Show/hide the aim markers; the spin disk shows only when usable. */
  private updateMarkers(): void {
    const showAim = this.aiming && !this.firing;
    if (this.dealerMarker) this.dealerMarker.visible = showAim;
    if (this.selfMarker) this.selfMarker.visible = showAim;
    if (this.spinToken) this.spinToken.visible = this.spinAllowed && !this.aiming;
  }

  // -------------------------------------------------------------------------
  // In-world interaction (click the gun / dealer / self marker / items / spin)
  // -------------------------------------------------------------------------

  private handlePointer(e: PointerEvent): void {
    const cam = this.camera;
    const dom = this.renderer?.domElement;
    const scene = this.scene;
    if (!cam || !dom || !scene) return;
    const rect = dom.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, cam);
    const hits = this.raycaster.intersectObjects(scene.children, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        const entry = this.interactives.find((it) => it.root === o);
        if (entry) {
          entry.hit();
          return;
        }
        o = o.parent;
      }
    }
  }

  /** Hover: show a pointer cursor when over any interactive object. */
  private handleHover(e: PointerEvent): void {
    const cam = this.camera;
    const dom = this.renderer?.domElement;
    const scene = this.scene;
    if (!cam || !dom || !scene) return;
    const rect = dom.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, cam);
    const hits = this.raycaster.intersectObjects(scene.children, true);
    let hovered: THREE.Object3D | null = null;
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        if (this.interactives.some((it) => it.root === o)) {
          hovered = o;
          break;
        }
        o = o.parent;
      }
      if (hovered) break;
    }
    this.hoverRoot = hovered;
    dom.style.cursor = hovered ? "pointer" : "default";

    // If hovering one of the player's own item zones, report the item for a
    // simple descriptive caption (null when not over a held item).
    let item: ItemType | null = null;
    if (hovered) {
      const idx = this.playerSlots.findIndex((s) => s.group === hovered);
      if (idx >= 0) item = this.playerItems[idx] ?? null;
      // Bet chips show their value.
      const chip = this.betChips.find((c) => c.group === hovered);
      if (chip) {
        if (this.hoverChipValue !== chip.value) {
          this.hoverChipValue = chip.value;
          this.onHoverChip(chip.value);
        }
        this.onHoverItem(null);
        dom.style.cursor = "pointer";
        return; // early return — skip the rest of hover logic
      } else {
        if (this.hoverChipValue !== null) {
          this.hoverChipValue = null;
          this.onHoverChip(null);
        }
      }
    }
    if (item !== this.hoverItemKey) {
      this.hoverItemKey = item;
      this.onHoverItem(item);
    }
  }

  private onGunClick(): void {
    if (!this.playerTurn || this.matchOver || this.roundsRemaining === 0) return;
    this.onInteract();
    this.aiming = !this.aiming;
    this.aimTarget = "AI";
    this.firing = false;
    if (this.aiming) this.onGunRaise();
    this.updateMarkers();
  }

  private onTargetClick(target: ParticipantId): void {
    if (!this.aiming || !this.playerTurn || this.firing) return;
    this.onInteract();
    // Map the visual target to the correct engine participant.
    const engineTarget = this.mapTarget(target);
    this.aimTarget = target;
    this.firing = true;
    this.gunDropAt = this.now() + 1500;
    this.updateMarkers();
    this.onAction({ kind: "SHOOT", target: engineTarget });
  }

  private onSpinClick(): void {
    if (!this.spinAllowed) return;
    this.onInteract();
    this.aiming = false;
    this.updateMarkers();
    this.onAction({ kind: "SPIN" });
  }

  private onSlotClick(index: number): void {
    if (!this.playerTurn) return;
    const item = this.playerItems[index];
    if (!item) return;
    this.onInteract();
    this.onAction({ kind: "USE_ITEM", item });
  }

  /**
   * Reconcile a side's HP with what's currently shown. Heals/first render apply
   * immediately; a lost life keeps the dying candle LIT and schedules a delayed
   * "blow-out" timed to land while the candle camera is on it.
   */
  private applyHpDisplay(
    side: "player" | "dealer",
    markers: HpMarker[],
    hp: number,
    max: number,
  ): void {
    const shown = this.shownHp[side];
    if (shown < 0 || hp >= shown) {
      // First render, or a heal: snap to the new value.
      this.shownHp[side] = hp;
      this.renderHpMarkers(markers, hp, max);
      return;
    }
    // A life was lost: keep the candle lit for now and queue the blow-out.
    this.renderHpMarkers(markers, shown, max);
    const dyingIdx = max - shown;
    this.candleBlow = {
      markers,
      index: dyingIdx,
      max,
      side,
      target: hp,
      startMs: this.now() + 1950,
      dur: 800,
      soundPlayed: false,
    };
  }

  /** Paint a row: `lit` candles burning, the rest snuffed + melted down. */
  private renderHpMarkers(markers: HpMarker[], lit: number, max: number): void {
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      if (!m) continue;
      const used = i < max;
      m.group.visible = used;
      if (!used) continue;
      const alive = i >= (max - lit);
      m.flame.visible = alive;
      m.glowMat.emissiveIntensity = alive ? 2.6 : 0.0;
      m.light.intensity = alive ? 0.5 : 0.0;
      m.wax.scale.y = alive ? 1 : 0.4;
      m.wax.position.y = alive ? 0.3 : 0.16;
      m.flame.rotation.z = 0;
      m.flame.scale.set(1, 1, 1);
    }
  }

  private updateSlots(slots: ItemSlot[], items: ReadonlyArray<ItemType>, isDealerSide = false): void {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot) continue;
      clearGroup(slot.contents);
      const item = items[i];
      if (item) {
        slot.contents.add(buildItemContents(item));
        slot.contents.visible = true;
        slot.contents.position.set(0, 0, 0);
        slot.contents.scale.setScalar(1);
        slot.rimMat.color.setHex(isDealerSide ? 0xff9980 : 0xd8d2c0);
        slot.rimMat.emissiveIntensity = isDealerSide ? 0.8 : 0.5;
        slot.rimMat.opacity = isDealerSide ? 0.85 : 0.55;
      } else {
        slot.rimMat.color.setHex(0x5a564a);
        slot.rimMat.emissiveIntensity = 0.15;
        slot.rimMat.opacity = 0.55;
      }
    }
  }

  /**
   * Reveal the round composition: lay out the live + blank shells face-up so
   * the player can count them once, then (after a hold) the "automatic table"
   * flips them down out of sight. Called on every ROUND_SET_LOADED.
   */
  private revealShells(live: number, blank: number, withBoxes: boolean): void {
    const group = this.shellGroup;
    if (!group) return;
    clearGroup(group);
    this.shellItems = [];
    this.shellSlot = undefined;
    const total = live + blank;
    if (total === 0) return;
    const spacing = 0.46;
    const x0 = -((total - 1) * spacing) / 2;
    const width = (total - 1) * spacing + 0.6;

    // A dark "hatch" in the table that opens beneath the shells as they flip.
    const slot = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.04, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x05060a, roughness: 0.9 }),
    );
    slot.position.set(0, 0.02, 0);
    slot.scale.set(1, 1, 0.001); // closed until the flip
    group.add(slot);
    this.shellSlot = slot;

    let idx = 0;
    const add = (s: THREE.Group): void => {
      s.position.set(x0 + idx * spacing, 0, 0);
      group.add(s);
      this.shellItems.push(s);
      idx++;
    };
    for (let i = 0; i < live; i++) add(buildShell(true));
    for (let i = 0; i < blank; i++) add(buildShell(false));

    group.visible = false; // Hidden until the board goes away
    this.shellRevealStart = this.now() + (withBoxes ? 9500 : 4500); // Wait for previous sequences
  }

  /** Drive the reveal → hatch-flip-into-table animation each frame. */
  private updateShellReveal(t: number): void {
    const group = this.shellGroup;
    if (!group || this.shellRevealStart < 0) return;
    const tt = this.now() - this.shellRevealStart;
    const n = this.shellItems.length;

    if (tt < 0) {
      group.visible = false;
      return;
    }
    group.visible = true;

    const appearMs = 300;
    const totalAppearMs = n * appearMs;
    const holdEnd = totalAppearMs + SHELL_HOLD_MS;

    if (tt < holdEnd) {
      // Held face-up: pop up one by one, then a gentle bob so they read as freshly placed.
      this.shellItems.forEach((c, i) => {
        const cAppearTime = i * appearMs;
        if (tt < cAppearTime) {
          c.visible = false;
        } else {
          c.visible = true;
          const p = Math.min(1, (tt - cAppearTime) / 200);
          c.scale.setScalar(easeOutCubic(p));
          c.position.y = Math.sin(t * 3 + i * 0.5) * 0.04;
          c.rotation.x = 0;
        }
      });
      if (this.shellSlot) this.shellSlot.scale.z = 0.001;
      return;
    }
    if (tt > holdEnd + SHELL_FLIP_MS) {
      group.visible = false;
      this.shellRevealStart = -1;
      // The table is loaded — give the gun a quick "ready" flourish.
      this.startFx("spin", 800);
      this.startFx("gunReady", 600);
      return;
    }
    // Flip phase: the hatch opens and each shell somersaults into it, staggered.
    const into = tt - holdEnd;
    const per = SHELL_FLIP_MS * 0.5;
    const stagger = n > 1 ? (SHELL_FLIP_MS - per) / n : 0;
    const open = Math.sin(Math.min(1, into / SHELL_FLIP_MS) * Math.PI); // open then close
    if (this.shellSlot) this.shellSlot.scale.z = 0.001 + open;
    this.shellItems.forEach((c, i) => {
      const p = Math.min(1, Math.max(0, (into - i * stagger) / per));
      const e = easeOutCubic(p);
      c.rotation.x = e * (Math.PI * 0.8); // tip forward and over
      c.position.y = -e * 0.9; // drop through the hatch
      c.position.z = e * 0.15; // a small forward toss
    });
  }

  // -------------------------------------------------------------------------
  // Action feedback (Req 8.4): latch effects + cut the camera, applied frame+1
  // -------------------------------------------------------------------------

  playActionFeedback(event: GameEvent): void {
    switch (event.type) {
      case "LIVE_FIRED": {
        // A LIVE round connects: big flash, hard recoil, shake, eye flare,
        // blood on the victim, a flinch, a long candle-blowing gust — and a
        // camera that reveals the Dealer then cuts to the snuffed candle.
        this.startFx("muzzle", 320);
        this.startFx("recoil", 420);
        this.startFx("shake", 700);
        this.startFx("eyeflare", 600);
        this.startFx(`hurt_${event.target}`, 700);
        this.startFx("windGust", 3200);
        this.triggerBlood(event.target);
        this.cutToShot(event.target, true);
        break;
      }
      case "BLANK_FIRED":
        this.startFx("recoil", 300);
        this.cutToShot(event.target, false);
        break;
      case "SHOT_STARTED":
        // Anticipation: a small recoil; the shot cut is set by LIVE/BLANK.
        this.aiAimingTarget = null;
        this.startFx("recoil", 220);
        break;
      case "SPUN":
        this.startFx("spin", 1100);
        this.cutToCylinder();
        break;
      case "ROUND_SET_LOADED":
        // 1. Board drops (0 - 4.5s)
        // 2. Boxes slide in (4.5s - 9.5s)
        // 3. Shells reveal and flip (9.5s - 15s)
        if (this.roundBoard) updateRoundBoardText(this.roundBoard, `ROUND ${event.roundNumber}`, ``);
        this.startFx("roundBoard", 4500);
        const withBoxes = event.roundNumber > 1;
        if (withBoxes) {
          this.startFx("briefcase", 15000);
          this.startFx("shellReveal", 15000);
        } else {
          this.startFx("shellReveal", 10000); 
        }
        this.startFx("roundPopup", 7000);
        this.revealShells(event.live, event.blank, withBoxes);
        this.cutToRoundSequence(withBoxes);
        break;
      case "ITEM_USED":
        // Only an item use frames the user — HP changes must NOT move the
        // camera, or they would clobber the queued candle shot above.
        this.startFx("eyeflare", 320);
        this.triggerItemBurst(event.by, event.item);
        if (event.item === "INVERTER") this.startFx("spin", 500);
        this.cutToParticipant(event.by, 1300);
        break;
      case "HP_CHANGED":
        // No camera move here (see ITEM_USED note): just a brief flare.
        this.startFx("eyeflare", 220);
        break;
      case "MATCH_OVER": {
        const deadId = event.winner === "PLAYER" ? "AI" : "PLAYER";
        const shots: CamShot[] = [];
        
        if (deadId === "AI") {
           // Push in on the dying dealer and watch him sink
           shots.push({
              pos: new THREE.Vector3(1.2, 7.5, DEALER_Z + 1.5),
              look: new THREE.Vector3(0, 2.0, DEALER_Z),
              holdMs: 4000,
              lerp: 0.03
           });
        } else {
           // Player dies. Camera falls backward to look up at the ceiling
           shots.push({
              pos: new THREE.Vector3(0, SURFACE_Y + 0.2, PLAYER_Z + 2.0),
              look: new THREE.Vector3(0, 15, PLAYER_Z + 2.0),
              holdMs: 4000,
              lerp: 0.02
           });
        }
        
        // We append to the queue so it runs immediately AFTER the candle shot (which is already queued by LIVE_FIRED)
        this.camQueue.push(...shots);
        this.startFx(`death_${deadId}`, 8000);
        break;
      }
      default:
        break;
    }
  }

  /** Seed a blood burst at the victim's chest/head and start its timer. */
  private triggerBlood(target: ParticipantId): void {
    const blood = this.blood;
    if (!blood) return;
    const z = target === "AI" ? DEALER_Z : PLAYER_Z;
    const y = target === "AI" ? 5.2 : 3.6;
    blood.group.position.set(0, y, z);
    blood.group.visible = true;
    for (const p of blood.particles) {
      // Spray outward toward the camera (+Z) and upward.
      const ang = Math.random() * Math.PI * 2;
      const spread = 1.2 + Math.random() * 2.6;
      p.vel.set(
        Math.cos(ang) * spread * 0.7,
        2.5 + Math.random() * 3.5,
        Math.sin(ang) * spread * 0.5 + (target === "AI" ? 2.0 : -2.0),
      );
      p.mesh.position.set(
        (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * 0.3,
        0,
      );
      p.mesh.visible = true;
      const mat = p.mesh.material as THREE.MeshStandardMaterial;
      mat.opacity = 1;
    }
    this.bloodStart = this.now();
  }

  /** Flare a coloured ring where an item was used, themed to the item. */
  private triggerItemBurst(by: ParticipantId, item: ItemType): void {
    const burst = this.itemBurst;
    if (!burst) return;
    // Place it at the relevant spot: gun for round-altering items, the user's
    // HP for the medkit, the opponent for handcuffs, else the user's zones.
    let x = 0;
    let z = by === "AI" ? -ITEM_ROW_Z : ITEM_ROW_Z;
    if (item === "MAGNIFYING_GLASS" || item === "INVERTER" || item === "HOLLOW_POINT") {
      x = 0;
      z = GUN_REST_Z;
    } else if (item === "MEDKIT") {
      x = HP_X;
      z = by === "AI" ? -HP_ROW_Z : HP_ROW_Z;
    } else if (item === "HANDCUFFS") {
      x = 0;
      z = by === "AI" ? PLAYER_Z - 1.5 : DEALER_Z + 1.5; // flares on the bound one
    }
    burst.position.set(x, SURFACE_Y + 0.5, z);
    const mat = burst.material as THREE.MeshBasicMaterial;
    mat.color.setHex(ITEM_BURST_COLOR[item]);
    burst.visible = true;
    this.itemBurstStart = this.now();
  }

  private startFx(key: string, dur: number): void {
    this.fx[key] = { start: this.now(), dur: Math.max(1, dur) };
  }

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

  // -------------------------------------------------------------------------
  // Camera director: play a queue of framed shots, then ease back to FP
  // -------------------------------------------------------------------------

  private applyShot(s: CamShot): void {
    this.camTargetPos.copy(s.pos);
    this.camTargetLook.copy(s.look);
    this.camHoldUntil = this.now() + s.holdMs;
    this.camLerp = s.lerp;
    this.camFocused = true;
  }

  private playSequence(shots: CamShot[]): void {
    const first = shots[0];
    if (!first) return;
    this.camQueue = shots.slice(1);
    this.applyShot(first);
  }

  /** Hold on the Player from the Dealer's POV while it's his turn. */
  private cutToDealerTurn(): void {
    this.playSequence([
      {
        pos: new THREE.Vector3(1.2, 6.5, DEALER_Z - 1.5), // Over the dealer's shoulder
        look: new THREE.Vector3(0, 4.5, PLAYER_Z), // Looking across the table at the hooded player
        holdMs: 2900,
        lerp: 0.04, // slow, smooth push-in
      },
    ]);
  }

  /** Reveal the Dealer on any shot (you only see the enemy during gunfire). */
  private cutToShot(target: ParticipantId, live: boolean): void {
    const shots: CamShot[] = [];
    // Push in on the hooded Dealer across the table — close on the grin/eyes.
    shots.push({
      pos: new THREE.Vector3(0.4, 5.9, DEALER_Z + 4.2),
      look: new THREE.Vector3(0, 5.4, DEALER_Z + 0.4),
      holdMs: live ? 1600 : 1100,
      lerp: live ? 0.05 : 0.07,
    });
    if (live) shots.push(this.candleShot(target));
    this.playSequence(shots);
  }

  /** A close shot of the exact candle that's about to blow out, framed from the
   *  near side so the dealer's body never blocks it. */
  private candleShot(target: ParticipantId): CamShot {
    const z = target === "AI" ? -HP_ROW_Z : HP_ROW_Z;
    // Aim at the specific dying candle when we know which one it is.
    const spacing = 0.44;
    const idx = this.candleBlow ? this.candleBlow.index : 2;
    const cx = HP_X - idx * spacing;
    return {
      pos: new THREE.Vector3(cx + 0.2, SURFACE_Y + 0.95, z + 1.7),
      look: new THREE.Vector3(cx, SURFACE_Y + 0.55, z),
      holdMs: 2100,
      lerp: 0.08,
    };
  }

  /** Close top-down on the shells while the round composition is revealed. */
  private cutToRoundSequence(withBoxes: boolean): void {
    const sequence: CamShot[] = [
      {
        pos: new THREE.Vector3(0, 8.0, 15.0), // Backed up and raised up for a wide cinematic view
        look: new THREE.Vector3(0, 4.0, 0), // Looking directly at the center of the table
        holdMs: 4500, // Wide view for the board dropping
        lerp: 0.08,
      }
    ];

    if (withBoxes) {
      sequence.push({
        pos: CAM_FP.pos,
        look: CAM_FP.look,
        holdMs: 5000, // FP view for the boxes sliding in
        lerp: 0.08,
      });
    }

    sequence.push({
      pos: new THREE.Vector3(2.6, SURFACE_Y + 3.0, 4.2),
      look: new THREE.Vector3(2.6, SURFACE_Y, 0),
      holdMs: 5500, // Look down at shells
      lerp: 0.08,
    });

    this.playSequence(sequence);
  }

  /** Close on the cylinder as it spins. */
  private cutToCylinder(): void {
    this.playSequence([
      {
        pos: new THREE.Vector3(2.6, 4.6, 3.6),
        look: new THREE.Vector3(0, SURFACE_Y + 0.3, GUN_REST_Z),
        holdMs: 1300,
        lerp: 0.07,
      },
    ]);
  }

  /** Medium shot framing whoever used an item. */
  private cutToParticipant(p: ParticipantId, holdMs: number): void {
    if (p === "AI") {
      this.playSequence([
        {
          pos: new THREE.Vector3(3.2, 5.6, 2.6),
          look: new THREE.Vector3(0, 5.0, DEALER_Z + 1.5),
          holdMs,
          lerp: 0.06,
        },
      ]);
    } else {
      // Glance down at the player's own item boxes.
      this.playSequence([
        {
          pos: new THREE.Vector3(0, 6.2, ITEM_ROW_Z + 3.0),
          look: new THREE.Vector3(0, SURFACE_Y, ITEM_ROW_Z),
          holdMs,
          lerp: 0.07,
        },
      ]);
    }
  }

  /** Set the AI's intended target during its "thinking/aiming" pause. */
  setAiAiming(target: "PLAYER" | "AI" | null): void {
    this.aiAimingTarget = target;
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running || !this.renderer) return;
    this.running = true;
    this.startMs = this.now();
    const loop = (): void => {
      if (!this.running) return;
      this.frame();
      this.rafId =
        typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame(loop) : 0;
    };
    loop();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.rafId && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = 0;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Play a coin flip animation on the right side of the table.
   * First lets the player choose heads or tails (5 sec timer), then flips.
   * `result` is what the coin lands on (true = heads). Player wins if their
   * pick matches the result.
   */
  playCoinFlip(
    result: boolean,
    onFlipSound: () => void,
    onLandSound: () => void,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const scene = this.scene;
      if (!scene) { resolve(result); return; }

      // Build the coin where the shells normally appear (right side, center-Z).
      const chip = buildBetChip(100);
      const coin = chip.group;
      const coinX = 2.6; // same X as shell group
      const coinZ = 0;
      coin.position.set(coinX, SURFACE_Y + 0.2, coinZ);
      scene.add(coin);

      // Camera: angled top-down looking at the coin area.
      this.playSequence([
        {
          pos: new THREE.Vector3(coinX + 0.5, SURFACE_Y + 3.8, 3.2),
          look: new THREE.Vector3(coinX, SURFACE_Y + 0.5, coinZ),
          holdMs: 12000,
          lerp: 0.08,
        },
      ]);

      // Show choice buttons (HEADS / TAILS) — 5 second timer.
      let playerPick: boolean | null = null;
      const choiceEl = document.createElement("div");
      choiceEl.style.cssText =
        "position:fixed;bottom:18%;left:50%;transform:translateX(-50%);" +
        "display:flex;gap:30px;z-index:9999;pointer-events:auto;";
      const makeBtn = (label: string, val: boolean): HTMLButtonElement => {
        const btn = document.createElement("button");
        btn.textContent = label;
        btn.style.cssText =
          "font-family:'Courier New',monospace;font-size:20px;font-weight:700;" +
          "letter-spacing:5px;color:#d9cdb4;background:rgba(0,0,0,0.7);" +
          "border:2px solid #d4a843;padding:14px 28px;cursor:pointer;" +
          "text-transform:uppercase;transition:border-color .15s,color .15s;";
        btn.addEventListener("mouseenter", () => { btn.style.borderColor = "#fff"; btn.style.color = "#fff"; });
        btn.addEventListener("mouseleave", () => { btn.style.borderColor = "#d4a843"; btn.style.color = "#d9cdb4"; });
        btn.addEventListener("click", () => { playerPick = val; });
        return btn;
      };
      choiceEl.appendChild(makeBtn("HEADS", true));
      choiceEl.appendChild(makeBtn("TAILS", false));
      document.body.appendChild(choiceEl);

      // Timer: 5 seconds to choose, then auto-pick heads.
      const timerEl = document.createElement("div");
      timerEl.style.cssText =
        "position:fixed;bottom:28%;left:50%;transform:translateX(-50%);" +
        "font-family:'Courier New',monospace;font-size:14px;letter-spacing:3px;" +
        "color:#888;z-index:9999;pointer-events:none;";
      timerEl.textContent = "CHOOSE: 5";
      document.body.appendChild(timerEl);

      let countdown = 5;
      const interval = setInterval(() => {
        countdown--;
        timerEl.textContent = `CHOOSE: ${countdown}`;
        if (countdown <= 0 || playerPick !== null) {
          clearInterval(interval);
          if (playerPick === null) playerPick = true; // default heads
          choiceEl.remove();
          timerEl.remove();
          doFlip();
        }
      }, 1000);

      const doFlip = (): void => {
        onFlipSound();
        const startMs = this.now();
        const flipDur = 2000;
        const fallDur = 450;
        const wobbleDur = 700;
        const totalDur = flipDur + fallDur + wobbleDur;
        const targetRot = (result ? 0 : Math.PI) + Math.PI * 2 * 8;
        const landY = SURFACE_Y + 0.12;
        const peakY = SURFACE_Y + 4.2;
        let landSoundPlayed = false;

        const animate = (): void => {
          const elapsed = this.now() - startMs;

          if (elapsed >= totalDur) {
            // Final rest.
            coin.position.set(coinX, landY, coinZ);
            coin.rotation.set(result ? 0 : Math.PI, 0, 0);
            setTimeout(() => {
              scene.remove(coin);
              const won = playerPick === result;
              resolve(won);
            }, 1800);
            return;
          }

          if (elapsed < flipDur) {
            // Spinning up in the air.
            const t = elapsed / flipDur;
            const h = Math.sin(t * Math.PI); // 0→1→0 arc
            coin.position.set(coinX, SURFACE_Y + 0.2 + h * (peakY - SURFACE_Y), coinZ);
            coin.rotation.set(t * targetRot, 0, 0);
          } else if (elapsed < flipDur + fallDur) {
            // Falling straight down to the table.
            const t = (elapsed - flipDur) / fallDur;
            const ease = t * t; // accelerating fall
            const fromY = SURFACE_Y + 0.2; // the arc ends near start height
            coin.position.set(coinX, fromY + (landY - fromY) * ease, coinZ);
            coin.rotation.set(targetRot, 0, 0);
          } else {
            // Wobble/rattle on the table.
            if (!landSoundPlayed) {
              landSoundPlayed = true;
              onLandSound();
            }
            const t = (elapsed - flipDur - fallDur) / wobbleDur;
            const decay = (1 - t) * (1 - t); // quadratic decay
            const freq = t * Math.PI * 8;
            const wobble = Math.sin(freq) * decay * 0.12;
            coin.position.set(
              coinX + wobble * 0.4,
              landY + Math.abs(wobble) * 0.15,
              coinZ + wobble * 0.3,
            );
            coin.rotation.set(
              (result ? 0 : Math.PI) + wobble * 0.6,
              wobble * 0.3,
              wobble * 0.4,
            );
          }

          requestAnimationFrame(animate);
        };
        animate();
      };
    });
  }

  /** Set which participant the local player controls (for multiplayer). */
  setLocalParticipant(p: "PLAYER" | "AI"): void {
    this.localParticipant = p;
    // If we're player2 ("AI"), flip the camera to the other side of the table.
    if (p === "AI" && this.camera) {
      // Mirror the base camera to the dealer's side.
      CAM_FP.pos.z = -CAM_FP.pos.z;
      CAM_FP.look.z = -CAM_FP.look.z;
    }
  }

  /**
   * Map a click-target to the correct engine ParticipantId based on who we are.
   * "Shoot the figure across the table" = shoot opponent.
   * "Shoot self ring" = shoot yourself.
   */
  private mapTarget(clickTarget: "PLAYER" | "AI"): "PLAYER" | "AI" {
    if (this.localParticipant === "PLAYER") {
      // Normal: clicking dealer ring = shoot AI, clicking self ring = shoot PLAYER.
      return clickTarget === "AI" ? "AI" : "PLAYER";
    } else {
      // Flipped: we ARE "AI", so clicking the figure across = shoot PLAYER (opponent).
      // Clicking self = shoot AI (us).
      return clickTarget === "AI" ? "PLAYER" : "AI";
    }
  }

  /** Play the intro zoom-out from the table on page load. */
  playIntroZoom(): void {
    const close = new THREE.Vector3(0, 5.5, 4.0);
    const closeLook = new THREE.Vector3(0, 3.25, -0.5);
    this.camPos.copy(close);
    this.camLook.copy(closeLook);
    this.camTargetPos.copy(close);
    this.camTargetLook.copy(closeLook);
    if (this.camera) {
      this.camera.position.copy(close);
      this.camera.lookAt(closeLook);
    }
    this.camTargetPos.set(0, 11, 15);
    this.camTargetLook.set(0, 3, -1);
    this.camHoldUntil = this.now() + 6000;
    this.camFocused = true;
    this.camLerp = 0.018;
    this.camQueue = [];
  }

  /**
   * Show three bet chips on the table and cut the camera to frame them.
   * Returns a Promise that resolves with the chosen bet value when the player
   * clicks one. After selection the chips are removed from the scene.
   */
  showBetChips(): Promise<number> {
    return new Promise((resolve) => {
      const scene = this.scene;
      if (!scene) { resolve(100); return; }

      // Show a BACK button overlay during bet selection.
      let backBtn: HTMLElement | null = null;
      if (typeof document !== "undefined") {
        backBtn = document.createElement("button");
        backBtn.textContent = "← BACK";
        backBtn.className = "rr-back-btn";
        backBtn.style.cssText =
          "position:fixed;top:24px;left:24px;z-index:80;" +
          "font-family:'Courier New',monospace;font-size:14px;letter-spacing:3px;" +
          "color:#cc3333;background:none;border:none;padding:8px 0;" +
          "cursor:pointer;text-transform:uppercase;transition:color .2s;";
        backBtn.addEventListener("mouseenter", () => {
          if (backBtn) { backBtn.style.color = "#ff4444"; }
        });
        backBtn.addEventListener("mouseleave", () => {
          if (backBtn) { backBtn.style.color = "#cc3333"; }
        });
        backBtn.addEventListener("click", () => {
          cleanup();
          window.location.reload();
        });
        document.body.appendChild(backBtn);
      }

      const group = new THREE.Group();
      // Place coins on the far right edge of the table.
      group.position.set(TABLE.width / 2 - 0.5, SURFACE_Y, 0);
      scene.add(group);
      this.betChipGroup = group;
      this.betChips = [];

      const values = [100, 1000, 10000];
      const spacing = 1.2;
      const z0 = -((values.length - 1) * spacing) / 2;

      values.forEach((v, i) => {
        const chip = buildBetChip(v);
        chip.group.position.set(0, 0, z0 + i * spacing);
        group.add(chip.group);
        this.betChips.push(chip);
        this.interactives.push({
          root: chip.group,
          hit: () => {
            if (this.onBetSelected) {
              this.onCoinSelect();
              this.onBetSelected(v);
            }
          },
        });
      });

      this.onBetSelected = (value: number) => {
        cleanup();

        // After picking, cut to the revolver on the table before starting.
        this.playSequence([
          {
            pos: new THREE.Vector3(0.8, SURFACE_Y + 2.0, 2.5),
            look: new THREE.Vector3(0, SURFACE_Y + 0.2, GUN_REST_Z),
            holdMs: 2200,
            lerp: 0.06,
          },
        ]);
        // Resolve after the revolver reveal.
        setTimeout(() => resolve(value), 2400);
      };

      const cleanup = (): void => {
        // Remove coins from the scene + interactives.
        this.betChips.forEach((c) => {
          const idx = this.interactives.findIndex((it) => it.root === c.group);
          if (idx >= 0) this.interactives.splice(idx, 1);
        });
        if (this.betChipGroup) {
          scene.remove(this.betChipGroup);
          this.betChipGroup = undefined;
        }
        this.betChips = [];
        this.onBetSelected = null;
        if (backBtn && backBtn.parentNode) backBtn.parentNode.removeChild(backBtn);
      };

      // Cut the camera to frame the chips on the side of the table.
      this.playSequence([
        {
          pos: new THREE.Vector3(TABLE.width / 2 + 1.5, SURFACE_Y + 3.0, 4.0),
          look: new THREE.Vector3(TABLE.width / 2 - 1.0, SURFACE_Y + 0.3, 0),
          holdMs: 30000, // hold indefinitely until they pick
          lerp: 0.06,
        },
      ]);
    });
  }

  private frame(): void {
    const elapsed = this.now() - this.startMs;
    this.animate(elapsed);
    const { renderer, scene, camera } = this;
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
  }

  private animate(elapsedMs: number): void {
    const t = elapsedMs / 1000;

    // --- Swinging bulb: pendulum + steady waver + horror blink-outs ------
    if (this.bulb && this.bulbMesh) {
      const swingX = 0; // Math.sin(t * 0.7) * 0.6;
      const swingZ = 0; // Math.cos(t * 0.5) * 0.4;
      this.bulb.position.set(swingX, 11, swingZ);
      this.bulbMesh.position.copy(this.bulb.position);
      const waver = 0.93 + 0.05 * Math.sin(t * 2.3) + 0.02 * Math.sin(t * 7.1);

      // Random horror blink-outs: the bulb cuts to BLACK for a beat, sometimes
      // stuttering, then surges back — like failing wiring.
      const nowMs = this.now();
      if (this.nextBlink === 0) this.nextBlink = nowMs + 2500;
      let blinkMul = 1;
      if (nowMs < this.blinkEnd) {
        // Mostly fully off, with the odd weak stutter-flash.
        blinkMul = Math.random() < 0.75 ? 0 : 0.25;
      } else if (nowMs >= this.nextBlink) {
        this.blinkEnd = nowMs + 120 + Math.random() * 260;
        this.nextBlink = nowMs + 2600 + Math.random() * 5200;
        this.onBlink(); // play the flicker sound
      }
      const intensity = 42 * waver * blinkMul;
      this.bulb.intensity = intensity;
      (this.bulbMesh.material as THREE.MeshStandardMaterial).emissiveIntensity =
        0.15 + (intensity / 42) * 2.8;
    }

    // --- Figures breathe / sway; eyes + grin shimmer --------------------
    if (this.dealer) {
      const b = Math.sin(t * 1.3);
      this.dealer.torso.rotation.x = b * 0.02 + this.flinch("AI");
      this.dealer.torso.position.y = b * 0.04;
      const shimmer = 2.2 + Math.sin(t * 3) * 0.4;
      this.dealer.eyeMat.emissiveIntensity = shimmer;
      this.dealer.mouthMat.emissiveIntensity = 1.6 + Math.sin(t * 3 + 0.6) * 0.3;
    }
    if (this.player) {
      const b = Math.sin(t * 1.3 + 1.1);
      this.player.torso.rotation.x = b * 0.02 + this.flinch("PLAYER");
      this.player.torso.position.y = b * 0.035;
    }

    // --- Eye + grin flare on shots/hits ----------------------------------
    const flare = this.fxProgress("eyeflare");
    if (flare !== null && this.dealer) {
      const boost = (1 - flare) * 4.0;
      this.dealer.eyeMat.emissiveIntensity = 2.2 + boost;
      this.dealer.mouthMat.emissiveIntensity = 1.6 + boost;
    }

    // --- Revolver: rest in the centre circle, rise "into hand" on aim ----
    if (this.revolver) {
      // Auto-lower the gun a beat after a shot has been fired.
      if (this.gunDropAt > 0 && this.now() > this.gunDropAt) {
        this.aiming = false;
        this.firing = false;
        this.gunDropAt = 0;
        this.updateMarkers();
      }

      this.aimT += ((this.aiming ? 1 : 0) - this.aimT) * 0.12;
      this.dealerAimT += ((this.aiAimingTarget ? 1 : 0) - this.dealerAimT) * 0.12;
      const a = this.aimT;
      const g = this.revolver.group;

      // Hover effect for the gun
      let targetLift = 0;
      let targetRot = 0;
      if (!this.aiming && !this.firing && !this.aiAimingTarget && this.hoverRoot === this.revolver.group) {
        targetLift = 0.15;
        targetRot = 0.15;
      }
      this.gunHoverY += (targetLift - this.gunHoverY) * 0.2;
      this.gunHoverRot += (targetRot - this.gunHoverRot) * 0.2;

      // Cylinder idle rotation + fast SPUN spin (about its own Y axis).
      let spinRot = t * 0.6;
      const spin = this.fxProgress("spin");
      if (spin !== null) spinRot += easeOutCubic(spin) * Math.PI * 2 * 4;
      this.revolver.drum.rotation.z = spinRot;

      const recoil = this.fxProgress("recoil");
      const recoilBump = recoil !== null ? Math.sin(recoil * Math.PI) * 0.5 : 0;
      const recoilPitch = recoil !== null ? Math.sin(recoil * Math.PI) * 0.55 : 0;
      const ready = this.fxProgress("gunReady");
      const readyHop = ready !== null ? Math.sin(ready * Math.PI) * 0.5 : 0;

      g.position.x = 0;
      let targetPy = this.gunBaseY + this.gunHoverY + readyHop + recoilBump;
      let targetPz = GUN_REST_Z;
      let targetRx = 0;
      let targetRy = -0.5;
      let targetRz = this.gunHoverRot;

      if (a > 0.001) {
        // Player Aiming
        if (this.aimTarget === "PLAYER") {
          targetPy += a * 2.0;
          targetPz += a * 1.4;
          targetRx = a * 0.7 + recoilPitch;
          targetRy = -0.5 + a * (Math.PI + 0.5);
          targetRz = a * (Math.PI / 2) + this.gunHoverRot;
        } else {
          targetPy += a * 1.6;
          targetPz += a * 2.2;
          targetRx = a * -0.32 - recoilPitch;
          targetRy = -0.5 + a * 0.5;
          targetRz = a * (Math.PI / 2) + this.gunHoverRot;
        }
      } else if (this.dealerAimT > 0.001) {
        // Dealer Aiming
        const da = this.dealerAimT;
        if (this.aiAimingTarget === "PLAYER") {
          targetPy += da * 4.0;
          targetPz -= da * 7.5; // moves back to z = -5
          targetRx = da * -0.15 - recoilPitch;
          targetRy = -0.5 + da * 0.5;
          targetRz = da * (Math.PI / 2);
        } else {
          targetPy += da * 4.0;
          targetPz -= da * 7.5;
          targetRx = da * 0.7 + recoilPitch;
          targetRy = -0.5 + da * (Math.PI + 0.5);
          targetRz = da * (Math.PI / 2);
        }
      }

      g.position.y = targetPy;
      g.position.z = targetPz;
      g.rotation.x = targetRx;
      g.rotation.y = targetRy;
      g.rotation.z = targetRz;

      const muzzle = this.fxProgress("muzzle");
      if (muzzle !== null) {
        this.revolver.flashMesh.visible = true;
        const k = 1 - muzzle;
        this.revolver.flashMesh.scale.setScalar(0.8 + muzzle * 2.2);
        (this.revolver.flashMesh.material as THREE.MeshStandardMaterial).emissiveIntensity =
          k * 6;
        this.revolver.flash.intensity = k * 22;
      } else {
        this.revolver.flashMesh.visible = false;
        this.revolver.flash.intensity = 0;
      }
    }

    // --- Blood particles: analytic ballistic flight + fade ---------------
    this.updateBlood();
    this.updateShellReveal(t);

    // --- Item-use burst: expanding glowing ring that fades ---------------
    if (this.itemBurst && this.itemBurstStart >= 0) {
      const bt = (this.now() - this.itemBurstStart) / 700;
      if (bt >= 1) {
        this.itemBurst.visible = false;
        this.itemBurstStart = -1;
      } else {
        const e = easeOutCubic(bt);
        this.itemBurst.scale.setScalar(0.4 + e * 2.2);
        (this.itemBurst.material as THREE.MeshStandardMaterial).opacity = (1 - bt) * 0.9;
        this.itemBurst.rotation.z = bt * 1.5;
      }
    }

    // --- HP candle flame flicker + wind-gust lean after a hit ------------
    const flick = 1 + Math.sin(t * 11) * 0.18 + Math.sin(t * 23) * 0.09;
    const wind = this.fxProgress("windGust");
    const gust =
      wind !== null
        ? Math.sin(wind * Math.PI) * (0.9 + 0.3 * Math.sin(t * 17))
        : 0;
    const blowMarker = this.candleBlow
      ? this.candleBlow.markers[this.candleBlow.index]
      : undefined;
    for (const m of [...this.playerHp, ...this.dealerHp]) {
      if (m === blowMarker) continue; // handled by the blow-out below
      if (m.flame.visible) {
        const lean = gust * 1.1;
        m.flame.rotation.z = lean;
        m.flame.scale.set(1 + Math.abs(lean) * 0.5, flick * (1 - Math.abs(lean) * 0.35), 1);
        m.light.intensity = 0.45 * flick * (1 - Math.abs(gust) * 0.6);
      }
    }

    // --- The dying candle: blow it out ON camera (delayed extinguish) -----
    if (this.candleBlow) {
      const cb = this.candleBlow;
      const m = cb.markers[cb.index];
      if (!m) {
        this.candleBlow = null;
      } else {
        const tt = this.now() - cb.startMs;
        if (tt < 0) {
          // Still waiting for the camera: keep it burning, trembling slightly.
          m.flame.visible = true;
          m.flame.rotation.z = Math.sin(t * 8) * 0.15;
          m.flame.scale.set(1, flick, 1);
          m.glowMat.emissiveIntensity = 2.6;
          m.light.intensity = 0.5 * flick;
        } else {
          const p = Math.min(1, tt / cb.dur);
          if (p < 1) {
            // Fire the blow sound once at the very start of the blow.
            if (!cb.soundPlayed) {
              cb.soundPlayed = true;
              this.onCandleBlow();
            }
            // Hard blow: the flame whips sideways, stretches and shrinks out.
            m.flame.visible = true;
            m.flame.rotation.z = Math.sin(p * Math.PI) * 1.9;
            m.flame.scale.set(1 + p * 0.6, Math.max(0.04, 1 - p), 1);
            m.glowMat.emissiveIntensity = 2.6 * (1 - p);
            m.light.intensity = 0.5 * (1 - p);
          } else {
            this.shownHp[cb.side] = cb.target;
            this.renderHpMarkers(cb.markers, cb.target, cb.max);
            this.candleBlow = null;
          }
        }
      }
    }

    // --- Mini lamp flicker (a tired, guttering second source) ------------
    if (this.miniLamp) {
      const lf = 0.8 + 0.18 * Math.sin(t * 6.3) + 0.1 * Math.sin(t * 13.7);
      this.miniLamp.light.intensity = 6 * lf;
      this.miniLamp.glowMat.emissiveIntensity = 2.4 * lf;
      this.miniLamp.flame.scale.y = lf;
    }

    // --- Graveflies swarm + blink under the lamp ------------------------
    if (this.graveflies) {
      for (const f of this.graveflies.flies) {
        const a = t * f.speed + f.phase;
        f.mesh.position.set(
          f.cx + Math.cos(a) * f.rx,
          f.cy + Math.sin(a * 1.7) * f.ry,
          f.cz + Math.sin(a) * f.rz,
        );
        const mat = f.mesh.material as THREE.MeshStandardMaterial;
        // Horror blink: each fly winks on/off at its own irregular rate.
        const blink = Math.sin(a * 6 + Math.sin(a * 2.3) * 3);
        const on = blink > -0.2;
        mat.emissiveIntensity = on ? 2.4 + blink * 1.2 : 0.1;
        mat.opacity = on ? 0.5 + 0.4 * (0.5 + 0.5 * blink) : 0.05;
      }
    }

    // --- Held items rest in their zones; the hovered one floats up -------
    for (const slot of this.playerSlots) {
      if (slot.contents.children.length === 0) continue;
      const hovered = this.hoverRoot === slot.group;
      const targetY = hovered ? 0.32 : 0.12;
      slot.contents.position.y += (targetY - slot.contents.position.y) * 0.2;
    }
    for (const slot of this.dealerSlots) {
      if (slot.contents.children.length === 0) continue;
      slot.contents.position.y += (0.12 - slot.contents.position.y) * 0.2;
    }

    // --- Bet coins: hovered stack floats up -----------------------------
    for (const chip of this.betChips) {
      const hovered = this.hoverRoot === chip.group;
      const targetY = hovered ? 0.3 : 0;
      chip.group.position.y += (targetY - chip.group.position.y) * 0.15;
    }

    // --- Box Animation --------------------------------------------
    const bcProg = this.fxProgress("briefcase");
    if (this.playerBox && this.dealerBox) {
      if (bcProg === null) { 
        this.playerBox.group.visible = false;
        this.dealerBox.group.visible = false;
        
        // When not animating, items should be visible
        const showSlot = (slot: ItemSlot) => {
           if (slot.contents.children.length > 0) {
             slot.contents.visible = true;
           }
        };
        this.playerSlots.forEach(showSlot);
        this.dealerSlots.forEach(showSlot);
      } else {
        const tMs = bcProg * 15000;
        
        if (tMs < 4500) {
           this.playerBox.group.visible = false;
           this.dealerBox.group.visible = false;
           // Hide items before they fly out of the box
           const hideSlot = (slot: ItemSlot) => {
              if (slot.contents.children.length > 0) {
                slot.contents.visible = false;
              }
           };
           this.playerSlots.forEach(hideSlot);
           this.dealerSlots.forEach(hideSlot);
        } else if (tMs > 9500) {
           this.playerBox.group.visible = false;
           this.dealerBox.group.visible = false;
           // Show items in their final slots
           const showSlot = (slot: ItemSlot) => {
             if (slot.contents.children.length > 0) {
               slot.contents.visible = true;
               slot.contents.scale.setScalar(1);
               slot.contents.position.set(0, 0, 0);
             }
           };
           this.playerSlots.forEach(showSlot);
           this.dealerSlots.forEach(showSlot);
        } else {
           this.playerBox.group.visible = true;
           this.dealerBox.group.visible = true;
           
           const slideIn = Math.min(1, Math.max(0, (tMs - 4500) / 800));
           const slideOut = Math.min(1, Math.max(0, (tMs - 8700) / 800));
           
           let pxPos = 12;
           let dxPos = -12;
           if (tMs < 8700) {
              pxPos = 12 - easeOutCubic(slideIn) * 8.5; // Stops at 3.5
              dxPos = -12 + easeOutCubic(slideIn) * 8.5; // Stops at -3.5
           } else {
              pxPos = 3.5 + easeOutCubic(slideOut) * 12; 
              dxPos = -3.5 - easeOutCubic(slideOut) * 12; 
           }
           
           this.playerBox.group.position.set(pxPos, SURFACE_Y, ITEM_ROW_Z);
           this.dealerBox.group.position.set(dxPos, SURFACE_Y, -ITEM_ROW_Z);
           
           const openProg = Math.min(1, Math.max(0, (tMs - 4500) / 800));
           const closeProg = Math.min(1, Math.max(0, (tMs - 8000) / 700));
           let lidAngle = 0;
           if (tMs >= 4500 && tMs < 8000) {
              lidAngle = easeOutCubic(openProg) * Math.PI * 0.6;
           } else if (tMs >= 8000) {
              lidAngle = (1 - easeOutCubic(closeProg)) * Math.PI * 0.6;
           }
           this.playerBox.lid.rotation.x = -lidAngle;
           this.dealerBox.lid.rotation.x = lidAngle; 
           
           // Item flying animation (1-by-1)
           const animateSlot = (slot: ItemSlot, idx: number, box: THREE.Group) => {
             if (slot.contents.children.length === 0) return;
             
             const itemStartTime = 4900 + (idx * 400);
             if (tMs < itemStartTime) {
               slot.contents.visible = false;
               return;
             }
             slot.contents.visible = true;
             
             const flyProg = Math.min(1, Math.max(0, (tMs - itemStartTime) / 400));
             const eFly = easeOutCubic(flyProg);
             
             // World positions
             const bx = box.position.x;
             const bz = box.position.z;
             const by = SURFACE_Y + 0.3; // inside box
             
             // Arrange items in a neat 2x4 grid inside the box
             const row = Math.floor(idx / 4); // 0 or 1
             const col = idx % 4; // 0, 1, 2, 3
             // The box is facing +Z for both.
             // Let's center the grid relative to bx, bz
             const itemBx = bx + (col - 1.5) * 0.8;
             const itemBz = bz + (row - 0.5) * 0.6;
             
             const sx = slot.group.position.x;
             const sz = slot.group.position.z;
             const sy = slot.group.position.y;
             
             const dx = itemBx - sx;
             const dy = by - sy;
             const dz = itemBz - sz;
             
             slot.contents.position.set(
                dx * (1 - eFly),
                dy * (1 - eFly) + 0.12 * eFly + Math.sin(flyProg * Math.PI) * 1.5,
                dz * (1 - eFly)
             );
             slot.contents.scale.setScalar(Math.max(0.01, eFly));
           };
           
           this.playerSlots.forEach((slot, i) => animateSlot(slot, i, this.playerBox!.group));
           this.dealerSlots.forEach((slot, i) => animateSlot(slot, i, this.dealerBox!.group));
        }
      }
    } else {
      // If no box fx, ensure items are visible and scaled correctly
      const showSlot = (slot: ItemSlot) => {
        if (slot.contents.children.length > 0) {
          slot.contents.visible = true;
          slot.contents.scale.setScalar(1);
        }
      };
      this.playerSlots.forEach(showSlot);
      this.dealerSlots.forEach(showSlot);
    }

    // --- Shell Reveal Animation -----------------------------------------
    // Visibility handled exclusively inside updateShellReveal now!
    this.fxProgress("shellReveal"); // Just consume the progress to keep the effect alive


    // --- Round Board Animation ------------------------------------------
    const rbProg = this.fxProgress("roundBoard");
    if (this.roundBoard) {
      if (rbProg === null) {
        this.roundBoard.visible = false;
      } else {
        this.roundBoard.visible = true;
        const p = rbProg;
        const drop = Math.min(1, Math.max(0, p / 0.15));
        const rise = Math.min(1, Math.max(0, (p - 0.85) / 0.15));
        
        let yPos = 18;
        if (p < 0.85) {
           yPos = 18 - easeOutCubic(drop) * 12.5; // Stops at 5.5
        } else {
           yPos = 5.5 + easeOutCubic(rise) * 12.5; 
        }
        
        // Sway physics
        const dropEnergy = 1 - drop; // high energy while dropping
        const swayZ = Math.sin(t * 3.1) * 0.15 * dropEnergy + Math.sin(t * 1.5) * 0.04;
        const swayX = Math.sin(t * 2.7 + 1.2) * 0.1 * dropEnergy + Math.sin(t * 1.1 + 0.5) * 0.02;
        
        const euler = new THREE.Euler(swayX, 0, swayZ, 'XYZ');
        const localTop = new THREE.Vector3(0, 10.8, 0); // Top of the chains
        localTop.applyEuler(euler);
        
        this.roundBoard.position.set(0 - localTop.x, yPos + 10.8 - localTop.y, 0 - localTop.z);
        this.roundBoard.rotation.copy(euler);
      }
    }

    // --- Death Animations -----------------------------------------------
    this.deathPlayerProg = this.fxProgress("death_PLAYER");
    const deathAiProg = this.fxProgress("death_AI");
    
    if (this.dealer) {
      if (deathAiProg !== null) {
        // Dealer dies: simple fall backwards, turn black (emissive off)
        const p = deathAiProg;
        const ease = 1 - Math.pow(1 - p, 3);
        this.dealer.group.rotation.x = ease * -1.5; // fall back
        this.dealer.group.rotation.z = 0;
        this.dealer.group.position.y = 0; // do not sink
        
        // "dead body only see black"
        this.dealer.eyeMat.emissiveIntensity = 0;
        this.dealer.mouthMat.emissiveIntensity = 0;
        
        // Pour blood a lot
        if (p < 0.1 && this.bloodStart < 0) {
           this.bloodDurMs = 4000;
           this.triggerBlood("AI");
        }
      } else {
        this.dealer.group.rotation.x = 0;
        this.dealer.group.rotation.z = 0;
        this.dealer.group.position.y = 0;
      }
    }
    
    if (this.deathPlayerProg !== null && this.deathPlayerProg < 0.1 && this.bloodStart < 0) {
       this.bloodDurMs = 4000;
       this.triggerBlood("PLAYER");
    }

    this.updateCamera(t);
  }

  /** Current flinch rotation offset for a participant (0 when not hit). */
  private flinch(p: ParticipantId): number {
    const prog = this.fxProgress(`hurt_${p}`);
    if (prog === null) return 0;
    // A sharp jerk back that settles: sign reads as recoiling away from the gun.
    const dir = p === "AI" ? -1 : 1;
    return dir * Math.sin(prog * Math.PI) * 0.35 * (1 - prog);
  }

  /** Advance the blood burst (ballistic + gravity) and fade it out. */
  private updateBlood(): void {
    const blood = this.blood;
    if (!blood || this.bloodStart < 0) return;
    const tt = (this.now() - this.bloodStart) / 1000;
    const durS = this.bloodDurMs / 1000;
    if (tt >= durS) {
      blood.group.visible = false;
      for (const p of blood.particles) p.mesh.visible = false;
      this.bloodStart = -1;
      return;
    }
    const fade = 1 - tt / durS;
    const g = -11;
    for (const p of blood.particles) {
      p.mesh.position.set(
        p.vel.x * tt,
        p.vel.y * tt + 0.5 * g * tt * tt,
        p.vel.z * tt,
      );
      const mat = p.mesh.material as THREE.MeshStandardMaterial;
      mat.opacity = fade;
      p.mesh.scale.setScalar(0.6 + fade * 0.6);
    }
  }

  /** Ease the camera toward its current target; drift gently when wide. */
  private updateCamera(t: number): void {
    const cam = this.camera;
    if (!cam) return;

    // Pulse the aim markers so they read as interactive.
    const pulse = 1 + Math.sin(t * 5) * 0.18;
    if (this.dealerMarker?.visible) this.dealerMarker.scale.setScalar(pulse);
    if (this.selfMarker?.visible) this.selfMarker.scale.setScalar(pulse);
    
    // Spin token stays static and dims, lighting up when hovered.
    if (this.spinToken?.visible) {
      this.spinToken.scale.setScalar(1.0);
      const isHovered = this.hoverRoot === this.spinToken;
      this.spinToken.children.forEach(child => {
        if (child instanceof THREE.Mesh) {
          const mat = child.material as THREE.MeshStandardMaterial;
          if (mat.emissive && mat.emissive.getHex() > 0) {
            mat.emissiveIntensity = isHovered ? 2.5 : 0.2;
          }
        }
      });
    }

    // Advance the shot queue; when it empties, return to the FP base shot.
    if (this.camFocused && this.now() >= this.camHoldUntil) {
      const next = this.camQueue.shift();
      if (next) this.applyShot(next);
      else {
        this.camFocused = false;
        this.camLerp = 0.04;
      }
    }

    if (!this.camFocused && !this.inMenu) {
      // First-person base shot with a subtle living sway.
      let bx = CAM_FP.pos.x;
      let by = CAM_FP.pos.y;
      let bz = CAM_FP.pos.z;
      let lx = CAM_FP.look.x;
      let ly = CAM_FP.look.y;
      let lz = CAM_FP.look.z;
      
      if (this.aiming) {
        by = 9.5;
        bz = 7.5;
        ly = 4.5;
        lz = -2.5; // Look up at the dealer
      } else if (this.aiAimingTarget) {
        if (this.aiAimingTarget === "PLAYER") {
          by = 9.5;
          bz = -7.5;
          ly = 4.5;
          lz = 2.5; // Over dealer's shoulder looking at player
        } else {
          by = 8.5;
          bx = 2.0;
          bz = -5.0;
          ly = 4.5;
          lz = -6.0; // Dealer aiming at self
        }
      }

      this.camTargetPos.set(
        bx + Math.sin(t * 0.4) * 0.12,
        by + Math.sin(t * 0.5) * 0.08,
        bz,
      );
      this.camTargetLook.set(lx, ly, lz);
    }

    if (this.inMenu) {
      this.menuAngle += 0.001; // slow continuous rotation
      // Orbit around the table
      this.camPos.x = Math.sin(this.menuAngle) * 12.0;
      this.camPos.z = Math.cos(this.menuAngle) * 12.0;
      this.camPos.y = 8.0;

      // To push the table to the right, we aim slightly to the left of the table.
      const center = new THREE.Vector3(0, SURFACE_Y, 0);
      const toCenter = center.clone().sub(this.camPos).normalize();
      
      // toCenter cross Up gives the actual Right vector.
      const trueRight = toCenter.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
      
      // Look left by subtracting trueRight
      this.camLook.copy(center).sub(trueRight.multiplyScalar(3.5));
    } else if (!this.transitioning) {
      this.camPos.lerp(this.camTargetPos, this.camLerp);
      this.camLook.lerp(this.camTargetLook, this.camLerp);
    }

    // Shake on a live shot, added on top of the eased position.
    let sx = 0;
    let sy = 0;
    const shake = this.fxProgress("shake");
    if (shake !== null) {
      const m = (1 - shake) * 0.3;
      sx += (Math.random() - 0.5) * m;
      sy += (Math.random() - 0.5) * m;
    }
    
    if (this.deathPlayerProg !== null) {
      // Simple falling back
      cam.rotation.z = 0;
    } else {
      cam.rotation.z = 0;
    }

    cam.position.set(this.camPos.x + sx, this.camPos.y + sy, this.camPos.z);
    cam.lookAt(this.camLook);
  }

  // -------------------------------------------------------------------------
  // Resize / unavailable / teardown
  // -------------------------------------------------------------------------

  private handleResize(): void {
    if (typeof window === "undefined") return;
    this.width = window.innerWidth || this.width;
    this.height = window.innerHeight || this.height;
    if (this.renderer) this.renderer.setSize(this.width, this.height, false);
    if (this.camera) {
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
    }
  }

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
      el.style.background = "#07060a";
      el.style.color = "#8b0000";
      el.style.fontFamily = "'Courier New', monospace";
      el.style.letterSpacing = "4px";
      el.style.zIndex = "9999";
      document.body.appendChild(el);
      this.overlay = el;
    } catch {
      // Showing the overlay must never throw.
    }
  }

  destroy(): void {
    this.stop();
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", this.onResize);
    }
    if (this.renderer) {
      this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
      this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
    }
    if (this.scene) {
      this.scene.traverse((o) => disposeTree(o));
    }
    if (this.renderer) {
      try {
        this.renderer.dispose();
      } catch {
        // ignore teardown errors
      }
    }
    this.renderer = undefined;
    this.scene = undefined;
    this.camera = undefined;
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    this.overlay = undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function easeOutCubic(p: number): number {
  const x = 1 - p;
  return 1 - x * x * x;
}

/** Dispose geometry + materials of an object subtree to free GPU memory. */
function disposeTree(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry?.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    }
  });
}

/** Remove and dispose every child of a group. */
function clearGroup(group: THREE.Group): void {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const child = group.children[i];
    if (!child) continue;
    group.remove(child);
    disposeTree(child);
  }
}

/** A floating glowing ring + downward arrow used to mark a click target. */
function makeTargetMarker(color: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 2.4,
    transparent: true,
    opacity: 1,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.07, 10, 28), mat);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.4, 4), mat);
  arrow.position.y = -0.5;
  arrow.rotation.y = Math.PI / 4;
  g.add(arrow);
  return g;
}

/** A small disk with a circular-arrow, the in-world SPIN control. */
function makeSpinToken(): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.34, 0.08, 20),
    new THREE.MeshStandardMaterial({
      color: 0x1a140e,
      roughness: 0.6,
      transparent: true,
      opacity: 1,
    }),
  );
  g.add(base);
  const arrowMat = new THREE.MeshStandardMaterial({
    color: 0xd9a441,
    emissive: 0xd9a441,
    emissiveIntensity: 1.6,
    transparent: true,
    opacity: 1,
  });
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.2, 0.035, 8, 20, Math.PI * 1.5),
    arrowMat,
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.07;
  g.add(ring);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.14, 8), arrowMat);
  head.position.set(0.2, 0.07, 0);
  head.rotation.z = -Math.PI / 2;
  g.add(head);
  return g;
}

export { participantName };
