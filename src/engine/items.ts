// Item use resolution for the Revolver Roulette rules engine.
//
// All functions here are PURE: they operate on the immutable `GameState` and
// related types, produce new objects rather than mutating, and draw randomness
// only from the injected `RNG` (needed because Speed_Loader reloads the
// Cylinder as a new Round_Set). They never call `Math.random` directly.
//
// Cylinder representation (consistent with cylinder.ts / shot.ts):
//   - `chambers` is a fixed-length array; a `null` entry is a fired/emptied
//     Chamber. `currentIndex` points at the Current Chamber (the next Round to
//     fire). A loaded Current Chamber requires `currentIndex` to be in
//     `[0, chambers.length)` AND `chambers[currentIndex]` to be non-null.

import type {
  Chamber,
  Cylinder,
  EngineResult,
  GameEvent,
  GameState,
  ItemType,
  Participant,
  ParticipantId,
  RoundType,
} from "./types";
import type { RNG } from "../rng/rng";

/** The other Participant in the Match. */
function opponentOf(id: ParticipantId): ParticipantId {
  return id === "PLAYER" ? "AI" : "PLAYER";
}

/**
 * The Round currently at the Current Chamber, or `null` if no Round is loaded
 * there. The Current Chamber is loaded only when `currentIndex` is within
 * bounds and the chamber at that index is non-null.
 */
function currentChamber(cylinder: Cylinder): Chamber {
  if (cylinder.currentIndex < 0 || cylinder.currentIndex >= cylinder.chambers.length) {
    return null;
  }
  return cylinder.chambers[cylinder.currentIndex] ?? null;
}

/** The opposite classification of a Round (used by the Inverter). */
function flipRound(round: RoundType): RoundType {
  return round === "LIVE" ? "BLANK" : "LIVE";
}

/**
 * Return a copy of `items` with exactly one instance of `item` removed. The
 * caller has already confirmed the item is present (Requirement 5.3). The
 * input array is untouched.
 */
function removeOneItem(
  items: ReadonlyArray<ItemType>,
  item: ItemType,
): ItemType[] {
  const copy = items.slice();
  const idx = copy.indexOf(item);
  if (idx >= 0) copy.splice(idx, 1);
  return copy;
}

/**
 * Apply an Item used by the active Participant (the user), per Requirement 5.
 *
 * Behavior summary:
 *   - If the user does not hold `item`: reject with `ITEM_NOT_HELD`, leaving the
 *     `GameState` unchanged with no events (Requirement 5.13).
 *   - Otherwise: remove exactly one instance of `item` from the user's
 *     inventory (Requirement 5.3), retain the Turn with the active Participant
 *     (Requirement 5.12), emit `ITEM_USED`, and apply the item's effect:
 *       - MAGNIFYING_GLASS: reveal the loaded Current Chamber's classification
 *         to the user only (Requirement 5.4). No-op reveal if unloaded.
 *       - SPEED_LOADER: reload the Cylinder as a new Round_Set after removing
 *         the item; appends its `ROUND_SET_LOADED` event (Requirement 5.5).
 *       - MEDKIT: heal the user to `min(hp + 1, startingHp)`, emitting
 *         `HP_CHANGED` (Requirement 5.6).
 *       - HANDCUFFS: set `skipNextTurnOf` to the opponent so their next Turn is
 *         skipped (Requirement 5.7); the skip is consumed in the turn logic.
 *       - INVERTER: flip the loaded Current Chamber Live<->Blank in a new
 *         Cylinder (Requirement 5.8). No-op flip if unloaded.
 *       - HOLLOW_POINT: set the user's Damage_Multiplier to 2 (Requirement 5.9).
 *
 * Pure: randomness only via `rng` (Speed_Loader). Returns an `EngineResult`.
 */
