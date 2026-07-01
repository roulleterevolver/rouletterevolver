// Minimal end-of-match overlay for the Revolver Roulette app shell.
//
// Gameplay is driven entirely by clicking objects in the 3D scene (the revolver
// to aim then the Dealer / SELF marker to fire, the item zones to use items,
// the spin disk to spin) — there is NO on-screen HUD during play. This module
// only shows a winner banner and a NEW MATCH button when the Match ends.

import type { Action, GameState, ParticipantId } from "../engine/types";
import { isMatchOver, winnerOf } from "../engine/lifecycle";

export interface ControlCallbacks {
  readonly onAction: (action: Action) => void;
  readonly onInteract: () => void;
}

function participantLabel(id: ParticipantId): string {
  return id === "PLAYER" ? "YOU" : "THE DEALER";
}

/**
 * The end-of-match overlay. Construct it, `mount` it into a host element, then
 * call `update(state)` on every state change; it stays hidden until the Match
 * is over, then reveals the winner and the NEW MATCH button.
 */
export class ActionPanel {
  private readonly cb: ControlCallbacks;

  private readonly root: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly newMatchBtn: HTMLButtonElement;

  constructor(cb: ControlCallbacks) {
    this.cb = cb;

    this.root = el("div", "rr-endcard");
    this.root.style.display = "none";

    this.banner = el("div", "rr-turn");
    this.newMatchBtn = el("button", "rr-newmatch");
    this.newMatchBtn.type = "button";
    this.newMatchBtn.textContent = "NEW MATCH";
    this.newMatchBtn.addEventListener("click", () => {
      this.cb.onInteract();
      this.cb.onAction({ kind: "START_NEW_MATCH" });
    });

    this.root.append(this.banner, this.newMatchBtn);
  }

  mount(host: HTMLElement): void {
    host.appendChild(this.root);
  }

  update(state: GameState): void {
    if (!isMatchOver(state)) {
      this.root.style.display = "none";
      return;
    }
    const winner = winnerOf(state);
    const won = winner === "PLAYER";
    this.banner.textContent =
      winner !== null ? `${participantLabel(winner)} WINS` : "MATCH OVER";
    this.banner.className = `rr-turn ${won ? "rr-turn-win" : "rr-turn-lose"}`;
    this.root.className = `rr-endcard ${won ? "rr-endcard-win" : "rr-endcard-lose"}`;
    this.root.style.display = "";
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
