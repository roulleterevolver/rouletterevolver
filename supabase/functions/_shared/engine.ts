// Bundled game engine for Supabase Edge Functions.
// This is a self-contained module with all pure game logic — no browser deps.
// Generated from: src/engine/*.ts + src/rng/rng.ts

// ============================================================================
// RNG
// ============================================================================

export interface RNG {
  next(): number;
  nextInt(n: number): number;
}

export class SeededRng implements RNG {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  nextInt(n: number): number {
    return Math.floor(this.next() * n);
  }
}

export class SystemRng implements RNG {
  next(): number { return Math.random(); }
  nextInt(n: number): number { return Math.floor(Math.random() * n); }
}

// ============================================================================
// Types
// ============================================================================

export type RoundType = "LIVE" | "BLANK";
export type Chamber = RoundType | null;
export interface Cylinder { readonly chambers: ReadonlyArray<Chamber>; readonly currentIndex: number; readonly size: number; }
export type ParticipantId = "PLAYER" | "AI";
export type ItemType = "MAGNIFYING_GLASS" | "SPEED_LOADER" | "MEDKIT" | "HANDCUFFS" | "INVERTER" | "HOLLOW_POINT";
export type DamageMultiplier = 1 | 2;
export interface Participant { readonly id: ParticipantId; readonly hp: number; readonly items: ReadonlyArray<ItemType>; readonly damageMultiplier: DamageMultiplier; readonly revealedCurrentChamber: RoundType | null; }
export interface GameConfig { readonly startingHp: number; readonly minRounds: number; readonly maxRounds: number; readonly itemsPerRoundSet: number; readonly maxItems: number; readonly maxSpinsPerTurn: number; }
export type Phase = "MATCH_INTRO" | "PLAYER_TURN" | "AI_THINKING" | "RESOLVING" | "ROUND_SET_RELOAD" | "MATCH_OVER";
export interface GameState { readonly config: GameConfig; readonly phase: Phase; readonly cylinder: Cylinder; readonly participants: Readonly<Record<ParticipantId, Participant>>; readonly activeParticipant: ParticipantId; readonly spinsUsedThisTurn: number; readonly skipNextTurnOf: ParticipantId | null; readonly winner: ParticipantId | null; readonly roundSetIndex: number; }
export type Action = { readonly kind: "SHOOT"; readonly target: ParticipantId } | { readonly kind: "SPIN" } | { readonly kind: "USE_ITEM"; readonly item: ItemType } | { readonly kind: "START_NEW_MATCH" };
export type GameEvent = { readonly type: "ROUND_SET_LOADED"; readonly live: number; readonly blank: number; readonly total: number; readonly roundNumber: number } | { readonly type: "SPUN" } | { readonly type: "SHOT_STARTED"; readonly target: ParticipantId } | { readonly type: "LIVE_FIRED"; readonly target: ParticipantId; readonly damage: number } | { readonly type: "BLANK_FIRED"; readonly target: ParticipantId } | { readonly type: "ITEM_USED"; readonly by: ParticipantId; readonly item: ItemType } | { readonly type: "TURN_PASSED"; readonly to: ParticipantId } | { readonly type: "TURN_SKIPPED"; readonly participant: ParticipantId } | { readonly type: "HP_CHANGED"; readonly participant: ParticipantId; readonly hp: number } | { readonly type: "MATCH_OVER"; readonly winner: ParticipantId };
export type RejectionReason = "NOT_YOUR_TURN" | "EMPTY_CYLINDER" | "SPIN_NOT_ALLOWED" | "ITEM_NOT_HELD" | "NO_LOADED_ROUND" | "MATCH_OVER" | "INVALID_ACTION";
export interface EngineResult { readonly state: GameState; readonly events: ReadonlyArray<GameEvent>; readonly rejected?: RejectionReason; }

// ============================================================================
// Cylinder
// ============================================================================

function shuffleInPlace<T>(arr: T[], rng: RNG): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = arr[i]!; arr[i] = arr[j]!; arr[j] = tmp;
  }
  return arr;
}

