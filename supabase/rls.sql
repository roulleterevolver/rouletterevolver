-- Revolver Roulette — Row-Level Security policies (PREPARED, run when ready)
-- ===========================================================================
-- These policies are designed for the ACTUAL runtime model of the game:
--
--   * ALL writes go through Edge Functions (join-queue, submit-action,
--     coin-pick) using the SERVICE ROLE key, which BYPASSES RLS. Clients never
--     write to these tables directly.
--   * Clients only ever READ (poll) their own rows: their queue entry and the
--     match they're a participant in.
--
-- Therefore the client-facing policies below are SELECT-only. This keeps the
-- surface tiny and safe: a player can read their own queue row and their own
-- match, and nothing else. All mutations remain server-authoritative.
--
-- REQUIREMENT — anonymous auth:
-- These policies use auth.uid(), so each client must have a Supabase auth
-- session and player IDs must equal auth.uid(). The game currently uses random
-- sessionStorage IDs. To switch:
--   1. Supabase Dashboard → Authentication → Providers → enable "Anonymous".
--   2. In src/multiplayer/config.ts set  USE_SUPABASE_AUTH = true
--      (the client then calls signInAnonymously() and uses auth.uid() as the
--       player_id — already wired in client.ts).
--   3. Run THIS file in the SQL Editor.
--
-- To roll back to the current open (testing) mode, run the DISABLE block at the
-- bottom instead.
-- ===========================================================================

-- --- Enable RLS ------------------------------------------------------------
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue   ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;

-- --- Clean slate (drop any earlier policies so this file is idempotent) -----
DROP POLICY IF EXISTS "Players read own"          ON players;
DROP POLICY IF EXISTS "Players insert own"        ON players;
DROP POLICY IF EXISTS "Players update own"        ON players;
DROP POLICY IF EXISTS "Queue read own"            ON queue;
DROP POLICY IF EXISTS "Queue insert own"          ON queue;
DROP POLICY IF EXISTS "Queue update own"          ON queue;
DROP POLICY IF EXISTS "Match read participants"   ON matches;
DROP POLICY IF EXISTS "players_select_own"        ON players;
DROP POLICY IF EXISTS "queue_select_own"          ON queue;
DROP POLICY IF EXISTS "matches_select_participant" ON matches;

-- --- players: a player may read their OWN profile --------------------------
-- (Balance / wins / losses. Written only by Edge Functions via service role.)
CREATE POLICY "players_select_own" ON players
  FOR SELECT USING (auth.uid() = id);

-- --- queue: a player may read their OWN queue entry ------------------------
-- (Used to detect status flipping to 'matched'. Inserts/updates are done by
--  join-queue with the service role.)
CREATE POLICY "queue_select_own" ON queue
  FOR SELECT USING (auth.uid() = player_id);

-- --- matches: only the two participants may read the match -----------------
-- (State polling, coin lock, turn deadline. All updates are server-side.)
CREATE POLICY "matches_select_participant" ON matches
  FOR SELECT USING (auth.uid() = player1_id OR auth.uid() = player2_id);

-- NOTE: No INSERT/UPDATE/DELETE policies are defined for clients on purpose —
-- the anon role has no write path, so every mutation must go through the
-- service-role Edge Functions. This is the intended security boundary.

-- ===========================================================================
-- DISABLE BLOCK — run this instead to return to open testing mode:
-- ---------------------------------------------------------------------------
-- ALTER TABLE players DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE queue   DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE matches DISABLE ROW LEVEL SECURITY;
-- ===========================================================================
