// Phase 7 — customer personalities (PURE DATA, consumed by Customer.js + Game).
// Every delivery has an owner with feelings about how (and WHEN) it arrives:
//
//   fastBonus    extra fraction of the payout when delivered FAST (≤ fastThresh × par)
//   latePenalty  fraction docked when delivered LATE (≥ lateThresh × par)
//   fastThresh / lateThresh   per-customer overrides of the time verdicts
//
// Line buckets: start, bump, nearFall (mid-run); hurry (one nag when you blow
// past par); perfect/good/bad (quality verdict); fast/late (time verdict —
// they outrank quality lines when tips are on the line).
export const TIME_DEFAULTS = { fastThresh: 0.85, lateThresh: 1.4 };

export const CUSTOMERS = {
  // Cardboard boxes — a chill moving-day dude. Hard to upset, tips a little.
  mover: {
    avatar: '🧔',
    name: 'Moving-Day Mike',
    fastBonus: 0.1,
    latePenalty: 0.1,
    lines: {
      start: ['It\'s just my whole life in boxes, no pressure man.'],
      bump: ['Duuude, easy.', 'I heard something shift, bro.', 'Whoa whoa whoa.'],
      nearFall: ['DUDE. The boxes!', 'Not the boxes, man!'],
      hurry: ['No rush man but… kinda rush?'],
      perfect: ['Duuude. Flawless. Respect.'],
      good: ['Eh, it\'s mostly fine. It\'s cool.'],
      bad: ['Bro. My vinyl collection was in there. Not cool.'],
      fast: ['Already?! Dude, you\'re a legend. Extra for you.'],
      late: ['Man, I\'ve been sitting on the curb for HOURS.'],
    },
  },

  // Glass panels — a perfectionist architect. Generous if quick, brutal reviews.
  architect: {
    avatar: '🤓',
    name: 'The Architect',
    fastBonus: 0.2,
    latePenalty: 0.25,
    lines: {
      start: ['Those panels are bespoke. BESPOKE. Drive accordingly.'],
      bump: ['Was that a vibration?!', 'I designed that glass, not your driving!', 'Careful! Tolerance is 0.2 millimetres!'],
      nearFall: ['THE PANELS! MY ATRIUM!', 'I will NOT redesign the lobby!'],
      hurry: ['The glazing crew bills by the hour, you know.'],
      perfect: ['Pristine. The atrium shall gleam. Acceptable work.'],
      good: ['There are… imperfections. The client must never know.'],
      bad: ['You delivered me a box of GRAVEL.'],
      fast: ['Ahead of schedule! The crew can start today — bonus approved.'],
      late: ['The installation window is GONE. Invoice adjusted. Downward.'],
    },
  },

  // Fish tank — a kid whose pets are in there. Big feelings, small allowance.
  kid: {
    avatar: '🧒',
    name: 'Tommy (age 8)',
    fastBonus: 0.15,
    latePenalty: 0,   // a kid doesn't dock you — he just worries
    lines: {
      start: ['Mister Bubbles and Greg live in there. PLEASE be careful.'],
      bump: ['Mister Bubbles felt that!!', 'Greg is scared!!', 'The water went sideways!!'],
      nearFall: ['MISTER BUBBLES NOOO!!', 'THE WATER IS ESCAPING!!'],
      hurry: ['Fish get bored, you know!!'],
      perfect: ['MISTER BUBBLES! GREG! You\'re home!! Thank you mister!!'],
      good: ['Greg looks dizzy but… he\'s okay. I think.'],
      bad: ['You… you SPILLED my best friends. 😭'],
      fast: ['That was SO FAST! Here, my whole allowance!!'],
      late: ['I waited so long I named a rock Greg Two.'],
    },
  },

  // Wedding cake — the bride. A schedule exists. The schedule is SACRED.
  bride: {
    avatar: '👰',
    name: 'The Bride',
    fastBonus: 0.15,
    latePenalty: 0.4, // the ceremony will NOT be moved
    lateThresh: 1.3,
    lines: {
      start: ['Please… deliver my wedding cake in one piece!'],
      bump: ['Was that a pothole?!', 'Be careful with my cake!', 'Easy — EASY!',
        'My grandmother made that recipe!', 'I felt that one!'],
      nearFall: ['THAT CAKE COST $10,000!!', 'NO no no — don\'t you DARE!', 'KEEP IT LEVEL!'],
      hurry: ['The ceremony starts in MINUTES!!'],
      perfect: ['It\'s PERFECT! Bless you! 😭'],
      good: ['Phew… a few smudges, but it\'ll do. Thank you!'],
      bad: ['My wedding is RUINED. 😡', 'What did you DO to my cake?!'],
      fast: ['You\'re early!! Oh thank heavens — here, take extra!'],
      late: ['The guests ATE THE APPETIZERS. ALL OF THEM. This is docked.'],
    },
  },

  // Explosive barrels — a grumpy site foreman. Time is money; lateness is theft.
  foreman: {
    avatar: '👷',
    name: 'Foreman Gruff',
    fastBonus: 0.1,
    latePenalty: 0.35, // grumpy tips less if late — THE spec example
    lateThresh: 1.25,
    lines: {
      start: ['Demolition\'s scheduled. Don\'t blow up my schedule. Or my barrels.'],
      bump: ['OI! Those are EXPLOSIVES!', 'You tryin\' to retire me early?!', 'I FELT that from here!'],
      nearFall: ['IF THOSE GO UP, YOU\'RE FIRED. FROM A CANNON.'],
      hurry: ['Clock\'s ticking! I don\'t pay for scenic routes!'],
      perfect: ['Hmph. On the money. Don\'t let it go to your head.'],
      good: ['Dented but functional. Like me.'],
      bad: ['WELL THE BUILDING\'S ALREADY DEMOLISHED. YOU\'RE THE BOMB NOW.'],
      fast: ['Early?! Hmph. Fine. Small bonus. SMALL.'],
      late: ['You\'re LATE. Crew sat around eatin\' sandwiches on MY dime. Docked!'],
    },
  },

  // Dinosaur egg — a frantic paleontologist. The egg MUST stay warm: 2× for speed.
  professor: {
    avatar: '🧑‍🔬',
    name: 'Prof. Hatchsworth',
    fastBonus: 1.0,  // "pays 2× for fast" — the egg is COOLING
    fastThresh: 0.9,
    latePenalty: 0.3,
    lines: {
      start: ['The egg is COOLING. Sixty-five million years and it dies in YOUR truck?!'],
      bump: ['The embryo felt that!', 'Gentle! It predates the wheel!', 'My life\'s work!!'],
      nearFall: ['NOT THE EGG! NOT! THE! EGG!'],
      hurry: ['The temperature is DROPPING, driver!!'],
      perfect: ['Intact! INTACT! Nobel committee, take note!'],
      good: ['Hairline fractures… like my nerves. But it lives.'],
      bad: ['Congratulations. You re-extincted the dinosaurs.'],
      fast: ['STILL WARM! Magnificent!! DOUBLE PAY — take it, TAKE IT!'],
      late: ['It\'s gone cold… sixty-five million years, undone by traffic.'],
    },
  },

  // Alien artifact — a deadpan agent. The organisation does not wait.
  agent: {
    avatar: '🕵️',
    name: 'Agent Smithee',
    fastBonus: 0.2,
    latePenalty: 0.3,
    lines: {
      start: ['You did not see the crate. You are not delivering the crate. Drive.'],
      bump: ['The crate you are not carrying just made a noise.', 'That did not happen.'],
      nearFall: ['Containment is… inadvisable to lose.'],
      hurry: ['The organisation has noticed your pace. The organisation is displeased.'],
      perfect: ['Acceptable. This conversation never occurred.'],
      good: ['The scuffs will be classified.'],
      bad: ['The cleanup team is en route. For the artifact. Possibly for you.'],
      fast: ['Punctual. The organisation rewards punctuality. Discreetly.'],
      late: ['You kept IT waiting. IT does not like waiting. Fee adjusted.'],
    },
  },

  // Nuclear battery — a by-the-book general. Both carrot and stick.
  general: {
    avatar: '🎖️',
    name: 'General Stricture',
    fastBonus: 0.25,
    latePenalty: 0.35,
    lines: {
      start: ['That battery powers the base. Lose it and you\'ll glow AND be court-martialled.'],
      bump: ['REPORT! What was that?!', 'Handle with PROTOCOL, soldier!'],
      nearFall: ['CODE RED! CODE RED!'],
      hurry: ['You are BEHIND SCHEDULE, soldier!'],
      perfect: ['Mission accomplished. Outstanding, soldier.'],
      good: ['Acceptable losses. Barely.'],
      bad: ['The base is dark. YOU are the reason the base is dark.'],
      fast: ['Ahead of schedule! That\'s a commendation — and a bonus.'],
      late: ['You call that a supply line?! Pay docked, soldier!'],
    },
  },

  // Sleeping dragon — an unbothered wizard. Money is a construct; speed is nice.
  wizard: {
    avatar: '🧙',
    name: 'Zanthar the Drowsy',
    fastBonus: 0.3,
    latePenalty: 0.15,
    lines: {
      start: ['She sleeps. She must CONTINUE sleeping. You understand.'],
      bump: ['She stirred. Do you enjoy being flammable?', 'Smooth roads, mortal!'],
      nearFall: ['HER EYELID TWITCHED. DRIVE BETTER.'],
      hurry: ['Her nap ends at dusk. Dusk approaches.'],
      perfect: ['Still dreaming of sheep. Splendid work, mortal.'],
      good: ['She\'s half-awake… I shall sing the lullaby of nine hours.'],
      bad: ['She is awake. RUN. INVOICE LATER. RUN.'],
      fast: ['Swift as a griffin! Gold for you, mortal!'],
      late: ['She nearly woke from boredom. Boredom! In MY dragon!'],
    },
  },

  // Fallback for anything unmapped.
  default: {
    avatar: '🧍',
    name: 'The Customer',
    fastBonus: 0.1,
    latePenalty: 0.15,
    lines: {
      start: ['Handle this with care, please.'],
      bump: ['Hey — watch the bumps!', 'Careful back there!', 'Take it easy!'],
      nearFall: ['Don\'t you dare drop it!', 'WHOA — keep it steady!'],
      hurry: ['Any day now…'],
      perfect: ['Flawless! Thank you!'],
      good: ['Good enough. Thanks.'],
      bad: ['This is a disaster…'],
      fast: ['So fast! Here\'s a little extra.'],
      late: ['Took you long enough…'],
    },
  },
};

// Resolve a delivery's customer (by key) onto the default so every bucket and
// tip field is always present.
export function resolveCustomer(key) {
  const base = CUSTOMERS.default;
  const c = CUSTOMERS[key] || base;
  return {
    ...base, ...c,
    ...TIME_DEFAULTS,
    fastThresh: c.fastThresh ?? TIME_DEFAULTS.fastThresh,
    lateThresh: c.lateThresh ?? TIME_DEFAULTS.lateThresh,
    lines: { ...base.lines, ...c.lines },
  };
}
