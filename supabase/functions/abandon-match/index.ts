// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.6";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { match_id, player_id } = await req.json();
    if (!match_id || !player_id) throw new Error("Missing match_id or player_id");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // Fetch the match to verify the player is in it
    const { data: match, error } = await supabase
      .from("matches")
      .select("*")
      .eq("id", match_id)
      .single();

    if (error || !match) throw new Error("Match not found");
    if (match.status !== "active") return new Response("Match not active", { headers: corsHeaders });
    if (match.player1_id !== player_id && match.player2_id !== player_id) {
      throw new Error("Player not in this match");
    }

    // Determine the remaining player (the winner)
    const winnerPlayerId = match.player1_id === player_id ? match.player2_id : match.player1_id;
    // Determine winner enum based on which seat the winner occupies
    const winnerParticipant = match.player1_id === winnerPlayerId ? "PLAYER" : "AI";

    // Update match status to finished and set the winner
    const newState = {
      ...match.state,
      winner: winnerParticipant,
    };

    const { error: updateError } = await supabase
      .from("matches")
      .update({
        status: "finished",
        state: newState,
      })
      .eq("id", match_id);

    if (updateError) throw updateError;

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
