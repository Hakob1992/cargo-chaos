import * as THREE from 'three';
import { gsap } from 'gsap';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RAPIER } from '../core/Physics.js';
import { SHORTCUT_HAZARDS } from '../data/routes.js';

const TREE_FILES = ['Tree_1', 'Tree_2', 'Tree_3', 'Tree_4', 'Tree_5'];
const TREE_TARGET_H = 5.5;
const UP = new THREE.Vector3(0, 1, 0);

// Deterministic RNG (mulberry32) so the level is the same every load.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Phase 5 — a DESIGNED countryside level with a risk/reward fork. One shared
// farmyard stem leads to a signposted junction where two routes split and
// reconverge on the same delivery pad:
//
//   THE HIGHWAY    — long, wide, smooth sweepers all the way around.
//   FARM SHORTCUT  — cuts the loop: narrow track, mud pits, washboard bumps
//                    and a jump ramp.
//
// The route is chosen pre-run (Menu); a barricade physically closes the other
// branch so its laxer par can't be exploited. Terrain/scenery machinery is the
// same as the old procedural build (fbm terrain, instanced forests, farms) —
// only the road layout is authored now.
export class World {
  constructor(scene, physics) {
    this.scene = scene;
    this.physics = physics;
    this.world = physics.world;
    this.roadLift = 0.18;

    this._baseY = this.#fbm(0, 0); // so terrainY(0,0) ≈ 0 (clean spawn)

    const gen = this.#generateRoutes();
    this.stemPts = gen.stem;
    this.hwPts = gen.highway;
    this.scPts = gen.shortcut;
    this.forkPos = gen.fork;

    // Area bounds (all route points + margin) drive terrain + scatter extents.
    const bb = new THREE.Box3().setFromPoints([...gen.stem, ...gen.highway, ...gen.shortcut]);
    const M = 75;
    this.bounds = {
      minX: bb.min.x - M, maxX: bb.max.x + M,
      minZ: bb.min.z - M, maxZ: bb.max.z + M,
    };

    this.#buildLighting();
    this.#buildTerrain();
    this.#buildRoads();
    this.#buildDeliveryPad();
    this.#buildScenery();
    this.#animateAmbient();
    this.setActiveRoute('highway');
  }

  // ---- Ambient motion (GSAP) -----------------------------------------------
  // Slow, looping life: clouds drift + bob across the sky, the signpost creaks
  // in the wind, and the delivery-pad ring pulses like a "land here" beacon.
  #animateAmbient() {
    (this.clouds || []).forEach((s, i) => {
      const x0 = s.position.x;
      gsap.to(s.position, {
        x: x0 + 60 + i * 6, duration: 26 + i * 3,
        ease: 'sine.inOut', yoyo: true, repeat: -1,
      });
      gsap.to(s.position, {
        y: s.position.y + 3, duration: 7 + (i % 4),
        ease: 'sine.inOut', yoyo: true, repeat: -1, delay: i * 0.4,
      });
    });

    if (this.signpost) {
      gsap.to(this.signpost.rotation, {
        z: 0.025, duration: 2.6, ease: 'sine.inOut', yoyo: true, repeat: -1,
      });
    }

