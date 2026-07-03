// Procedural 3D models for the Revolver Roulette renderer.
//
// Everything here is built from Three.js primitive geometry — no external
// model files. The aim is a stylized, dark "PS1/PS2 horror" look: low-poly
// figures and props that read as scary because of lighting, fog and shadow
// rather than mesh detail. These builders are PURE construction helpers: they
// take Three and return Groups/Meshes. They own no game rules and read no
// GameState. The renderer positions, lights and animates whatever they return.

import * as THREE from "three";
import type { ItemType } from "../engine/types";

// ---------------------------------------------------------------------------
// Palette (dark horror — ember, bone, blood, rust)
// ---------------------------------------------------------------------------

export const PAL = {
  void: 0x07060a,
  fog: 0x0a0809,
  floor: 0x141014,
  wall: 0x0f0c10,
  tableWood: 0x2a1d14,
  tableWoodDark: 0x160f0a,
  feltGreen: 0x16241c,
  coat: 0x14110f,
  coatTrim: 0x2a211a,
  flesh: 0xc7c0ad,
  fleshDark: 0x8a8472,
  ember: 0xff5a1a,
  emberDim: 0x8a2f0e,
  bone: 0xd8c9a4,
  blood: 0x8b0000,
  bloodDim: 0x40100c,
  steel: 0x4a4a52,
  steelDark: 0x202026,
  steelHi: 0x6a6a74,
  brass: 0xc09a3e,
  white: 0xe8e2d2,
} as const;

// ---------------------------------------------------------------------------
// Material helpers
// ---------------------------------------------------------------------------

function matte(color: number, rough = 0.95, metal = 0.0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

function metalMat(color: number, rough = 0.4): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.9 });
}

function glow(color: number, intensity = 1.5): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.4,
    metalness: 0.0,
  });
}

/** Enable casting/receiving shadows recursively on a built object. */
export function castReceive(obj: THREE.Object3D, cast = true, receive = true): void {
  obj.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = cast;
      m.receiveShadow = receive;
    }
  });
}

// ---------------------------------------------------------------------------
// Procedural grunge textures (old, stained, scratched) — canvas-based
// ---------------------------------------------------------------------------

function hex(n: number): string {
  return "#" + n.toString(16).padStart(6, "0");
}

/**
 * Paint an aged surface texture: a base colour, fine grime noise, dark
 * scratches, and (optionally) dried blood blotches. Returns null when no DOM
 * is available (tests), so callers fall back to a flat colour.
 */
function makeGrungeTexture(
  base: number,
  opts: { blood?: boolean; scratches?: number; grime?: number } = {},
): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  try {
    const N = 512;
    const c = document.createElement("canvas");
    c.width = N;
    c.height = N;
    const ctx = c.getContext("2d");
    if (!ctx) return null;

    ctx.fillStyle = hex(base);
    ctx.fillRect(0, 0, N, N);

    // Fine grime: thousands of faint dark/light specks.
    const grime = opts.grime ?? 5000;
    for (let i = 0; i < grime; i++) {
      const x = Math.random() * N;
      const y = Math.random() * N;
      const dark = Math.random() < 0.6;
      ctx.fillStyle = dark ? "rgba(0,0,0,0.12)" : "rgba(180,170,150,0.06)";
      ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }

    // Worn patches.
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * N;
      const y = Math.random() * N;
      const r = 20 + Math.random() * 70;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(0,0,0,0.16)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Scratches: thin pale gouges.
    const scratches = opts.scratches ?? 40;
    for (let i = 0; i < scratches; i++) {
      const x = Math.random() * N;
      const y = Math.random() * N;
      const a = Math.random() * Math.PI * 2;
      const len = 10 + Math.random() * 120;
      ctx.strokeStyle = `rgba(200,190,170,${0.05 + Math.random() * 0.12})`;
      ctx.lineWidth = Math.random() < 0.3 ? 1.5 : 0.7;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }

    // Dried blood blotches + spatter.
    if (opts.blood) {
      for (let i = 0; i < 7; i++) {
        const x = Math.random() * N;
        const y = Math.random() * N;
        const r = 14 + Math.random() * 46;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(70,8,6,0.85)");
        g.addColorStop(0.6, "rgba(45,6,5,0.6)");
        g.addColorStop(1, "rgba(30,4,4,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        // spatter droplets around it
        for (let j = 0; j < 18; j++) {
          const da = Math.random() * Math.PI * 2;
          const dd = r + Math.random() * r * 1.4;
          const dr = 1 + Math.random() * 3;
          ctx.fillStyle = "rgba(55,7,5,0.7)";
          ctx.beginPath();
          ctx.arc(x + Math.cos(da) * dd, y + Math.sin(da) * dd, dr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Room: floor + back walls, all very dark (fog swallows the edges)
// ---------------------------------------------------------------------------

export function buildRoom(): THREE.Group {
  const g = new THREE.Group();

  // A stained concrete floor — grimy, scratched, with old dried blood.
  const floorMat = matte(PAL.floor);
  const floorTex = makeGrungeTexture(PAL.floor, { blood: true, scratches: 90, grime: 9000 });
  if (floorTex) {
    floorTex.repeat.set(3, 3);
    floorMat.map = floorTex;
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  g.add(floor);

  const wallMat = matte(PAL.wall);
  const wallTex = makeGrungeTexture(PAL.wall, { scratches: 50, grime: 7000 });
  if (wallTex) {
    wallTex.repeat.set(3, 2);
    wallMat.map = wallTex;
  }
  const back = new THREE.Mesh(new THREE.PlaneGeometry(60, 30), wallMat);
  back.position.set(0, 15, -16);
  back.receiveShadow = true;
  g.add(back);

  const left = new THREE.Mesh(new THREE.PlaneGeometry(40, 30), wallMat);
  left.position.set(-22, 15, 0);
  left.rotation.y = Math.PI / 2;
  left.receiveShadow = true;
  g.add(left);

  const right = new THREE.Mesh(new THREE.PlaneGeometry(40, 30), wallMat);
  right.position.set(22, 15, 0);
  right.rotation.y = -Math.PI / 2;
  right.receiveShadow = true;
  g.add(right);

  return g;
}

// ---------------------------------------------------------------------------
// Table: a heavy, stained wooden slab with a felt inlay on four thick legs
// ---------------------------------------------------------------------------

export const TABLE = {
  width: 10,
  depth: 6,
  thickness: 0.5,
  topY: 3.0,
} as const;

/** Y of the table's working surface (where props sit). */
export const SURFACE_Y = TABLE.topY + TABLE.thickness / 2;

export function buildTable(): THREE.Group {
  const g = new THREE.Group();
  const woodTop = matte(0x241810, 0.95);
  const woodLeg = matte(PAL.tableWoodDark, 0.95);

  // Aged, scratched wood + a bloodstained felt (procedural grunge textures).
  const woodTex = makeGrungeTexture(0x241810, { scratches: 70, grime: 6000 });
  if (woodTex) woodTop.map = woodTex;

  const top = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.width, TABLE.thickness, TABLE.depth),
    woodTop,
  );
  top.position.y = TABLE.topY;
  g.add(top);

  // A dark, stained felt playing surface inset into the top.
  const feltMat = matte(0x16221b, 0.98);
  const feltTex = makeGrungeTexture(0x16221b, { blood: true, scratches: 30, grime: 5000 });
  if (feltTex) feltMat.map = feltTex;
  const felt = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.width * 0.82, 0.06, TABLE.depth * 0.74),
    feltMat,
  );
  felt.position.set(0, SURFACE_Y + 0.01, 0);
  felt.receiveShadow = true;
  g.add(felt);

  // A thin brass trim framing the felt.
  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.width * 0.85, 0.04, TABLE.depth * 0.77),
    metalMat(PAL.brass, 0.5),
  );
  trim.position.set(0, SURFACE_Y, 0);
  g.add(trim);

  // Painted chalk markings on the felt (zone lines + a centre circle), like
  // the reference table.
  const chalk = new THREE.MeshStandardMaterial({
    color: 0xc7c1ad,
    emissive: 0x2a2620,
    emissiveIntensity: 0.35,
    roughness: 0.85,
  });
  const lineY = SURFACE_Y + 0.04;
  const feltW = TABLE.width * 0.8;
  const feltD = TABLE.depth * 0.7;
  const mkLine = (w: number, d: number, x: number, z: number): void => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), chalk);
    m.position.set(x, lineY, z);
    g.add(m);
  };
  // Outer boundary.
  mkLine(feltW, 0.05, 0, feltD / 2);
  mkLine(feltW, 0.05, 0, -feltD / 2);
  mkLine(0.05, feltD, feltW / 2, 0);
  mkLine(0.05, feltD, -feltW / 2, 0);
  // The two dividing lines splitting each player's half from the centre.
  mkLine(feltW, 0.05, 0, feltD * 0.16);
  mkLine(feltW, 0.05, 0, -feltD * 0.16);
  // A faint centre circle where the gun rests.
  const circle = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.03, 6, 48), chalk);
  circle.rotation.x = Math.PI / 2;
  circle.position.set(0, lineY, 0);
  g.add(circle);

  const legGeo = new THREE.BoxGeometry(0.6, TABLE.topY, 0.6);
  const lx = TABLE.width / 2 - 0.7;
  const lz = TABLE.depth / 2 - 0.7;
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    const leg = new THREE.Mesh(legGeo, woodLeg);
    leg.position.set(sx * lx, TABLE.topY / 2, sz * lz);
    g.add(leg);
  }

  // Iron bolt studs at the four corners of the top (like the reference table).
  const boltMat = metalMat(0x2a2a2e, 0.55);
  const bx = TABLE.width / 2 - 0.45;
  const bz = TABLE.depth / 2 - 0.45;
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.1, 6), boltMat);
    bolt.position.set(sx * bx, TABLE.topY + TABLE.thickness / 2 + 0.03, sz * bz);
    g.add(bolt);
  }

  castReceive(g, true, true);
  return g;
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

