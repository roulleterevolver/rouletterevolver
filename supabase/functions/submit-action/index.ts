// @ts-nocheck
// Supabase Edge Function: submit-action
//
// Called by the client when a player takes an action. Validates the turn,
// runs the pure engine (reduce), saves the new state, and broadcasts events
// to both players. Enforces the 30-second turn timeout.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// --- Import the pure game engine (bundled) ---
import { reduce, SystemRng, type GameState, type Action } from "../_shared/engine.ts";

const TURN_TIMEOUT_SEC = 30;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ActionPayload {
  match_id: string;
  player_id: string;
  action: { kind: string; target?: string; item?: string };
}

serve(async (req: Request) => {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { match_id, player_id, action } = (await req.json()) as ActionPayload;

    // Create a service-role client (bypasses RLS for server-side writes).
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Load the match.
    const { data: match, error: matchErr } = await supabase
      .from("matches")
      .select("*")
      .eq("id", match_id)
      .single();

    if (matchErr || !match) {
      return new Response(JSON.stringify({ error: "Match not found" }), { status: 404, headers: corsHeaders });
    }

    if (match.status !== "active") {
      return new Response(JSON.stringify({ error: "Match is not active" }), { status: 400, headers: corsHeaders });
    }

    // Determine which player slot this is (player1 or player2).
    let playerSlot: "player1" | "player2";
    if (player_id === match.player1_id) playerSlot = "player1";
    else if (player_id === match.player2_id) playerSlot = "player2";
    else return new Response(JSON.stringify({ error: "Not a participant" }), { status: 403, headers: corsHeaders });

    // Map player slots to engine ParticipantIds.
    // player1 = "PLAYER", player2 = "AI" (reusing the engine's two-participant model).
    const participantId = playerSlot === "player1" ? "PLAYER" : "AI";
    const state = match.state;

    // Validate it's this player's turn (engine also checks, but early-reject saves a DB write).
    if (state.activeParticipant !== participantId) {
      // Don't block — let the engine reject it so we can debug. Log it.
      console.warn(`[submit-action] ${participantId} tried to act but active is ${state.activeParticipant}`);
    }

    // Check turn timeout — if deadline has passed, auto-shoot-self.
    const now = new Date();
    if (match.turn_deadline && new Date(match.turn_deadline) < now) {
      // Time's up — force a self-shot as punishment.
      action.kind = "SHOOT";
      action.target = participantId;
    }

    // --- Run the engine ---
    const rng = new SystemRng();
    const result = reduce(state as GameState, action as Action, rng);

    if (result.rejected) {
      return new Response(JSON.stringify({ error: "Action rejected", reason: result.rejected }), { status: 400, headers: corsHeaders });
    }

    // Set the new turn deadline (30s from now for the next active player).
    const newState = result.state;
    const matchOver = newState.winner !== null;
    const newDeadline = matchOver
      ? null
      : new Date(Date.now() + TURN_TIMEOUT_SEC * 1000).toISOString();

    // Save to DB.
    const nextSeq = (match.event_seq ?? 0) + 1;
    const updates: Record<string, unknown> = {
      state: newState,
      turn_deadline: newDeadline,
      // Persist the events so the OTHER player's poller can replay them
      // (shots, captions, audio) exactly as the acting player saw them.
      event_seq: nextSeq,
      last_events: result.events,
    };
    if (matchOver) {
      const winnerId = newState.winner === "PLAYER" ? match.player1_id : match.player2_id;
      updates.winner_id = winnerId;
      updates.status = "finished";
      updates.finished_at = new Date().toISOString();
    }

    await supabase.from("matches").update(updates).eq("id", match_id);

    // Distribute winnings if match is over.
    if (matchOver && updates.winner_id) {
      const pot = match.bet_amount * 2;
      await supabase.rpc("add_balance", { p_id: updates.winner_id, amount: pot });
      // Update win/loss counts.
      const loserId = updates.winner_id === match.player1_id ? match.player2_id : match.player1_id;
      await supabase.rpc("increment_wins", { p_id: updates.winner_id });
      await supabase.rpc("increment_losses", { p_id: loserId });
    }

    // Broadcast the events to both players via Realtime channel.
    await supabase.channel(`match:${match_id}`).send({
      type: "broadcast",
      event: "game_events",
      payload: {
        events: result.events,
        state: newState,
        turn_deadline: newDeadline,
      },
    });

    return new Response(JSON.stringify({ ok: true, events: result.events, state: newState, event_seq: nextSeq }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