export function loadCylinder(liveCount: number, blankCount: number, rng: RNG): Cylinder {
  const rounds: RoundType[] = [];
  for (let i = 0; i < liveCount; i++) rounds.push("LIVE");
  for (let i = 0; i < blankCount; i++) rounds.push("BLANK");
  shuffleInPlace(rounds, rng);
  return { chambers: rounds.slice(), currentIndex: 0, size: liveCount + blankCount };
}

export function shuffleRemaining(cylinder: Cylinder, rng: RNG): Cylinder {
  const remaining: RoundType[] = [];
  for (let i = 0; i < cylinder.chambers.length; i++) {
    const r = cylinder.chambers[i]; if (r !== null && r !== undefined) remaining.push(r);
  }
  shuffleInPlace(remaining, rng);
  const chambers: Chamber[] = new Array<Chamber>(cylinder.size).fill(null);
  for (let i = 0; i < remaining.length; i++) chambers[i] = remaining[i]!;
  return { chambers, currentIndex: 0, size: cylinder.size };
}

export function remainingCounts(cylinder: Cylinder): { live: number; blank: number } {
  let live = 0, blank = 0;
  for (let i = cylinder.currentIndex; i < cylinder.chambers.length; i++) {
    const r = cylinder.chambers[i]; if (r === "LIVE") live++; else if (r === "BLANK") blank++;
  }
  return { live, blank };
}

// ============================================================================
// Lifecycle
// ============================================================================

const ALL_ITEM_TYPES: ReadonlyArray<ItemType> = ["MAGNIFYING_GLASS", "SPEED_LOADER", "MEDKIT", "HANDCUFFS", "INVERTER", "HOLLOW_POINT"];

export const DEFAULT_CONFIG: GameConfig = { startingHp: 5, minRounds: 2, maxRounds: 6, itemsPerRoundSet: 2, maxItems: 8, maxSpinsPerTurn: 1 };

function chooseComposition(config: GameConfig, rng: RNG): { live: number; blank: number } {
  const span = config.maxRounds - config.minRounds + 1;
  const total = config.minRounds + rng.nextInt(span);
  const live = 1 + rng.nextInt(total - 1);
  return { live, blank: total - live };
}

function grantItems(existing: ReadonlyArray<ItemType>, count: number, maxItems: number, rng: RNG): ItemType[] {
  const items: ItemType[] = existing.slice();
  for (let i = 0; i < count; i++) items.push(ALL_ITEM_TYPES[rng.nextInt(ALL_ITEM_TYPES.length)]!);
  if (items.length > maxItems) items.length = maxItems;
  return items;
}

export function createMatch(config: GameConfig, rng: RNG): EngineResult {
  const mkP = (id: ParticipantId): Participant => ({ id, hp: config.startingHp, items: [], damageMultiplier: 1, revealedCurrentChamber: null });
  const { live, blank } = chooseComposition(config, rng);
  const cylinder = loadCylinder(live, blank, rng);
  const counts = remainingCounts(cylinder);
  const state: GameState = { config, phase: "PLAYER_TURN", cylinder, participants: { PLAYER: mkP("PLAYER"), AI: mkP("AI") }, activeParticipant: "PLAYER", spinsUsedThisTurn: 0, skipNextTurnOf: null, winner: null, roundSetIndex: 0 };
  return { state, events: [{ type: "ROUND_SET_LOADED", live: counts.live, blank: counts.blank, total: cylinder.size, roundNumber: 1 }] };
}

export function loadRoundSet(state: GameState, rng: RNG): EngineResult {
  const { config } = state;
  const { live, blank } = chooseComposition(config, rng);
  const cylinder = loadCylinder(live, blank, rng);
  const counts = remainingCounts(cylinder);
  const grantCount = state.roundSetIndex === 0 ? 2 : 4;
  const player: Participant = { ...state.participants.PLAYER, items: grantItems(state.participants.PLAYER.items, grantCount, config.maxItems, rng) };
  const ai: Participant = { ...state.participants.AI, items: grantItems(state.participants.AI.items, grantCount, config.maxItems, rng) };
  const newState: GameState = { ...state, cylinder, participants: { PLAYER: player, AI: ai }, spinsUsedThisTurn: 0, winner: null, roundSetIndex: state.roundSetIndex + 1 };
  return { state: newState, events: [{ type: "ROUND_SET_LOADED", live: counts.live, blank: counts.blank, total: cylinder.size, roundNumber: state.roundSetIndex + 2 }] };
}

