// Application entry point — the composition root for the Revolver Roulette
// single-player prototype.
//
// This file contains NO game rules. It only WIRES the pieces together:
//   - constructs a GameController (the only stateful coordinator),
//   - constructs the Renderer (PixiJS) and AudioSystem (Howler),
//   - subscribes the Renderer to state changes and drives renderer feedback +
//     audio from the controller's event stream,
//   - builds the player control panel and routes its clicks into
//     `controller.submitPlayerAction`,
//   - starts the Match.
//
// All authoritative game logic lives in the pure engine reached through the
// controller; this module never inspects or mutates state for rules purposes.

import { GameController } from "./controller/gameController";
import { Renderer3D } from "./render/renderer3d";
import { AudioSystem } from "./audio/audioSystem";
import { DEFAULT_CONFIG } from "./engine/lifecycle";
import { remainingCounts } from "./engine/cylinder";
import { SeededRng, SystemRng, type RNG } from "./rng/rng";
import { ActionPanel } from "./app/controls";
import { CaptionView } from "./app/caption";
import { captionFor, itemCaption } from "./app/captions";
import { initSettings, initItemCards } from "./app/landing";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/**
 * Resolve the randomness source. By default play is non-deterministic
 * (`SystemRng`). For reproducible sessions a seed may be supplied via the URL
 * query, e.g. `?seed=123`, which selects a deterministic `SeededRng`.
 */
function resolveRng(): RNG {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("seed");
    if (raw !== null && raw.trim() !== "") {
      const seed = Number.parseInt(raw, 10);
      if (Number.isFinite(seed)) {
        return new SeededRng(seed);
      }
    }
  } catch {
    // Ignore malformed location/search; fall through to the system RNG.
  }
  return new SystemRng();
}

/** Build the page layout: a fullscreen canvas host plus a bottom controls overlay. */
function buildLayout(app: HTMLElement): {
  canvasHost: HTMLElement;
  controlsHost: HTMLElement;
} {
  app.textContent = "";

  // The canvas host fills the viewport; the renderer's canvas stretches to it.
  const canvasHost = document.createElement("div");
  canvasHost.className = "rr-canvas-host";

  // The controls overlay floats along the bottom edge above the canvas.
  const controlsHost = document.createElement("div");
  controlsHost.className = "rr-controls-host";

  app.append(canvasHost, controlsHost);

  return { canvasHost, controlsHost };
}