    if (this.deliveryRing) {
      gsap.to(this.deliveryRing.scale, {
        x: 1.12, y: 1.12, duration: 1.1, ease: 'sine.inOut', yoyo: true, repeat: -1,
      });
      gsap.to(this.deliveryRing.material, {
        emissiveIntensity: 1.4, duration: 1.1, ease: 'sine.inOut', yoyo: true, repeat: -1,
      });
    }
  }

  // ---- Terrain height (2D fbm value-noise) --------------------------------

  #vnoise(x, z) {
    const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
    const h = (a, b) => { const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return n - Math.floor(n); };
    const n00 = h(xi, zi), n10 = h(xi + 1, zi), n01 = h(xi, zi + 1), n11 = h(xi + 1, zi + 1);
    const nx0 = n00 + (n10 - n00) * u, nx1 = n01 + (n11 - n01) * u;
    return (nx0 + (nx1 - nx0) * v) * 2 - 1; // -1..1
  }

  #fbm(x, z) {
    let f = 0.011, amp = 2.7, sum = 0;
    for (let o = 0; o < 4; o++) { sum += this.#vnoise(x * f, z * f) * amp; f *= 2.03; amp *= 0.5; }
    return sum;
  }

  // Small, gentle elevation changes (a few metres). Flattened to a clean,
  // level clearing around the spawn point (0,6) so the truck spawns without
  // punching into a sloped surface, blending to full terrain by ~45 m out.
  terrainY(x, z) {
    const d = Math.hypot(x, z - 6);
    const flat = THREE.MathUtils.smoothstep(d, 14, 48); // 0 at spawn → 1 far
    return (this.#fbm(x, z) - this._baseY) * flat;
  }

  // ---- Designed route layout (Phase 5) -------------------------------------

  // Hand-authored fork layout. The stem heads out of the farmyard, the highway
  // sweeps a long arc east and back, and the shortcut cuts straight across the
  // inside of that arc with authored S-bend offsets. The shortcut is derived
  // analytically from fork→pad so both branches ALWAYS converge exactly.
  #generateRoutes() {
    const rng = mulberry32(20260608);

    // STEM — a straight-ish launch out of the farmyard, heading +Z.
    const stem = [new THREE.Vector3(0, 0, 0)];
    let x = 0, z = 0, h = 0; // h = heading; 0 → +Z
    for (let i = 0; i < 4; i++) {
      h += (rng() - 0.5) * 0.06;
      x += Math.sin(h) * 20; z += Math.cos(h) * 20;
      stem.push(new THREE.Vector3(x, 0, z));
    }
    const fork = stem[stem.length - 1].clone();

    // HIGHWAY — authored sweep: bend east, long diagonal, sweep back left,
    // then ease north into the pad. Gentle turns only (≤0.3 rad/step).
    const hwTurns = [
      0.36, 0.36, 0.3,                          // bend hard east — commit to the detour
      0.0, 0.0, 0.0, 0.0,                       // long diagonal north-east
      -0.18, -0.22, -0.24, -0.24, -0.22, -0.18, // big sweep back left
      0.0, 0.0, 0.0,                            // straight north-west
      0.1, 0.12, 0.08,                          // ease right, face north
      0.0, 0.0, 0.0, 0.0, 0.0,                  // long finish straight to the pad
    ];
    const highway = [];
    let hx = fork.x, hz = fork.z, hh = h;
    for (const turn of hwTurns) {
      let tt = turn + (rng() - 0.5) * 0.03;
      if (hx > 115) tt -= 0.2; else if (hx < -45) tt += 0.2; // stay in bounds
      hh += tt;
      hx += Math.sin(hh) * 23; hz += Math.cos(hh) * 23;
      highway.push(new THREE.Vector3(hx, 0, hz));
    }
    const pad = highway[highway.length - 1].clone();

    // SHORTCUT — cut the corner: blend the straight fork→pad line with authored
    // perpendicular S-bend offsets, pushed to the OPPOSITE side of the highway
    // bulge so the two branches never meet until the pad.
    const dir = new THREE.Vector2(pad.x - fork.x, pad.z - fork.z);
    const L = dir.length(); dir.normalize();
    const perp = new THREE.Vector2(dir.y, -dir.x); // (x,z) perpendicular
    const mid = highway[Math.floor(highway.length / 2)];
    const hwSide = Math.sign(perp.dot(new THREE.Vector2(mid.x - fork.x, mid.z - fork.z))) || 1;
    const side = -hwSide;
    // Offset amplitudes (m) along the cut — a wandering farm track with two
    // S-bends. Index 0 is the fork itself (amplitude 0, skipped below).
    const amps = [0, 9, 18, 24, 18, 4, -10, -16, -8, 6, 10, 3, 0];
    const shortcut = [];
    for (let k = 1; k < amps.length; k++) {
      const t = k / (amps.length - 1);
      shortcut.push(new THREE.Vector3(
        fork.x + dir.x * L * t + perp.x * amps[k] * side,
        0,
        fork.z + dir.y * L * t + perp.y * amps[k] * side
      ));
    }
    shortcut[shortcut.length - 1].copy(pad);

    return { stem, highway, shortcut, fork, pad };
  }

  // ---- Lighting / sky ------------------------------------------------------

  #buildLighting() {
    const hemi = new THREE.HemisphereLight(0xcfeaff, 0x9fc26a, 1.25);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff6e0, 2.1);
    sun.position.set(60, 90, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 140;
    sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
    sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
    sun.shadow.camera.far = 360;
    this.scene.add(sun);

    this.scene.fog = new THREE.Fog(0xcfeaff, 130, 480);
    this.scene.background = this.#makeSkyTexture();
    this.#buildClouds();
  }

  #makeSkyTexture() {
    const c = document.createElement('canvas'); c.width = 16; c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.0, '#4fa9e8'); g.addColorStop(0.45, '#86c9f2');
    g.addColorStop(0.78, '#c2e8fb'); g.addColorStop(1.0, '#e8f6ff');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 16, 256);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  #buildClouds() {
    const tex = this.#makeCloudTexture();
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.95 });
    const rng = mulberry32(99);
    this.clouds = [];
    for (let i = 0; i < 10; i++) {
      const s = new THREE.Sprite(mat);
      s.position.set((rng() - 0.5) * 500, 55 + rng() * 30, (rng()) * 360 - 30);
      const sc = 60 + rng() * 70; s.scale.set(sc, sc * 0.55, 1);
      this.scene.add(s);
      this.clouds.push(s);
    }
  }

  #makeCloudTexture() {
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d');
    const cx = S / 2, cy = S * 0.55, baseR = S * 0.16, outline = S * 0.022;
    const lobes = [{ a: 0, d: 0, s: 1.0 }]; const n = 9;
    for (let i = 0; i < n; i++) lobes.push({ a: Math.PI + (i / (n - 1)) * Math.PI, d: 0.85 + Math.random() * 0.25, s: 0.55 + Math.random() * 0.35 });
    for (let i = 0; i < 4; i++) lobes.push({ a: 0.2 + (i / 3) * 2.7, d: 0.55, s: 0.6 });
    const xy = (l) => [cx + Math.cos(l.a) * l.d * baseR * 2.4, cy + Math.sin(l.a) * l.d * baseR];
    ctx.fillStyle = '#5b8fb5'; for (const l of lobes) { const [x, y] = xy(l); ctx.beginPath(); ctx.arc(x, y, l.s * baseR + outline, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#ffffff'; for (const l of lobes) { const [x, y] = xy(l); ctx.beginPath(); ctx.arc(x, y, l.s * baseR, 0, 7); ctx.fill(); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ---- Textures ------------------------------------------------------------

  // Procedural cartoon asphalt: gray base with speckle + faint cracks, a dashed
  // yellow centre line, and white edge lines. U is clamped (markings stay put
  // across the width) and V repeats (dashes tile down the length). One tile is
  // 260 px = 2 dash cycles, so dashes line up seamlessly across tiles.
  #asphaltTexture() {
    if (this._asphaltTex) return this._asphaltTex;
    const W = 128, H = 260;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const rng = mulberry32(7);
    // Base + speckle for a hand-painted asphalt grain.
    ctx.fillStyle = '#73767e'; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 2600; i++) {
      const x = rng() * W, y = rng() * H, s = rng() * 1.5 + 0.4;
      const d = Math.floor((rng() - 0.5) * 44);
      ctx.fillStyle = `rgba(${112 + d},${115 + d},${123 + d},0.5)`;
      ctx.fillRect(x, y, s, s);
    }
    // A few faint cracks (nods to the cracked-street reference).
    ctx.strokeStyle = 'rgba(42,44,50,0.45)'; ctx.lineWidth = 1.4;
    for (let i = 0; i < 5; i++) {
      let x = rng() * W, y = rng() * H; ctx.beginPath(); ctx.moveTo(x, y);
      const segs = 3 + Math.floor(rng() * 3);
      for (let j = 0; j < segs; j++) { x += (rng() - 0.5) * 38; y += (rng() - 0.5) * 70; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    // White edge lines, inset slightly from each side.
    ctx.fillStyle = '#eceae3';
    ctx.fillRect(7, 0, 5, H); ctx.fillRect(W - 12, 0, 5, H);
    // Dashed yellow centre line — period 130 px (dash 70, gap 60).
    ctx.fillStyle = '#f4c542';
    for (let y = 0; y < H; y += 130) ctx.fillRect(W / 2 - 4, y, 8, 70);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    this._asphaltTex = tex;
    return tex;
  }

  #tex(file, rx = 1, ry = 1) {
    const t = new THREE.TextureLoader().load(`./textures/${file}`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.repeat.set(rx, ry); t.anisotropy = 4;
    return t;
  }

  // ---- Terrain mesh + collider --------------------------------------------

  #buildTerrain() {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const seg = 4; // metres per quad
    const cols = Math.ceil((maxX - minX) / seg);
    const rows = Math.ceil((maxZ - minZ) / seg);
    const positions = [], uvs = [];
    for (let r = 0; r <= rows; r++) {
      const z = minZ + (r / rows) * (maxZ - minZ);
      for (let c = 0; c <= cols; c++) {
        const x = minX + (c / cols) * (maxX - minX);
        positions.push(x, this.terrainY(x, z), z);
        uvs.push(x / 16, z / 16);
      }
    }
    const W = cols + 1, indices = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = r * W + c, b = a + 1, d = (r + 1) * W + c, e = d + 1;
        indices.push(a, d, b, b, d, e);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      map: this.#tex('grass.png'), color: 0x8ccf5a, roughness: 1,
    }));
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(new Float32Array(positions), new Uint32Array(indices)).setFriction(1.0),
      body
    );
  }

  // ---- Roads (stem + two branches) ------------------------------------------

  #buildRoads() {
    const curve = (head, pts) =>
      new THREE.CatmullRomCurve3([head.clone(), ...pts.map((p) => p.clone())], false, 'catmullrom', 0.5);

    const stemCurve = new THREE.CatmullRomCurve3(this.stemPts, false, 'catmullrom', 0.5);
    const hwCurve = curve(this.forkPos, this.hwPts);
    const scCurve = curve(this.forkPos, this.scPts);

    const stemS = stemCurve.getSpacedPoints(48);
    const hwS = hwCurve.getSpacedPoints(240);
    const scS = scCurve.getSpacedPoints(150);

    // Ribbons: highway wide & forgiving, shortcut narrow & mean (lifted a hair
    // so the overlapping fork joint doesn't z-fight).
    // All three ribbons are paved asphalt with lane markings.
    this.stemLen = this.#ribbon(stemS, 4.0, 4.8, 0, true);
    this.hwLen = this.#ribbon(hwS, 4.2, 5.4, 0, true);
    this.scLen = this.#ribbon(scS, 2.6, 3.4, 0.012, true);

    // Per-road drivable info for off-road queries: edge = half-width + grace.
    this._roads = [
      { samples: stemS, edge: 5.4 },
      { samples: hwS, edge: 5.8 },
      { samples: scS, edge: 3.9 },
    ];
    this._centerline = hwS; // scenery (farms/dirt paths) hangs off the highway

    this.deliveryPos = hwS[hwS.length - 1].clone();
    this.deliveryPos.y = this.terrainY(this.deliveryPos.x, this.deliveryPos.z);

    // A road-coloured disc at the junction masks the three ribbon seams.
    const patch = new THREE.Mesh(
      new THREE.CircleGeometry(7, 24),
      new THREE.MeshStandardMaterial({ color: 0x73767e, roughness: 0.95 })
    );
    patch.rotation.x = -Math.PI / 2;
    patch.position.set(this.forkPos.x, this.terrainY(this.forkPos.x, this.forkPos.z) + this.roadLift + 0.006, this.forkPos.z);
    patch.receiveShadow = true;
    this.scene.add(patch);

    // Shortcut hazards + the barricades that close the unchosen branch.
    this.#buildMud(scS);
    this.#buildBumps(scS);
    this.#buildRamp(scS);
    this.barriers = {
      highway: this.#buildBarrier(hwS, 5.0),
      shortcut: this.#buildBarrier(scS, 3.4),
    };
    this.#buildSignpost(stemS, hwS, scS);
  }

  // Build one road ribbon (mesh + trimesh collider) along `samples`, with the
  // half-width pinching from hwMax on straights to hwMin in tight corners.
  // Returns the centreline length in metres.
  #ribbon(samples, hwMin, hwMax, lift, paved = true) {
    const N = samples.length - 1;
    const hwArr = new Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const a = samples[Math.max(0, i - 1)], b = samples[i], c = samples[Math.min(N, i + 1)];
      const h1 = Math.atan2(b.x - a.x, b.z - a.z), h2 = Math.atan2(c.x - b.x, c.z - b.z);
      let dh = h2 - h1; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
      hwArr[i] = THREE.MathUtils.lerp(hwMax, hwMin, THREE.MathUtils.smoothstep(Math.abs(dh), 0.02, 0.12));
    }
    const hwSmooth = (i) => { let s = 0, n = 0; for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j <= N) { s += hwArr[j]; n++; } } return s / n; };

    const positions = [], uvs = [];
    const tan = new THREE.Vector3(), perp = new THREE.Vector3();
    let dist = 0;
    for (let i = 0; i <= N; i++) {
      const c = samples[i];
      const a = samples[Math.max(0, i - 1)], b = samples[Math.min(N, i + 1)];
      tan.set(b.x - a.x, 0, b.z - a.z).normalize();
      perp.set(tan.z, 0, -tan.x);
      const hw = hwSmooth(i);
      const y = this.terrainY(c.x, c.z) + this.roadLift + lift;
      if (i > 0) dist += Math.hypot(c.x - samples[i - 1].x, c.z - samples[i - 1].z);
      positions.push(
        c.x + perp.x * hw, y, c.z + perp.z * hw,
        c.x - perp.x * hw, y, c.z - perp.z * hw
      );
      // Width-normalised U (0=one edge, 1=other, 0.5=centreline) so lane
      // markings always track the road; V runs along the length (one asphalt
      // tile per 16 m → a dashed centre line every ~8 m).
      const v = dist / 16;
      uvs.push(0, v, 1, v);
    }
    const indices = [];
    for (let i = 0; i < N; i++) {
      const a = i * 2, b = a + 1, c = (i + 1) * 2, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    // Paved roads get the procedural asphalt (gray + dashed yellow centre line
    // + white edges); the dirt shortcut gets a flat warm tan.
    const mat = paved
      ? new THREE.MeshStandardMaterial({ map: this.#asphaltTexture(), roughness: 0.95, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({ color: 0xd9a85f, roughness: 1, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(new Float32Array(positions), new Uint32Array(indices)).setFriction(1.1),
      body
    );
    return dist;
  }

  // ---- Shortcut hazards -------------------------------------------------------

  // Mud pits at authored fractions along the shortcut — they cut tyre grip.
  #buildMud(scS) {
    this.mudPatches = [];
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a2c1c, roughness: 0.32, metalness: 0.05 });
    for (const f of SHORTCUT_HAZARDS.mud) {
      const c = scS[Math.floor(f * (scS.length - 1))];
      const r = 4.2;
      this.mudPatches.push({ x: c.x, z: c.z, r });
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 22), mat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(c.x, this.terrainY(c.x, c.z) + this.roadLift + 0.025, c.z);
      disc.receiveShadow = true;
      this.scene.add(disc);
    }
  }

  // Washboard bump strips: low bars across the track that kick cargo airborne.
  #buildBumps(scS) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a6f4d, roughness: 1 });
    const geo = new THREE.BoxGeometry(7.2, 0.14, 0.44);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const q = new THREE.Quaternion();
    for (const f of SHORTCUT_HAZARDS.bumpClusters) {
      const base = Math.floor(f * (scS.length - 1));
      for (let b = 0; b < SHORTCUT_HAZARDS.bumpsPerCluster; b++) {
        const i = Math.min(scS.length - 2, base + b * SHORTCUT_HAZARDS.bumpSpacingSamples);
        const c = scS[i], n = scS[i + 1];
        const yaw = Math.atan2(n.x - c.x, n.z - c.z);
        const y = this.terrainY(c.x, c.z) + this.roadLift + 0.05;
        q.setFromAxisAngle(UP, yaw);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(c.x, y, c.z);
        mesh.quaternion.copy(q);
        mesh.castShadow = true; mesh.receiveShadow = true;
        this.scene.add(mesh);
        this.world.createCollider(
          RAPIER.ColliderDesc.cuboid(3.6, 0.07, 0.22)
            .setTranslation(c.x, y, c.z)
            .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
            .setFriction(1.0),
          body
        );
      }
    }
  }

  // The jump: a plank ramp across the track. Hit it fast for air (style!), but
  // the landing is the cargo's problem.
  #buildRamp(scS) {
    const i = Math.floor(SHORTCUT_HAZARDS.ramp * (scS.length - 1));
    const c = scS[i], n = scS[Math.min(scS.length - 1, i + 1)];
    const yaw = Math.atan2(n.x - c.x, n.z - c.z);
    const PITCH = 0.21; // rad — launch angle
    const qYaw = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -PITCH);
    const q = qYaw.clone().multiply(qPitch);
    const y = this.terrainY(c.x, c.z) + this.roadLift + Math.sin(PITCH) * 1.6 * 0.55;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(6.8, 0.24, 3.2),
      new THREE.MeshStandardMaterial({ color: 0xb8915f, roughness: 0.9 })
    );
    mesh.position.set(c.x, y, c.z);
    mesh.quaternion.copy(q);
    mesh.castShadow = true; mesh.receiveShadow = true;
    this.scene.add(mesh);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(3.4, 0.12, 1.6)
        .setTranslation(c.x, y, c.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setFriction(1.1),
      body
    );
    this.rampPos = { x: c.x, z: c.z };
  }

  // ---- Barricades + signpost ---------------------------------------------------

  // A striped sawhorse across a branch entrance, a few metres past the fork.
  // Built once per branch; setActiveRoute() shows/enables exactly one of them.
  #buildBarrier(samples, halfWidth) {
    const i = 7;
    const c = samples[i], n = samples[i + 1];
    const yaw = Math.atan2(n.x - c.x, n.z - c.z);
    const y = this.terrainY(c.x, c.z) + this.roadLift;

    const g = new THREE.Group();
    g.position.set(c.x, y, c.z);
    g.rotation.y = yaw;
    const post = new THREE.MeshStandardMaterial({ color: 0x6b5535, roughness: 0.9 });
    const w = halfWidth + 0.6;
    for (const px of [-w + 0.5, w - 0.5]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.05, 0.22), post);
      p.position.set(px, 0.52, 0); p.castShadow = true; g.add(p);
    }
    const plank = new THREE.Mesh(
      new THREE.BoxGeometry(w * 2, 0.32, 0.1),
      new THREE.MeshStandardMaterial({ color: 0xd0452b, roughness: 0.8 })
    );
    plank.position.y = 0.82; plank.castShadow = true; g.add(plank);
    const plank2 = new THREE.Mesh(
      new THREE.BoxGeometry(w * 2, 0.18, 0.1),
      new THREE.MeshStandardMaterial({ color: 0xf2e8cf, roughness: 0.8 })
    );
    plank2.position.y = 0.5; plank2.castShadow = true; g.add(plank2);
    this.scene.add(g);

    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(w, 0.6, 0.12)
        .setTranslation(c.x, y + 0.6, c.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
      body
    );
    return { group: g, collider };
  }

  // Fork signpost: a pole beside the junction with one arrow plank per branch.
  #buildSignpost(stemS, hwS, scS) {
    const f = this.forkPos;
    // Plant it beside the stem, out of the roadway.
    const a = stemS[stemS.length - 2], b = stemS[stemS.length - 1];
    const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1;
    const px = f.x + (tz / tl) * 7.5, pz = f.z + (-tx / tl) * 7.5;
    const py = this.terrainY(px, pz);

    const g = new THREE.Group();
    g.position.set(px, py, pz);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.16, 3.0, 8),
      new THREE.MeshStandardMaterial({ color: 0x6b5535, roughness: 0.9 })
    );
    pole.position.y = 1.5; pole.castShadow = true; g.add(pole);

    const mkPlank = (text, towards, yLevel, tint) => {
      const cnv = document.createElement('canvas'); cnv.width = 512; cnv.height = 96;
      const ctx = cnv.getContext('2d');
      ctx.fillStyle = '#f2e8cf'; ctx.fillRect(0, 0, 512, 96);
      ctx.strokeStyle = '#2c2014'; ctx.lineWidth = 10; ctx.strokeRect(5, 5, 502, 86);
      ctx.fillStyle = tint; ctx.font = 'bold 52px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, 256, 52);
      const tex = new THREE.CanvasTexture(cnv); tex.colorSpace = THREE.SRGBColorSpace;
      const plank = new THREE.Mesh(
        new THREE.BoxGeometry(3.0, 0.6, 0.08),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 })
      );
      // Point the plank's long axis along the branch's initial heading.
      const h = Math.atan2(towards.x - f.x, towards.z - f.z);
      plank.rotation.y = h - Math.PI / 2;
      plank.position.y = yLevel;
      plank.castShadow = true;
      g.add(plank);
    };
    mkPlank('HIGHWAY →', hwS[10], 2.6, '#1f7a44');
    mkPlank('SHORTCUT →', scS[10], 2.0, '#b23a1e');
    this.scene.add(g);
    this.signpost = g;
  }

  // ---- Route selection (Phase 5 API) -------------------------------------------

  // Open the chosen branch and barricade the other. Sets routeLength for par.
  setActiveRoute(routeId) {
    this.activeRouteId = routeId === 'shortcut' ? 'shortcut' : 'highway';
    const closed = this.activeRouteId === 'shortcut' ? 'highway' : 'shortcut';
    for (const [id, bar] of Object.entries(this.barriers)) {
      const on = id === closed;
      bar.group.visible = on;
      bar.collider.setEnabled(on);
    }
    this.routeLength = this.stemLen + (this.activeRouteId === 'shortcut' ? this.scLen : this.hwLen);
  }

  // Centreline length (m) of a route choice, for the pre-run menu.
  lengthOf(routeId) {
    return this.stemLen + (routeId === 'shortcut' ? this.scLen : this.hwLen);
  }

  // Grip multiplier at a world position (1 = full, lower on mud).
  // Accepts a Vector3 or (x, z) — Game passes the truck position object.
  gripAt(p, maybeZ) {
    const x = typeof p === 'object' ? p.x : p;
    const z = typeof p === 'object' ? p.z : maybeZ;
    if (!this.mudPatches) return 1;
    let g = 1;
    for (const m of this.mudPatches) {
      const d = Math.hypot(x - m.x, z - m.z);
      if (d < m.r) g = Math.min(g, 0.3 + 0.7 * THREE.MathUtils.smoothstep(d, m.r * 0.45, m.r));
    }
    return g;
  }

  // Min distance from (x,z) to ANY road centreline (coarse, fast enough).
  #distToRoad(x, z) {
    let best = 1e9;
    for (const road of this._roads) {
      const s = road.samples, step = 3;
      for (let i = 0; i < s.length; i += step) {
        const dx = s[i].x - x, dz = s[i].z - z; const d = dx * dx + dz * dz;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  }

  // How far (in metres) a world position lies BEYOND the drivable road edge.
  // Each road carries its own edge (the narrow shortcut forgives less).
  // Parking on the delivery pad never counts as off-road.
  offRoadDistance(x, z) {
    if (this.deliveryPos) {
      const pd = Math.hypot(x - this.deliveryPos.x, z - this.deliveryPos.z);
      if (pd < 6) return 0;
    }
    let best = 1e9;
    for (const road of this._roads) {
      const s = road.samples, step = 3;
      let d2 = 1e18;
      for (let i = 0; i < s.length; i += step) {
        const dx = s[i].x - x, dz = s[i].z - z; const d = dx * dx + dz * dz;
        if (d < d2) d2 = d;
      }
      best = Math.min(best, Math.sqrt(d2) - road.edge);
    }
    return Math.max(0, best);
  }

  // ---- Delivery pad --------------------------------------------------------

  #buildDeliveryPad() {
    const p = this.deliveryPos, padY = p.y;
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(5, 5, 0.3, 32),
      new THREE.MeshStandardMaterial({ color: 0x2fbf6f, emissive: 0x1c7a44, emissiveIntensity: 0.4, roughness: 0.6 })
    );
    pad.position.set(p.x, padY + 0.05, p.z); pad.receiveShadow = true;
    this.scene.add(pad);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(5, 0.25, 12, 48),
      new THREE.MeshStandardMaterial({ color: 0x9affc8, emissive: 0x35d07a, emissiveIntensity: 0.8 })
    );
    ring.rotation.x = Math.PI / 2; ring.position.set(p.x, padY + 0.3, p.z);
    this.scene.add(ring);
    this.deliveryRing = ring; this.ringBaseY = padY + 0.3;
  }

  // ---- Scenery: forests, fields, rocks, farms, dirt paths ------------------

  #buildScenery() {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const rng = mulberry32(7777);

    // Forest density: low-freq cluster noise → patches of woods between fields.
    const forestPts = [], rockPts = [];
    for (let z = minZ; z < maxZ; z += 5) {
      for (let x = minX; x < maxX; x += 5) {
        const jx = x + (rng() - 0.5) * 4.5, jz = z + (rng() - 0.5) * 4.5;
        const d = this.#distToRoad(jx, jz);
        if (d < 7) continue; // keep the road clear
        const cluster = this.#vnoise(jx * 0.018 + 50, jz * 0.018 + 50); // -1..1
        const gy = this.terrainY(jx, jz);
        if (cluster > 0.12 && rng() < 0.5 + cluster * 0.4) {
          forestPts.push({ x: jx, y: gy, z: jz, rotY: rng() * Math.PI * 2, scale: 0.7 + rng() * 0.7 });
        } else if (cluster < -0.25 && rng() < 0.04 && d > 9) {
          rockPts.push({ x: jx, y: gy, z: jz, rotY: rng() * Math.PI * 2, scale: 0.4 + rng() * 1.2 });
        }
      }
    }
    if (forestPts.length > 520) forestPts.length = 520;
    this.#instanceTrees(forestPts);
    this.#instanceRocks(rockPts);
    this.#buildFarms(rng);
    this.#buildDirtPaths(rng);
  }

  #instanceTrees(forestPts) {
    const loader = new GLTFLoader();
    TREE_FILES.forEach((file, vi) => {
      loader.load(`./${file}.glb`, (gltf) => {
        gltf.scene.updateMatrixWorld(true);
        const geos = []; let mat = null;
        gltf.scene.traverse((c) => {
          if (c.isMesh) {
            const g = c.geometry.clone(); g.applyMatrix4(c.matrixWorld);
            ['tangent'].forEach((a) => g.deleteAttribute(a));
            geos.push(g); if (!mat) mat = c.material;
          }
        });
        if (!geos.length) return;
        let merged = geos.length > 1 ? (mergeGeometries(geos, false) || geos[0]) : geos[0];
        merged.computeBoundingBox();
        const bb = merged.boundingBox, size = new THREE.Vector3(), ctr = new THREE.Vector3();
        bb.getSize(size); bb.getCenter(ctr);
        merged.translate(-ctr.x, -bb.min.y, -ctr.z); // base at origin, centred
        const baseScale = TREE_TARGET_H / (size.y || 1);

        const pts = forestPts.filter((_, idx) => idx % TREE_FILES.length === vi);
        const inst = new THREE.InstancedMesh(merged, mat, pts.length);
        inst.castShadow = true; inst.receiveShadow = false;
        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
        pts.forEach((pt, idx) => {
          const sc = baseScale * pt.scale;
          q.setFromAxisAngle(UP, pt.rotY); s.set(sc, sc, sc); p.set(pt.x, pt.y, pt.z);
          m.compose(p, q, s); inst.setMatrixAt(idx, m);
        });
        inst.instanceMatrix.needsUpdate = true;
        this.scene.add(inst);
      }, undefined, (err) => console.warn(`World: ${file}.glb failed`, err));
    });
  }

  #instanceRocks(rockPts) {
    if (!rockPts.length) return;
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8c867a, roughness: 1, flatShading: true });
    const inst = new THREE.InstancedMesh(geo, mat, rockPts.length);
    inst.castShadow = true; inst.receiveShadow = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    rockPts.forEach((pt, idx) => {
      q.setFromAxisAngle(UP, pt.rotY);
      s.set(pt.scale, pt.scale * (0.6 + 0.3 * pt.scale), pt.scale);
      p.set(pt.x, pt.y + pt.scale * 0.2, pt.z);
      m.compose(p, q, s); inst.setMatrixAt(idx, m);
    });
    inst.instanceMatrix.needsUpdate = true;
    this.scene.add(inst);
  }

  // A few small farmsteads (barn = box body + prism roof) in open fields by the road.
  #buildFarms(rng) {
    const wall = new THREE.MeshStandardMaterial({ color: 0xb24a3a, roughness: 0.9 });
    const roof = new THREE.MeshStandardMaterial({ color: 0x6b5535, roughness: 0.9 });
    const s = this._centerline;
    let placed = 0;
    for (let attempt = 0; attempt < 60 && placed < 3; attempt++) {
      const i = 20 + Math.floor(rng() * (s.length - 40));
      const c = s[i];
      const side = rng() < 0.5 ? -1 : 1;
      // perpendicular offset off the road into the field
      const a = s[Math.max(0, i - 1)], b = s[Math.min(s.length - 1, i + 1)];
      const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1;
      const px = (tz / tl) * side, pz = (-tx / tl) * side;
      const off = 16 + rng() * 10;
      const fx = c.x + px * off, fz = c.z + pz * off;
      if (this.#vnoise(fx * 0.018 + 50, fz * 0.018 + 50) > 0) continue; // avoid woods
      const fy = this.terrainY(fx, fz);
      this.#barn(fx, fy, fz, rng() * Math.PI, wall, roof);
      placed++;
    }
  }

  #barn(x, y, z, yaw, wallMat, roofMat) {
    const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = yaw;
    const body = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 8), wallMat);
    body.position.y = 2; body.castShadow = true; body.receiveShadow = true; g.add(body);
    const roofGeo = new THREE.CylinderGeometry(0.001, 4.4, 2.6, 4, 1); // 4-sided prism (ridge)
    const r = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.2, 8.4), roofMat); // simple flat cap fallback
    // gable roof from a rotated box-prism:
    const gable = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 2.9, 8.2, 3), roofMat);
    gable.rotation.z = Math.PI / 2; gable.rotation.y = Math.PI / 2; gable.scale.set(1, 1, 0.62);
    gable.position.y = 4 + 1.0; gable.castShadow = true; g.add(gable);
    this.scene.add(g);
  }

  // Thin dirt side-paths branching off the road into the fields (visual only).
  #buildDirtPaths(rng) {
    const s = this._centerline;
    const mat = new THREE.MeshStandardMaterial({ color: 0xa98a5f, roughness: 1 });
    for (let n = 0; n < 2; n++) {
      const i = 40 + Math.floor(rng() * (s.length - 80));
      const c = s[i];
      const a = s[Math.max(0, i - 1)], b = s[Math.min(s.length - 1, i + 1)];
      const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1;
      const side = rng() < 0.5 ? -1 : 1;
      let dirx = (tz / tl) * side, dirz = (-tx / tl) * side;
      // build a short wandering ribbon
      const pos = [], idx = []; let px = c.x, pz = c.z; let hd = Math.atan2(dirx, dirz);
      const steps = 10, hw = 1.4;
      for (let k = 0; k <= steps; k++) {
        const nx = Math.sin(hd), nz = Math.cos(hd);
        const ox = nz, oz = -nx; // perp
        const y = this.terrainY(px, pz) + 0.12;
        pos.push(px + ox * hw, y, pz + oz * hw, px - ox * hw, y, pz - oz * hw);
        hd += (rng() - 0.5) * 0.5; px += nx * 6; pz += nz * 6;
      }
      for (let k = 0; k < steps; k++) { const A = k * 2, B = A + 1, C = (k + 1) * 2, D = C + 1; idx.push(A, C, B, B, C, D); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx); g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat); m.receiveShadow = true; this.scene.add(m);
    }
  }

  // ---- API -----------------------------------------------------------------

  isAtDelivery(position, radius = 4.5) {
    const dx = position.x - this.deliveryPos.x, dz = position.z - this.deliveryPos.z;
    return Math.hypot(dx, dz) <= radius;
  }

  update(t) {
    if (this.deliveryRing) this.deliveryRing.position.y = this.ringBaseY + Math.sin(t * 2) * 0.15;
  }
}
