// Delivery definitions, ordered by difficulty (mirrors the GDD level list).
// fragility: 0..1 multiplier on impact damage. mass: kg-ish (heavier slows the truck).
// size: cargo box half-extents [x, y, z] in metres. tall boxes tip more easily.
// NOTE: footprint is capped to fit the GLB truck bed — x ≤ 0.55 (width) and
// z ≤ 0.6 (depth) so the cargo's front face stays behind the cab (z ≈ -0.25 at
// BED_Z -0.95). Height (y) is free to vary for tipping gameplay.
// `behavior` names a personality from cargoTypes.js. That one field is what
// makes each load play differently — see CARGO_BEHAVIORS for the rules.
export const DELIVERIES = [
  {
    id: 'boxes',
    name: 'Cardboard Boxes',
    tag: 'EASY',
    reward: 350,
    mass: 60,
    fragility: 0.35,
    size: [0.5, 0.45, 0.55],
    color: 0xc8965a,
    behavior: 'standard',
  },
  {
    id: 'glass',
    name: 'Glass Panels',
    tag: 'FRAGILE',
    reward: 650,
    mass: 120,
    fragility: 0.9,
    // A crate of panels: deep enough not to topple on acceleration (a razor-thin
    // slab tips instantly without straps), and bottom-weighted (comDrop) so it
    // rides upright. Glass is meant to fail from IMPACTS, not from tipping.
    size: [0.55, 0.75, 0.3],
    comDrop: 0.4,
    color: 0x8fd0e8,
    behavior: 'glass_vase',
  },
  {
    // Added in Phase 3 with NO engine changes — pure data, reusing the box
    // renderer + the `fish_tank` personality (lean it too far and it spills).
    id: 'fishtank',
    name: 'Fish Tank',
    tag: 'SLOSHY',
    reward: 800,
    mass: 140,
    fragility: 0.85,
    size: [0.55, 0.6, 0.5],
    comDrop: 0.25,
    color: 0x4aa3d6,
    behavior: 'fish_tank',
  },
  {
    id: 'cake',
    starGate: 3, // total stars required to unlock
    name: 'Giant Wedding Cake',
    tag: 'VERY FRAGILE',
    reward: 900,
    mass: 90,
    fragility: 1.0,
    size: [0.5, 0.7, 0.55],
    color: 0xf4c6d0,
    behavior: 'birthday_cake',
  },
  {
    id: 'barrels',
    starGate: 6,
    name: 'Explosive Barrels',
    tag: 'DANGEROUS',
    reward: 1800,
    mass: 200,
    fragility: 0.8,
    size: [0.5, 0.55, 0.55],
    color: 0xd8531f,
    behavior: 'gas_canister',
  },
  {
    id: 'dino-egg',
    starGate: 9,
    name: 'Dinosaur Egg',
    tag: 'VERY FRAGILE',
    reward: 1200,
    mass: 150,
    fragility: 0.95,
    size: [0.5, 0.6, 0.55],
    color: 0xe8dcb0,
    behavior: 'glass_vase',
  },
  {
    id: 'artifact',
    starGate: 12,
    name: 'Alien Artifact',
    tag: 'MYSTERIOUS',
    reward: 2400,
    mass: 110,
    fragility: 0.7,
    size: [0.48, 0.6, 0.5],
    color: 0x7be0a0,
    behavior: 'standard',
  },
  {
    id: 'nuke',
    starGate: 15,
    name: 'Nuclear Battery',
    tag: 'HAZARDOUS',
    reward: 3200,
    mass: 300,
    fragility: 0.85,
    size: [0.48, 0.5, 0.5],
    color: 0xf0e040,
    behavior: 'gas_canister',
  },
  {
    id: 'dragon',
    starGate: 20,
    name: 'Sleeping Dragon',
    tag: 'LEGENDARY',
    reward: 5000,
    mass: 400,
    fragility: 0.75,
    size: [0.55, 0.75, 0.6],
    color: 0xa05cc0,
    behavior: 'live_animals',
  },
];

// Cargo condition ratings keyed off remaining integrity (100 - damage%).
export const RATINGS = [
  { min: 100, label: 'PERFECT', payout: 1.0 },
  { min: 90, label: 'EXCELLENT', payout: 0.9 },
  { min: 75, label: 'GOOD', payout: 0.75 },
  { min: 50, label: 'DAMAGED', payout: 0.5 },
  { min: 0, label: 'DISASTER', payout: 0.1 },
];

export function ratingFor(integrity) {
  return RATINGS.find((r) => integrity >= r.min) ?? RATINGS[RATINGS.length - 1];
}
