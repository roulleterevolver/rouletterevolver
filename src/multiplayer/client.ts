// Multiplayer client adapter for Revolver Roulette.
//
// Replaces the local GameController in multiplayer mode. Instead of running the
// engine locally, it sends actions to the Supabase Edge Function and receives
// state/events via Supabase Realtime broadcasts.

import { createClient, type SupabaseClient, type RealtimeChannel } from "@supabase/supabase-js";
import type { Action, GameEvent, GameState } from "../engine/types";

export interface MultiplayerConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  playerId: string;
  /** Called when the game state updates (for the renderer). */
  onStateChange: (state: GameState) => void;
  /** Called when game events arrive (for audio/captions/renderer feedback). */
  onEvents: (events: GameEvent[]) => void;
  /** Called when the turn timer ticks (seconds remaining). */
  onTimerTick: (secondsLeft: number) => void;
  /** Called when matched with an opponent. */
  onMatched: (data: { matchId: string; youAre: "player1" | "player2"; firstTurn: string }) => void;
  /** Called when the match ends. */
  onMatchOver: (winnerId: string) => void;
}

export class MultiplayerClient {
  private supabase: SupabaseClient;
  private playerId: string;
  private matchId: string | null = null;
  private youAre: "player1" | "player2" = "player1";
  private channel: RealtimeChannel | null = null;
  private queueChannel: RealtimeChannel | null = null;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private turnDeadline: number | null = null;
  private config: MultiplayerConfig;

  constructor(config: MultiplayerConfig) {
    this.config = config;
    this.playerId = config.playerId;
    this.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
  }

  /** Join the matchmaking queue with a bet amount. */
  async joinQueue(betAmount: number): Promise<void> {
    // Subscribe to personal queue channel for match notifications.
    this.queueChannel = this.supabase
      .channel(`queue:${this.playerId}`)
      .on("broadcast", { event: "matched" }, ({ payload }) => {
        this.handleMatched(payload);
      })
      .subscribe();

    // Call the join-queue Edge Function.
    const { data, error } = await this.supabase.functions.invoke("join-queue", {
      body: { player_id: this.playerId, bet_amount: betAmount },
    });

    if (error) throw new Error(`Queue error: ${error.message}`);

    // If matched immediately (the function found an opponent).
    if (data?.status === "matched") {
      this.handleMatched({
        match_id: data.match_id,
        you_are: "player2",
        first_turn: data.first_turn,
      });
    }
  }

  /** Cancel matchmaking. */
  async cancelQueue(): Promise<void> {
    if (this.queueChannel) {
      this.supabase.removeChannel(this.queueChannel);
      this.queueChannel = null;
    }
    // TODO: Call cancel-queue Edge Function to refund bet.
  }

  /** Submit a player action during the match. */
  async submitAction(action: Action): Promise<void> {
    if (!this.matchId) return;

    const { error } = await this.supabase.functions.invoke("submit-action", {
      body: {
        match_id: this.matchId,
        player_id: this.playerId,
        action,
      },
    });

    if (error) {
      console.warn("[multiplayer] action rejected:", error.message);
    }
  }

  /** Clean up channels and timers. */
  destroy(): void {
    if (this.channel) this.supabase.removeChannel(this.channel);
    if (this.queueChannel) this.supabase.removeChannel(this.queueChannel);
    if (this.timerInterval) clearInterval(this.timerInterval);
  }

  // --- Private ---

  private handleMatched(payload: any): void {
    this.matchId = payload.match_id;
    this.youAre = payload.you_are;

    // Clean up queue channel.
    if (this.queueChannel) {
      this.supabase.removeChannel(this.queueChannel);
      this.queueChannel = null;
    }

    // Subscribe to the match channel for real-time game events.
    this.channel = this.supabase
      .channel(`match:${this.matchId}`)
      .on("broadcast", { event: "game_events" }, ({ payload: eventPayload }) => {
        this.handleGameEvents(eventPayload);
      })
      .subscribe();

    this.config.onMatched({
      matchId: this.matchId!,
      youAre: this.youAre,
      firstTurn: payload.first_turn,
    });
  }

  private handleGameEvents(payload: any): void {
    const { events, state, turn_deadline } = payload;

    // Update the turn timer.
    if (turn_deadline) {
      this.turnDeadline = new Date(turn_deadline).getTime();
      this.startTimer();
    } else {
      this.stopTimer();
    }

    // Fire callbacks.
    if (state) this.config.onStateChange(state as GameState);
    if (events && events.length > 0) this.config.onEvents(events as GameEvent[]);

    // Check for match over.
    if (state?.winner !== null) {
      const winnerId = state.winner === "PLAYER"
        ? (this.youAre === "player1" ? this.playerId : "opponent")
        : (this.youAre === "player2" ? this.playerId : "opponent");
      this.config.onMatchOver(winnerId);
      this.stopTimer();
    }
  }

  private startTimer(): void {
    this.stopTimer();
    this.timerInterval = setInterval(() => {
      if (!this.turnDeadline) return;
      const left = Math.max(0, Math.ceil((this.turnDeadline - Date.now()) / 1000));
      this.config.onTimerTick(left);
      if (left <= 0) {
        this.stopTimer();
        // Auto-shoot-self is handled server-side on the next action attempt.
      }
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }
}
