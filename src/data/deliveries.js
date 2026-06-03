// Delivery definitions, ordered by difficulty (mirrors the GDD level list).
// fragility: 0..1 multiplier on impact damage. mass: kg-ish (heavier slows the truck).
// size: cargo box half-extents [x, y, z] in metres. tall boxes tip more easily.
// NOTE: footprint is capped to fit the GLB truck bed — x ≤ 0.55 (width) and
// z ≤ 0.6 (depth) so the cargo's front face stays behind the cab (z ≈ -0.25 at
// BED_Z -0.95). Height (y) is free to vary for tipping gameplay.
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
  },
  {
    id: 'glass',
    name: 'Glass Panels',
    tag: 'FRAGILE',
    reward: 650,
    mass: 120,
    fragility: 0.9,
    size: [0.55, 0.8, 0.14],
    color: 0x8fd0e8,
  },
  {
    id: 'cake',
    name: 'Giant Wedding Cake',
    tag: 'VERY FRAGILE',
    reward: 900,
    mass: 90,
    fragility: 1.0,
    size: [0.5, 0.7, 0.55],
    color: 0xf4c6d0,
  },
  {
    id: 'barrels',
    name: 'Explosive Barrels',
    tag: 'DANGEROUS',
    reward: 1800,
    mass: 200,
    fragility: 0.8,
    size: [0.5, 0.55, 0.55],
    color: 0xd8531f,
  },
  {
    id: 'dino-egg',
    name: 'Dinosaur Egg',
    tag: 'VERY FRAGILE',
    reward: 1200,
    mass: 150,
    fragility: 0.95,
    size: [0.5, 0.6, 0.55],
    color: 0xe8dcb0,
  },
  {
    id: 'artifact',
    name: 'Alien Artifact',
    tag: 'MYSTERIOUS',
    reward: 2400,
    mass: 110,
    fragility: 0.7,
    size: [0.48, 0.6, 0.5],
    color: 0x7be0a0,
  },
  {
    id: 'nuke',
    name: 'Nuclear Battery',
    tag: 'HAZARDOUS',
    reward: 3200,
    mass: 300,
    fragility: 0.85,
    size: [0.48, 0.5, 0.5],
    color: 0xf0e040,
  },
  {
    id: 'dragon',
    name: 'Sleeping Dragon',
    tag: 'LEGENDARY',
    reward: 5000,
    mass: 400,
    fragility: 0.75,
    size: [0.55, 0.75, 0.6],
    color: 0xa05cc0,
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
