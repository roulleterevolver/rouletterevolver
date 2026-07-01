// Game_Controller state machine for the Revolver Roulette single-player
// prototype.
//
// The controller is the ONLY stateful coordinator in the system (design
// "Game_Controller / State Machine"). Every game rule lives in the pure
// `Rules_Engine`; this module merely:
//
//   - holds the current `GameState`,
//   - translates validated human input into `Action`s and dispatches them
//     through `reduce`,
//   - drives the turn flow by scheduling the AI_Opponent's turn after a
//     bounded, configurable delay (Requirement 6.7, never exceeding 3s),
//   - pushes new state to state-change observers (the Renderer subscribes) and
//     emitted events to event observers (the Audio_System subscribes).
//
// It owns no game rules: it relies on `reduce` to validate and apply actions,
// `createMatch` to initialize, `toPlayerView` to project the public view for
// the AI, `decide` for the AI's choice, and `isMatchOver` to detect the end.
//
// Determinism & testability: both the RNG and the scheduler (the
// setTimeout/clearTimeout pair and the AI delay) are injectable so tests can
// drive the controller with a seeded RNG under fake timers.

import type {
  Action,
  EngineResult,
  GameConfig,
  GameEvent,
  GameState,
} from "../engine/types";
import type { RNG } from "../rng/rng";
import { SystemRng } from "../rng/rng";
import { reduce } from "../engine/reduce";
import { createMatch, isMatchOver, DEFAULT_CONFIG } from "../engine/lifecycle";
import { toPlayerView } from "../engine/view";
import { decide } from "../ai/decide";

/** Observer registered via `onStateChange`; receives each new `GameState`. */
export type StateObserver = (state: GameState) => void;

/** Observer registered via `onEvents`; receives each batch of `GameEvent`s. */
export type EventObserver = (events: readonly GameEvent[]) => void;

/** Opaque timer handle returned by the injected scheduler. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** A `setTimeout`-shaped function the controller uses to schedule AI turns. */
export type SetTimeoutFn = (handler: () => void, delayMs: number) => TimerHandle;

/** A `clearTimeout`-shaped function paired with {@link SetTimeoutFn}. */
export type ClearTimeoutFn = (handle: TimerHandle) => void;

/** Construction options; every dependency has a production-safe default. */
export interface GameControllerOptions {
  /** Randomness source. Defaults to {@link SystemRng} (non-deterministic). */
  readonly rng?: RNG;
  /**
   * Artificial think-time before the AI acts, for game feel. Clamped to
   * `[0, MAX_AI_DELAY_MS]` internally as a hard safety bound (Requirement 6.7).
   */
  readonly aiDelayMs?: number;
  /** Injectable scheduler; defaults to the global `setTimeout`. */
  readonly setTimeoutFn?: SetTimeoutFn;
  /** Injectable canceller; defaults to the global `clearTimeout`. */
  readonly clearTimeoutFn?: ClearTimeoutFn;
  /** Fires when a new game state is committed. */
  readonly onState?: (state: GameState) => void;
  /** Fires when state transitions generate side-effects (e.g. shots, items). */
  readonly onEvents?: (events: ReadonlyArray<GameEvent>) => void;
  /** Fires when the AI prepares to shoot. */
  readonly onAiAim?: (target: "PLAYER" | "AI") => void;
}

/** A sensible default AI think-time delay for game feel. */
export const DEFAULT_AI_DELAY_MS = 800;

/**
 * The hard upper bound on the AI think-time delay (Requirement 6.7: the AI must
 * produce and apply its action within a maximum of 3 seconds). The controller
 * clamps any configured delay to this value so the bound can never be exceeded.
 */
export const MAX_AI_DELAY_MS = 3000;

/** The controller's safe fallback action when the AI's choice is rejected. */
const FALLBACK_AI_ACTION: Action = { kind: "SHOOT", target: "PLAYER" };

/**
 * The stateful turn/phase coordinator. Construct it, register observers, then
 * call {@link GameController.start} to begin a Match.
 */
export class GameController {
  private readonly rng: RNG;
  private readonly aiDelayMs: number;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;

