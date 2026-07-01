-- Helper RPC functions for the multiplayer system.
-- Run this in your Supabase SQL Editor.

-- Deduct balance (for bet escrow).
CREATE OR REPLACE FUNCTION deduct_balance(p_id UUID, amount INT)
RETURNS VOID AS $$
BEGIN
  UPDATE players SET balance = balance - amount WHERE id = p_id AND balance >= amount;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add balance (for winnings payout).
CREATE OR REPLACE FUNCTION add_balance(p_id UUID, amount INT)
RETURNS VOID AS $$
BEGIN
  UPDATE players SET balance = balance + amount WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Increment wins.
CREATE OR REPLACE FUNCTION increment_wins(p_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE players SET wins = wins + 1 WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Increment losses.
CREATE OR REPLACE FUNCTION increment_losses(p_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE players SET losses = losses + 1 WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
