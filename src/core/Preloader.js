import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DELIVERIES } from '../data/deliveries.js';

// Every GLB + texture the game pulls in lazily during play. Preloading them up
// front (into THREE.Cache) means the later `loader.load(...)` calls in World /
// Truck / Cargo resolve from cache instantly — no mid-game pop-in or black
// frames while a model streams in over a slow mobile connection.
const TREES = ['Tree_1', 'Tree_2', 'Tree_3', 'Tree_4', 'Tree_5'];
const TEXTURES = ['grass.png'];

export function preloadAssets(onProgress) {
  THREE.Cache.enabled = true;

  const models = new Set(['Car1.glb']);
  for (const d of DELIVERIES) if (d.model) models.add(d.model);
  for (const t of TREES) models.add(`${t}.glb`);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };

    const manager = new THREE.LoadingManager();
    manager.onProgress = (_url, loaded, total) => onProgress?.(total ? loaded / total : 0);
    manager.onLoad = finish;
    // LoadingManager still calls itemEnd on error, so onLoad fires regardless —
    // a missing asset just falls back to its in-engine placeholder.
    manager.onError = (url) => console.warn('Preload: failed', url);

    const gltf = new GLTFLoader(manager);
    const tex = new THREE.TextureLoader(manager);
    const noop = () => {};
    for (const m of models) gltf.load(`./${m}`, noop, undefined, noop);
    for (const t of TEXTURES) tex.load(`./textures/${t}`, noop, undefined, noop);

    // Safety net: never let a stalled request block the game from starting.
    setTimeout(finish, 12000);
  });
}
