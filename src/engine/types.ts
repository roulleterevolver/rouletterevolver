// Core data models and types for the Revolver Roulette rules engine.
//
// These types are PURE data: they import nothing from PixiJS, Howler, or the
// DOM. All game state is modeled as immutable structures; transitions produce
// new objects rather than mutating in place. This keeps the engine
// deterministic and exhaustively testable.

// ---------------------------------------------------------------------------
// Rounds and the Cylinder
// ---------------------------------------------------------------------------

/** Classification of a single cartridge. */
export type RoundType = "LIVE" | "BLANK";

/**
 * A single chamber in the Cylinder. Holds one Round, or `null` once it has
 * been fired/emptied.
 */
export type Chamber = RoundType | null;

/**
 * The revolver's cylinder. `chambers` is a fixed-length array for the current
 * Round_Set; `currentIndex` points at the Current Chamber (the next Round to
 * fire). The order of rounds is hidden information (Requirement 1.6).
 */
export interface Cylinder {
  readonly chambers: ReadonlyArray<Chamber>;
  /** Index of the Current Chamber (next Round to fire). */
  readonly currentIndex: number;
  /** Number of chambers loaded when this Round_Set began (2..6). */
  readonly size: number;
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

/** Identifies one of the two participants in a Match. */
export type ParticipantId = "PLAYER" | "AI";

/** All Item types available in the prototype. */
export type ItemType =
  | "MAGNIFYING_GLASS" // Reveal the Current Chamber to the using Participant only.
  | "SPEED_LOADER" // Reload the Cylinder as a new Round_Set.
  | "MEDKIT" // Restore 1 HP up to the starting value.
  | "HANDCUFFS" // Skip the opponent's next Turn.
  | "INVERTER" // Flip the Current Chamber's Round (Live <-> Blank).
  | "HOLLOW_POINT"; // Double damage on the next Live Round fired.

/** The damage factor applied to the next Live Round fired by a Participant. */
export type DamageMultiplier = 1 | 2;

/** A single participant's state. */
export interface Participant {
  readonly id: ParticipantId;
  /** Current hit points, in the range [0, startingHp]. */
  readonly hp: number;
  /** Held Items; length is capped at GameConfig.maxItems. */
  readonly items: ReadonlyArray<ItemType>;
  /** Multiplier applied to the next Live Round this Participant fires. */
  readonly damageMultiplier: DamageMultiplier;
  /**
   * Classification of the Current Chamber as privately revealed to THIS
   * Participant (via Magnifying_Glass), valid until the next Shot or Spin.
   * `null` when this Participant has no current revealed knowledge. This is
   * never exposed to the opponent's PlayerView.
   */
  readonly revealedCurrentChamber: RoundType | null;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Tunable parameters for a Match. All bounds come from the requirements. */
export interface GameConfig {
  /** Starting HP for both Participants (2..6). */
  readonly startingHp: number;
  /** Minimum number of Rounds loaded per Round_Set (>= 2). */
  readonly minRounds: number;
  /** Maximum number of Rounds loaded per Round_Set (<= 6). */
  readonly maxRounds: number;
  /** Number of Items granted to each Participant per Round_Set (0..4). */
  readonly itemsPerRoundSet: number;
  /** Maximum Items a Participant may hold (4). */
  readonly maxItems: number;
  /** Maximum Spin Actions allowed per Turn (1..3). */
  readonly maxSpinsPerTurn: number;
}

// ---------------------------------------------------------------------------
// Game state machine
// ---------------------------------------------------------------------------

/** The high-level phase of the game, driven by the Game_Controller. */
export type Phase =
  | "MATCH_INTRO"
  | "PLAYER_TURN"
  | "AI_THINKING"
  | "RESOLVING"
  | "ROUND_SET_RELOAD"
  | "MATCH_OVER";

/** The complete, immutable game state. */
export interface GameState {
  readonly config: GameConfig;
  readonly phase: Phase;
  readonly cylinder: Cylinder;
  readonly participants: Readonly<Record<ParticipantId, Participant>>;
  /** The Participant whose Turn is currently in progress. */
  readonly activeParticipant: ParticipantId;
  /** Spin Actions taken so far during the current Turn. */
  readonly spinsUsedThisTurn: number;
  /** If set, this Participant's next Turn will be skipped (Handcuffs). */
  readonly skipNextTurnOf: ParticipantId | null;
  /** The winning Participant, or `null` while the Match is in progress. */
  readonly winner: ParticipantId | null;
  /** Index of the current Round_Set within the Match (diagnostics/tension). */
  readonly roundSetIndex: number;
}

// ---------------------------------------------------------------------------
// Actions (inputs to the engine)
// ---------------------------------------------------------------------------

/**
 * A player- or AI-issued action. Actions are plain data so they can be
 * produced by either input source, logged, and replayed deterministically.
 */
export type Action =
  | { readonly kind: "SHOOT"; readonly target: ParticipantId }
  | { readonly kind: "SPIN" }
  | { readonly kind: "USE_ITEM"; readonly item: ItemType }
  | { readonly kind: "START_NEW_MATCH" };

// ---------------------------------------------------------------------------
// Events (engine -> presentation)
// ---------------------------------------------------------------------------

/**
 * Declarative descriptions of what just happened, consumed by the Renderer and
 * Audio_System so they need no knowledge of the rules.
 */
export type GameEvent =
  | { readonly type: "ROUND_SET_LOADED"; readonly live: number; readonly blank: number; readonly total: number; readonly roundNumber: number }
  | { readonly type: "SPUN" }
  | { readonly type: "SHOT_STARTED"; readonly target: ParticipantId }
  | { readonly type: "LIVE_FIRED"; readonly target: ParticipantId; readonly damage: number }
  | { readonly type: "BLANK_FIRED"; readonly target: ParticipantId }
  | { readonly type: "ITEM_USED"; readonly by: ParticipantId; readonly item: ItemType }
  | { readonly type: "TURN_PASSED"; readonly to: ParticipantId }
  | { readonly type: "TURN_SKIPPED"; readonly participant: ParticipantId }
  | { readonly type: "HP_CHANGED"; readonly participant: ParticipantId; readonly hp: number }
  | { readonly type: "MATCH_OVER"; readonly winner: ParticipantId };

// ---------------------------------------------------------------------------
// Engine results
// ---------------------------------------------------------------------------

/** Why an action was rejected by the engine (state-preserving no-op). */
export type RejectionReason =
  | "NOT_YOUR_TURN"
  | "EMPTY_CYLINDER"
  | "SPIN_NOT_ALLOWED"
  | "ITEM_NOT_HELD"
  | "NO_LOADED_ROUND"
  | "MATCH_OVER"
  | "INVALID_ACTION";

/**
 * The result of a transition. `events` is an ordered list of side-effect
 * descriptions; `rejected` is present only when the action was illegal, in
 * which case `state` is returned unchanged.
 */
export interface EngineResult {
  readonly state: GameState;
  readonly events: ReadonlyArray<GameEvent>;
  readonly rejected?: RejectionReason;
}

// ---------------------------------------------------------------------------
// PlayerView (projection for the AI and UI)
// ---------------------------------------------------------------------------

/**
 * The public projection of game state for a single Participant. It exposes
 * only visible information (Requirements 1.4-1.6) and never the hidden order
 * of Rounds in the Cylinder.
 */
export interface PlayerView {
  readonly phase: Phase;
  readonly self: ParticipantId;
  readonly selfHp: number;
  readonly opponentHp: number;
  readonly selfItems: ReadonlyArray<ItemType>;
  readonly opponentItems: ReadonlyArray<ItemType>;
  /** Visible count of remaining Live Rounds. */
  readonly liveRemaining: number;
  /** Visible count of remaining Blank Rounds. */
  readonly blankRemaining: number;
  /** Total remaining Rounds in the Cylinder. */
  readonly roundsRemaining: number;
  readonly spinsUsedThisTurn: number;
  readonly maxSpinsPerTurn: number;
  /**
   * The Current Chamber's classification, present only when THIS Participant
   * revealed it (Magnifying_Glass) and no Shot or Spin has occurred since.
   */
  readonly knownCurrentChamber: RoundType | null;
}
