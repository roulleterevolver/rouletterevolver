-- Revolver Roulette — Supabase multiplayer schema
-- Run this in your Supabase SQL Editor to create all needed tables.

-- Players (linked to auth.users via id)
CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT 'ANONYMOUS',
  balance BIGINT NOT NULL DEFAULT 10000, -- starting balance
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Matchmaking queue
CREATE TABLE IF NOT EXISTS queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  bet_amount INT NOT NULL CHECK (bet_amount IN (100, 1000, 10000)),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'matched', 'cancelled')),
  match_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Active + finished matches
CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player1_id UUID NOT NULL REFERENCES players(id),
  player2_id UUID NOT NULL REFERENCES players(id),
  bet_amount INT NOT NULL,
  -- The full GameState as JSON (authoritative server state).
  state JSONB NOT NULL DEFAULT '{}',
  -- Who goes first (result of coin flip): 'player1' or 'player2'.
  first_turn TEXT NOT NULL DEFAULT 'player1' CHECK (first_turn IN ('player1', 'player2')),
  -- Active player's turn deadline (UTC). NULL when match is over.
  turn_deadline TIMESTAMPTZ,
  -- 30 seconds per turn.
  turn_timeout_sec INT NOT NULL DEFAULT 30,
  winner_id UUID REFERENCES players(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished', 'abandoned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- Index for fast matchmaking lookups.
CREATE INDEX IF NOT EXISTS idx_queue_waiting ON queue (bet_amount, status) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_matches_active ON matches (status) WHERE status = 'active';

-- Enable Realtime on the tables players need to subscribe to.
ALTER PUBLICATION supabase_realtime ADD TABLE queue;
ALTER PUBLICATION supabase_realtime ADD TABLE matches;

-- Row-Level Security (RLS) — players can only see/modify their own data.
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;

-- Players: read own, insert own on signup.
CREATE POLICY "Players read own" ON players FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Players insert own" ON players FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Players update own" ON players FOR UPDATE USING (auth.uid() = id);

-- Queue: read own, insert own, update own (cancel).
CREATE POLICY "Queue read own" ON queue FOR SELECT USING (auth.uid() = player_id);
CREATE POLICY "Queue insert own" ON queue FOR INSERT WITH CHECK (auth.uid() = player_id);
CREATE POLICY "Queue update own" ON queue FOR UPDATE USING (auth.uid() = player_id);

-- Matches: both players can read their match.
CREATE POLICY "Match read participants" ON matches FOR SELECT
  USING (auth.uid() = player1_id OR auth.uid() = player2_id);