export interface FigureHandles {
  group: THREE.Group;
  /** The whole upper body — leans on aim/recoil. */
  torso: THREE.Group;
  /** Glowing eye material (intensity flickers / flares on shots). */
  eyeMat: THREE.MeshStandardMaterial;
  /** Glowing grin material (flares with the eyes). */
  mouthMat: THREE.MeshStandardMaterial;
  /** Right arm group — raises when aiming. */
  arm: THREE.Group;
  /** Resting rotation of the arm (radians, X) so the renderer can return to it. */
  armRestX: number;
  /** Optional head group — the renderer tilts/twitches it for unease. */
  head?: THREE.Group;
}

/** A creepy glowing crescent grin built from a partial torus arc. */
function buildGrin(color: number, intensity: number, width: number): THREE.Mesh {
  const geo = new THREE.TorusGeometry(width, width * 0.16, 6, 16, Math.PI);
  const mesh = new THREE.Mesh(geo, glow(color, intensity));
  // Flip so the arc opens upward into a smile.
  mesh.rotation.z = Math.PI;
  return mesh;
}

/**
 * The Dealer: a tall hooded figure, face lost in shadow but for two ember eyes
 * and a wide, unsettling grin. Skeletal hands rest on the table.
 */
export function buildDealer(): FigureHandles {
  const group = new THREE.Group();
  const torso = new THREE.Group();

  const suit = matte(0x0a090b, 0.92); // grave-black frock coat
  const suitTrim = matte(0x1c1418, 0.85);
  const bone = matte(0xd3c8b0, 0.8); // aged, yellowed bone mask
  const boneDark = matte(0x9a8f78, 0.85);
  const flesh = matte(0xb4ada0, 0.7); // corpse-grey skin

  // Tall, tapering lower robe with a tattered hem.
  const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 1.05, 4.2, 12), suit);
  lower.position.y = 2.1;
  group.add(lower);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.3;
    const flap = new THREE.Mesh(
      new THREE.ConeGeometry(0.14 + Math.random() * 0.1, 0.5 + Math.random() * 0.45, 5),
      suit,
    );
    flap.rotation.x = Math.PI; // point down
    flap.position.set(Math.cos(a) * 0.92, 0.24, Math.sin(a) * 0.92);
    group.add(flap);
  }

  // Gaunt, angular chest — a suit jacket hanging off bones.
  const chest = new THREE.Mesh(new THREE.BoxGeometry(1.35, 2.3, 0.75), suit);
  chest.position.y = 4.4;
  torso.add(chest);
  // Sunken sternum shadow down the front.
  const sternum = new THREE.Mesh(new THREE.BoxGeometry(0.46, 1.7, 0.1), matte(0x040308, 0.98));
  sternum.position.set(0, 4.45, 0.36);
  torso.add(sternum);
  // Faint rib bars pressing through the coat.
  for (let i = 0; i < 4; i++) {
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.95 - i * 0.1, 0.045, 0.05), suitTrim);
    rib.position.set(0, 5.15 - i * 0.28, 0.4);
    torso.add(rib);
  }
  // Waist taper.
  const waist = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.6, 0.68), suit);
  waist.position.y = 3.1;
  torso.add(waist);

  // Hunched, too-high shoulders.
  const shoulderGeo = new THREE.BoxGeometry(0.78, 0.55, 0.82);
  const shL = new THREE.Mesh(shoulderGeo, suit);
  shL.position.set(-0.92, 5.5, 0);
  shL.rotation.z = 0.35;
  torso.add(shL);
  const shR = new THREE.Mesh(shoulderGeo, suit);
  shR.position.set(0.92, 5.5, 0);
  shR.rotation.z = -0.35;
  torso.add(shR);

  // High mortician's collar wrapping the back of the neck.
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.52, 0.68, 0.95, 12, 1, true, Math.PI / 2, Math.PI),
    suitTrim,
  );
  collar.position.set(0, 5.85, -0.08);
  torso.add(collar);

  // Neck: thin, too long, craning slightly forward.
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.22, 1.15, 10), flesh);
  neck.position.set(0, 5.95, 0.06);
  neck.rotation.x = 0.1;
  torso.add(neck);

  // -------------------------------------------------------------------
  // The head — an elongated, cracked bone mask under a mortician's hat.
  // Built inside its own group so the renderer can tilt/twitch it.
  // -------------------------------------------------------------------
  const head = new THREE.Group();
  head.position.set(0, 6.62, 0.12);
  torso.add(head);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.72, 24, 20), bone);
  skull.scale.set(0.95, 1.28, 0.9);
  head.add(skull);

  // Narrow jaw drawn down too far.
  const jaw = new THREE.Mesh(new THREE.ConeGeometry(0.46, 0.85, 10), bone);
  jaw.rotation.x = Math.PI;
  jaw.position.set(0, -0.72, 0.14);
  head.add(jaw);

  // Sunken cheek hollows.
  const hollowMat = matte(0x241d15, 0.95);
  const cheekGeo = new THREE.SphereGeometry(0.19, 10, 8);
  const cheekL = new THREE.Mesh(cheekGeo, hollowMat);
  cheekL.position.set(-0.42, -0.2, 0.46);
  cheekL.scale.set(0.9, 1.5, 0.45);
  head.add(cheekL);
  const cheekR = new THREE.Mesh(cheekGeo, hollowMat);
  cheekR.position.set(0.42, -0.2, 0.46);
  cheekR.scale.set(0.9, 1.5, 0.45);
  head.add(cheekR);

  // Heavy brow ridge shading the sockets.
  const brow = new THREE.Mesh(new THREE.BoxGeometry(1.06, 0.16, 0.26), boneDark);
  brow.position.set(0, 0.36, 0.56);
  brow.rotation.x = 0.3;
  head.add(brow);

  // Deep black eye pits, angled inward for menace.
  const socketMat = matte(0x030303, 0.98);
  const socketGeo = new THREE.SphereGeometry(0.19, 12, 10);
  const skL = new THREE.Mesh(socketGeo, socketMat);
  skL.position.set(-0.3, 0.14, 0.52);
  skL.scale.set(1.05, 1.2, 0.55);
  skL.rotation.z = -0.35;
  head.add(skL);
  const skR = new THREE.Mesh(socketGeo, socketMat);
  skR.position.set(0.3, 0.14, 0.52);
  skR.scale.set(1.05, 1.2, 0.55);
  skR.rotation.z = 0.35;
  head.add(skR);

  // Pinprick ember pupils burning inside the pits.
  const eyeMat = glow(0xff2212, 3.0);
  const pupilGeo = new THREE.SphereGeometry(0.055, 8, 8);
  const eyeL = new THREE.Mesh(pupilGeo, eyeMat);
  eyeL.position.set(-0.3, 0.12, 0.62);
  head.add(eyeL);
  const eyeR = new THREE.Mesh(pupilGeo, eyeMat);
  eyeR.position.set(0.3, 0.12, 0.62);
  head.add(eyeR);

  // A grin far too wide: a glowing seam carved across the mask...
  const mouthMat = glow(0xff4a1a, 1.2);
  const seam = new THREE.Mesh(
    new THREE.TorusGeometry(0.4, 0.035, 6, 24, Math.PI * 0.9),
    mouthMat,
  );
  seam.rotation.z = Math.PI + (Math.PI - Math.PI * 0.9) / 2;
  seam.position.set(0, -0.18, 0.56);
  seam.scale.set(1.1, 0.55, 0.5);
  head.add(seam);

  // ...lined with crooked, irregular teeth (one gap left dark).
  const toothMat = matte(0xc9bd9e, 0.85);
  for (let i = 0; i < 9; i++) {
    if (i === 2) continue; // missing tooth
    const fx = i / 8 - 0.5;
    const tx = fx * 0.78;
    const ty = -0.36 - Math.abs(fx) * 0.16 + (i % 2 === 0 ? 0.02 : -0.02);
    const th = 0.12 + ((i * 37) % 5) * 0.02;
    const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.07, th, 0.05), toothMat);
    tooth.position.set(tx, ty, 0.6 - Math.abs(fx) * 0.12);
    tooth.rotation.z = fx * 0.5 + (i % 3 === 0 ? 0.12 : -0.08);
    head.add(tooth);
  }

  // Cracks spidering across the mask.
  const crackMat = matte(0x14110d, 0.95);
  const crackSpecs: Array<[number, number, number, number, number]> = [
    // x, y, len, rotZ, rotX
    [-0.18, 0.52, 0.5, 0.35, 0.25],
    [0.3, 0.44, 0.38, -0.5, 0.2],
    [-0.44, -0.05, 0.42, 1.15, 0.0],
    [0.12, -0.5, 0.34, 0.2, -0.2],
  ];
  for (const [cx, cy, len, rz, rx] of crackSpecs) {
    const crack = new THREE.Mesh(new THREE.BoxGeometry(0.022, len, 0.02), crackMat);
    crack.position.set(cx, cy, 0.6);
    crack.rotation.set(rx, 0, rz);
    head.add(crack);
  }

  // The mortician's top hat, tilted just slightly wrong.
  const hatMat = matte(0x0b0a0c, 0.9);
  const hatBrim = new THREE.Mesh(new THREE.CylinderGeometry(0.86, 0.92, 0.07, 20), hatMat);
  hatBrim.position.set(0, 0.8, -0.04);
  hatBrim.rotation.set(-0.08, 0, 0.05);
  head.add(hatBrim);
  const hatTop = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.57, 1.05, 18), hatMat);
  hatTop.position.set(0, 1.32, -0.07);
  hatTop.rotation.set(-0.08, 0, 0.05);
  head.add(hatTop);
  const hatBand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.545, 0.585, 0.16, 18),
    matte(0x4a0a0a, 0.7),
  );
  hatBand.position.set(0, 0.92, -0.05);
  hatBand.rotation.set(-0.08, 0, 0.05);
  head.add(hatBand);

  // Cold morgue underlight + a faint ember glow at the eyes.
  const faceLight = new THREE.PointLight(0x8fb8ff, 2.0, 3.4, 2);
  faceLight.position.set(0, 5.4, 1.4);
  torso.add(faceLight);
  const emberLight = new THREE.PointLight(0xff3018, 0.9, 1.8, 2);
  emberLight.position.set(0, 6.75, 0.95);
  torso.add(emberLight);

  // Long skeletal arms ending in bony fingers splayed on the table.
  const restArm = buildSkeletalArm(suit, bone);
  restArm.position.set(0.7, 4.8, 0.4);
  restArm.rotation.x = -1.15;
  restArm.rotation.z = -0.2;
  torso.add(restArm);

  const arm = buildSkeletalArm(suit, bone);
  arm.position.set(-0.7, 4.8, 0.4);
  const armRestX = -1.15;
  arm.rotation.x = armRestX;
  arm.rotation.z = 0.2;
  torso.add(arm);

  group.add(torso);
  castReceive(group, true, false);
  return { group, torso, eyeMat, mouthMat, arm, armRestX, head };
}

