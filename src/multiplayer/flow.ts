// Multiplayer game flow: search → match → coin flip → play.
//
// This module only orchestrates the match lifecycle. It does NOT render or play
// audio itself — the `MultiplayerGameController` it creates is wired to the
// EXACT same presentation pipeline as single-player via the `wire` callback, so
// gameplay looks and feels identical. The only difference is a second real
// player instead of the AI, each seeing their own point of view.

import { MultiplayerGameController } from "./gameController";
import type { Action } from "../engine/types";
import type { Renderer3D } from "../render/renderer3d";
import type { AudioSystem } from "../audio/audioSystem";
import type { CaptionView } from "../app/caption";

export interface MultiplayerFlowDeps {
  renderer: Renderer3D;
  audio: AudioSystem;
  caption: CaptionView;
  playerId: string;
  betAmount: number;
  /** Attach the shared renderer/audio/caption presentation to the controller. */
  wire: (controller: MultiplayerGameController) => void;
  onMatchStart: () => void;
  onMatchEnd: (youWon: boolean) => void;
}

export function startMultiplayerFlow(deps: MultiplayerFlowDeps): {
  cancel: () => void;
  submitAction: (a: Action) => void;
} {
  const { renderer, audio, caption, playerId, betAmount, wire, onMatchStart, onMatchEnd } = deps;

  let cancelled = false;
  let matchStarted = false;

  // Turn-timer readout (top-right), only visible in the final 10 seconds.
  const timerEl = document.createElement("div");
  timerEl.style.cssText =
    "position:fixed;top:20px;right:20px;font-family:'Courier New',monospace;" +
    "font-size:28px;font-weight:700;letter-spacing:4px;color:#cc3333;" +
    "z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.3s;";
  document.body.appendChild(timerEl);

  const controller = new MultiplayerGameController({
    playerId,

    onMatched: async ({ youAre, coinResult }) => {
      if (cancelled) return;

      // Second player controls the "AI" seat: mirror camera + swap targets.
      renderer.setLocalParticipant(youAre === "player1" ? "PLAYER" : "AI");

      caption.enqueue("OPPONENT FOUND", "The table awaits.");
      await wait(2000);
      if (cancelled) return;

      // Server-authoritative coin: both clients animate the SAME landing face
      // (`coinResult`), and the heads/tails pick is first-come-first-serve.
      const serverYouFirst = await renderer.playCoinFlip(
        coinResult,
        () => audio.playCoinFlipShimmer(),
        () => audio.playCoinFlipTable(),
        {
          submitPick: (pick) => controller.submitCoinPick(pick).then((r) => ({
            myPick: r.myPick,
            youFirst: r.youFirst,
          })),
          pollLock: () => controller.pollCoinLock(),
        },
      );
      if (cancelled) return;
      const goesFirst = serverYouFirst;

      caption.enqueue(
        goesFirst ? "YOU GO FIRST" : "THEY GO FIRST",
        goesFirst ? "The coin chose you." : "The coin chose them.",
      );
      await wait(2500);
      if (cancelled) return;

      // Reveal the board (emits initial state + ROUND_SET_LOADED events).
      matchStarted = true;
      controller.beginMatch();
      onMatchStart();
    },

    onMatchOver: (youWon) => {
      if (cancelled) return;
      timerEl.style.opacity = "0";
      onMatchEnd(youWon);
    },

    onTimerTick: (secondsLeft) => {
      if (cancelled || !matchStarted) return;
      if (secondsLeft <= 10) {
        timerEl.style.opacity = "1";
        timerEl.textContent = String(secondsLeft);
        timerEl.style.color = secondsLeft <= 5 ? "#ff0000" : "#cc3333";
      } else {
        timerEl.style.opacity = "0";
      }
    },
  });

  // Wire the shared presentation pipeline (identical to single-player).
  wire(controller);

  caption.enqueue("SEARCHING", "Looking for an opponent...");
  controller.joinQueue(betAmount).catch((err) => {
    console.error("[multiplayer] queue error:", err);
    caption.enqueue("CONNECTION LOST", "Could not reach matchmaking.");
  });

  return {
    cancel: () => {
      cancelled = true;
      controller.dispose();
      if (timerEl.parentNode) timerEl.parentNode.removeChild(timerEl);
    },
    submitAction: (action: Action) => {
      if (!matchStarted || cancelled) return;
      controller.submitPlayerAction(action);
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