  private state: GameState | null = null;
  private pendingAiTimer: TimerHandle | null = null;
  private disposed = false;
  private aiPaused = false;

  private readonly stateObservers: StateObserver[] = [];
  private readonly eventObservers: EventObserver[] = [];
  private readonly onAiAim: (target: "PLAYER" | "AI") => void;

  constructor(options: GameControllerOptions = {}) {
    this.rng = options.rng ?? new SystemRng();
    const requested = options.aiDelayMs ?? DEFAULT_AI_DELAY_MS;
    this.aiDelayMs = Math.min(Math.max(0, requested), MAX_AI_DELAY_MS);
    this.setTimeoutFn =
      options.setTimeoutFn ?? ((handler, delay) => setTimeout(handler, delay));
    this.clearTimeoutFn =
      options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
    if (options.onState) this.stateObservers.push(options.onState);
    if (options.onEvents) this.eventObservers.push(options.onEvents);
    this.onAiAim = options.onAiAim ?? (() => {});
  }

  /** The configured AI think-time delay (already clamped to the 3s bound). */
  getAiDelayMs(): number {
    return this.aiDelayMs;
  }

  /**
   * Initialize a new Match (Requirements 7.1, 7.2): build the initial state via
   * `createMatch`, emit the initial state and the `ROUND_SET_LOADED` event, then
   * begin turn handling. `config` defaults to `DEFAULT_CONFIG` when omitted.
   * The first Turn is always the Player's (Requirement 7.2), so no AI turn is
   * scheduled here; the defensive `scheduleAiIfNeeded` call keeps the behavior
   * correct even if that ever changes.
   */
  start(config?: GameConfig): void {
    if (this.disposed) return;
    this.cancelPendingAi();

    const result = createMatch(config ?? DEFAULT_CONFIG, this.rng);
    this.state = result.state;
    this.emitState();
    this.emitEvents(result.events);

    this.scheduleAiIfNeeded();
  }

  /** The current authoritative `GameState`. Throws if called before `start`. */
  getState(): GameState {
    if (this.state === null) {
      throw new Error("GameController.getState() called before start().");
    }
    return this.state;
  }

  pauseAi(): void {
    if (this.aiPaused) return;
    this.aiPaused = true;
    this.cancelPendingAi();
  }

  resumeAi(): void {
    if (!this.aiPaused) return;
    this.aiPaused = false;
    this.scheduleAiIfNeeded();
  }

  /**
   * Submit validated human input (Requirement 3.8). The action is IGNORED
   * unless it is the Player's Turn in a player-actionable phase, with one
   * exception: `START_NEW_MATCH` is always allowed to pass through (it is the
   * documented escape hatch from `MATCH_OVER`, Requirements 7.5, 7.6).
   *
   * On an accepted dispatch the action is reduced, the new state and events are
   * emitted, and — if the Turn is now the AI's — the AI turn is scheduled.
   */
  submitPlayerAction(action: Action): void {
    if (this.disposed || this.state === null) return;

    // START_NEW_MATCH passthrough: permitted regardless of whose turn it is or
    // whether the Match is over.
    if (action.kind === "START_NEW_MATCH") {
      this.dispatch(action);
      return;
    }

    // Requirement 3.8: drop human input that is not the Player's to give (the
    // AI is acting, or the Match is over).
    if (!this.isPlayerActionable()) return;

    this.dispatch(action);
  }

  /** Register a state observer (the Renderer subscribes here). */
  onStateChange(cb: StateObserver): void {
    this.stateObservers.push(cb);
  }

  /** Register an event observer (the Audio_System subscribes here). */
  onEvents(cb: EventObserver): void {
    this.eventObservers.push(cb);
  }

  /** Register an event observer using the old name for backward compatibility. */
  onEventChange(cb: EventObserver): void {
    this.eventObservers.push(cb);
  }

  /**
   * Tear down the controller: cancel any pending AI timer and drop all
   * observers so no further callbacks fire.
   */
  dispose(): void {
    this.disposed = true;
    this.cancelPendingAi();
    this.stateObservers.length = 0;
    this.eventObservers.length = 0;
  }

  // --- internals ----------------------------------------------------------