/** A gaunt arm ending in a bony hand with long, splayed fingers. */
function buildSkeletalArm(
  coat: THREE.MeshStandardMaterial,
  bone: THREE.MeshStandardMaterial,
): THREE.Group {
  const arm = new THREE.Group();
  const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.12, 1.5, 8), coat);
  upper.position.y = -0.75;
  arm.add(upper);
  const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.09, 1.3, 8), coat);
  fore.position.set(0, -1.7, 0.35);
  fore.rotation.x = -0.5;
  arm.add(fore);
  // Exposed bony wrist.
  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.055, 0.22, 8), bone);
  wrist.position.set(0, -2.24, 0.62);
  wrist.rotation.x = -0.6;
  arm.add(wrist);
  // Flat skeletal palm.
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.3), bone);
  palm.position.set(0, -2.36, 0.76);
  arm.add(palm);
  // Four long fingers, splayed and slightly curled — plus a thumb.
  for (let i = 0; i < 4; i++) {
    const fx = -0.09 + i * 0.06;
    const finger = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.016, 0.44, 6), bone);
    finger.position.set(fx, -2.42, 0.98);
    finger.rotation.x = -1.35;
    finger.rotation.z = fx * 1.2;
    arm.add(finger);
    const knuckle = new THREE.Mesh(new THREE.SphereGeometry(0.028, 6, 6), bone);
    knuckle.position.set(fx, -2.38, 0.9);
    arm.add(knuckle);
  }
  const thumb = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.018, 0.3, 6), bone);
  thumb.position.set(0.16, -2.38, 0.8);
  thumb.rotation.set(-1.1, 0, -0.9);
  arm.add(thumb);
  return arm;
}

