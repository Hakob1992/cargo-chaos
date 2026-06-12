// Phase 5 — risk/reward route definitions (LEVEL DATA, no engine logic).
// Every run starts with a choice between two routes to the same delivery pad:
//
//   THE HIGHWAY    — long, wide and smooth. Nothing will surprise you.
//   FARM SHORTCUT  — much shorter, but narrow, muddy and bumpy, with a jump.
//                    Pays a bonus and its par pace is generous — IF the cargo
//                    survives the ride.
//
// The geometry itself is authored in World.js (designed fork, not procedural);
// this file owns the tuning knobs so route balance is a data edit.
export const ROUTES = {
  highway: {
    id: 'highway',
    name: 'THE HIGHWAY',
    tag: 'SAFE',
    desc: 'Long, wide and smooth. No surprises.',
    // Par time = route length / parSpeed (m/s). Higher = stricter par.
    parSpeed: 10.5,
    payoutMult: 1.0,
    color: 0x2fbf6f,
  },
  shortcut: {
    id: 'shortcut',
    name: 'FARM SHORTCUT',
    tag: 'RISKY',
    desc: 'Way shorter — but narrow, muddy, bumpy… and there is a jump.',
    parSpeed: 8.5, // generous pace: beat it hard for a big time score
    payoutMult: 1.25,
    color: 0xd8531f,
  },
};

// ---- Shortcut hazard layout (fractions along the shortcut branch, 0→1) ------
export const SHORTCUT_HAZARDS = {
  mud: [0.24, 0.5, 0.72],          // grip-cutting mud pits
  bumpClusters: [0.34, 0.6],       // washboard bump strips (cargo goes flying)
  bumpsPerCluster: 3,
  bumpSpacingSamples: 2,           // distance between bars within a cluster
  ramp: 0.82,                      // the jump
};