export function isMatchOver(state: GameState): boolean { return state.winner !== null || state.participants.PLAYER.hp <= 0 || state.participants.AI.hp <= 0; }

// ============================================================================
// Spin
// ============================================================================

function canSpin(state: GameState): boolean {
  const { live, blank } = remainingCounts(state.cylinder);
  return (live + blank) >= 2 && state.spinsUsedThisTurn < state.config.maxSpinsPerTurn;
}

function spin(state: GameState, rng: RNG): EngineResult {
  if (!canSpin(state)) return { state, events: [], rejected: "SPIN_NOT_ALLOWED" };
  const cylinder = shuffleRemaining(state.cylinder, rng);
  const player: Participant = { ...state.participants.PLAYER, revealedCurrentChamber: null };
  const ai: Participant = { ...state.participants.AI, revealedCurrentChamber: null };
  return { state: { ...state, cylinder, participants: { PLAYER: player, AI: ai }, spinsUsedThisTurn: state.spinsUsedThisTurn + 1 }, events: [{ type: "SPUN" }] };
}

// ============================================================================
// Shot
// ============================================================================

function opponentOf(id: ParticipantId): ParticipantId { return id === "PLAYER" ? "AI" : "PLAYER"; }
function currentChamber(cylinder: Cylinder): Chamber { if (cylinder.currentIndex < 0 || cylinder.currentIndex >= cylinder.chambers.length) return null; return cylinder.chambers[cylinder.currentIndex] ?? null; }

function fire(state: GameState, target: ParticipantId, rng: RNG): EngineResult {
  const firerId = state.activeParticipant;
  const round = currentChamber(state.cylinder);
  if (round === null) { const r = loadRoundSet(state, rng); return { ...r, rejected: "EMPTY_CYLINDER" }; }
  const isLive = round === "LIVE";
  const firer = state.participants[firerId];
  const events: GameEvent[] = [{ type: "SHOT_STARTED", target }];
  let player: Participant = { ...state.participants.PLAYER };
  let ai: Participant = { ...state.participants.AI };
  const getP = (id: ParticipantId) => id === "PLAYER" ? player : ai;
  const setP = (id: ParticipantId, p: Participant) => { if (id === "PLAYER") player = p; else ai = p; };
  if (isLive) {
    const tp = getP(target); const damage = Math.min(tp.hp, 1 * firer.damageMultiplier); const newHp = tp.hp - damage;
    setP(target, { ...getP(target), hp: newHp });
    events.push({ type: "LIVE_FIRED", target, damage }, { type: "HP_CHANGED", participant: target, hp: newHp });
    if (firer.damageMultiplier > 1) setP(firerId, { ...getP(firerId), damageMultiplier: 1 });
  } else { events.push({ type: "BLANK_FIRED", target }); }
  player = { ...player, revealedCurrentChamber: null }; ai = { ...ai, revealedCurrentChamber: null };
  const participants: Record<ParticipantId, Participant> = { PLAYER: player, AI: ai };
  const chambers: Chamber[] = state.cylinder.chambers.slice(); chambers[state.cylinder.currentIndex] = null;
  let next = state.cylinder.currentIndex + 1; while (next < chambers.length && chambers[next] === null) next++;
  const firedCylinder: Cylinder = { chambers, currentIndex: next, size: state.cylinder.size };
  const matchOver = participants[target].hp <= 0;
  let phase = state.phase, winner = state.winner, activeParticipant = firerId, spinsUsedThisTurn = state.spinsUsedThisTurn, skipNextTurnOf = state.skipNextTurnOf;
  if (matchOver) { winner = opponentOf(target); phase = "MATCH_OVER"; events.push({ type: "MATCH_OVER", winner }); }
  else { const keepTurn = target === firerId && !isLive; if (!keepTurn) { let na = opponentOf(firerId); if (skipNextTurnOf === na) { skipNextTurnOf = null; events.push({ type: "TURN_SKIPPED", participant: na }); na = firerId; } if (na !== activeParticipant) { activeParticipant = na; spinsUsedThisTurn = 0; events.push({ type: "TURN_PASSED", to: na }); } } }
  const firedState: GameState = { ...state, phase, cylinder: firedCylinder, participants, activeParticipant, spinsUsedThisTurn, skipNextTurnOf, winner };
  if (!matchOver && currentChamber(firedCylinder) === null) { const r = loadRoundSet(firedState, rng); return { state: r.state, events: [...events, ...r.events] }; }
  return { state: firedState, events };
}

