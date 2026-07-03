// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface CancelPayload {
  match_id: string;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { match_id } = (await req.json()) as CancelPayload;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // If a match is cancelled during the pending phase, we should clean up
    // the matches table and reset the queue entries (or delete them).
    // Let's delete the match so it's clean.
    await supabase
      .from("matches")
      .delete()
      .eq("id", match_id);

    // For the queue entries, we could put them back to "waiting" or just delete them
    // so they have to rejoin. Deleting them is safer to avoid stale state.
    const { data: queueEntries } = await supabase
      .from("queue")
      .select("id, player_id")
      .eq("match_id", match_id);

    if (queueEntries) {
      await supabase
        .from("queue")
        .delete()
        .eq("match_id", match_id);

      // Notify both players that the match was cancelled
      for (const entry of queueEntries) {
        await supabase.channel(`queue:${entry.player_id}`).send({
          type: "broadcast",
          event: "match_cancelled",
          payload: { match_id },
        });
      }
    }

    return new Response(JSON.stringify({ status: "cancelled" }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
