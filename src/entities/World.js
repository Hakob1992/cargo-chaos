import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RAPIER } from '../core/Physics.js';

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

// A long, winding European-style backroad over gently rolling countryside.
// The road is a Catmull-Rom ribbon through a procedurally-generated path
// (organic curves, sharp turns, S-bends, and a tight HAIRPIN "expert section"),
// hugging an fbm-noise terrain. Forest clusters, open fields, rocks, farms and
// dirt side-paths are scattered with noise so there's no obvious grid pattern.
// All filler props are InstancedMesh, so the whole forest costs only a handful
// of draw calls.
export class World {
  constructor(scene, physics) {
    this.scene = scene;
    this.physics = physics;
    this.world = physics.world;
    this.roadLift = 0.18;

    this._baseY = this.#fbm(0, 0); // so terrainY(0,0) ≈ 0 (clean spawn)

    const gen = this.#generatePath();
    this.pathPts = gen.pts;
    this.segType = gen.segType;   // per-waypoint pacing label
    this.path = new THREE.CatmullRomCurve3(this.pathPts, false, 'catmullrom', 0.5);

    // Area bounds (path bbox + margin) drive terrain + scatter extents.
    const bb = new THREE.Box3().setFromPoints(this.pathPts);
    const M = 75;
    this.bounds = {
      minX: bb.min.x - M, maxX: bb.max.x + M,
      minZ: bb.min.z - M, maxZ: bb.max.z + M,
    };

    this.#buildLighting();
    this.#buildTerrain();
    this.#buildRoad();
    this.#buildDeliveryPad();
    this.#buildScenery();
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

  // ---- Procedural winding path --------------------------------------------

  // Deliberate difficulty pacing, NOT pure randomness:
  //   Recovery → Challenge → Recovery → Challenge → Recovery → BIG (hairpin) → Finish
  // Recovery sections straighten out (cake settles); challenges throw S-bends and
  // sharp turns; the big challenge is a tight hairpin switchback.
  #generatePath() {
    const rng = mulberry32(20260608);
    const pts = [new THREE.Vector3(0, 0, 0)];
    const segType = ['recovery'];
    let x = 0, z = 0, h = 0; // h = heading; 0 → +Z
    const run = (type, steps, turnFn) => {
      const step = type === 'big' ? 12 : (type === 'challenge' ? 16 : 22);
      for (let i = 0; i < steps; i++) {
        let turn = turnFn(i);
        if (x > 60) turn -= 0.18; else if (x < -60) turn += 0.18; // stay in bounds
        h += turn;
        x += Math.sin(h) * step;
        z += Math.cos(h) * step;
        pts.push(new THREE.Vector3(x, 0, z));
        segType.push(type);
      }
    };
    // forward bias term pulls heading back toward +Z (used in calm sections)
    run('recovery', 4, () => (rng() - 0.5) * 0.10 - h * 0.25);                       // R1: settle
    run('challenge', 6, (i) => [0.55, 0.45, -0.5, -0.55, 0.25, 0.0][i] + (rng() - 0.5) * 0.08); // C1: S-bend
    run('recovery', 4, () => (rng() - 0.5) * 0.10 - h * 0.30);                       // R2
    run('challenge', 6, (i) => [-0.6, -0.45, 0.4, 0.5, -0.3, 0.0][i] + (rng() - 0.5) * 0.08);   // C2: sharp L→R
    run('recovery', 3, () => (rng() - 0.5) * 0.08 - h * 0.30);                       // R3: breather
    run('big', 4, () => 0.72);                                                       // BIG: hairpin (~165°)
    run('finish', 5, () => (rng() - 0.5) * 0.06 - h * 0.28);                         // straighten to pad
    return { pts, segType };
  }

  // ---- Lighting / sky ------------------------------------------------------

