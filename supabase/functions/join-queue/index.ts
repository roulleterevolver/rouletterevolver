// Supabase Edge Function: join-queue
//
// Called when a player picks a bet amount. Inserts them into the queue and
// immediately tries to match them with another waiting player at the same bet.
// If matched, creates a match and notifies both players.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createMatch, DEFAULT_CONFIG, SystemRng } from "../_shared/engine.ts";

const TURN_TIMEOUT_SEC = 30;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface JoinPayload {
  player_id: string;
  bet_amount: number;
}

serve(async (req: Request) => {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { player_id, bet_amount } = (await req.json()) as JoinPayload;

    if (![100, 1000, 10000].includes(bet_amount)) {
      return new Response(JSON.stringify({ error: "Invalid bet" }), { status: 400, headers: corsHeaders });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Ensure the player exists (create if not — for testing).
    const { data: player } = await supabase
      .from("players")
      .select("balance")
      .eq("id", player_id)
      .single();

    if (!player) {
      // Auto-create a player record for testing.
      await supabase.from("players").insert({ id: player_id, display_name: "PLAYER", balance: 100000 });
    }

    // Insert into queue (skip balance check for now).
    const { data: queueEntry } = await supabase
      .from("queue")
      .insert({ player_id, bet_amount, status: "waiting" })
      .select()
      .single();

    // Try to find a match — another "waiting" entry with the same bet, different player.
    const { data: opponent } = await supabase
      .from("queue")
      .select("*")
      .eq("bet_amount", bet_amount)
      .eq("status", "waiting")
      .neq("player_id", player_id)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (!opponent) {
      // No match yet — wait for someone else to join.
      return new Response(JSON.stringify({ status: "waiting", queue_id: queueEntry?.id }), { status: 200, headers: corsHeaders });
    }

    // Found an opponent — create the match!
    const coinFlip = Math.random() < 0.5 ? "player1" : "player2";
    // The coin's landing face is fixed now so BOTH clients animate the same
    // result. Who actually goes first is decided later by the players' picks
    // (see the coin-pick function); `first_turn` here is only a placeholder.
    const coinResult = Math.random() < 0.5; // true = HEADS

    // Generate the initial game state using the real engine.
    const rng = new SystemRng();
    const matchResult = createMatch(DEFAULT_CONFIG, rng);
    const initialState = {
      ...matchResult.state,
      activeParticipant: coinFlip === "player1" ? "PLAYER" : "AI",
    };

    const deadline = new Date(Date.now() + TURN_TIMEOUT_SEC * 1000).toISOString();

    const { data: match } = await supabase
      .from("matches")
      .insert({
        player1_id: opponent.player_id, // first queued = player1
        player2_id: player_id,          // joiner = player2
        bet_amount,
        state: initialState,
        first_turn: coinFlip,
        turn_deadline: deadline,
        status: "active",
        coin_result: coinResult,
        // Store the match-creation events (ROUND_SET_LOADED) as seq 1 so both
        // clients replay the same "X LIVE / Y BLANK" intro after the coin flip.
        event_seq: 1,
        last_events: matchResult.events,
      })
      .select()
      .single();

    if (!match) {
      return new Response(JSON.stringify({ error: "Failed to create match" }), { status: 500, headers: corsHeaders });
    }

    // Update both queue entries to "matched".
    await supabase
      .from("queue")
      .update({ status: "matched", match_id: match.id })
      .in("id", [opponent.id, queueEntry?.id]);

    // Deduct opponent's bet too (skipped for testing).
    // await supabase.rpc("deduct_balance", { p_id: opponent.player_id, amount: bet_amount });

    // Notify both players via Realtime.
    await supabase.channel(`queue:${opponent.player_id}`).send({
      type: "broadcast",
      event: "matched",
      payload: { match_id: match.id, opponent_id: player_id, you_are: "player1", first_turn: coinFlip },
    });
    await supabase.channel(`queue:${player_id}`).send({
      type: "broadcast",
      event: "matched",
      payload: { match_id: match.id, opponent_id: opponent.player_id, you_are: "player2", first_turn: coinFlip },
    });

    return new Response(JSON.stringify({ status: "matched", match_id: match.id, first_turn: coinFlip }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