export function applyItem(
  state: GameState,
  item: ItemType,
  _rng: RNG,
): EngineResult {
  const userId = state.activeParticipant;
  const user = state.participants[userId];

  // Requirement 5.13: an Item not in the user's inventory is a state-preserving
  // no-op with no events.
  if (!user.items.includes(item)) {
    return { state, events: [], rejected: "ITEM_NOT_HELD" };
  }

  // Requirement 5.3: remove exactly one instance of the used Item from the
  // user's inventory. The Turn is always retained (Requirement 5.12): the
  // active Participant never changes here.
  const userAfterRemoval: Participant = {
    ...user,
    items: removeOneItem(user.items, item),
  };

  const baseState: GameState = {
    ...state,
    participants: {
      ...state.participants,
      [userId]: userAfterRemoval,
    },
  };

  const events: GameEvent[] = [{ type: "ITEM_USED", by: userId, item }];

  switch (item) {
    case "MAGNIFYING_GLASS": {
      // Requirement 5.4: reveal the Current Chamber's classification to the
      // user only. If no Round is loaded, the item is still consumed but
      // nothing is revealed.
      const round = currentChamber(state.cylinder);
      if (round === null) {
        return { state: baseState, events };
      }
      const revealedState: GameState = {
        ...baseState,
        participants: {
          ...baseState.participants,
          [userId]: { ...userAfterRemoval, revealedCurrentChamber: round },
        },
      };
      return { state: revealedState, events };
    }

    case "SPEED_LOADER": {
      // Eject the current round from the cylinder (like Beer in Buckshot).
      // The round is discarded (shown to the user via the event) and the
      // cylinder advances to the next loaded chamber. If no round is loaded,
      // the item is consumed but nothing happens.
      const round = currentChamber(state.cylinder);
      if (round === null) {
        return { state: baseState, events };
      }
      // Empty the current chamber and advance.
      const chambers: Chamber[] = state.cylinder.chambers.slice();
      chambers[state.cylinder.currentIndex] = null;
      let next = state.cylinder.currentIndex + 1;
      while (next < chambers.length && chambers[next] === null) next++;
      const ejectedCylinder: Cylinder = {
        chambers,
        currentIndex: next,
        size: state.cylinder.size,
      };
      const ejectedState: GameState = {
        ...baseState,
        cylinder: ejectedCylinder,
        // Clear revealed knowledge since the chamber changed.
        participants: {
          ...baseState.participants,
          [userId]: { ...userAfterRemoval, revealedCurrentChamber: null },
        },
      };
      // Emit the ejected round type so the renderer/audio can show it.
      events.push({
        type: "ROUND_SET_LOADED",
        live: round === "LIVE" ? 1 : 0,
        blank: round === "BLANK" ? 1 : 0,
        total: 1,
        roundNumber: 0,
      });
      return { state: ejectedState, events };
    }

    case "MEDKIT": {
      // Requirement 5.6: heal up to the configured starting value.
      const newHp = Math.min(user.hp + 1, state.config.startingHp);
      const healedState: GameState = {
        ...baseState,
        participants: {
          ...baseState.participants,
          [userId]: { ...userAfterRemoval, hp: newHp },
        },
      };
      events.push({ type: "HP_CHANGED", participant: userId, hp: newHp });
      return { state: healedState, events };
    }

    case "HANDCUFFS": {
      // Requirement 5.7: cause the opponent's next Turn to be skipped. The
      // actual skip is consumed by the turn-transition logic in shot.ts.
      const cuffedState: GameState = {
        ...baseState,
        skipNextTurnOf: opponentOf(userId),
      };
      return { state: cuffedState, events };
    }

    case "INVERTER": {
      // Requirement 5.8: flip the Current Chamber's Round, immutably.
      const round = currentChamber(state.cylinder);
      if (round === null) {
        return { state: baseState, events };
      }
      const chambers: Chamber[] = state.cylinder.chambers.slice();
      chambers[state.cylinder.currentIndex] = flipRound(round);
      const flippedState: GameState = {
        ...baseState,
        cylinder: { ...state.cylinder, chambers },
      };
      return { state: flippedState, events };
    }

    case "HOLLOW_POINT": {
      // Requirement 5.9: set the user's Damage_Multiplier to 2.
      const buffedState: GameState = {
        ...baseState,
        participants: {
          ...baseState.participants,
          [userId]: { ...userAfterRemoval, damageMultiplier: 2 },
        },
      };
      return { state: buffedState, events };
    }
  }
}