// ============================================================================
// Items
// ============================================================================

function flipRound(r: RoundType): RoundType { return r === "LIVE" ? "BLANK" : "LIVE"; }
function removeOneItem(items: ReadonlyArray<ItemType>, item: ItemType): ItemType[] { const c = items.slice(); const i = c.indexOf(item); if (i >= 0) c.splice(i, 1); return c; }

function applyItem(state: GameState, item: ItemType, _rng: RNG): EngineResult {
  const userId = state.activeParticipant; const user = state.participants[userId];
  if (!user.items.includes(item)) return { state, events: [], rejected: "ITEM_NOT_HELD" };
  const userAfter: Participant = { ...user, items: removeOneItem(user.items, item) };
  const baseState: GameState = { ...state, participants: { ...state.participants, [userId]: userAfter } };
  const events: GameEvent[] = [{ type: "ITEM_USED", by: userId, item }];
  switch (item) {
    case "MAGNIFYING_GLASS": { const r = currentChamber(state.cylinder); if (!r) return { state: baseState, events }; return { state: { ...baseState, participants: { ...baseState.participants, [userId]: { ...userAfter, revealedCurrentChamber: r } } }, events }; }
    case "SPEED_LOADER": { const r = currentChamber(state.cylinder); if (!r) return { state: baseState, events }; const ch: Chamber[] = state.cylinder.chambers.slice(); ch[state.cylinder.currentIndex] = null; let n = state.cylinder.currentIndex + 1; while (n < ch.length && ch[n] === null) n++; events.push({ type: "ROUND_SET_LOADED", live: r === "LIVE" ? 1 : 0, blank: r === "BLANK" ? 1 : 0, total: 1, roundNumber: 0 }); return { state: { ...baseState, cylinder: { chambers: ch, currentIndex: n, size: state.cylinder.size }, participants: { ...baseState.participants, [userId]: { ...userAfter, revealedCurrentChamber: null } } }, events }; }
    case "MEDKIT": { const hp = Math.min(user.hp + 1, state.config.startingHp); events.push({ type: "HP_CHANGED", participant: userId, hp }); return { state: { ...baseState, participants: { ...baseState.participants, [userId]: { ...userAfter, hp } } }, events }; }
    case "HANDCUFFS": return { state: { ...baseState, skipNextTurnOf: opponentOf(userId) }, events };
    case "INVERTER": { const r = currentChamber(state.cylinder); if (!r) return { state: baseState, events }; const ch: Chamber[] = state.cylinder.chambers.slice(); ch[state.cylinder.currentIndex] = flipRound(r); return { state: { ...baseState, cylinder: { ...state.cylinder, chambers: ch } }, events }; }
    case "HOLLOW_POINT": return { state: { ...baseState, participants: { ...baseState.participants, [userId]: { ...userAfter, damageMultiplier: 2 } } }, events };
  }
}

// ============================================================================
// Reduce (the single entry point)
// ============================================================================

export function reduce(state: GameState, action: Action, rng: RNG): EngineResult {
  try {
    if (action.kind === "START_NEW_MATCH") return createMatch(state.config, rng);
    if (state.phase === "MATCH_OVER" || isMatchOver(state)) return { state, events: [], rejected: "MATCH_OVER" };
    switch (action.kind) {
      case "SHOOT": return fire(state, action.target, rng);
      case "SPIN": return spin(state, rng);
      case "USE_ITEM": return applyItem(state, action.item, rng);
    }
  } catch { return { state, events: [], rejected: "INVALID_ACTION" }; }
  return { state, events: [], rejected: "INVALID_ACTION" };
}
