// Creepy, Buckshot-Roulette-style action captions.
//
// Pure mapping from a `GameEvent` to a short on-screen caption (a bold title +
// a one-line description) shown briefly when the action happens. Returns `null`
// for events that should not interrupt with text (turn passes, HP ticks).

import type { GameEvent, ItemType } from "../engine/types";

export interface Caption {
  readonly title: string;
  readonly desc: string;
}

function who(id: "PLAYER" | "AI"): string {
  return id === "PLAYER" ? "YOU" : "THE DEALER";
}

const ITEM_CAPTION: Record<ItemType, Caption> = {
  MAGNIFYING_GLASS: { title: "MAGNIFIER", desc: "Check the current shell in the chamber." },
  SPEED_LOADER: { title: "EJECT", desc: "Rack the current round out. You see what it was." },
  MEDKIT: { title: "MEDKIT", desc: "Restore 1 health." },
  HANDCUFFS: { title: "HANDCUFFS", desc: "Skip the opponent's next turn." },
  INVERTER: { title: "INVERTER", desc: "Swap live to blank, and blank to live." },
  HOLLOW_POINT: { title: "SAW", desc: "Double the damage of the next shot." },
};

/** The descriptive caption for an item type (used for hover hints). */
export function itemCaption(item: ItemType): Caption {
  return ITEM_CAPTION[item];
}

/**
 * Map a `GameEvent` to its caption, or `null` to show nothing. Pure.
 */
export function captionFor(event: GameEvent): Caption | null {
  switch (event.type) {
    case "ROUND_SET_LOADED":
      return {
        title: `ROUND ${event.roundNumber}`,
        desc: "",
      };
    case "SPUN":
      return { title: "SPIN", desc: "The chambers blur. Fate is reshuffled." };
    case "LIVE_FIRED":
      return event.target === "AI"
        ? { title: "BANG", desc: "The dealer bleeds. It only grins wider." }
        : { title: "BANG", desc: "The round tears through you." };
    case "BLANK_FIRED":
      return event.target === "AI"
        ? { title: "CLICK", desc: "Empty. The dealer is unamused." }
        : { title: "CLICK", desc: "Empty. You breathe again \u2014 for now." };
    case "ITEM_USED":
      return ITEM_CAPTION[event.item];
    case "TURN_SKIPPED":
      return { title: "BOUND", desc: `${who(event.participant)} cannot move.` };
    case "TURN_PASSED":
      return event.to === "PLAYER"
        ? { title: "YOUR TURN", desc: "The iron waits for your hand." }
        : { title: "THE DEALER'S TURN", desc: "It reaches for the gun, grinning." };
    case "MATCH_OVER":
      return event.winner === "PLAYER"
        ? { title: "YOU SURVIVE", desc: "The dealer fades into the dark." }
        : { title: "YOU DIE", desc: "The dealer collects what it is owed." };
    default:
      return null; // SHOT_STARTED, HP_CHANGED, TURN_PASSED: no caption
  }
}