/** The Player: a hunched hooded figure, dimmer eyes and a faint grin. */
export function buildPlayer(): FigureHandles {
  const group = new THREE.Group();
  const torso = new THREE.Group();
  const coat = matte(0x2a241d, 0.95);
  const hoodMat = matte(0x1b1712, 0.97);
  const flesh = matte(0x5a4f43, 0.85);

  const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.45, 3.0, 12), coat);
  lower.position.y = 1.5;
  group.add(lower);

  const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.95, 1.7, 12), coat);
  chest.position.y = 3.3;
  torso.add(chest);

  const shoulders = new THREE.Mesh(new THREE.SphereGeometry(1.05, 14, 12), hoodMat);
  shoulders.scale.set(1.2, 0.65, 1.0);
  shoulders.position.y = 3.95;
  torso.add(shoulders);

  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 16), hoodMat);
  hood.scale.set(1.0, 1.12, 1.1);
  hood.position.y = 4.55;
  torso.add(hood);
  const brim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.54, 0.72, 0.6, 14, 1, true),
    hoodMat,
  );
  brim.position.set(0, 4.32, 0.18);
  brim.rotation.x = 0.15;
  torso.add(brim);

  const face = new THREE.Mesh(new THREE.SphereGeometry(0.44, 16, 16), flesh);
  face.scale.set(0.92, 1.08, 0.72);
  face.position.set(0, 4.52, 0.3);
  torso.add(face);

  const socketMat = matte(0x120e0b, 0.9);
  const socketGeo = new THREE.SphereGeometry(0.12, 10, 10);
  const skL = new THREE.Mesh(socketGeo, socketMat);
  skL.position.set(-0.16, 4.62, 0.54);
  const skR = new THREE.Mesh(socketGeo, socketMat);
  skR.position.set(0.16, 4.62, 0.54);
  torso.add(skL, skR);

  const eyeMat = glow(PAL.ember, 2.4);
  const eyeGeo = new THREE.SphereGeometry(0.1, 10, 10);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.16, 4.62, 0.58);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(0.16, 4.62, 0.58);
  torso.add(eyeL, eyeR);

  const mouthMat = glow(0xd4561c, 1.6);
  const grin = buildGrin(0xd4561c, 1.6, 0.24);
  grin.material = mouthMat;
  grin.position.set(0, 4.36, 0.6);
  grin.scale.set(1, 0.65, 1);
  torso.add(grin);

  const faceLight = new THREE.PointLight(0xff6a28, 1.8, 2.8, 2);
  faceLight.position.set(0, 4.55, 1.0);
  torso.add(faceLight);

  const armL = buildArm(coat, flesh, 0.85);
  armL.position.set(-0.92, 3.5, 0.3);
  armL.rotation.x = -1.2;
  armL.rotation.z = 0.2;
  torso.add(armL);

  const arm = buildArm(coat, flesh, 0.85);
  arm.position.set(0.92, 3.5, 0.3);
  const armRestX = -1.2;
  arm.rotation.x = armRestX;
  arm.rotation.z = -0.2;
  torso.add(arm);

  group.add(torso);
  castReceive(group, true, false);
  return { group, torso, eyeMat, mouthMat, arm, armRestX };
}

/** 
 * Build First-Person Player Hands that rest on the table 
 */
export function buildPlayerHands(): THREE.Group {
  const group = new THREE.Group();
  const flesh = matte(0x8f887c, 0.75); // pale, bloodless flesh
  const fleshDark = matte(0x6e675c, 0.85); // grime in the creases
  const sleeve = matte(0x14110e, 0.92); // ragged dark sleeves
  const sleeveWorn = matte(0x241d16, 0.95);

  const buildHand = (isLeft: boolean): THREE.Group => {
    const handGroup = new THREE.Group();
    // Sleeve, with a frayed torn cuff of jutting cones.
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.4, 1.8, 12), sleeve);
    arm.rotation.x = Math.PI / 2;
    arm.position.set(0, 0.2, 0.9);
    handGroup.add(arm);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + (isLeft ? 0.4 : 0.1);
      const fray = new THREE.Mesh(
        new THREE.ConeGeometry(0.05 + Math.random() * 0.03, 0.2 + Math.random() * 0.14, 4),
        sleeveWorn,
      );
      fray.rotation.x = -Math.PI / 2;
      fray.position.set(Math.cos(a) * 0.26, 0.2 + Math.sin(a) * 0.26, 0.05);
      handGroup.add(fray);
    }

    // Bony hand with visible knuckle ridges.
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.18, 0.66), flesh);
    hand.position.set(0, 0, -0.2);
    handGroup.add(hand);
    // Tendon ridges along the back of the hand.
    for (let i = 0; i < 4; i++) {
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.03, 0.5), fleshDark);
      ridge.position.set(-0.19 + i * 0.13, 0.1, -0.22);
      handGroup.add(ridge);
    }

    // Fingers: two knuckle-bent segments each, resting on the felt.
    for (let i = 0; i < 4; i++) {
      const fx = -0.2 + i * 0.13;
      const seg1 = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.28, 8), flesh);
      seg1.rotation.x = Math.PI / 2 - 0.15;
      seg1.position.set(fx, -0.03, -0.62);
      handGroup.add(seg1);
      const knuckle = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), flesh);
      knuckle.position.set(fx, -0.05, -0.76);
      handGroup.add(knuckle);
      const seg2 = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.04, 0.22, 8), flesh);
      seg2.rotation.x = Math.PI / 2 + 0.35;
      seg2.position.set(fx, -0.1, -0.86);
      handGroup.add(seg2);
      // Dark cracked nail.
      const nail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, 0.07), fleshDark);
      nail.position.set(fx, -0.06, -0.9);
      nail.rotation.x = 0.35;
      handGroup.add(nail);
    }

    // Thumb tucked along the inside edge.
    const thumb = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.32, 8), flesh);
    thumb.rotation.set(Math.PI / 2, 0, isLeft ? -0.7 : 0.7);
    thumb.position.set(isLeft ? 0.32 : -0.32, -0.02, -0.35);
    handGroup.add(thumb);

    // An old scar gouged across the back of the hand.
    const scar = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.4), matte(0x5a2420, 0.8));
    scar.position.set(isLeft ? 0.1 : -0.12, 0.1, -0.2);
    scar.rotation.y = isLeft ? 0.5 : -0.5;
    handGroup.add(scar);

    handGroup.position.set(isLeft ? -2.5 : 2.5, 3.4, 6.5);
    handGroup.rotation.y = isLeft ? 0.2 : -0.2;
    return handGroup;
  };

  group.add(buildHand(true));
  group.add(buildHand(false));
  castReceive(group, true, true);
  return group;
}

/** A simple two-segment arm with a hand, pivoting at the shoulder. */
function buildArm(
  coat: THREE.MeshStandardMaterial,
  flesh: THREE.MeshStandardMaterial,
  scale = 1,
): THREE.Group {
  const arm = new THREE.Group();
  const upper = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18 * scale, 0.16 * scale, 1.4 * scale, 8),
    coat,
  );
  upper.position.y = -0.7 * scale;
  arm.add(upper);
  const fore = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15 * scale, 0.13 * scale, 1.2 * scale, 8),
    coat,
  );
  fore.position.set(0, -1.6 * scale, 0.35 * scale);
  fore.rotation.x = -0.5;
  arm.add(fore);
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.17 * scale, 8, 8), flesh);
  hand.scale.set(1, 0.7, 1.2);
  hand.position.set(0, -2.15 * scale, 0.7 * scale);
  arm.add(hand);
  return arm;
}

// ---------------------------------------------------------------------------
// The Revolver: a proper top-down six-shooter that lies on the table
// ---------------------------------------------------------------------------

export interface RevolverHandles {
  group: THREE.Group;
  /** Spins about its axis. */
  drum: THREE.Group;
  /** Muzzle flash light + sprite. */
  flash: THREE.PointLight;
  flashMesh: THREE.Mesh;
}

