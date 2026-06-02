# Cargo Chaos 🚚💥

**Deliver it, don't destroy it!** A web-based delivery driving simulator — haul fragile and absurd cargo across a bumpy course without wrecking it, earn money, and upgrade your truck for crazier deliveries.

Built with **Three.js** (rendering) and **Rapier.js** (physics).

## Tech stack

- **Three.js** — WebGL rendering
- **@dimforge/rapier3d-compat** — deterministic rigid-body physics (raycast vehicle controller)
- **Vite** — dev server & build
- Vanilla HTML/CSS overlay for UI

## Getting started

```bash
npm install
npm run dev      # start the dev server (http://localhost:5173)
npm run build    # production build to dist/
npm run preview  # preview the production build
```

## How to play

- **W / ↑** accelerate · **S / ↓** reverse · **A D / ← →** steer
- **Space** brake · **R** recover (flip upright if you roll)
- On touch devices, on-screen pedals and steering appear automatically.

Pick a delivery from the garage, drive to the glowing green pad and **stop on it** to deliver. The less your cargo is damaged in transit, the bigger the payout. Spend earnings on upgrades (engine, tires, suspension, shocks, cargo straps, insurance) to tackle harder loads.

## Cargo & damage

Cargo has **weight** (heavier slows the truck), **fragility** (fragile cargo breaks on impact), and **stability** (tall cargo can tip). Damage accrues from hard impacts, tipping over, and falling off the bed. Ratings: Perfect → Excellent → Good → Damaged → Disaster.

## Status

Playable prototype. Currently the Rusty Pickup is drivable with all 8 deliveries; placeholder low-poly geometry. Roadmap: GLB models, audio (Howler.js), more vehicles, procedural routes, and random events.

---

🤖 Prototype scaffolded with [Claude Code](https://claude.com/claude-code)
