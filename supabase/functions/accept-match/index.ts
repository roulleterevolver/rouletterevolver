// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface AcceptPayload {
  match_id: string;
  player_id: string;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { match_id, player_id } = (await req.json()) as AcceptPayload;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: match, error: mErr } = await supabase
      .from("matches")
      .select("player1_id, player2_id, state")
      .eq("id", match_id)
      .single();

    if (mErr || !match) {
      return new Response(JSON.stringify({ error: "Match not found" }), { status: 404, headers: corsHeaders });
    }

    const state = match.state as any;
    
    if (match.player1_id === player_id) {
      state.player1_accepted = true;
    } else if (match.player2_id === player_id) {
      state.player2_accepted = true;
    } else {
      return new Response(JSON.stringify({ error: "Player not in match" }), { status: 403, headers: corsHeaders });
    }

    await supabase
      .from("matches")
      .update({ state })
      .eq("id", match_id);

    if (state.player1_accepted && state.player2_accepted) {
      // Broadcast to both players that the match is fully accepted!
      const payload = { match_id };

      const sendBroadcast = async (channelId: string, payload: any) => {
        const channel = supabase.channel(channelId);
        return new Promise<void>((resolve) => {
          channel.subscribe(async (status) => {
            if (status === "SUBSCRIBED") {
              await channel.send({
                type: "broadcast",
                event: "matched",
                payload,
              });
              supabase.removeChannel(channel);
              resolve();
            }
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              resolve(); // ignore errors to not block flow
            }
          });
        });
      };

      await Promise.all([
        sendBroadcast(`queue:${match.player1_id}`, payload),
        sendBroadcast(`queue:${match.player2_id}`, payload)
      ]);

      return new Response(JSON.stringify({ status: "matched" }), { status: 200, headers: corsHeaders });
    }

    // Still waiting for the other player
    return new Response(JSON.stringify({ status: "waiting" }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
