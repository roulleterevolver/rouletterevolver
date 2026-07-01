// Supabase configuration for multiplayer.
// The anon key is safe to expose client-side — it only grants access through RLS policies.

export const SUPABASE_URL = "https://xipxipoxatouxnipglxu.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhpcHhpcG94YXRvdXhuaXBnbHh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NzY0NzcsImV4cCI6MjA5ODQ1MjQ3N30.U9mWm_YWz0qVY3NEUDVGfyrhkMIYR5-p-9DThjaiPj8";

/**
 * When true, the client signs in with Supabase ANONYMOUS AUTH and uses the
 * resulting auth.uid() as its player_id. This is REQUIRED before enabling the
 * RLS policies in supabase/rls.sql (they key off auth.uid()).
 *
 * Leave false for open testing (random sessionStorage IDs, RLS disabled). To
 * turn on: enable the Anonymous provider in the Supabase dashboard, run
 * supabase/rls.sql, then set this to true.
 */
export const USE_SUPABASE_AUTH = false;

