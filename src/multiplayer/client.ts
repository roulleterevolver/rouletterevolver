// Multiplayer client for Revolver Roulette.
//
// The Supabase server is the ONLY source of truth. This client never runs the
// engine locally. It:
//   - joins the matchmaking queue and polls until an opponent is found,
//   - submits actions to the `submit-action` Edge Function,
//   - polls the authoritative `matches` row and, whenever the server's
//     `event_seq` advances, REPLAYS the stored `last_events` locally so BOTH
//     players (the actor and the observer) see identical shots/captions/audio.
//
// The acting player gets instant feedback from the function response; the
// observing player gets the same events on the next poll tick. A per-client
// `lastEventSeq` cursor guarantees each batch of events is played exactly once.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Action, GameEvent, GameState } from "../engine/types";
import { USE_SUPABASE_AUTH } from "./config";

export interface MultiplayerConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  playerId: string;
  /** Called once when matched. Includes the authoritative initial state/events. */
  onMatched: (data: {
    matchId: string;
    youAre: "player1" | "player2";
    firstTurn: "player1" | "player2";
    coinResult: boolean;
    initialState: GameState;
    initialEvents: GameEvent[];
  }) => void;
  /** Called on every authoritative state update (for the renderer/panel). */
  onStateChange: (state: GameState) => void;
  /** Called with each new batch of engine events (for audio/captions/feedback). */
  onEvents: (events: GameEvent[]) => void;
  /** Called each second with the active turn's remaining time. */
  onTimerTick: (secondsLeft: number) => void;
  onMatchOver: (youWon: boolean) => void;
}

const QUEUE_POLL_MS = 2000;
const MATCH_POLL_MS = 1200;

export class MultiplayerClient {
  private supabase: SupabaseClient;
  private playerId: string;
  private matchId: string | null = null;
  private youAre: "player1" | "player2" = "player1";
  private player1Id = "";
  private player2Id = "";

  private queuePollTimer: ReturnType<typeof setInterval> | null = null;
  private matchPollTimer: ReturnType<typeof setInterval> | null = null;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private turnDeadline: number | null = null;

  /** Highest server event_seq this client has already replayed. */
  private lastEventSeq = 0;
  private matchOverFired = false;
  private destroyed = false;

  private config: MultiplayerConfig;

  constructor(config: MultiplayerConfig) {
    this.config = config;
    this.playerId = config.playerId;
    this.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
  }

  /** Join the matchmaking queue with a bet amount, then poll until matched. */
  async joinQueue(betAmount: number): Promise<void> {
    await this.ensureAuth();
    const { data, error } = await this.supabase.functions.invoke("join-queue", {
      body: { player_id: this.playerId, bet_amount: betAmount },
    });

    if (error) throw new Error(`Could not reach matchmaking: ${error.message}`);
    if (data?.error) throw new Error(String(data.error));

    if (data?.status === "matched" && data.match_id) {
      await this.loadMatch(data.match_id);
      return;
    }

    if (data?.status === "pending" && data.match_id) {
      await this.loadMatch(data.match_id);
      return;
    }

    // Not matched yet — poll for our queue row flipping to "matched", or for a
    // match that lists us as a participant.
    const queueId = data?.queue_id as string | undefined;
    const channel = this.supabase.channel(`queue:${this.playerId}`);
    if (channel) {
      channel.on("broadcast", { event: "match_pending" }, (payload) => {
        this.clearQueuePoll();
        this.loadMatch(payload.payload.match_id);
      });

      channel.on("broadcast", { event: "match_cancelled" }, () => {
        this.clearQueuePoll();
      });

      channel.on("broadcast", { event: "matched" }, (payload) => {
        // We found a match!
        const data = payload.payload;
        this.clearQueuePoll();
        this.loadMatch(data.match_id);
      });
      channel.subscribe();
    }

    this.queuePollTimer = setInterval(async () => {
      if (this.destroyed) return;

      // 1. Check if we're in an active match
      const { data: match } = await this.supabase
        .from("matches")
        .select("id, state")
        .or(`player1_id.eq.${this.playerId},player2_id.eq.${this.playerId}`)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
        
      if (match?.id) {
        this.clearQueuePoll();
        await this.loadMatch(match.id);
        return;
      }

      // 2. Fallback to check queue status
      if (queueId) {
        const { data: row } = await this.supabase
          .from("queue")
          .select("status, match_id")
          .eq("id", queueId)
          .maybeSingle();
          
        if (row?.status === "matched" && row.match_id) {
          this.clearQueuePoll();
          await this.loadMatch(row.match_id);
        }
      }

    }, QUEUE_POLL_MS);
  }

  /** Submit a player action. The actor gets immediate feedback from the server. */
  async submitAction(action: Action): Promise<void> {
    if (!this.matchId || this.destroyed) return;

    const { data, error } = await this.supabase.functions.invoke("submit-action", {
      body: { match_id: this.matchId, player_id: this.playerId, action },
    });

    if (error) {
      console.warn("[multiplayer] action error:", error.message);
      return;
    }
    if (data?.error) {
      console.warn("[multiplayer] action rejected:", data.error, data.reason ?? "");
      return;
    }

    // Instant feedback for the acting player. Advance the cursor so the poll
    // does not replay these same events a second time.
    const seq = data?.event_seq as number | undefined;
    if (typeof seq === "number") this.lastEventSeq = Math.max(this.lastEventSeq, seq);

    if (data?.state) this.applyServerRow(data.state as GameState, data.turn_deadline ?? null);
    if (data?.events?.length) this.config.onEvents(data.events as GameEvent[]);

    this.checkMatchOver(data?.state as GameState | undefined);
  }

  /** Cancel matchmaking (best-effort). */
  async cancelQueue(): Promise<void> {
    this.clearQueuePoll();
  }