  /**
   * Reduce `action` against the current state, commit the result, emit, and
   * (re)schedule the AI turn if it is now the AI's to act.
   */
  private dispatch(action: Action): void {
    if (this.state === null) return;
    const result = reduce(this.state, action, this.rng);
    this.applyResult(result);
    this.scheduleAiIfNeeded();
  }

  /** Commit an `EngineResult`: update state, then emit state and events. */
  private applyResult(result: EngineResult): void {
    this.state = result.state;
    this.emitState();
    this.emitEvents(result.events);
  }

  /** True when the Player may act: Match in progress and it is the Player's Turn. */
  private isPlayerActionable(): boolean {
    const state = this.state;
    if (state === null) return false;
    if (state.phase === "MATCH_OVER" || isMatchOver(state)) return false;
    return state.activeParticipant === "PLAYER";
  }

  /**
   * Schedule the AI's turn if the Match is in progress and it is currently the
   * AI's Turn. Any previously pending AI timer is cancelled first so only one
   * AI turn is ever in flight. The dispatch is bounded by `aiDelayMs`, which is
   * clamped to at most {@link MAX_AI_DELAY_MS} (Requirement 6.7).
   */
  private scheduleAiIfNeeded(): void {
    if (this.disposed || this.state === null || this.aiPaused) return;
    if (!this.isAiActionable()) return;

    this.cancelPendingAi();
    this.pendingAiTimer = this.setTimeoutFn(() => {
      this.pendingAiTimer = null;
      this.runAiTurn();
    }, this.aiDelayMs);
  }

  /** True when the AI must act: Match in progress and it is the AI's Turn. */
  private isAiActionable(): boolean {
    const state = this.state;
    if (state === null) return false;
    if (state.phase === "MATCH_OVER" || isMatchOver(state)) return false;
    return state.activeParticipant === "AI";
  }

  /**
   * Compute and apply the AI's action (Requirements 6.1, 6.2, 6.7). The AI sees
   * only its public `PlayerView`; its chosen action is validated by passing it
   * through `reduce`. If the engine rejects it, the controller falls back to the
   * always-legal `SHOOT(PLAYER)` (also via `reduce`). After applying, if it is
   * still the AI's Turn (a kept turn, e.g. a confirmed self-blank), the next AI
   * turn is scheduled again.
   */
  private runAiTurn(): void {
    if (this.disposed || this.state === null) return;
    if (!this.isAiActionable()) return;

    const view = toPlayerView(this.state, "AI");
    const action = decide(view);

    // If the AI decides to shoot, give it an "aiming" pause.
    if (action.kind === "SHOOT") {
      this.onAiAim(action.target);
      this.pendingAiTimer = this.setTimeoutFn(() => {
        this.pendingAiTimer = null;
        if (this.disposed || this.state === null) return;
        let result = reduce(this.state, action, this.rng);
        if (result.rejected !== undefined) {
          result = reduce(this.state, FALLBACK_AI_ACTION, this.rng);
        }
        this.applyResult(result);
        this.scheduleAiIfNeeded();
      }, 1200); // 1.2s dramatic pause
      return;
    }

    let result = reduce(this.state, action, this.rng);
    if (result.rejected !== undefined) {
      // The AI returned an action the engine rejected; fall back to the safe
      // default so the AI always makes legal progress within its think-time.
      result = reduce(this.state, FALLBACK_AI_ACTION, this.rng);
    }

    this.applyResult(result);
    this.scheduleAiIfNeeded();
  }

  /** Cancel any pending AI timer. */
  private cancelPendingAi(): void {
    if (this.pendingAiTimer !== null) {
      this.clearTimeoutFn(this.pendingAiTimer);
      this.pendingAiTimer = null;
    }
  }

  /** Push the current state to every state observer. */
  private emitState(): void {
    if (this.state === null) return;
    const snapshot = this.state;
    for (const cb of this.stateObservers.slice()) {
      cb(snapshot);
    }
  }

  /** Push a batch of events to every event observer. */
  private emitEvents(events: readonly GameEvent[]): void {
    if (events.length === 0) return;
    for (const cb of this.eventObservers.slice()) {
      cb(events);
    }
  }
}
