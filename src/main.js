import './ui/styles.css';
import { Physics } from './core/Physics.js';
import { Game } from './core/Game.js';

// Bootstrap: Rapier's WASM must finish loading before we build any physics world.
async function main() {
  await Physics.init();
  const game = new Game();
  game.start();
  // Expose for quick debugging in the console.
  window.__game = game;
}

main().catch((err) => {
  console.error('Cargo Chaos failed to start:', err);
  const root = document.getElementById('ui-root');
  if (root) {
    root.innerHTML = `<div style="position:fixed;inset:0;display:grid;place-items:center;
      font-family:sans-serif;color:#fff;background:#181820;text-align:center;padding:2rem">
      <div><h2>Failed to load 😢</h2><pre style="opacity:.7;white-space:pre-wrap">${err.message}</pre></div></div>`;
  }
});