export function buildRevolver(): RevolverHandles {
  // A Colt-SAA-style revolver modelled lying on its SIDE on the table, so the
  // top-down camera sees its side profile (like the reference photo). The
  // profile is drawn in the X-Z plane (length along Z, "up of the gun" along
  // +X) and is thin along Y, so it rests flat on the felt with no clipping.
  const group = new THREE.Group();
  // Worn, oil-dark gunmetal — a weapon that has seen too much use.
  const silver = new THREE.MeshStandardMaterial({ color: 0x565a63, metalness: 0.92, roughness: 0.42 });
  const silverHi = new THREE.MeshStandardMaterial({ color: 0x7d818c, metalness: 0.88, roughness: 0.32 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x38220f, metalness: 0.05, roughness: 0.55 });
  const brass = metalMat(PAL.brass, 0.4);

  const T = 0.36; // thickness in Y (how thick the gun is as it lies on its side)
  const yc = T / 2;

  // --- Barrel (length along -Z, centered in the circle) -----------
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.8, 16), silver); // Shorter length (1.8) and silver
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0.0, yc, -1.2); // Centered (X=0) and moved back to match shorter length
  group.add(barrel);
  const ejector = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.4, 12), silverHi);
  ejector.rotation.x = Math.PI / 2;
  ejector.position.set(-0.18, yc, -1.1); // Adjusted ejector to fit
  group.add(ejector);
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.16, 16), silverHi);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(0.0, yc, -2.1);
  group.add(muzzle);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.16, T * 0.7, 0.08), silverHi);
  sight.position.set(0.16, yc, -2.0);
  group.add(sight);

  // --- Frame -----------------------------------------------------------
  const frameGeo = new THREE.BoxGeometry(0.8, T, 1.2);
  const frame = new THREE.Mesh(frameGeo, silver);
  frame.position.set(0.1, yc, 0);
  group.add(frame);

  // --- Drum (Cylinder) -------------------------------------------------
  const drum = new THREE.Group();
  drum.position.set(0, yc, 0.18);
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.95, 22), silverHi);
  cyl.rotation.x = Math.PI / 2; // axis along the barrel — shows the side bulge
  drum.add(cyl);
  const chamberMat = glow(0xff6a2a, 0.35);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    // Flute groove along the cylinder (the top ones read from above).
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.82), silver);
    f.position.set(Math.cos(a) * 0.36, Math.sin(a) * 0.36, 0);
    f.rotation.z = a;
    drum.add(f);
    // A faint ember chamber mouth on the front face.
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 8), chamberMat);
    c.rotation.x = Math.PI / 2;
    c.position.set(Math.cos(a) * 0.2, Math.sin(a) * 0.2, -0.5);
    drum.add(c);
    
    // Red ammo visible from the back of the drum
    const bulletMat = new THREE.MeshStandardMaterial({ color: 0xb51c1c, metalness: 0.3, roughness: 0.5 });
    const bullet = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.96, 8), bulletMat);
    bullet.rotation.x = Math.PI / 2;
    bullet.position.set(Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0);
    drum.add(bullet);
  }
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 8), silverHi);
  pin.rotation.x = Math.PI / 2;
  drum.add(pin);
  group.add(drum);

  // --- Hammer spur (back-top) ------------------------------------------
  const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.22, T * 0.85, 0.2), silverHi);
  hammer.position.set(0.42, yc, 0.55);
  group.add(hammer);

  // --- Trigger guard + trigger (ring lies in the X-Z plane) ------------
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.045, 8, 20), silver);
  guard.rotation.x = Math.PI / 2;
  guard.position.set(-0.28, yc, 0.5);
  group.add(guard);
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.05, T * 0.6, 0.18), silverHi);
  trigger.position.set(-0.24, yc, 0.5);
  group.add(trigger);

  // --- Plow-handle wood grip, angled down-and-back ---------------------
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.46, T, 1.05), wood);
  grip.position.set(-0.5, yc, 0.92);
  grip.rotation.y = 0.7;
  group.add(grip);
  const buttcap = new THREE.Mesh(new THREE.BoxGeometry(0.5, T, 0.14), silverHi);
  buttcap.position.set(-0.92, yc, 1.32);
  buttcap.rotation.y = 0.7;
  group.add(buttcap);
  const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, T + 0.02, 10), brass);
  screw.position.set(-0.5, yc, 0.92);
  group.add(screw);

  // Muzzle flash (hidden until fired).
  const flash = new THREE.PointLight(PAL.ember, 0, 9, 2);
  flash.position.set(0.3, yc, -3.4);
  group.add(flash);
  const flashMesh = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 10), glow(0xffd27f, 3));
  flashMesh.position.set(0.3, yc, -3.4);
  flashMesh.visible = false;
  group.add(flashMesh);

  castReceive(group, true, false);
  group.scale.setScalar(0.62);
  return { group, drum, flash, flashMesh };
}

// ---------------------------------------------------------------------------
// HP marker: a small candle whose flame gutters out as a life is lost
// (compact, so it doesn't crowd the table)
// ---------------------------------------------------------------------------

export interface HpMarker {
  group: THREE.Group;
  /** The flame mesh — hidden when the life is spent. */
  flame: THREE.Mesh;
  /** Flame material whose emissive flickers. */
  glowMat: THREE.MeshStandardMaterial;
  /** The melting wax column — shrinks when the life is spent. */
  wax: THREE.Mesh;
  light: THREE.PointLight;
}

export function buildHpMarker(): HpMarker {
  const group = new THREE.Group();
  const waxMat = matte(PAL.bone, 0.6);

  // A small brass dish the candle stands in.
  const dish = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.22, 0.06, 16),
    metalMat(PAL.brass, 0.45),
  );
  dish.position.y = 0.03;
  group.add(dish);

  // Wax column — leaning slightly, half-melted.
  const wax = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.5, 12), waxMat);
  wax.position.y = 0.3;
  wax.rotation.z = 0.05;
  group.add(wax);
  // Drips of hardened wax running down the sides into the dish.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.7;
    const dripLen = 0.12 + Math.random() * 0.22;
    const drip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.032, dripLen, 6),
      waxMat,
    );
    drip.position.set(Math.cos(a) * 0.12, 0.55 - dripLen / 2, Math.sin(a) * 0.12);
    group.add(drip);
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 6), waxMat);
    bead.position.set(Math.cos(a) * 0.13, 0.55 - dripLen, Math.sin(a) * 0.13);
    group.add(bead);
  }
  // A pooled blob of wax in the dish.
  const pool = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), waxMat);
  pool.scale.set(1, 0.28, 1);
  pool.position.y = 0.07;
  group.add(pool);

  // Wick.
  const wick = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, 0.08, 4),
    matte(0x1a140e, 0.9),
  );
  wick.position.y = 0.57;
  group.add(wick);

  // Teardrop flame (emissive).
  const glowMat = glow(0xffb24a, 2.6);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.26, 10), glowMat);
  flame.position.y = 0.72;
  group.add(flame);
  // A faint blue base to the flame.
  const flameBase = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 8, 8),
    glow(0x6fa8ff, 1.2),
  );
  flameBase.position.y = 0.62;
  group.add(flameBase);

  const light = new THREE.PointLight(0xffa030, 0.5, 2.2, 2);
  light.position.set(0, 0.75, 0);
  group.add(light);

  castReceive(wax, true, false);
  castReceive(dish, true, false);
  return { group, flame, glowMat, wax, light };
}

// ---------------------------------------------------------------------------
// Item tokens: a distinct little 3D model per item, on a small base tile
// ---------------------------------------------------------------------------

/** A physical item slot: an open box on the table that may hold one item. */
export interface ItemSlot {
  group: THREE.Group;
  /** Where the held item's model is parented (cleared/refilled by the renderer). */
  contents: THREE.Group;
  /** The slot frame material (dim when empty, brass-lit when filled). */
  rimMat: THREE.MeshStandardMaterial;
}

/**
 * Build one painted item "zone" on the felt: a flat chalk-outlined rectangle
 * (like Buckshot's table) that an item lies inside. Six of these sit in front
 * of each participant.
 */
export function buildItemSlot(): ItemSlot {
  const group = new THREE.Group();
  const S = 0.7; // zone footprint
  const len = 0.16; // corner-tick length
  const bar = 0.035;
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x9a8f78,
    emissive: 0x14110c,
    emissiveIntensity: 0.3,
    roughness: 0.85,
    transparent: true,
    opacity: 0.55,
  });

  // Minimalist: four faint corner ticks (no fill, no full border).
  const h = S / 2;
  const mk = (w: number, d: number, x: number, z: number): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), rimMat);
    m.position.set(x, 0.025, z);
    return m;
  };
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      group.add(mk(len, bar, sx * (h - len / 2), sz * h)); // horizontal tick
      group.add(mk(bar, len, sx * h, sz * (h - len / 2))); // vertical tick
    }
  }

  const contents = new THREE.Group();
  contents.position.y = 0.06;
  contents.scale.setScalar(1.25);
  group.add(contents);

  return { group, contents, rimMat };
}