  #buildLighting() {
    const hemi = new THREE.HemisphereLight(0xfff2d6, 0x8a9a5a, 1.3);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff0cf, 2.0);
    sun.position.set(60, 90, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 140;
    sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
    sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
    sun.shadow.camera.far = 360;
    this.scene.add(sun);

    this.scene.fog = new THREE.Fog(0xe8cba6, 90, 360);
    this.scene.background = this.#makeSkyTexture();
    this.#buildClouds();
  }

  #makeSkyTexture() {
    const c = document.createElement('canvas'); c.width = 16; c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.0, '#acc4d6'); g.addColorStop(0.45, '#cfd2c9');
    g.addColorStop(0.72, '#eccfa6'); g.addColorStop(1.0, '#f0d6ad');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 16, 256);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  #buildClouds() {
    const tex = this.#makeCloudTexture();
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.95 });
    const rng = mulberry32(99);
    for (let i = 0; i < 10; i++) {
      const s = new THREE.Sprite(mat);
      s.position.set((rng() - 0.5) * 500, 55 + rng() * 30, (rng()) * 360 - 30);
      const sc = 60 + rng() * 70; s.scale.set(sc, sc * 0.55, 1);
      this.scene.add(s);
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
    ctx.fillStyle = '#3a2c1a'; for (const l of lobes) { const [x, y] = xy(l); ctx.beginPath(); ctx.arc(x, y, l.s * baseR + outline, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#efe2c6'; for (const l of lobes) { const [x, y] = xy(l); ctx.beginPath(); ctx.arc(x, y, l.s * baseR, 0, 7); ctx.fill(); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ---- Textures ------------------------------------------------------------

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
      map: this.#tex('grass.png'), color: 0xa9be86, roughness: 1,
    }));
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(new Float32Array(positions), new Uint32Array(indices)).setFriction(1.0),
      body
    );
  }

  // ---- Road ribbon ---------------------------------------------------------

  #buildRoad() {
    const N = 360;
    const samples = this.path.getSpacedPoints(N);
    this._centerline = samples; // for distance-to-road queries
    // Half-width from local curvature: tight corners pinch narrower (harder).
    const hwArr = new Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const a = samples[Math.max(0, i - 1)], b = samples[i], c = samples[Math.min(N, i + 1)];
      const h1 = Math.atan2(b.x - a.x, b.z - a.z), h2 = Math.atan2(c.x - b.x, c.z - b.z);
      let dh = h2 - h1; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
      hwArr[i] = THREE.MathUtils.lerp(4.5, 3.0, THREE.MathUtils.smoothstep(Math.abs(dh), 0.02, 0.12));
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
      const y = this.terrainY(c.x, c.z) + this.roadLift;
      if (i > 0) dist += Math.hypot(c.x - samples[i - 1].x, c.z - samples[i - 1].z);
      positions.push(
        c.x + perp.x * hw, y, c.z + perp.z * hw,
        c.x - perp.x * hw, y, c.z - perp.z * hw
      );
      const v = dist / 8;
      uvs.push(hw / 8, v, -hw / 8, v);
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
    // Tinted tan so the asphalt-crack texture reads as a packed-dirt backroad.
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      map: this.#tex('road.png'), color: 0xb89a72, roughness: 1, side: THREE.DoubleSide,
    }));
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(new Float32Array(positions), new Uint32Array(indices)).setFriction(1.1),
      body
    );

    this.deliveryPos = samples[N].clone();
    this.deliveryPos.y = this.terrainY(this.deliveryPos.x, this.deliveryPos.z);

    this.#buildMud(samples, N);
  }

  // Mud patches in the challenge/hairpin sections — they cut tyre grip so the
  // truck (and cargo) can slide if you take them too fast. Visual + a grip zone.
  #buildMud(samples, N) {
    this.mudPatches = [];
    const segLen = this.segType.length - 1;
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a2c1c, roughness: 0.32, metalness: 0.05 });
    for (let i = 8; i < N - 8; i++) {
      const st = this.segType[Math.round((i / N) * segLen)];
      if (st !== 'challenge' && st !== 'big') continue;
      const c = samples[i];
      if (this.mudPatches.some((m) => Math.hypot(m.x - c.x, m.z - c.z) < 32)) continue;
      if (this.mudPatches.length >= 4) break;
      const r = 4.2;
      this.mudPatches.push({ x: c.x, z: c.z, r });
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 22), mat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(c.x, this.terrainY(c.x, c.z) + this.roadLift + 0.025, c.z);
      disc.receiveShadow = true;
      this.scene.add(disc);
    }
  }

  // Grip multiplier at a world position (1 = full, lower on mud).
  gripAt(x, z) {
    if (!this.mudPatches) return 1;
    let g = 1;
    for (const m of this.mudPatches) {
      const d = Math.hypot(x - m.x, z - m.z);
      if (d < m.r) g = Math.min(g, 0.3 + 0.7 * THREE.MathUtils.smoothstep(d, m.r * 0.45, m.r));
    }
    return g;
  }

  // Min distance from (x,z) to the road centreline (coarse, fast enough).
  #distToRoad(x, z) {
    let best = 1e9; const s = this._centerline; const step = 3; // sample every 3rd
    for (let i = 0; i < s.length; i += step) {
      const dx = s[i].x - x, dz = s[i].z - z; const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
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
