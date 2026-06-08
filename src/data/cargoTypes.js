// Cargo "personalities" — pure DATA consumed by Cargo.js. Each delivery in
// deliveries.js names one of these via `behavior: '<key>'`. Adding a new cargo
// type (or retuning an existing one) needs NO engine changes — that is the whole
// point of Phase 3.
//
// Fields the engine reads (all optional; `standard` supplies the defaults):
//   render               'box' | 'cake'  — which mesh/visual to build
//   impactScale          multiplies the base impact threshold (mass×60).
//                        LOWER = more fragile (breaks under gentler hits).
//   instantFailOnImpact  any impact past the threshold instantly ruins it
//   explodeOnSecondHit   first hit arms/dents it; the second one detonates
//   mustStayUpright      tilting past tolerance for too long ruins it
//   uprightToleranceDeg  lean angle (deg) that starts the spill/escape timer
//   openTimeoutSec       seconds past tolerance before it spills / escapes
//   failKind             flavour of the failure, drives the wreck visual + the
//                        end screen text: 'crush'|'shatter'|'explode'|'spill'|
//                        'escape'|'collapse'
//   stacked              (reserved) independent stacked tiers — not yet built
export const CARGO_BEHAVIORS = {
  // Ordinary crate — reproduces the pre-Phase-3 behaviour exactly.
  standard: {
    render: 'box',
    impactScale: 1,
    instantFailOnImpact: false,
    explodeOnSecondHit: false,
    mustStayUpright: false,
    uprightToleranceDeg: null,
    openTimeoutSec: null,
    failKind: 'crush',
  },

  // Glass: survives careful driving but ANY solid knock shatters it outright.
  glass_vase: {
    render: 'box',
    impactScale: 0.5,          // breaks at half the usual force
    instantFailOnImpact: true,
    failKind: 'shatter',
  },

  // Fish tank: the water sloshes — lean it too far and it spills out fast.
  fish_tank: {
    render: 'box',
    impactScale: 0.8,
    mustStayUpright: true,
    uprightToleranceDeg: 35,
    openTimeoutSec: 1.2,       // water leaves quickly once it tips
    failKind: 'spill',
  },

  // Live animals: a slower fuse — if the crate stays tipped, they escape.
  live_animals: {
    render: 'box',
    impactScale: 1,
    mustStayUpright: true,
    uprightToleranceDeg: 55,
    openTimeoutSec: 4,
    failKind: 'escape',
  },

  // Soft cake: squishes through visible stages, no hard fail trigger.
  birthday_cake: {
    render: 'cake',
    impactScale: 1.1,
    failKind: 'collapse',
  },

  // Pressurised canister: the first impact dents + hisses, the second blows.
  gas_canister: {
    render: 'box',
    impactScale: 0.9,
    explodeOnSecondHit: true,
    failKind: 'explode',
  },
};

// Resolve a delivery's behaviour (string key or inline object) onto the
// `standard` defaults so the engine always sees every field.
export function resolveBehavior(behavior) {
  const base = CARGO_BEHAVIORS.standard;
  const b = typeof behavior === 'string' ? CARGO_BEHAVIORS[behavior] : behavior;
  return { ...base, ...(b || {}) };
}
