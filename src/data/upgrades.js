// Upgrade tree (mirrors the GDD). Each upgrade has discrete levels with a cost
// and a numeric "value" the truck reads to tune physics/handling.
// level 0 = base (already owned). Costs index from level 1 upward.
export const UPGRADES = [
  {
    id: 'engine',
    name: 'Engine',
    desc: 'More engine force — better acceleration and top speed.',
    costs: [900, 1400, 2200],
    values: [1300, 1700, 2200, 2800], // engine force by level
  },
  {
    id: 'tires',
    name: 'Tires',
    desc: 'Grippier tires — more cornering traction.',
    costs: [600, 1000, 1600],
    values: [2.0, 2.6, 3.2, 4.0], // friction slip by level
  },
  {
    id: 'suspension',
    name: 'Suspension',
    desc: 'Stiffer suspension — less body roll over bumps.',
    costs: [800, 1200, 1800],
    values: [600, 750, 950, 1200], // suspension stiffness by level
  },
  {
    id: 'shocks',
    name: 'Shock Dampeners',
    desc: 'Smoother damping — cargo bounces less.',
    costs: [600, 1000, 1500],
    values: [0.6, 0.9, 1.2, 1.6], // suspension damping by level
  },
  {
    id: 'straps',
    name: 'Cargo Straps',
    desc: 'Stronger straps — cargo stays put on the bed.',
    costs: [700, 1100, 1700],
    values: [40, 80, 140, 220], // strap spring strength by level (40 = basic tie-down)
  },
  {
    id: 'insurance',
    name: 'Insurance',
    desc: 'Payout floor — even a disaster earns something back.',
    costs: [1000, 1800, 3000],
    values: [0.1, 0.25, 0.4, 0.6], // minimum payout fraction by level
  },
];

export function upgradeById(id) {
  return UPGRADES.find((u) => u.id === id);
}
