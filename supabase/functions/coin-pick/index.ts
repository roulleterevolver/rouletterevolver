// Supabase Edge Function: coin-pick
//
// First-come-first-serve coin call. The FIRST player to submit a side claims
// it via an atomic "WHERE coin_pick_by IS NULL" update; the other player is
// forced to the opposite side. `first_turn` (and the game state's active
// participant) is then derived from whichever picked side matches the fixed
// `coin_result` set at match creation — so both clients agree on the outcome
// AND see the coin land on the same face.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface PickPayload {
  match_id: string;
  player_id: string;
  pick: boolean; // true = HEADS, false = TAILS
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { match_id, player_id, pick } = (await req.json()) as PickPayload;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: match, error: matchErr } = await supabase
      .from("matches")
      .select("*")
      .eq("id", match_id)
      .single();
    if (matchErr || !match) {
      return new Response(JSON.stringify({ error: "Match not found" }), { status: 404, headers: corsHeaders });
    }

    const coinResult: boolean = match.coin_result ?? true;

    // Try to CLAIM the pick atomically: only succeeds if no one has picked yet.
    const { data: claimed } = await supabase
      .from("matches")
      .update({ coin_pick_by: player_id, coin_pick: pick })
      .eq("id", match_id)
      .is("coin_pick_by", null)
      .select()
      .maybeSingle();

    let firstPickBy: string;
    let firstPick: boolean;
    if (claimed) {
      firstPickBy = player_id;
      firstPick = pick;
    } else {
      // Someone already picked — reload to read their claim.
      const { data: m2 } = await supabase
        .from("matches")
        .select("coin_pick_by, coin_pick")
        .eq("id", match_id)
        .single();
      firstPickBy = m2?.coin_pick_by ?? match.player1_id;
      firstPick = m2?.coin_pick ?? true;
    }

    // This player's EFFECTIVE side (opposite of the claimer if they weren't first).
    const myPick = firstPickBy === player_id ? firstPick : !firstPick;

    // Derive who goes first: the side matching the coin result wins.
    const otherOfFirst =
      firstPickBy === match.player1_id ? match.player2_id : match.player1_id;
    const winnerPlayer = firstPick === coinResult ? firstPickBy : otherOfFirst;
    const firstTurn = winnerPlayer === match.player1_id ? "player1" : "player2";

    // The claimer commits the authoritative turn order + state once.
    if (claimed) {
      const newState = {
        ...match.state,
        activeParticipant: firstTurn === "player1" ? "PLAYER" : "AI",
      };
      await supabase
        .from("matches")
        .update({ first_turn: firstTurn, state: newState })
        .eq("id", match_id);
    }

    return new Response(
      JSON.stringify({
        my_pick: myPick,
        coin_result: coinResult,
        first_turn: firstTurn,
        locked_by_you: firstPickBy === player_id,
      }),
      { status: 200, headers: corsHeaders },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