/** The distinctive little object for each item type, centred at the origin. */
export function buildItemContents(item: ItemType): THREE.Group {
  const g = new THREE.Group();
  const dark = metalMat(PAL.steelDark, 0.5);

  switch (item) {
    case "MAGNIFYING_GLASS": {
      // Lies flat: dark metal rim + glass lens, with a black octagonal handle
      // extending out to one side (matching the reference photo).
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.17, 0.04, 8, 12),
        metalMat(0x3a3a3e, 0.5),
      );
      rim.rotation.x = Math.PI / 2;
      rim.position.set(-0.05, 0.06, -0.05);
      g.add(rim);
      const lens = new THREE.Mesh(
        new THREE.CylinderGeometry(0.15, 0.15, 0.03, 16),
        new THREE.MeshStandardMaterial({
          color: 0xaeb6bc,
          metalness: 0.2,
          roughness: 0.05,
          transparent: true,
          opacity: 0.45,
        }),
      );
      lens.position.set(-0.05, 0.06, -0.05);
      g.add(lens);
      // Black octagonal handle.
      const handle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.055, 0.42, 8),
        matte(0x111114, 0.55),
      );
      handle.rotation.set(0, 0, Math.PI / 2);
      handle.rotation.y = -0.7;
      handle.position.set(0.22, 0.06, 0.16);
      g.add(handle);
      const collar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 0.06, 8),
        metalMat(0x4a4a50, 0.45),
      );
      collar.rotation.set(0, 0, Math.PI / 2);
      collar.rotation.y = -0.7;
      collar.position.set(0.07, 0.06, 0.04);
      g.add(collar);
      break;
    }
    case "SPEED_LOADER": {
      // A flat star-shaped moon clip: a steel disc with a centre hole and six
      // scalloped cut-outs around the rim (matching the reference).
      const steelClip = metalMat(0x8a8a90, 0.45);
      const ring = new THREE.Mesh(
        new THREE.CylinderGeometry(0.26, 0.26, 0.05, 6),
        steelClip,
      );
      ring.position.y = 0.06;
      g.add(ring);
      // Centre hole (dark) + six rim scallops carved by dark cylinders.
      const hole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.1, 0.08, 16),
        matte(0x0a0a0c, 0.8),
      );
      hole.position.y = 0.08;
      g.add(hole);
      const scallopMat = matte(0x0a0a0c, 0.8);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const s = new THREE.Mesh(
          new THREE.CylinderGeometry(0.075, 0.075, 0.09, 12),
          scallopMat,
        );
        s.position.set(Math.cos(a) * 0.26, 0.08, Math.sin(a) * 0.26);
        g.add(s);
      }
      break;
    }
    case "MEDKIT": {
      // An energy-drink can (the in-fiction "medkit"): blue body, silver rims,
      // a white lightning bolt, and a pull-tab top — standing upright.
      const can = new THREE.Mesh(
        new THREE.CylinderGeometry(0.15, 0.15, 0.42, 20),
        new THREE.MeshStandardMaterial({ color: 0x1b50c0, metalness: 0.5, roughness: 0.35 }),
      );
      can.position.y = 0.21;
      g.add(can);
      const rimTop = new THREE.Mesh(
        new THREE.CylinderGeometry(0.15, 0.15, 0.05, 20),
        metalMat(0xb8bcc4, 0.3),
      );
      rimTop.position.y = 0.43;
      g.add(rimTop);
      const rimBot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.15, 0.15, 0.05, 20),
        metalMat(0xb8bcc4, 0.3),
      );
      rimBot.position.y = 0.02;
      g.add(rimBot);
      // White lightning bolt on the side (two angled slivers).
      const boltMat = glow(0xeef2ff, 0.5);
      const b1 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.02), boltMat);
      b1.position.set(0.02, 0.24, 0.15);
      b1.rotation.z = 0.5;
      const b2 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.02), boltMat);
      b2.position.set(-0.02, 0.16, 0.15);
      b2.rotation.z = 0.5;
      g.add(b1, b2);
      break;
    }
    case "HANDCUFFS": {
      // Two dark-steel cuff rings joined by a short chain (lying flat).
      const cuffMat = metalMat(0x4a4a4e, 0.45);
      const ring = (): THREE.Mesh =>
        new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.035, 10, 22), cuffMat);
      const a = ring();
      a.rotation.x = Math.PI / 2;
      a.position.set(-0.2, 0.05, 0);
      const b = ring();
      b.rotation.x = Math.PI / 2;
      b.position.set(0.2, 0.05, 0);
      g.add(a, b);
      // Chain links between them.
      const linkGeo = new THREE.TorusGeometry(0.035, 0.014, 8, 14);
      for (let i = 0; i < 3; i++) {
        const link = new THREE.Mesh(linkGeo, dark);
        link.rotation.x = i % 2 === 0 ? Math.PI / 2 : 0;
        link.position.set(-0.07 + i * 0.07, 0.05, 0);
        g.add(link);
      }
      break;
    }
    case "INVERTER": {
      // A dark metal box with a recessed face plate, corner screws and a
      // glowing amber toggle switch (matching the reference).
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.34, 0.28, 0.3),
        matte(0x1a1a1e, 0.6),
      );
      box.position.y = 0.16;
      g.add(box);
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(0.26, 0.2, 0.02),
        matte(0x101013, 0.7),
      );
      plate.position.set(0, 0.18, 0.16);
      g.add(plate);
      // Corner screws.
      const screwMat = metalMat(0x6a6a70, 0.4);
      for (const [sx, sy] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) {
        const sc = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.02, 6), screwMat);
        sc.rotation.x = Math.PI / 2;
        sc.position.set(sx * 0.1, 0.18 + sy * 0.07, 0.17);
        g.add(sc);
      }
      // Glowing amber ring + hex nut + toggle lever.
      const glowRing = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.018, 8, 20), glow(0xffa028, 2.4));
      glowRing.position.set(0, 0.18, 0.17);
      g.add(glowRing);
      const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 6), metalMat(0x55555c, 0.4));
      nut.rotation.x = Math.PI / 2;
      nut.position.set(0, 0.18, 0.18);
      g.add(nut);
      const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.16, 8), metalMat(0x70707a, 0.35));
      lever.position.set(-0.06, 0.16, 0.24);
      lever.rotation.z = 0.7;
      g.add(lever);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), metalMat(0x80808a, 0.3));
      tip.position.set(-0.12, 0.13, 0.27);
      g.add(tip);
      break;
    }
    case "HOLLOW_POINT": {
      // A small glass vial of dark serum with a worn metal cap — you coat the
      // next round in it for double damage (matching the reference).
      const glassMat = new THREE.MeshStandardMaterial({
        color: 0xcfd6d2,
        metalness: 0.1,
        roughness: 0.05,
        transparent: true,
        opacity: 0.28,
      });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.34, 16), glassMat);
      body.position.y = 0.2;
      g.add(body);
      // Dark serum filling most of the vial.
      const serum = new THREE.Mesh(
        new THREE.CylinderGeometry(0.085, 0.085, 0.24, 16),
        new THREE.MeshStandardMaterial({ color: 0x1a0606, roughness: 0.4 }),
      );
      serum.position.y = 0.17;
      g.add(serum);
      // Neck + worn metal cap.
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.06, 12), glassMat);
      neck.position.y = 0.4;
      g.add(neck);
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.075, 0.075, 0.08, 12),
        metalMat(0x6a665e, 0.6),
      );
      cap.position.y = 0.46;
      g.add(cap);
      break;
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Blood burst: a reusable pool of particles for a live-round hit
// ---------------------------------------------------------------------------

export interface BloodBurst {
  group: THREE.Group;
  particles: BloodParticle[];
}

export interface BloodParticle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
}

/**
 * Build a reusable blood-burst emitter: a pool of small dark-red particles,
 * hidden until the renderer triggers a burst by seeding velocities. The renderer
 * advances them under gravity and fades them out.
 */
export function buildBloodBurst(count = 150): BloodBurst {
  const group = new THREE.Group();
  group.visible = false;
  const particles: BloodParticle[] = [];
  const geo = new THREE.SphereGeometry(0.09, 6, 6);
  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color: PAL.blood,
      emissive: 0x300000,
      emissiveIntensity: 0.4,
      roughness: 0.6,
      transparent: true,
      opacity: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    group.add(mesh);
    particles.push({ mesh, vel: new THREE.Vector3() });
  }
  return { group, particles };
}

// ---------------------------------------------------------------------------
// Shell token: a standing cartridge (red = live, grey = blank)
// ---------------------------------------------------------------------------

