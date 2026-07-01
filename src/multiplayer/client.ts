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
  private pollTimer: ReturnType<typeof setInterval> | null = null;
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
    // Call the join-queue Edge Function.
    const { data, error } = await this.supabase.functions.invoke("join-queue", {
      body: { player_id: this.playerId, bet_amount: betAmount },
    });

    if (error) throw new Error(`Queue error: ${error.message}`);

    // If matched immediately (the function found an opponent).
    if (data?.status === "matched") {
      await this.loadMatchAndStart(data.match_id);
      return;
    }

    // Not matched yet — poll every 2 seconds until our queue row OR a match appears.
    const queueId = data?.queue_id;
    this.pollTimer = setInterval(async () => {
      // Check queue row first.
      if (queueId) {
        const { data: row } = await this.supabase
          .from("queue")
          .select("status, match_id")
          .eq("id", queueId)
          .single();
        if (row && row.status === "matched" && row.match_id) {
          if (this.pollTimer) clearInterval(this.pollTimer);
          this.pollTimer = null;
          await this.loadMatchAndStart(row.match_id);
          return;
        }
      }
      // Fallback: check matches table directly.
      const { data: match } = await this.supabase
        .from("matches")
        .select("id")
        .or(`player1_id.eq.${this.playerId},player2_id.eq.${this.playerId}`)
        .eq("status", "active")
        .limit(1)
        .single();
      if (match) {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        await this.loadMatchAndStart(match.id);
      }
    }, 2000);
  }

  /** Load match data from DB and trigger onMatched. */
  private async loadMatchAndStart(matchId: string): Promise<void> {
    this.matchId = matchId;

    // Load the match to get first_turn info.
    const { data: match } = await this.supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .single();

    if (!match) return;

    // Determine our role.
    if (this.playerId === match.player1_id) this.youAre = "player1";
    else this.youAre = "player2";

    // Clean up queue channel.
    if (this.queueChannel) {
      this.supabase.removeChannel(this.queueChannel);
      this.queueChannel = null;
    }

    // Subscribe to match updates for real-time game events.
    this.channel = this.supabase
      .channel(`match-watch-${matchId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "matches",
          filter: `id=eq.${matchId}`,
        },
        (payload: any) => {
          const row = payload.new;
          this.handleGameEvents({
            events: [], // Events come from the state diff
            state: row.state,
            turn_deadline: row.turn_deadline,
          });
        },
      )
      .subscribe();

    this.config.onMatched({
      matchId,
      youAre: this.youAre,
      firstTurn: match.first_turn,
    });

    // Initial state render.
    if (match.state) {
      this.config.onStateChange(match.state as GameState);
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
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  // --- Private ---

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
