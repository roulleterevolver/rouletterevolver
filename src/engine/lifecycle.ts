// Match and Round_Set lifecycle for the Revolver Roulette rules engine.
//
// All functions here are PURE: they operate on the immutable `GameState` and
// related types, produce new objects rather than mutating, and draw randomness
// only from the injected `RNG`. They never call `Math.random` directly.

import type {
  GameConfig,
  GameEvent,
  GameState,
  ItemType,
  Participant,
  ParticipantId,
  EngineResult,
} from "./types";
import type { RNG } from "../rng/rng";
import { loadCylinder, remainingCounts } from "./cylinder";

/**
 * The six Item types a Participant may be granted. Kept as a single source of
 * truth so item granting always draws from the full, valid set.
 */
export const ALL_ITEM_TYPES: ReadonlyArray<ItemType> = [
  "MAGNIFYING_GLASS",
  "SPEED_LOADER",
  "MEDKIT",
  "HANDCUFFS",
  "INVERTER",
  "HOLLOW_POINT",
];

/**
 * A sensible default configuration, consistent with the requirements' ranges:
 * startingHp 2..6, minRounds >= 2, maxRounds <= 6, itemsPerRoundSet 0..4,
 * maxItems 8 (one per on-table zone), maxSpinsPerTurn 1..3.
 */
export const DEFAULT_CONFIG: GameConfig = {
  startingHp: 5,
  minRounds: 2,
  maxRounds: 6,
  itemsPerRoundSet: 2,
  maxItems: 8,
  maxSpinsPerTurn: 1,
};

/**
 * Choose a random valid Cylinder composition for a new Round_Set: a total in
 * `[config.minRounds, config.maxRounds]`, then a Live count in `[1, total - 1]`
 * (guaranteeing at least 1 Live and 1 Blank), with the Blank count as the
 * remainder (Requirements 1.1, 1.3). Pure: randomness only via `rng`.
 */
export function chooseComposition(
  config: GameConfig,
  rng: RNG,
): { live: number; blank: number } {
  const span = config.maxRounds - config.minRounds + 1;
  const total = config.minRounds + rng.nextInt(span);
  const live = 1 + rng.nextInt(total - 1);
  const blank = total - live;
  return { live, blank };
}

/**
 * Grant `count` randomly chosen Items (from the six valid types) on top of an
 * existing inventory, then cap the resulting inventory at `maxItems`, discarding
 * any Items beyond the cap (Requirement 5.1). Returns a new array; the input is
 * untouched. Pure: randomness only via `rng`.
 */
export function grantItems(
  existing: ReadonlyArray<ItemType>,
  count: number,
  maxItems: number,
  rng: RNG,
): ItemType[] {
  const items: ItemType[] = existing.slice();
  for (let i = 0; i < count; i++) {
    const idx = rng.nextInt(ALL_ITEM_TYPES.length);
    items.push(ALL_ITEM_TYPES[idx]!);
  }
  // Cap at the maximum, discarding overflow.
  if (items.length > maxItems) {
    items.length = maxItems;
  }
  return items;
}

function makeParticipant(
  id: ParticipantId,
  config: GameConfig,
  rng: RNG,
): Participant {
  // Round 1 (start of match) grants 0 items according to Buckshot Roulette rules.
  return {
    id,
    hp: config.startingHp,
    items: grantItems([], 0, config.maxItems, rng),
    damageMultiplier: 1,
    revealedCurrentChamber: null,
  };
}

/**
 * Initialize a new Match (Requirements 2.1, 5.1, 7.1, 7.2): set both
 * Participants to the starting HP with a fresh granted Item set, load the first
 * Round_Set, assign the first Turn to the Player, and emit `ROUND_SET_LOADED`.
 */
export function createMatch(config: GameConfig, rng: RNG): EngineResult {
  const player = makeParticipant("PLAYER", config, rng);
  const ai = makeParticipant("AI", config, rng);

  const { live, blank } = chooseComposition(config, rng);
  const cylinder = loadCylinder(live, blank, rng);
  const counts = remainingCounts(cylinder);

  const state: GameState = {
    config,
    phase: "PLAYER_TURN",
    cylinder,
    participants: {
      PLAYER: player,
      AI: ai,
    },
    activeParticipant: "PLAYER",
    spinsUsedThisTurn: 0,
    skipNextTurnOf: null,
    winner: null,
    roundSetIndex: 0,
  };

  const events: GameEvent[] = [
    {
      type: "ROUND_SET_LOADED",
      live: counts.live,
      blank: counts.blank,
      total: cylinder.size,
      roundNumber: 1,
    },
  ];

  return { state, events };
}

/**
 * Reload the Cylinder as a new Round_Set (Requirements 1.7, 5.5, 7.3): pick a
 * fresh random valid composition, retain both Participants' current HP, grant a
 * fresh set of Items (appended then capped at `maxItems`), increment
 * `roundSetIndex`, reset `spinsUsedThisTurn`, and declare no winner. The active
 * Participant is preserved. Emits `ROUND_SET_LOADED`.
 */
export function loadRoundSet(state: GameState, rng: RNG): EngineResult {
  const { config } = state;

  const { live, blank } = chooseComposition(config, rng);
  const cylinder = loadCylinder(live, blank, rng);
  const counts = remainingCounts(cylinder);

  const prevPlayer = state.participants.PLAYER;
  const prevAi = state.participants.AI;

  // Buckshot Roulette item logic:
  // Round 2 (roundSetIndex 0 ending) -> 2 items
  // Round 3+ (roundSetIndex 1+ ending) -> 4 items
  let grantCount = 4;
  if (state.roundSetIndex === 0) grantCount = 2;

  const player: Participant = {
    ...prevPlayer,
    items: grantItems(prevPlayer.items, grantCount, config.maxItems, rng),
  };
  const ai: Participant = {
    ...prevAi,
    items: grantItems(prevAi.items, grantCount, config.maxItems, rng),
  };

  const newState: GameState = {
    ...state,
    cylinder,
    participants: {
      PLAYER: player,
      AI: ai,
    },
    spinsUsedThisTurn: 0,
    winner: null,
    roundSetIndex: state.roundSetIndex + 1,
  };

  const events: GameEvent[] = [
    {
      type: "ROUND_SET_LOADED",
      live: counts.live,
      blank: counts.blank,
      total: cylinder.size,
      roundNumber: state.roundSetIndex + 2,
    },
  ];

  return { state: newState, events };
}

/**
 * The Match is over when either Participant has been reduced to zero HP or a
 * winner has already been declared (Requirement 2.5).
 */
export function isMatchOver(state: GameState): boolean {
  if (state.winner !== null) return true;
  return state.participants.PLAYER.hp <= 0 || state.participants.AI.hp <= 0;
}

/**
 * The winning Participant: the one still standing when the other has reached
 * zero HP, otherwise an already-declared `winner`, otherwise `null` while the
 * Match is in progress (Requirements 2.5, 7.4).
 */
export function winnerOf(state: GameState): ParticipantId | null {
  const playerDead = state.participants.PLAYER.hp <= 0;
  const aiDead = state.participants.AI.hp <= 0;
  if (aiDead && !playerDead) return "PLAYER";
  if (playerDead && !aiDead) return "AI";
  return state.winner;
}