export function buildShell(live: boolean): THREE.Group {
  const g = new THREE.Group();
  const brass = metalMat(PAL.brass, 0.3);
  const casing = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.46, 16), brass);
  casing.position.y = 0.23;
  g.add(casing);
  // Rim at the base.
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.05, 16), brass);
  rim.position.y = 0.025;
  g.add(rim);

  if (live) {
    // A copper round-nose bullet seated in the case (the LIVE round).
    const copper = metalMat(0xb87333, 0.3);
    const nose = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 14, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      copper,
    );
    nose.scale.set(1, 1.5, 1);
    nose.position.y = 0.46;
    g.add(nose);
  } else {
    // An empty case with a dark hollow mouth (the BLANK round).
    const mouth = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.12, 0.08, 16),
      matte(0x14140f, 0.7),
    );
    mouth.position.y = 0.47;
    g.add(mouth);
  }

  castReceive(g, true, false);
  return g;
}

// ---------------------------------------------------------------------------
// Street lamp: a tall gooseneck post with a downward lamp head (2nd light)
// ---------------------------------------------------------------------------

export interface MiniLamp {
  group: THREE.Group;
  /** Warm light at the lamp head; flickers / blinks in the renderer. */
  light: THREE.PointLight;
  /** Emissive lamp-lens material. */
  glowMat: THREE.MeshStandardMaterial;
  /** The glowing lens mesh under the head. */
  flame: THREE.Mesh;
  /** World-space offset of the lamp head within the group (for the fly swarm). */
  headOffset: THREE.Vector3;
}

export function buildMiniLamp(): MiniLamp {
  const group = new THREE.Group();
  // Weathered teal metal, like the reference sprite.
  const metal = new THREE.MeshStandardMaterial({
    color: 0x33595a,
    roughness: 0.45,
    metalness: 0.7,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x1c3334,
    roughness: 0.5,
    metalness: 0.7,
  });

  const POST_H = 6.4;

  // Teardrop base (wide bulb at the bottom).
  const baseBulb = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 14), metal);
  baseBulb.scale.set(1, 1.3, 1);
  baseBulb.position.y = 0.6;
  group.add(baseBulb);
  const baseCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.34, 0.3, 14), dark);
  baseCollar.position.y = 1.25;
  group.add(baseCollar);

  // Main post.
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, POST_H, 14), metal);
  post.position.y = 1.4 + POST_H / 2;
  group.add(post);
  // Upper collar where the gooseneck begins.
  const topCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.3, 14), dark);
  topCollar.position.y = 1.4 + POST_H - 0.6;
  group.add(topCollar);

  // Gooseneck: a 180° tube arc bending up and over toward -X.
  const armR = 1.25;
  const armY = 1.4 + POST_H;
  const arc = new THREE.Mesh(
    new THREE.TorusGeometry(armR, 0.15, 10, 24, Math.PI),
    metal,
  );
  // Place the torus so its arc rises from the post top and comes down at -2R.
  arc.position.set(-armR, armY, 0);
  arc.rotation.z = 0; // arc spans the top half by default
  group.add(arc);

  // Lamp head: a downward-facing dome/cone at the end of the gooseneck.
  const headX = -armR * 2;
  const headY = armY - 0.1;
  const headOffset = new THREE.Vector3(headX, headY - 0.45, 0);

  const headTop = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), metal);
  headTop.position.set(headX, headY, 0);
  group.add(headTop);
  const headCone = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.5, 16), dark);
  headCone.position.set(headX, headY - 0.2, 0);
  group.add(headCone);

  // Glowing lens underneath the head.
  const glowMat = glow(0xffd27a, 3.0);
  const flame = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.16, 16), glowMat);
  flame.position.set(headX, headY - 0.5, 0);
  group.add(flame);

  // Warm light hanging at the head.
  const light = new THREE.PointLight(0xffc070, 14, 22, 2);
  light.position.set(headX, headY - 0.6, 0);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.bias = -0.0006;
  group.add(light);

  castReceive(baseBulb, true, true);
  castReceive(post, true, false);
  castReceive(arc, true, false);
  castReceive(headTop, true, false);
  castReceive(headCone, true, false);
  return { group, light, glowMat, flame, headOffset };
}

// ---------------------------------------------------------------------------
// Graveflies: slow drifting glowing motes for atmosphere
// ---------------------------------------------------------------------------

export interface Gravefly {
  mesh: THREE.Mesh;
  /** Orbit/drift parameters baked per fly. */
  cx: number;
  cy: number;
  cz: number;
  rx: number;
  rz: number;
  ry: number;
  speed: number;
  phase: number;
}

export interface Graveflies {
  group: THREE.Group;
  flies: Gravefly[];
}

export function buildGraveflies(count = 18): Graveflies {
  const group = new THREE.Group();
  const flies: Gravefly[] = [];
  const geo = new THREE.SphereGeometry(0.05, 6, 6);
  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffd27f,
      emissive: 0xffaa44,
      emissiveIntensity: 2.2,
      transparent: true,
      opacity: 0.85,
    });
    const mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);
    // A tight swarm clustered around the group origin (placed under the lamp).
    flies.push({
      cx: (Math.random() - 0.5) * 1.4,
      cy: (Math.random() - 0.5) * 1.6,
      cz: (Math.random() - 0.5) * 1.4,
      rx: 0.3 + Math.random() * 0.9,
      rz: 0.3 + Math.random() * 0.9,
      ry: 0.2 + Math.random() * 0.6,
      speed: 0.6 + Math.random() * 1.4,
      phase: Math.random() * Math.PI * 2,
      mesh,
    });
  }
  return { group, flies };
}

export interface Briefcase {
  group: THREE.Group;
  lid: THREE.Group;
}

export function buildBriefcase(): Briefcase {
  const group = new THREE.Group();
  
  const caseMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8, metalness: 0.2 });
  
  // Base
  const baseBox = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.6, 1.5), caseMat);
  baseBox.position.y = 0.3;
  group.add(baseBox);
  
  // Lid (Hinged at the back: z = -0.75)
  const lid = new THREE.Group();
  lid.position.set(0, 0.6, -0.75); // Hinge position
  
  const lidBox = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.3, 1.5), caseMat);
  lidBox.position.set(0, 0.15, 0.75); // Offset so hinge is at back
  lid.add(lidBox);
  
  group.add(lid);
  
  castReceive(group, true, true);
  return { group, lid };
}

export function buildRoundBoard(): THREE.Group {
  const group = new THREE.Group();
  
  // 1. The wooden board (base)
  const boardMat = new THREE.MeshStandardMaterial({ 
    color: 0x3a2a1a,
    roughness: 0.9, 
    metalness: 0.1
  });
  const board = new THREE.Mesh(new THREE.BoxGeometry(5.0, 1.6, 0.3), boardMat);
  group.add(board);
  
  // 2. The text canvas plane (placed slightly in front of the board)
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#3a2a1a';
    ctx.fillRect(0, 0, 1024, 256);
  }
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  
  const textMat = new THREE.MeshStandardMaterial({ 
    map: texture,
    emissiveMap: texture,
    emissive: 0xffffff,
    emissiveIntensity: 0.4,
    transparent: true
  });
  // Aspect ratio is 4:1, so 4.8 x 1.2 fits nicely inside the 5.0 x 1.6 board.
  const textPlane = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 1.2), textMat);
  textPlane.position.set(0, 0, 0.17); // Slightly in front of the board (+Z) to avoid Z-fighting
  textPlane.userData = { canvas, ctx, texture };
  group.add(textPlane);
  
  // Second text plane on the back
  const textPlane2 = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 1.2), textMat);
  textPlane2.position.set(0, 0, -0.17); // Slightly behind the board (-Z)
  textPlane2.rotation.y = Math.PI; // Face the enemy
  group.add(textPlane2);
  
  // Chains
  const chainMat = new THREE.MeshStandardMaterial({ 
    color: 0x888888, 
    roughness: 0.6, 
    metalness: 0.8 
  });
  const buildChainLinks = () => {
    const cg = new THREE.Group();
    const torusGeo = new THREE.TorusGeometry(0.12, 0.04, 8, 16);
    // 30 links to make it long enough (10 units tall roughly)
    for (let i = 0; i < 60; i++) {
      const link = new THREE.Mesh(torusGeo, chainMat);
      link.position.set(0, i * 0.18, 0); // 0.18 spacing for interlocking
      link.rotation.y = i % 2 === 0 ? 0 : Math.PI / 2; // Alternate rotation
      link.rotation.x = Math.PI / 2; // Stand vertically
      cg.add(link);
    }
    return cg;
  };
  
  const c1 = buildChainLinks();
  c1.position.set(-2.0, 0.5, 0);
  group.add(c1);
  
  const c2 = buildChainLinks();
  c2.position.set(2.0, 0.5, 0);
  group.add(c2);
  
  castReceive(group, true, true);
  return group;
}