/** Construct, wire, and start the game. Resolves once the Match has begun. */
async function bootstrap(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>("#app");
  const homeOverlay = document.getElementById("landing-page");
  const playBtn = document.getElementById("rr-play-btn");
  
  if (!app || !homeOverlay || !playBtn) return;

  const { canvasHost, controlsHost } = buildLayout(app);

  // A simple bet-amount hint that shows when hovering coins.
  const betHint = document.createElement("div");
  betHint.style.cssText =
    "position:fixed;bottom:10%;left:50%;transform:translateX(-50%);" +
    "font-family:'Courier New',monospace;font-size:22px;font-weight:700;" +
    "letter-spacing:6px;color:#d9cdb4;text-transform:uppercase;" +
    "text-shadow:0 0 10px rgba(0,0,0,0.9);pointer-events:none;" +
    "z-index:9999;opacity:0;transition:opacity 0.12s ease;";
  document.body.appendChild(betHint);

  // Initialize ScrollTrigger animations for sections
  const sections = gsap.utils.toArray<HTMLElement>('.rr-section');
  
  sections.forEach((sec) => {
    gsap.from(sec, {
      opacity: 0,
      y: 100,
      duration: 1,
      ease: "power2.out",
      scrollTrigger: {
        trigger: sec,
        scroller: homeOverlay,
        start: "top 80%",
      }
    });
  });

  // Smooth magnetic snapping
  ScrollTrigger.create({
    trigger: homeOverlay,
    scroller: homeOverlay,
    start: "top top",
    end: "bottom bottom",
    snap: {
      snapTo: 1 / 3, // Snap to roughly 4 sections
      duration: { min: 0.5, max: 1.5 },
      delay: 0.1,
      ease: "power3.inOut"
    }
  });

  // --- Core + presentation systems -------------------------------------
  const controller = new GameController({ 
    rng: resolveRng(), 
    aiDelayMs: 2600,
    onAiAim: (target) => renderer?.setAiAiming(target),
  });
  const audio = new AudioSystem();
  audio.init();

  // Landing page: settings + 3D item card previews.
  initSettings(audio);
  initItemCards();

  // The ambient drone (Requirement 9.1) must start on a USER GESTURE: browsers
  // block audio autoplay until the user first interacts with the page. We latch
  // it to the first control interaction below.
  let ambientStarted = false;
  const startAmbientOnce = (): void => {
    if (ambientStarted) return;
    ambientStarted = true;
    audio.startAmbient();
  };

  const onInteract = (): void => {
    startAmbientOnce(); // first user gesture unlocks/starts ambient audio
    audio.playUiBlip(); // UI blip on every interaction (Req 9.6)
  };

  // Browsers block audio until a user gesture. Start the music on the very
  // first click ANYWHERE (not just on an interactive object), so it always
  // begins even if the player clicks empty space first.
  // The renderer owns in-world interaction: clicks on the gun/dealer/items/spin
  // are turned into player Actions here.
  const renderer = new Renderer3D({
    onAction: (action) => controller.submitPlayerAction(action),
    onInteract,
    onBlink: () => audio.playFlick(),
    onHoverItem: (item) => {
      if (item) {
        const c = itemCaption(item);
        caption.showHint(c.title, c.desc);
      } else {
        caption.clearHint();
      }
    },
    onHoverChip: (value) => {
      if (value !== null) {
        audio.playCoinHover();
        const formatted = value >= 10000 ? "10,000" : value >= 1000 ? "1,000" : "100";
        betHint.textContent = "BET " + formatted;
        betHint.style.opacity = "1";
      } else {
        betHint.style.opacity = "0";
      }
    },
    onCoinSelect: () => audio.playCoinSelect(),
    onGunRaise: () => audio.playGunRaise(),
    onCandleBlow: () => audio.playCandleBlow(),
  });

  // --- Status bar (no action menu; gameplay is in-world) ---------------
  const panel = new ActionPanel({
    onAction: (action) => controller.submitPlayerAction(action),
    onInteract,
  });
  panel.mount(controlsHost);

  // --- Creepy action captions (Buckshot-style typewriter + text blip) --
  const caption = new CaptionView(
    () => audio.playTextBlip(),
    () => audio.stopTextBlip(),
  );
  let isCinematicPlaying = false;
  caption.onIdle = () => {
    if (!isCinematicPlaying) {
      controller.resumeAi();
    }
  };
  caption.mount(canvasHost);

  // Browsers block audio until a user gesture. Start the music on the very
  // first click ANYWHERE (not just on an interactive object), so it always
  // begins even if the player clicks empty space first.
  if (typeof window !== "undefined") {
    window.addEventListener("pointerdown", () => {
      startAmbientOnce();
      caption.skipCurrent();
    });
  }

  // --- Wire the controller's outputs to presentation -------------------
  // Events drive renderer action-feedback and all audio. Tension is derived
  // from the live cylinder: remaining (live + blank) over the loaded size.
  
  let matchOverTimeout: any = null;

  controller.onStateChange((state) => {
    renderer.render(state);
    if (state.phase === "MATCH_OVER") {
      if (!matchOverTimeout) {
        matchOverTimeout = setTimeout(() => {
          panel.update(state);
        }, 8000); // 1.6s dealer + 2.1s candle + 4s death + small buffer
      }
    } else {
      panel.update(state);
      if (matchOverTimeout) {
        clearTimeout(matchOverTimeout);
        matchOverTimeout = null;
      }
    }
  });
  controller.onEvents((events) => {
    let pushedCaption = false;
    let roundSetDelay = 0;
    let hasLiveFired = false;
    let roundLoadedEvent: any = null;
    let startDelay = 0;
    
    for (const event of events) {
      if (event.type === "LIVE_FIRED") hasLiveFired = true;
      
      if (event.type === "ROUND_SET_LOADED") {
        roundLoadedEvent = event;
      } else {
        renderer.playActionFeedback(event);
      }
      
      const cap = captionFor(event);
      if (cap) {
        if (event.type === "ITEM_USED" && event.item === "MAGNIFYING_GLASS") {
          const state = controller.getState();
          const revealed = state.participants[event.by].revealedCurrentChamber;
          if (revealed) {
            caption.enqueue("MAGNIFIER", `You see a ${revealed} shell in the chamber.`);
          } else {
            caption.enqueue(cap.title, cap.desc);
          }
        } else {
          caption.enqueue(cap.title, cap.desc);
        }
        pushedCaption = true;
      }
    }
    
      if (roundLoadedEvent) {
        // If a shot just fired (and blew out a candle), wait 3.5s before dropping the board
        startDelay = hasLiveFired ? 3500 : 0;
        setTimeout(() => {
          renderer.playActionFeedback(roundLoadedEvent);
          audio.handleEvents([roundLoadedEvent]);
        }, startDelay);
        
        roundSetDelay = startDelay + (roundLoadedEvent.roundNumber > 1 ? 15000 : 10000);
      }
      
      if (pushedCaption || roundSetDelay > 0) {
        controller.pauseAi();
        
        if (roundSetDelay > 0) {
          isCinematicPlaying = true;
          setTimeout(() => {
            caption.enqueue("", `${roundLoadedEvent.live} LIVE. ${roundLoadedEvent.blank} BLANK.`);
          }, startDelay + (roundLoadedEvent.roundNumber > 1 ? 9500 : 4500));

          setTimeout(() => {
            isCinematicPlaying = false;
            if (caption.isIdle) {
              controller.resumeAi();
            }
          }, roundSetDelay);
        }
      }

    audio.handleEvents(events.filter(e => e.type !== "ROUND_SET_LOADED"));

    const { cylinder } = controller.getState();
    const counts = remainingCounts(cylinder);
    audio.setTension(counts.live + counts.blank, cylinder.size);
  });

  // --- Renderer init (async; degrades gracefully) ----------------------
  // If the WebGL/canvas context cannot be created, show the "unavailable"
  // overlay but keep running: the game logic and controls still work (Req 8.5).
  const result = await renderer.init(canvasHost);
  if (!result.ok) {
    renderer.showRenderUnavailable();
    homeOverlay.classList.add("rr-hidden");
    controller.start(DEFAULT_CONFIG);
  } else {
    renderer.start();
    
    // Intro: the camera starts on the table then zooms out; hero fades in.
    renderer.playIntroZoom();
    const hero = document.querySelector<HTMLElement>(".rr-hero");
    setTimeout(() => {
      if (hero) hero.classList.add("rr-visible");
    }, 800);
    
    // Set the initial cinematic home camera
    renderer.setMenuCamera();
    
    // Wait for user to click PLAY
    playBtn.addEventListener("click", () => {
      onInteract(); // unlock audio context
      homeOverlay.classList.add("rr-hidden");
      renderer.transitionToGame(async () => {
        // Show 3D bet coins on the table; wait for selection.
        const bet = await renderer.showBetChips();
        if (bet < 0) return; // user hit BACK — home screen is re-shown
        (window as any).__rr_bet = bet;

        // Coin flip to decide who goes first.
        const coinResult = Math.random() < 0.5; // what the coin actually lands on
        const playerWon = await renderer.playCoinFlip(
          coinResult,
          () => audio.playCoinFlipShimmer(),
          () => audio.playCoinFlipTable(),
        );
        const youFirst = playerWon;
        caption.enqueue(
          youFirst ? "YOU GO FIRST" : "THE DEALER GOES FIRST",
          youFirst ? "The coin favors you." : "It grins. It chose itself.",
        );
        await new Promise((r) => setTimeout(r, 2500));

        controller.start(DEFAULT_CONFIG);
      });
    }, { once: true });

    // FIND OPPONENT (multiplayer) button.
    const multiBtn = document.getElementById("rr-multi-btn");
    if (multiBtn) {
      multiBtn.addEventListener("click", () => {
        onInteract();
        homeOverlay.classList.add("rr-hidden");
        renderer.transitionToGame(async () => {
          // Pick a bet first.
          const bet = await renderer.showBetChips();
          if (bet < 0) return;
          (window as any).__rr_bet = bet;

          // Start the multiplayer flow.
          const { startMultiplayerFlow } = await import("./multiplayer/flow");
          startMultiplayerFlow({
            renderer,
            audio,
            caption,
            playerId: crypto.randomUUID(), // TODO: replace with auth user ID
            betAmount: bet,
            onMatchStart: () => {
              caption.enqueue("MATCH STARTED", "Your turn.");
            },
            onMatchEnd: (youWon) => {
              caption.enqueue(
                youWon ? "YOU WIN" : "YOU LOSE",
                youWon ? "The pot is yours." : "Better luck next time.",
              );
            },
          });
        });
      });
    }
  }
}

void bootstrap();