  /**
   * Submit this client's heads/tails call. First-come-first-serve: the server
   * claims the side for the first caller and forces the opposite on the other.
   * Resolves with THIS client's effective pick + the shared coin result +
   * whether this client goes first.
   */
  async submitCoinPick(pick: boolean): Promise<{ myPick: boolean; coinResult: boolean; youFirst: boolean; newState?: any }> {
    if (!this.matchId) return { myPick: pick, coinResult: pick, youFirst: true };
    const { data, error } = await this.supabase.functions.invoke("coin-pick", {
      body: { match_id: this.matchId, player_id: this.playerId, pick },
    });
    if (error || data?.error || !data) {
      console.warn("[multiplayer] coin-pick error:", error?.message ?? data?.error);
      return { myPick: pick, coinResult: pick, youFirst: true };
    }
    return {
      myPick: data.my_pick,
      coinResult: data.coin_result,
      youFirst: data.first_turn === this.youAre,
      newState: data.state,
    };
  }

  /**
   * Poll whether the opponent already locked a side. Returns the side THIS
   * client is forced to (opposite of the opponent's), or null if still open /
   * this client is the one who claimed it.
   */
  async pollCoinLock(): Promise<boolean | null> {
    if (!this.matchId) return null;
    const { data } = await this.supabase
      .from("matches")
      .select("coin_pick_by, coin_pick")
      .eq("id", this.matchId)
      .maybeSingle();
    if (!data || data.coin_pick_by == null) return null;
    if (data.coin_pick_by === this.playerId) return null; // we claimed it
    return !data.coin_pick; // forced to the opposite of the opponent
  }

  /** Tear down all timers and channels. */
  destroy(): void {
    this.destroyed = true;
    this.clearQueuePoll();
    if (this.matchPollTimer) clearInterval(this.matchPollTimer);
    this.stopTimer();
  }

  // --- internals ----------------------------------------------------------

  /**
   * When USE_SUPABASE_AUTH is on, ensure an anonymous auth session exists and
   * adopt its auth.uid() as the player_id (so the RLS policies in rls.sql
   * apply). No-op otherwise, keeping the current open testing model intact.
   */
  private async ensureAuth(): Promise<void> {
    if (!USE_SUPABASE_AUTH) return;
    const { data: sessionData } = await this.supabase.auth.getSession();
    let userId = sessionData.session?.user?.id;
    if (!userId) {
      const { data, error } = await this.supabase.auth.signInAnonymously();
      if (error) {
        console.warn("[multiplayer] anonymous sign-in failed:", error.message);
        return;
      }
      userId = data.user?.id;
    }
    if (userId) this.playerId = userId;
  }

  private async loadMatch(matchId: string): Promise<void> {
    this.matchId = matchId;

    const { data: match } = await this.supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .single();
    if (!match) return;

    this.player1Id = match.player1_id;
    this.player2Id = match.player2_id;
    this.youAre = this.playerId === match.player1_id ? "player1" : "player2";
    this.lastEventSeq = match.event_seq ?? 1; // initial events replayed via onMatched

    // Hand the authoritative initial state/events to the controller. The coin
    // flip UI runs BEFORE the intro events are replayed (see the controller).
    this.config.onMatched({
      matchId,
      youAre: this.youAre,
      firstTurn: match.first_turn,
      coinResult: match.coin_result ?? true,
      initialState: match.state as GameState,
      initialEvents: (match.last_events ?? []) as GameEvent[],
    });

    this.startMatchPoll(matchId);
  }

  private startMatchPoll(matchId: string): void {
    if (this.matchPollTimer) clearInterval(this.matchPollTimer);
    this.matchPollTimer = setInterval(async () => {
      if (this.destroyed) return;
      const { data: row } = await this.supabase
        .from("matches")
        .select("state, turn_deadline, status, event_seq, last_events")
        .eq("id", matchId)
        .single();
      if (!row) return;

      const seq = (row.event_seq ?? 0) as number;
      if (seq > this.lastEventSeq) {
        this.lastEventSeq = seq;
        // Replay the authoritative events FIRST (so captions/animations know the
        // pre-shot state), then commit the new state.
        this.applyServerRow(row.state as GameState, row.turn_deadline ?? null);
        if (row.last_events?.length) this.config.onEvents(row.last_events as GameEvent[]);
        this.checkMatchOver(row.state as GameState);
      }

      if (row.status === "finished" && this.matchPollTimer) {
        clearInterval(this.matchPollTimer);
        this.matchPollTimer = null;
      }
    }, MATCH_POLL_MS);
  }

  private applyServerRow(state: GameState, deadline: string | null): void {
    this.config.onStateChange(state);
    if (deadline && state.winner === null) {
      this.turnDeadline = new Date(deadline).getTime();
      this.startTimer();
    } else {
      this.turnDeadline = null;
      this.stopTimer();
    }
  }

  private checkMatchOver(state?: GameState): void {
    if (!state || state.winner === null || this.matchOverFired) return;
    this.matchOverFired = true;
    this.stopTimer();
    const winnerId = state.winner === "PLAYER" ? this.player1Id : this.player2Id;
    this.config.onMatchOver(winnerId === this.playerId);
  }

  private startTimer(): void {
    this.stopTimer();
    this.timerInterval = setInterval(() => {
      if (!this.turnDeadline) return;
      const left = Math.max(0, Math.ceil((this.turnDeadline - Date.now()) / 1000));
      this.config.onTimerTick(left);
      if (left <= 0) this.stopTimer();
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  private clearQueuePoll(): void {
    if (this.queuePollTimer) {
      clearInterval(this.queuePollTimer);
      this.queuePollTimer = null;
    }
  }
}
