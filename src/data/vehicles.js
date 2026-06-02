// Vehicle roster from the GDD. Only the Rusty Pickup is fully playable in this
// prototype; the rest are defined for the unlock/progression UI.
export const VEHICLES = [
  {
    id: 'pickup',
    name: 'Rusty Pickup',
    unlockCost: 0,
    baseEngineForce: 2600,
    mass: 900,
    color: 0x3a78c2,
    playable: true,
  },
  { id: 'van', name: 'Delivery Van', unlockCost: 4000, playable: false },
  { id: 'box-truck', name: 'Box Truck', unlockCost: 9000, playable: false },
  { id: 'hauler', name: 'Heavy Hauler', unlockCost: 18000, playable: false },
  { id: 'hover', name: 'Hover Truck', unlockCost: 35000, playable: false },
  { id: 'rocket', name: 'Rocket Truck', unlockCost: 60000, playable: false },
];
