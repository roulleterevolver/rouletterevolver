// Multiplayer game flow: search → match → coin flip → play.
//
// Orchestrates the multiplayer experience using the MultiplayerClient and the
// existing renderer/audio/caption systems.

import { MultiplayerClient } from "./client";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";
import type { Action, GameEvent, GameState } from "../engine/types";
import type { Renderer3D } from "../render/renderer3d";
import type { AudioSystem } from "../audio/audioSystem";
import type { CaptionView } from "../app/caption";

export interface MultiplayerFlowDeps {
  renderer: Renderer3D;
  audio: AudioSystem;
  caption: CaptionView;
  playerId: string;
  betAmount: number;
  /** Called when the match starts (hide searching UI, show game). */
  onMatchStart: () => void;
  /** Called when the match ends. */
  onMatchEnd: (youWon: boolean) => void;
}

/**
 * Start the multiplayer flow. Returns a cleanup function.
 */
export function startMultiplayerFlow(deps: MultiplayerFlowDeps): { cancel: () => void } {
  const { renderer, audio, caption, playerId, betAmount, onMatchStart, onMatchEnd } = deps;

  let cancelled = false;
  let client: MultiplayerClient | null = null;
  let timerEl: HTMLElement | null = null;

  // Create the turn timer display.
  timerEl = document.createElement("div");
  timerEl.style.cssText =
    "position:fixed;top:20px;right:20px;font-family:'Courier New',monospace;" +
    "font-size:28px;font-weight:700;letter-spacing:4px;color:#cc3333;" +
    "z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.3s;";
  document.body.appendChild(timerEl);

  client = new MultiplayerClient({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    playerId,
    onStateChange: (state: GameState) => {
      if (cancelled) return;
      renderer.render(state);
    },
    onEvents: (events: GameEvent[]) => {
      if (cancelled) return;
      for (const event of events) {
        renderer.playActionFeedback(event);
      }
      audio.handleEvents(events);
    },
    onTimerTick: (secondsLeft: number) => {
      if (cancelled || !timerEl) return;
      if (secondsLeft <= 10) {
        timerEl.style.opacity = "1";
        timerEl.textContent = String(secondsLeft);
        if (secondsLeft <= 5) timerEl.style.color = "#ff0000";
      } else {
        timerEl.style.opacity = "0";
      }
    },
    onMatched: async (data) => {
      if (cancelled) return;
      caption.enqueue("OPPONENT FOUND", "The table awaits.");

      // Wait for caption, then coin flip.
      await new Promise((r) => setTimeout(r, 2000));
      if (cancelled) return;

      const youFirst = data.firstTurn === data.youAre;
      await renderer.playCoinFlip(
        youFirst,
        () => audio.playCoinFlipShimmer(),
        () => audio.playCoinFlipTable(),
      );
      if (cancelled) return;

      caption.enqueue(
        youFirst ? "YOU GO FIRST" : "THEY GO FIRST",
        youFirst ? "The coin chose you." : "The coin chose them.",
      );
      await new Promise((r) => setTimeout(r, 2500));
      if (cancelled) return;

      onMatchStart();
    },
    onMatchOver: (winnerId: string) => {
      if (cancelled) return;
      const youWon = winnerId === playerId;
      if (timerEl) timerEl.style.opacity = "0";
      onMatchEnd(youWon);
    },
  });

  // Join the queue.
  caption.enqueue("SEARCHING", "Looking for an opponent...");
  client.joinQueue(betAmount).catch((err) => {
    console.error("[multiplayer] queue error:", err);
    caption.enqueue("ERROR", "Could not join queue.");
  });

  // Wire the renderer's action clicks to the multiplayer client.
  // The renderer's onAction callback is set during construction, so we need
  // to redirect it. For now, we expose a submitAction method the main flow
  // can call.
  (window as any).__multiplayerSubmitAction = (action: Action) => {
    if (client && !cancelled) client.submitAction(action);
  };

  return {
    cancel: () => {
      cancelled = true;
      if (client) {
        client.cancelQueue();
        client.destroy();
      }
      if (timerEl && timerEl.parentNode) timerEl.parentNode.removeChild(timerEl);
    },
  };
}
