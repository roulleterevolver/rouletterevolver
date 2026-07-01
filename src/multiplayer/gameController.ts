// MultiplayerGameController — a drop-in replacement for the single-player
// GameController that sources ALL state and events from the Supabase server
// instead of running the engine locally.
//
// It satisfies the same `PresentationController` surface (`getState`,
// `onStateChange`, `onEvents`, `pauseAi`, `resumeAi`) so `main.ts` can wire the
// renderer / audio / captions with the EXACT same code path used for
// single-player. The only difference is the source of truth:
//
//   single-player : local `reduce()` in GameController
//   multiplayer   : the authoritative `matches` row, polled by MultiplayerClient
//
// The AI hooks are no-ops here — in multiplayer the "AI" seat is a real second
// human, so there is no AI to pause or resume.

import type { Action, GameEvent, GameState } from "../engine/types";
import type {
  EventObserver,
  PresentationController,
  StateObserver,
} from "../controller/gameController";
import { MultiplayerClient } from "./client";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";

export interface MultiplayerControllerOptions {
  playerId: string;
  /**
   * Fired once when an opponent is found, BEFORE the intro board is revealed.
   * `youFirst` is the placeholder turn order; the real order is decided by the
   * coin pick. `coinResult` is the shared landing face (both clients agree).
   * Call {@link MultiplayerGameController.beginMatch} when the cinematic
   * finishes to reveal the board.
   */
  onMatched: (info: {
    youAre: "player1" | "player2";
    youFirst: boolean;
    coinResult: boolean;
  }) => void;
  /** Fired once when the match ends; `youWon` reflects this client. */
  onMatchOver: (youWon: boolean) => void;
  /** Fired each second with the active turn's remaining time. */
  onTimerTick: (secondsLeft: number) => void;
}

export class MultiplayerGameController implements PresentationController {
  private readonly client: MultiplayerClient;
  private readonly stateObservers: StateObserver[] = [];
  private readonly eventObservers: EventObserver[] = [];

  private state: GameState | null = null;
  private initialState: GameState | null = null;
  private initialEvents: GameEvent[] = [];
  private started = false;

  constructor(opts: MultiplayerControllerOptions) {
    this.client = new MultiplayerClient({
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY,
      playerId: opts.playerId,

      onMatched: (data) => {
        // Stash the authoritative initial state/events; do NOT reveal them yet.
        this.initialState = data.initialState;
        this.initialEvents = data.initialEvents;
        this.state = data.initialState;
        const youFirst = data.firstTurn === data.youAre;
        opts.onMatched({ youAre: data.youAre, youFirst, coinResult: data.coinResult });
      },

      onStateChange: (state) => {
        this.state = state;
        // Ignore live updates until the intro board has been revealed, so the
        // coin-flip cinematic isn't interrupted by an early state push.
        if (this.started) this.emitState(state);
      },

      onEvents: (events) => {
        if (this.started) this.emitEvents(events);
      },

      onTimerTick: opts.onTimerTick,
      onMatchOver: opts.onMatchOver,
    });
  }

  /** Join the queue and start matchmaking. */
  joinQueue(betAmount: number): Promise<void> {
    return this.client.joinQueue(betAmount);
  }

  /** Submit this client's heads/tails call (first-come-first-serve). */
  submitCoinPick(pick: boolean): Promise<{ myPick: boolean; coinResult: boolean; youFirst: boolean }> {
    return this.client.submitCoinPick(pick);
  }

  /** Poll whether the opponent already claimed a side (returns our forced side). */
  pollCoinLock(): Promise<boolean | null> {
    return this.client.pollCoinLock();
  }

  /**
   * Reveal the board once the coin-flip cinematic is done: emits the initial
   * server state and its `ROUND_SET_LOADED` events, exactly like the
   * single-player controller does at `start()`.
   */
  beginMatch(): void {
    if (this.started || !this.initialState) return;
    this.started = true;
    this.emitState(this.initialState);
    if (this.initialEvents.length) this.emitEvents(this.initialEvents);
  }

  // --- PresentationController surface -------------------------------------

  getState(): GameState {
    if (this.state === null) {
      throw new Error("MultiplayerGameController.getState() called before match start.");
    }
    return this.state;
  }

  onStateChange(cb: StateObserver): void {
    this.stateObservers.push(cb);
  }

  onEvents(cb: EventObserver): void {
    this.eventObservers.push(cb);
  }

  /** No AI in multiplayer — the opponent seat is a real player. */
  pauseAi(): void {}
  resumeAi(): void {}

  // --- input --------------------------------------------------------------

  /** Route a validated in-world action to the server. */
  submitPlayerAction(action: Action): void {
    if (action.kind === "START_NEW_MATCH") return; // rematch not supported yet
    if (!this.started) return;
    void this.client.submitAction(action);
  }

  dispose(): void {
    this.client.destroy();
    this.stateObservers.length = 0;
    this.eventObservers.length = 0;
  }

  // --- internals ----------------------------------------------------------

  private emitState(state: GameState): void {
    for (const cb of this.stateObservers.slice()) cb(state);
  }

  private emitEvents(events: readonly GameEvent[]): void {
    if (events.length === 0) return;
    for (const cb of this.eventObservers.slice()) cb(events);
  }
}