export function updateRoundBoardText(group: THREE.Group, text: string, desc: string): void {
  // textPlane is the second child (index 1)
  const textPlane = group.children[1] as THREE.Mesh;
  if (!textPlane || !textPlane.userData || !textPlane.userData.ctx) return;
  
  const canvas = textPlane.userData.canvas as HTMLCanvasElement;
  const ctx = textPlane.userData.ctx as CanvasRenderingContext2D;
  const texture = textPlane.userData.texture as THREE.CanvasTexture;
  
  // Clear with transparent or wood color (we'll use wood color to blend with board)
  ctx.fillStyle = '#3a2a1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Draw some wood grain lines for detail
  ctx.fillStyle = '#2a1a0a';
  for (let i = 0; i < 20; i++) {
    ctx.fillRect(0, Math.random() * canvas.height, canvas.width, Math.random() * 5 + 1);
  }

  // Draw scratches/damage (deep gouges)
  ctx.strokeStyle = '#1a0a05'; // Dark, deep color
  ctx.lineCap = 'round';
  for (let i = 0; i < 15; i++) {
    ctx.lineWidth = Math.random() * 4 + 1;
    ctx.beginPath();
    let startX = Math.random() * canvas.width;
    let startY = Math.random() * canvas.height;
    ctx.moveTo(startX, startY);
    // Scratches are usually somewhat straight but jagged
    ctx.lineTo(startX + (Math.random() - 0.5) * 200, startY + (Math.random() - 0.5) * 100);
    ctx.stroke();
  }

  // Draw blood splatters
  for (let i = 0; i < 40; i++) {
    // Random position, heavily weighted towards edges
    let bx = Math.random() > 0.5 ? Math.random() * 300 : canvas.width - Math.random() * 300;
    let by = Math.random() > 0.5 ? Math.random() * 100 : canvas.height - Math.random() * 100;
    
    // Sometimes put blood right in the middle
    if (Math.random() > 0.8) {
      bx = Math.random() * canvas.width;
      by = Math.random() * canvas.height;
    }

    ctx.fillStyle = `rgba(100, 0, 0, ${Math.random() * 0.7 + 0.3})`; // Dark dried blood
    ctx.beginPath();
    ctx.arc(bx, by, Math.random() * 15 + 2, 0, Math.PI * 2);
    ctx.fill();
    
    // Add small satellite splatters around the main one
    for (let j = 0; j < 3; j++) {
      ctx.beginPath();
      ctx.arc(bx + (Math.random() - 0.5) * 40, by + (Math.random() - 0.5) * 40, Math.random() * 5 + 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  
  // Draw main text
  ctx.fillStyle = '#d9cdb4'; // Chalk color
  ctx.font = 'bold 90px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  // Add slight shadow
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetX = 4;
  ctx.shadowOffsetY = 4;
  
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 - 20);

  // Draw sub text (desc)
  ctx.fillStyle = '#9a3b33'; // Reddish chalk
  ctx.font = 'bold 36px "Courier New", monospace';
  ctx.fillText(desc, canvas.width / 2, canvas.height / 2 + 50);
  
  texture.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Betting chip: a round poker-chip-style disc with a revolver engraving
// ---------------------------------------------------------------------------

export interface BetChip {
  group: THREE.Group;
  value: number;
}

export function buildBetChip(value: number): BetChip {
  const group = new THREE.Group();

  // A heavy, aged brass coin with a reeded (ridged) edge and a raised
  // revolver relief pressed into a recessed inner face.
  const brass = new THREE.MeshStandardMaterial({
    color: 0xb08d3a,
    metalness: 0.75,
    roughness: 0.35,
  });
  const brassLight = new THREE.MeshStandardMaterial({
    color: 0xc9a04a,
    metalness: 0.7,
    roughness: 0.3,
  });
  const brassDark = new THREE.MeshStandardMaterial({
    color: 0x7a5a1e,
    metalness: 0.65,
    roughness: 0.45,
  });

  const coinH = 0.08; // thick coin
  const R = 0.28; // coin radius
  const count = value >= 10000 ? 8 : value >= 1000 ? 4 : 1;

  for (let i = 0; i < count; i++) {
    const y = i * coinH;
    // Main disc.
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(R, R, coinH, 36), brass);
    disc.position.y = y + coinH / 2;
    group.add(disc);
    // Reeded edge: many small vertical ribs around the circumference.
    const ribGeo = new THREE.BoxGeometry(0.012, coinH * 0.7, 0.02);
    for (let r = 0; r < 28; r++) {
      const a = (r / 28) * Math.PI * 2;
      const rib = new THREE.Mesh(ribGeo, brassDark);
      rib.position.set(
        Math.cos(a) * (R + 0.005),
        y + coinH / 2,
        Math.sin(a) * (R + 0.005),
      );
      rib.rotation.y = a;
      group.add(rib);
    }
    // Raised rim border on top and bottom faces.
    const rimTop = new THREE.Mesh(new THREE.TorusGeometry(R - 0.03, 0.018, 6, 28), brassLight);
    rimTop.rotation.x = Math.PI / 2;
    rimTop.position.y = y + coinH;
    group.add(rimTop);
  }

  // Top face: a recessed inner circle with the revolver relief.
  const topY = count * coinH;
  const recess = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.78, R * 0.78, 0.015, 28), brassDark);
  recess.position.y = topY + 0.005;
  group.add(recess);
  // Inner rim ring.
  const innerRim = new THREE.Mesh(new THREE.TorusGeometry(R * 0.78, 0.014, 6, 28), brassLight);
  innerRim.rotation.x = Math.PI / 2;
  innerRim.position.y = topY + 0.015;
  group.add(innerRim);

  // Revolver relief (raised on the recessed face).
  const relief = brassLight;
  const rY = topY + 0.018;
  // Frame/body block.
  const frame = new THREE.Mesh(new THREE.BoxGeometry(R * 0.35, 0.015, R * 0.22), relief);
  frame.position.set(0, rY, 0);
  group.add(frame);
  // Barrel (long, extending right).
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, R * 0.55, 10), relief);
  barrel.rotation.z = Math.PI / 2;
  barrel.position.set(R * 0.32, rY, -0.01);
  group.add(barrel);
  // Cylinder drum (round, prominent).
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.18, R * 0.18, 0.02, 14), relief);
  drum.position.set(-R * 0.02, rY + 0.005, 0);
  group.add(drum);
  // Grip (angled down-right from frame).
  const gripBlock = new THREE.Mesh(new THREE.BoxGeometry(R * 0.18, 0.015, R * 0.35), relief);
  gripBlock.position.set(-R * 0.12, rY, R * 0.22);
  gripBlock.rotation.y = 0.2;
  group.add(gripBlock);
  // Trigger guard arc.
  const guard = new THREE.Mesh(new THREE.TorusGeometry(R * 0.1, 0.014, 6, 12, Math.PI), relief);
  guard.rotation.x = Math.PI / 2;
  guard.position.set(R * 0.02, rY, R * 0.1);
  group.add(guard);
  // Hammer spur (small nub at back-top).
  const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.03), relief);
  hammer.position.set(-R * 0.18, rY + 0.01, -R * 0.08);
  group.add(hammer);

  castReceive(group, true, false);
  return { group, value };
}
