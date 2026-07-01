// Landing page enhancements: settings panel + mini 3D item previews.

import * as THREE from "three";
import type { ItemType } from "../engine/types";
import { buildItemContents } from "../render/models3d";
import type { AudioSystem } from "../audio/audioSystem";

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

export function initSettings(audio: AudioSystem): void {
  const overlay = document.getElementById("rr-settings");
  const openBtn = document.getElementById("rr-settings-btn");
  const closeBtn = document.getElementById("rr-settings-close");
  const musicSlider = document.getElementById("rr-vol-music") as HTMLInputElement | null;
  const sfxSlider = document.getElementById("rr-vol-sfx") as HTMLInputElement | null;
  const blipSlider = document.getElementById("rr-vol-blip") as HTMLInputElement | null;

  if (!overlay || !openBtn || !closeBtn) return;

  openBtn.addEventListener("click", () => overlay.classList.add("rr-open"));
  closeBtn.addEventListener("click", () => overlay.classList.remove("rr-open"));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.remove("rr-open");
  });

  musicSlider?.addEventListener("input", () => {
    audio.setMusicVolume(Number(musicSlider.value) / 100);
  });
  sfxSlider?.addEventListener("input", () => {
    audio.setSfxVolume(Number(sfxSlider.value) / 100);
  });
  blipSlider?.addEventListener("input", () => {
    audio.setBlipVolume(Number(blipSlider.value) / 100);
  });
}

// ---------------------------------------------------------------------------
// Mini 3D item card previews
// ---------------------------------------------------------------------------

export function initItemCards(): void {
  const cards = document.querySelectorAll<HTMLCanvasElement>(".rr-card-3d");
  cards.forEach((canvas) => {
    const item = canvas.dataset.item as ItemType | undefined;
    if (!item) return;
    renderItemCard(canvas, item);
  });
}

function renderItemCard(canvas: HTMLCanvasElement, item: ItemType): void {
  const w = canvas.clientWidth || 240;
  const h = canvas.clientHeight || 140;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, w / h, 0.1, 30);
  camera.position.set(0, 0, 3.2);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0x5a5054, 2.5));
  const key = new THREE.PointLight(0xffb060, 10, 14, 2);
  key.position.set(2, 3, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x6080aa, 0.8);
  rim.position.set(-2, 1, -2);
  scene.add(rim);
  const up = new THREE.DirectionalLight(0x504848, 0.5);
  up.position.set(0, -3, 2);
  scene.add(up);

  const model = buildItemContents(item);
  // Scale each item to fill the frame.
  let s = 3.2;
  if (item === "MAGNIFYING_GLASS") s = 2.6;
  if (item === "HANDCUFFS") s = 2.4;
  if (item === "SPEED_LOADER") s = 3.4;
  if (item === "MEDKIT") s = 2.8;
  if (item === "INVERTER") s = 2.4;
  if (item === "HOLLOW_POINT") s = 3.4;
  model.scale.setScalar(s);

  // Stand up items that are modeled lying flat so they face the camera.
  if (item === "MAGNIFYING_GLASS") {
    model.rotation.x = -Math.PI * 0.42;
    model.rotation.z = 0.3;
  } else if (item === "HANDCUFFS") {
    model.rotation.x = -Math.PI * 0.42;
  } else if (item === "SPEED_LOADER") {
    model.rotation.x = -Math.PI * 0.3;
  }
  // Shift tall items down so their full height is visible in the frame.
  if (item === "HOLLOW_POINT") model.position.y = -0.82;
  if (item === "MEDKIT") model.position.y = -0.67;
  if (item === "INVERTER") model.position.y = -0.35;
  scene.add(model);

  const baseY = model.position.y;
  function animate(): void {
    requestAnimationFrame(animate);
    const t = performance.now() / 1000;
    model.rotation.y = t * 0.4;
    model.position.y = baseY + Math.sin(t * 1.2) * 0.03;
    renderer.render(scene, camera);
  }
  animate();
}
