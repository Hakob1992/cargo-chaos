import './ui/styles.css';
import { Physics } from './core/Physics.js';
import { Game } from './core/Game.js';
import { preloadAssets } from './core/Preloader.js';

const fillEl = document.getElementById('ld-fill');
const tipEl = document.getElementById('ld-tip');
const loadingEl = document.getElementById('loading');
const setBar = (f) => { if (fillEl) fillEl.style.width = `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`; };
const setTip = (t) => { if (tipEl) tipEl.textContent = t; };
const hideLoading = () => {
  if (!loadingEl) return;
  loadingEl.classList.add('done');
  setTimeout(() => loadingEl.remove(), 500);
};

// Bootstrap: Rapier's WASM must finish loading before we build any physics
// world, then we preload every model/texture so play starts with no pop-in or
// black frames. The progress bar (in index.html) tracks the whole sequence.
async function main() {
  setTip('Warming up the engine…');
  await Physics.init();
  setBar(0.12);

  setTip('Loading the garage…');
  await preloadAssets((f) => setBar(0.12 + f * 0.83));
  setBar(1);

  const game = new Game();
  game.start();
  window.__game = game; // expose for quick debugging in the console
  hideLoading();
}

main().catch((err) => {
  console.error('Cargo Chaos failed to start:', err);
  setTip('Failed to load 😢');
  const root = document.getElementById('ui-root');
  if (root) {
    root.innerHTML = `<div style="position:fixed;inset:0;display:grid;place-items:center;
      font-family:sans-serif;color:#fff;background:#181820;text-align:center;padding:2rem;z-index:600">
      <div><h2>Failed to load 😢</h2><pre style="opacity:.7;white-space:pre-wrap">${err.message}</pre></div></div>`;
  }
});
