/**
 * Natural bidding for BettyBridge, following Betty's house rules:
 *
 *   - 13 points to open the bidding.
 *   - Five cards in Spades or Hearts to open a major.
 *   - A five-card minor, or three cards in Clubs or Diamonds, otherwise.
 *   - 1 No Trump shows 16 to 18 points with even distribution.
 *   - Ace 4, King 3, Queen 2, Jack 1.
 *   - Suit order for bidding: Clubs, Diamonds, Hearts, Spades, No Trump.
 *
 * Deliberately convention-free: every call means exactly what it says.
 * Betty bids by tapping buttons, so the computer must never read a
 * hidden meaning into her call — no Stayman, no transfers, no weak twos.
 * The only artificial calls are the strong 2 Clubs opening and the
 * takeout double, both of which every bridge player already knows.
 *
 * Each call comes back with a plain-English explanation so the auction
 * review screen can tell Betty why the computer bid what it bid.
 */

export const BID_SUITS = ['C', 'D', 'H', 'S', 'NT'];

const SEATS = ['N', 'E', 'S', 'W'];
const SUIT_WORDS = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades', NT: 'No Trump' };
const HCP_VALUE = { A: 4, K: 3, Q: 2, J: 1 };
const MAJORS = ['H', 'S'];
const ALL_SUITS = ['C', 'D', 'H', 'S'];

// Betty settled this herself: "When opening bid is made, just high card
// points matter. Later distribution is counted." So the opening bid is a
// straight 13 high cards — no length, no shortness — and distribution only
// comes into it once a fit is found and a hand is being raised.

const seatIndex = (s) => SEATS.indexOf(s);
const partnerOf = (s) => SEATS[(seatIndex(s) + 2) % 4];
const sameSide = (a, b) => (seatIndex(a) % 2) === (seatIndex(b) % 2);

const pass = (why) => ({ type: 'pass', explanation: why });
const call = (level, suit, why) => ({ type: 'bid', level, suit, explanation: why });
const dbl = (why) => ({ type: 'double', explanation: why });

const pts = (n) => `${n} point${n === 1 ? '' : 's'}`;
// The middle of a shown range, with very wide ranges treated cautiously
const midOf = (r) => Math.round((r.min + Math.min(r.max, r.min + 6)) / 2);
const SUIT_WORDS_ONE = { C: 'Club', D: 'Diamond', H: 'Heart', S: 'Spade', NT: 'No Trump' };
const named = (level, suit) => `${level} ${level === 1 ? SUIT_WORDS_ONE[suit] : SUIT_WORDS[suit]}`;

// --- HAND EVALUATION ---------------------------------------------------

export function analyzeHand(hand) {
  const len = { C: 0, D: 0, H: 0, S: 0 };
  const bySuit = { C: [], D: [], H: [], S: [] };
  let hcp = 0;

  for (const c of hand) {
    len[c.suit]++;
    bySuit[c.suit].push(c.rank);
    hcp += HCP_VALUE[c.rank] || 0;
  }

  const shape = ALL_SUITS.map(s => len[s]).sort((a, b) => b - a);
  // Balanced = 4-3-3-3, 4-4-3-2 or 5-3-3-2: no void, no singleton, one doubleton at most
  const balanced = shape[3] >= 2 && shape.filter(c => c === 2).length <= 1;

  // Length points: one extra for every card past the fifth in a suit
  let lengthPts = 0;
  for (const s of ALL_SUITS) if (len[s] > 5) lengthPts += len[s] - 5;

  // Shortness points, counted only when raising partner's trump suit
  const shortnessPts = (trump) => {
    let p = 0;
    for (const s of ALL_SUITS) {
      if (s === trump) continue;
      if (len[s] === 0) p += 3;
      else if (len[s] === 1) p += 2;
      else if (len[s] === 2) p += 1;
    }
    return p;
  };

  const hasStopper = (s) => {
    const ranks = bySuit[s];
    if (ranks.includes('A')) return true;
    if (ranks.includes('K') && len[s] >= 2) return true;
    if (ranks.includes('Q') && len[s] >= 3) return true;
    if (ranks.includes('J') && len[s] >= 4) return true;
    return false;
  };

  // Longest suit, breaking ties toward the higher-ranking suit
  let longest = 'S';
  for (const s of ['S', 'H', 'D', 'C']) if (len[s] > len[longest]) longest = s;

  // Best major of at least five cards, if any
  let longMajor = null;
  for (const s of MAJORS) {
    if (len[s] >= 5 && (!longMajor || len[s] > len[longMajor])) longMajor = s;
  }
  if (len.S === 5 && len.H === 5) longMajor = 'S';

  const ruleOf20 = hcp + shape[0] + shape[1] >= 20;

  return {
    hcp, len, bySuit, balanced, lengthPts, shortnessPts,
    hasStopper, longest, longMajor, ruleOf20,
    total: hcp + lengthPts
  };
}

// --- READING THE AUCTION ----------------------------------------------

// What the computer assumes a call promises. Used both to read partner
// and to keep the computer's own bids inside a sane range.
function rangeForCall(seat, c, prior) {
  const bidsSoFar = prior.filter(x => x.type === 'bid');
  const opening = bidsSoFar[0] || null;
  const partner = partnerOf(seat);
  const partnerOpened = opening && opening.player === partner;
  const weOpened = opening && sameSide(opening.player, seat);
  const myPrior = prior.filter(x => x.player === seat);
  const firstCall = myPrior.length === 0;
  // Passing before partner opened does not stop me being the responder,
  // so "my first say" is counted from the opening bid, not from the deal.
  const openingIndex = prior.findIndex(x => x.type === 'bid');
  const firstSinceOpening = openingIndex < 0
    ? firstCall
    : prior.slice(openingIndex + 1).every(x => x.player !== seat);

  if (c.type === 'pass') {
    if (!opening && firstCall) return { min: 0, max: 12 };
    if (partnerOpened && firstCall) return { min: 0, max: 5 };
    return null;
  }
  if (c.type === 'double') {
    const takeout = opening && !weOpened && firstCall && opening.level === 1 && opening.suit !== 'NT';
    return takeout ? { min: 12, max: 21 } : { min: 10, max: 37 };
  }
  if (c.type === 'redouble') return { min: 10, max: 37 };

  // --- an actual bid ---
  if (!opening) {
    if (c.suit === 'NT' && c.level === 1) return { min: 16, max: 18 };
    if (c.suit === 'NT' && c.level === 2) return { min: 22, max: 24 };
    return { min: 13, max: 21 };
  }

  if (partnerOpened && firstSinceOpening) {
    const oSuit = opening.suit;
    if (oSuit === 'NT' && opening.level === 1) {
      if (c.suit === 'NT') {
        if (c.level === 2) return { min: 8, max: 9 };
        if (c.level === 3) return { min: 10, max: 15 };
        if (c.level === 4) return { min: 16, max: 17 };
        if (c.level >= 6) return { min: 18, max: 37 };
      }
      if (c.level === 2) return { min: 0, max: 9 };
      if (c.level === 3) return { min: 10, max: 15 };
      if (c.level === 4) return { min: 8, max: 15 };
      return null;
    }
    if (oSuit === 'NT' && opening.level === 2) {
      if (c.level === 3) return { min: 4, max: 10 };
      if (c.suit === 'NT' && c.level === 4) return { min: 11, max: 12 };
      if (c.level >= 6) return { min: 13, max: 37 };
      return { min: 4, max: 12 };
    }
    // Partner opened one of a suit
    if (c.suit === oSuit) {
      if (c.level === 2) return { min: 6, max: 10 };
      if (c.level === 3) return { min: 10, max: 12 };
      if (c.level >= 4) return { min: 12, max: 16 };
    }
    if (c.suit === 'NT') {
      if (c.level === 1) return { min: 6, max: 9 };
      if (c.level === 2) return { min: 11, max: 12 };
      if (c.level === 3) return { min: 13, max: 16 };
    }
    if (c.level === 1) return { min: 6, max: 20 };
    if (c.level === 2) return { min: 10, max: 20 };
    return { min: 13, max: 20 };
  }

  if (!weOpened && firstSinceOpening) {
    const partnerActed = prior.some(x => x.player === partner && x.type !== 'pass');
    if (partnerActed) {
      // Partner overcalled or doubled; I am only answering them. A forced
      // answer to a takeout double can be completely worthless.
      const partnerDoubled = prior.some(x => x.player === partner && x.type === 'double');
      const partnerSuit = [...prior].reverse().find(x => x.player === partner && x.type === 'bid');
      const before = bidsSoFar[bidsSoFar.length - 1];
      let cheapest = 1;
      if (before) {
        cheapest = BID_SUITS.indexOf(c.suit) > BID_SUITS.indexOf(before.suit)
          ? before.level : before.level + 1;
      }
      const jump = c.level - cheapest;
      if (c.suit === 'NT') {
        if (c.level === 1) return { min: 6, max: 10 };
        if (c.level === 2) return { min: 11, max: 12 };
        return { min: 13, max: 16 };
      }
      if (partnerSuit && c.suit === partnerSuit.suit) {
        if (jump >= 2) return { min: 11, max: 14 };
        if (jump === 1) return { min: 9, max: 12 };
        return { min: 5, max: 10 };
      }
      if (partnerDoubled) {
        if (jump >= 2) return { min: 12, max: 16 };
        if (jump === 1) return { min: 9, max: 11 };
        return { min: 0, max: 8 };
      }
      return { min: 6, max: 12 };
    }
    if (c.suit === 'NT' && c.level === 1) return { min: 16, max: 18 };
    if (c.level === 1) return { min: 8, max: 16 };
    if (c.level === 2) return { min: 11, max: 17 };
    return { min: 10, max: 20 };
  }

  if (partnerOpened && !firstSinceOpening) {
    // Responder saying more. A jump shows values; a quiet rebid does not.
    const prevHighest = bidsSoFar[bidsSoFar.length - 1];
    let cheapest = 1;
    if (prevHighest) {
      cheapest = BID_SUITS.indexOf(c.suit) > BID_SUITS.indexOf(prevHighest.suit)
        ? prevHighest.level : prevHighest.level + 1;
    }
    const jump = c.level - cheapest;
    if (c.suit === 'NT') {
      if (c.level === 2) return { min: 11, max: 12 };
      if (c.level >= 3) return { min: 13, max: 16 };
      return { min: 6, max: 10 };
    }
    const gameLevel = MAJORS.includes(c.suit) ? 4 : 5;
    if (c.level >= gameLevel) return { min: 12, max: 16 };
    if (jump >= 1) return { min: 10, max: 12 };
    return { min: 6, max: 11 };
  }

  if (opening.player === seat) {
    // Opener describing further
    if (c.suit === 'NT') {
      if (c.level === 1) return { min: 13, max: 15 };
      if (c.level === 2) return { min: 19, max: 21 };
      if (c.level === 3) return null; // could be strong, could be accepting an invitation
    }
    const prevHighest = bidsSoFar[bidsSoFar.length - 1];
    let cheapest = 1;
    if (prevHighest) {
      cheapest = BID_SUITS.indexOf(c.suit) > BID_SUITS.indexOf(prevHighest.suit)
        ? prevHighest.level : prevHighest.level + 1;
    }
    const jump = c.level - cheapest;
    const gameLevel = MAJORS.includes(c.suit) ? 4 : 5;
    if (c.level >= gameLevel) return null; // could be a stretch, so read nothing into it
    if (jump >= 2) return { min: 19, max: 21 };
    if (jump === 1) return { min: 16, max: 18 };
    return { min: 13, max: 15 };
  }

  return null;
}

export function estimateRange(seat, bids) {
  let min = 0;
  let max = 37;
  const prior = [];
  for (const c of bids) {
    if (c.player === seat) {
      const r = rangeForCall(seat, c, prior);
      if (r) {
        min = Math.max(min, r.min);
        max = Math.min(max, r.max);
        if (max < min) max = min;
      }
    }
    prior.push(c);
  }
  return { min, max };
}

// How many cards partner has promised in a suit, judging from their calls
function estimateLength(seat, bids, suit) {
  let best = 0;
  const bidsOfSeat = bids.filter(c => c.player === seat && c.type === 'bid');
  const allBids = bids.filter(c => c.type === 'bid');
  const opening = allBids[0] || null;
  const timesBid = bidsOfSeat.filter(c => c.suit === suit).length;
  if (timesBid === 0) return 0;

  if (opening && opening.player === seat && opening.suit === suit) {
    best = MAJORS.includes(suit) ? 5 : 3;
  } else {
    best = 4;
  }
  if (timesBid >= 2) best = Math.max(best, 6);
  // A raise of partner's suit promises support, not length of its own
  const partner = partnerOf(seat);
  const partnerBidIt = bids.some(c => c.player === partner && c.type === 'bid' && c.suit === suit);
  if (partnerBidIt && !(opening && opening.player === seat && opening.suit === suit)) {
    best = Math.max(3, Math.min(best, 4));
  }
  return best;
}

function buildContext(seat, bids, a) {
  const partner = partnerOf(seat);
  const realBids = bids.filter(c => c.type === 'bid');
  const highest = realBids.length ? realBids[realBids.length - 1] : null;
  const opening = realBids.length ? realBids[0] : null;
  const lastAction = [...bids].reverse().find(c => c.type !== 'pass') || null;

  const myCalls = bids.filter(c => c.player === seat);
  const myBids = myCalls.filter(c => c.type === 'bid');
  const partnerCalls = bids.filter(c => c.player === partner);
  const partnerBids = partnerCalls.filter(c => c.type === 'bid');
  const partnerLastBid = partnerBids.length ? partnerBids[partnerBids.length - 1] : null;
  const partnerDoubled = partnerCalls.some(c => c.type === 'double');

  const weOpened = !!opening && sameSide(opening.player, seat);
  const iOpened = !!opening && opening.player === seat;
  const partnerOpened = !!opening && opening.player === partner;
  const oppsBid = realBids.some(c => !sameSide(c.player, seat));

  let role;
  if (!opening && !partnerDoubled) role = 'open';
  else if (iOpened) role = 'opener';
  else if (partnerOpened) role = 'responder';
  else if (myBids.length > 0) role = 'overcaller';
  else if (partnerBids.length > 0 || partnerDoubled) role = 'advancer';
  else role = 'defend';

  const cheapest = (suit) => {
    if (!highest) return 1;
    if (BID_SUITS.indexOf(suit) > BID_SUITS.indexOf(highest.suit)) return highest.level;
    return highest.level + 1;
  };

  const partnerRange = estimateRange(partner, bids);
  const myTurnNumber = myCalls.length + 1;

  // The suit our side has agreed on, if any: a strain both partners bid
  let agreedSuit = null;
  for (const s of ['S', 'H', 'D', 'C', 'NT']) {
    const mine = myBids.some(c => c.suit === s);
    const theirs = partnerBids.some(c => c.suit === s);
    if (mine && theirs) { agreedSuit = s; break; }
  }
  // Support for partner's suit also counts as agreement
  if (!agreedSuit && partnerLastBid && partnerLastBid.suit !== 'NT' && a.len[partnerLastBid.suit] >= 4) {
    agreedSuit = partnerLastBid.suit;
  }

  return {
    seat, partner, bids, highest, opening, lastAction,
    myCalls, myBids, partnerCalls, partnerBids, partnerLastBid, partnerDoubled,
    weOpened, iOpened, partnerOpened, oppsBid, role, cheapest,
    partnerRange, myTurnNumber, agreedSuit,
    partnerLength: (s) => estimateLength(partner, bids, s)
  };
}

// --- OPENING THE BIDDING ----------------------------------------------

function openingCall(a) {
  const { hcp, len, balanced, longMajor } = a;

  if (hcp >= 22 && balanced) {
    return call(2, 'NT', `${pts(hcp)}, even distribution — opening 2 No Trump`);
  }
  // 1 No Trump shows 16 to 18 with even distribution. With a five-card
  // major, open the major instead so we can still find the major fit.
  if (hcp >= 16 && hcp <= 18 && balanced && !longMajor) {
    return call(1, 'NT', `${pts(hcp)}, even distribution — opening 1 No Trump`);
  }

  if (hcp < 13) {
    return pass(`Only ${pts(hcp)} in high cards — you need 13 to open`);
  }

  if (longMajor) {
    return call(1, longMajor, `${pts(hcp)} and ${len[longMajor]} ${SUIT_WORDS[longMajor]} — opening ${named(1, longMajor)}`);
  }

  // No five-card major: open the better minor
  let minor;
  if (len.D >= 5 && len.D > len.C) minor = 'D';
  else if (len.C >= 5 && len.C >= len.D) minor = 'C';
  else if (len.D >= 4 && len.C >= 4) minor = 'D';
  else if (len.D > len.C) minor = 'D';
  else minor = 'C';
  return call(1, minor, `${pts(hcp)} but no five-card major — opening ${named(1, minor)}`);
}

// --- RESPONDING TO PARTNER'S OPENING ----------------------------------

function respondToNoTrump(a, ctx, openingLevel) {
  const { hcp, len, longMajor, hasStopper } = a;
  const lo = openingLevel === 1 ? 16 : 22;
  // If they have overcalled, we need their suit stopped before No Trump
  const theirSuits = ctx.bids
    .filter(c => c.type === 'bid' && !sameSide(c.player, ctx.seat) && c.suit !== 'NT')
    .map(c => c.suit);
  const theirSuitsStopped = theirSuits.every(s => hasStopper(s));
  const combined = hcp + lo;
  const want = (lvl, suit, why) => (ctx.cheapest(suit) <= lvl ? call(lvl, suit, why) : null);

  if (longMajor) {
    if (combined >= 26) {
      const c = want(3, longMajor, `${pts(hcp)} and ${len[longMajor]} ${SUIT_WORDS[longMajor]} — enough for game, let partner choose`);
      if (c) return c;
    } else if (openingLevel === 1) {
      const c = want(2, longMajor, `${pts(hcp)} and ${len[longMajor]} ${SUIT_WORDS[longMajor]} — safer in a suit than No Trump`);
      if (c) return c;
    }
  }

  if (combined >= 33 && theirSuitsStopped) {
    const c = want(6, 'NT', `${pts(hcp)} opposite ${lo}+ — enough for a small slam`);
    if (c) return c;
  }
  if (combined >= 31 && theirSuitsStopped) {
    const c = want(4, 'NT', `${pts(hcp)} — inviting partner to a slam`);
    if (c) return c;
  }
  if (combined >= 26 && theirSuitsStopped) {
    const c = want(3, 'NT', `${pts(hcp)} opposite ${lo}+ — that is game`);
    if (c) return c;
  }
  if (combined >= 23 && theirSuitsStopped) {
    const c = want(2, 'NT', `${pts(hcp)} — inviting game`);
    if (c) return c;
  }
  return pass(`Only ${pts(hcp)} — partner's No Trump is high enough`);
}

function respondToSuitOpening(a, ctx) {
  const o = ctx.opening;
  const oSuit = o.suit;
  const { hcp, len, balanced, hasStopper } = a;
  const support = len[oSuit];
  const isMajor = MAJORS.includes(oSuit);
  const want = (lvl, suit, why) => (ctx.cheapest(suit) <= lvl ? call(lvl, suit, why) : null);

  // Raising partner counts shortness as extra value
  const raisePts = support >= 4 ? hcp + a.shortnessPts(oSuit) : hcp;

  if (hcp <= 5) return pass(`Only ${pts(hcp)} — too weak to answer`);

  // 1. An eight-card major fit is the best contract there is — show it first
  if (isMajor && support >= 3) {
    let target;
    let why;
    if (raisePts >= 13 && hcp >= 10) { target = 4; why = `${pts(raisePts)} with ${support} ${SUIT_WORDS[oSuit]} — straight to game`; }
    else if (raisePts >= 10 && hcp >= 8) { target = 3; why = `${pts(raisePts)} with ${support} ${SUIT_WORDS[oSuit]} — inviting game`; }
    else { target = 2; why = `${pts(raisePts)} with ${support} ${SUIT_WORDS[oSuit]} — a simple raise`; }
    const c = want(target, oSuit, why);
    if (c) return c;
    return pass('Partner\'s suit is already too high for my hand');
  }

  // 2. Over a minor, look for a major fit at the one level
  if (!isMajor) {
    let major = null;
    if (len.H >= 4 && len.S >= 4) major = len.S > len.H ? 'S' : 'H';
    else if (len.S >= 4) major = 'S';
    else if (len.H >= 4) major = 'H';
    if (major && hcp >= 6) {
      const c = want(1, major, `${pts(hcp)} and ${len[major]} ${SUIT_WORDS[major]} — looking for a major fit`);
      if (c) return c;
    }
  } else if (oSuit === 'H' && len.S >= 4 && hcp >= 6) {
    const c = want(1, 'S', `${pts(hcp)} and ${len.S} Spades — showing my own suit`);
    if (c) return c;
  }

  // 3. Balanced hands say so in No Trump
  const stoppersOk = ALL_SUITS.every(s => len[s] >= 3 || hasStopper(s) || s === oSuit);
  if (balanced || stoppersOk) {
    if (hcp >= 13) {
      const c = want(3, 'NT', `${pts(hcp)}, even distribution — that is game`);
      if (c) return c;
    }
    if (hcp >= 11) {
      const c = want(2, 'NT', `${pts(hcp)}, even distribution — inviting game`);
      if (c) return c;
    }
    if (hcp >= 6) {
      const c = want(1, 'NT', `${pts(hcp)} but no fit for partner — 1 No Trump`);
      if (c) return c;
    }
  }

  // 4. Ten or more points: show a suit of my own
  if (hcp >= 10) {
    let best = null;
    for (const s of ['S', 'H', 'D', 'C']) {
      if (s === oSuit) continue;
      if (len[s] >= 5 && (!best || len[s] > len[best])) best = s;
    }
    if (best) {
      const lvl = ctx.cheapest(best);
      if (lvl <= 2) return call(lvl, best, `${pts(hcp)} and ${len[best]} ${SUIT_WORDS[best]} — showing my suit`);
    }
  }

  // 5. Support for a minor
  if (!isMajor && support >= 4) {
    if (hcp >= 10) {
      const c = want(3, oSuit, `${pts(hcp)} with ${support} ${SUIT_WORDS[oSuit]} — inviting game`);
      if (c) return c;
    }
    const c = want(2, oSuit, `${pts(hcp)} with ${support} ${SUIT_WORDS[oSuit]} — a simple raise`);
    if (c) return c;
  }

  if (hcp >= 6) {
    const c = want(1, 'NT', `${pts(hcp)} — nothing better to say than 1 No Trump`);
    if (c) return c;
  }
  return pass(`${pts(hcp)} — nothing safe to bid`);
}

function firstResponse(a, ctx) {
  const o = ctx.opening;
  if (o.suit === 'NT') return respondToNoTrump(a, ctx, o.level);
  return respondToSuitOpening(a, ctx);
}

// --- OPENER'S SECOND CALL ---------------------------------------------

function openerRebid(a, ctx) {
  const o = ctx.opening;
  const r = ctx.partnerLastBid;
  const { hcp, len, balanced, hasStopper } = a;
  const want = (lvl, suit, why) => (ctx.cheapest(suit) <= lvl ? call(lvl, suit, why) : null);

  if (!r) {
    return pass('Partner has nothing to say, so I stop here');
  }

  const partnerMin = ctx.partnerRange.min;
  const combined = hcp + midOf(ctx.partnerRange);
  const flatEnough = balanced || ALL_SUITS.every(s2 => hasStopper(s2) || len[s2] >= 3);

  // Partner raised my suit
  if (r.suit === o.suit && o.suit !== 'NT') {
    const isMajor = MAJORS.includes(o.suit);
    const gameLevel = isMajor ? 4 : 5;
    const mine = hcp + a.lengthPts;
    if (r.level >= gameLevel) return pass('Partner has taken us to game — that is plenty');
    if (combined >= 26 && isMajor) {
      const c = want(4, o.suit, `${pts(mine)} opposite partner's ${partnerMin}+ — enough for game`);
      if (c) return c;
    }
    // With a minor fit, 3 No Trump is a far easier game than five of a minor
    if (combined >= 26 && !isMajor && flatEnough) {
      const c = want(3, 'NT', `${pts(mine)} opposite partner's ${partnerMin}+ — 3 No Trump is the easier game`);
      if (c) return c;
    }
    if (combined >= 23 && r.level < 3) {
      const c = want(3, o.suit, `${pts(mine)} — inviting game`);
      if (c) return c;
    }
    return pass(`${pts(mine)} — we are high enough`);
  }

  // Partner bid No Trump
  if (r.suit === 'NT') {
    if (r.level >= 3) return pass('Partner has bid game — that is enough');
    if (r.level === 2) {
      if (combined >= 26) {
        const c = want(3, 'NT', `${pts(hcp)} opposite partner's ${partnerMin}+ — accepting the invitation`);
        if (c) return c;
      }
      return pass(`${pts(hcp)} — declining the invitation`);
    }
    // Partner responded 1 No Trump, which shows 6 to 9
    if (hcp >= 19 && flatEnough) {
      const c = want(2, 'NT', `${pts(hcp)}, even distribution — inviting game`);
      if (c) return c;
    }
    if (len[o.suit] >= 6 && o.suit !== 'NT') {
      // A long suit plus extra strength is worth showing at a higher level
      const target = hcp >= 19 ? (MAJORS.includes(o.suit) ? 4 : 3) : (hcp >= 16 ? 3 : 2);
      const c = want(target, o.suit, `${pts(hcp)} and ${len[o.suit]} ${SUIT_WORDS[o.suit]} — repeating my long suit`);
      if (c) return c;
    }
    let second = null;
    for (const s2 of ALL_SUITS) {
      if (s2 === o.suit) continue;
      if (len[s2] >= 4 && (!second || len[s2] > len[second])) second = s2;
    }
    if (second && hcp >= 16 && ctx.cheapest(second) <= 2) {
      return call(ctx.cheapest(second), second, `${pts(hcp)} and ${len[second]} ${SUIT_WORDS[second]} — showing my second suit`);
    }
    return pass(`${pts(hcp)} — partner is weak, so I stop here`);
  }

  // Partner bid a new suit
  const support = len[r.suit];
  const isMajorFit = MAJORS.includes(r.suit) && support >= 4;
  if (support >= 4) {
    const raisePts = hcp + a.shortnessPts(r.suit);
    if (raisePts >= 19 && hcp >= 16 && isMajorFit) {
      const c = want(4, r.suit, `${pts(raisePts)} with ${support} ${SUIT_WORDS[r.suit]} — straight to game`);
      if (c) return c;
    }
    if (combined >= 26 && isMajorFit) {
      const c = want(4, r.suit, `${pts(raisePts)} with ${support} ${SUIT_WORDS[r.suit]} — raising to game`);
      if (c) return c;
    }
    if (raisePts >= 16 && hcp >= 15 && combined >= 23) {
      const c = want(r.level + 2, r.suit, `${pts(raisePts)} with ${support} ${SUIT_WORDS[r.suit]} — a strong raise`);
      if (c) return c;
    }
    const c = want(r.level + 1, r.suit, `${pts(raisePts)} with ${support} ${SUIT_WORDS[r.suit]} — supporting partner`);
    if (c) return c;
  }

  if (combined >= 26 && balanced && ALL_SUITS.every(s => hasStopper(s) || len[s] >= 3)) {
    const c = want(3, 'NT', `${pts(hcp)} opposite partner's ${partnerMin}+ — 3 No Trump`);
    if (c) return c;
  }

  if (o.suit !== 'NT' && len[o.suit] >= 6) {
    const target = hcp >= 19 ? (MAJORS.includes(o.suit) ? 4 : 3) : (hcp >= 16 ? 3 : 2);
    const lvl = ctx.cheapest(o.suit);
    if (lvl <= target) {
      return call(Math.max(lvl, Math.min(target, lvl + (hcp >= 16 ? 1 : 0))), o.suit,
        `${pts(hcp)} and ${len[o.suit]} ${SUIT_WORDS[o.suit]} — repeating my long suit`);
    }
  }

  let second = null;
  for (const s of ALL_SUITS) {
    if (s === o.suit || s === r.suit) continue;
    if (len[s] >= 4 && (!second || len[s] > len[second])) second = s;
  }
  if (second) {
    const lvl = ctx.cheapest(second);
    // Bidding a higher suit at the two level promises extra strength
    const reverse = lvl > o.level && BID_SUITS.indexOf(second) > BID_SUITS.indexOf(o.suit);
    if (lvl <= 2 && (!reverse || hcp >= 16)) {
      return call(lvl, second, `${pts(hcp)} and ${len[second]} ${SUIT_WORDS[second]} — my second suit`);
    }
  }

  if (flatEnough) {
    if (hcp >= 19) {
      const c = want(2, 'NT', `${pts(hcp)}, even distribution — showing extra strength`);
      if (c) return c;
    }
    const c = want(1, 'NT', `${pts(hcp)}, even distribution`) ||
              want(2, 'NT', `${pts(hcp)}, even distribution`);
    if (c) return c;
  }

  // Partner's two-level answer promised real values, so I owe them a reply.
  // Never by naming my own suit again on five — that promises six.
  if (r.level >= 2 && ctx.partnerRange.min >= 10) {
    if (len[r.suit] >= 3) {
      const c = want(r.level + 1, r.suit, `${pts(hcp)} with ${len[r.suit]} ${SUIT_WORDS[r.suit]} — supporting partner`);
      if (c) return c;
    }
    if (o.suit !== 'NT' && len[o.suit] >= 6) {
      const c = want(ctx.cheapest(o.suit), o.suit, `${len[o.suit]} ${SUIT_WORDS[o.suit]} — back to my own long suit`);
      if (c) return c;
    }
    let other = null;
    for (const s2 of ALL_SUITS) {
      if (s2 === o.suit || s2 === r.suit) continue;
      if (len[s2] >= 4 && (!other || len[s2] > len[other])) other = s2;
    }
    if (other) {
      const c = want(ctx.cheapest(other), other, `${pts(hcp)} and ${len[other]} ${SUIT_WORDS[other]} — my other suit`);
      if (c) return c;
    }
    const c = want(ctx.cheapest('NT'), 'NT', `${pts(hcp)} — nothing else to show`);
    if (c) return c;
  }

  return pass(`${pts(hcp)} — nothing more to say`);
}

// --- COMPETING AGAINST THE OPPONENTS ----------------------------------

function overcallOrDouble(a, ctx) {
  const { hcp, len, balanced, hasStopper } = a;
  const opening = ctx.opening;
  const want = (lvl, suit, why) => (ctx.cheapest(suit) <= lvl ? call(lvl, suit, why) : null);

  if (hcp < 8) return pass(`Only ${pts(hcp)} — staying out of it`);

  // 1NT overcall: 15-18 balanced with their suit stopped
  if (hcp >= 16 && hcp <= 18 && balanced && (opening.suit === 'NT' || hasStopper(opening.suit))) {
    const c = want(1, 'NT', `${pts(hcp)}, even distribution, their suit stopped — 1 No Trump`);
    if (c) return c;
  }

  // A good five-card suit is worth an overcall — but never in a suit the
  // opponents have already bid, and never on a ragged holding.
  const theirSuits = ctx.bids
    .filter(c => c.type === 'bid' && !sameSide(c.player, ctx.seat))
    .map(c => c.suit);
  let best = null;
  for (const s of ['S', 'H', 'D', 'C']) {
    if (theirSuits.includes(s)) continue;
    if (len[s] >= 5 && (!best || len[s] > len[best])) best = s;
  }
  if (best) {
    const lvl = ctx.cheapest(best);
    const honours = a.bySuit[best].filter(r => 'AKQJ'.includes(r)).length;
    const goodSuit = len[best] >= 6 || honours >= 2;
    const needed = lvl === 1 ? 8 : 12;
    if (hcp >= needed && lvl <= 2 && (lvl === 1 || goodSuit)) {
      return call(lvl, best, `${pts(hcp)} and ${len[best]} ${SUIT_WORDS[best]} — overcalling`);
    }
  }

  // Takeout double: opening values, short in their suit, support everywhere else
  if (hcp >= 12 && opening.level === 1 && opening.suit !== 'NT' && ctx.myCalls.length === 0) {
    const theirSuit = opening.suit;
    const short = len[theirSuit] <= 2;
    const othersOk = ALL_SUITS.every(s => s === theirSuit || len[s] >= 3);
    if (short && othersOk && ctx.lastAction === opening) {
      return dbl(`${pts(hcp)}, short in ${SUIT_WORDS[theirSuit]} — double asks partner to pick a suit`);
    }
  }

  return pass(hcp >= 12 ? `${pts(hcp)} but no safe bid` : `Only ${pts(hcp)} — staying out of it`);
}

// Partner overcalled or doubled; decide what to do about it
function advance(a, ctx) {
  const { hcp, len, balanced, hasStopper } = a;
  const want = (lvl, suit, why) => (ctx.cheapest(suit) <= lvl ? call(lvl, suit, why) : null);

  if (ctx.partnerDoubled && ctx.partnerBids.length === 0) {
    // Partner asked me to name my best suit
    const theirSuits = ctx.bids.filter(c => c.type === 'bid' && !sameSide(c.player, ctx.seat)).map(c => c.suit);
    let best = null;
    for (const s of ['S', 'H', 'D', 'C']) {
      if (theirSuits.includes(s)) continue;
      if (!best || len[s] > len[best]) best = s;
    }
    if (hcp >= 11 && balanced && theirSuits.every(s => s === 'NT' || hasStopper(s))) {
      const c = want(2, 'NT', `${pts(hcp)}, even distribution, their suit stopped`);
      if (c) return c;
    }
    if (best) {
      const lvl = ctx.cheapest(best);
      if (hcp >= 11 && lvl + 1 <= 3) {
        return call(lvl + 1, best, `${pts(hcp)} and ${len[best]} ${SUIT_WORDS[best]} — a strong answer to partner's double`);
      }
      if (lvl <= 3) {
        return call(lvl, best, `${pts(hcp)} — answering partner's double with my best suit`);
      }
    }
    return pass('Nothing I can bid safely');
  }

  const oppSuits = ctx.bids
    .filter(c => c.type === 'bid' && !sameSide(c.player, ctx.seat))
    .map(c => c.suit);
  const pSuit = ctx.partnerLastBid ? ctx.partnerLastBid.suit : null;
  if (!pSuit) return pass('Nothing to add');

  if (pSuit !== 'NT' && len[pSuit] >= 3) {
    const raisePts = hcp + (len[pSuit] >= 4 ? a.shortnessPts(pSuit) : 0);
    const isMajor = MAJORS.includes(pSuit);
    const combined = hcp + ctx.partnerRange.min;
    let target = ctx.partnerLastBid.level + 1;
    if (raisePts >= 13 && hcp >= 10 && combined >= 26 && isMajor) target = 4;
    else if (raisePts >= 10 && hcp >= 8) target = Math.min(ctx.partnerLastBid.level + 2, 3);
    else if (raisePts < 6) return pass(`Only ${pts(hcp)} — leaving partner alone`);
    const c = want(target, pSuit, `${pts(raisePts)} with ${len[pSuit]} ${SUIT_WORDS[pSuit]} — supporting partner`);
    if (c) return c;
    return pass('Already high enough');
  }

  if (hcp >= 11 && balanced) {
    const c = want(2, 'NT', `${pts(hcp)}, even distribution`);
    if (c) return c;
  }
  if (hcp >= 10) {
    let best = null;
    for (const s of ['S', 'H', 'D', 'C']) {
      if (oppSuits.includes(s)) continue;
      if (len[s] >= 5 && (!best || len[s] > len[best])) best = s;
    }
    if (best) {
      const lvl = ctx.cheapest(best);
      if (lvl <= 2) return call(lvl, best, `${pts(hcp)} and ${len[best]} ${SUIT_WORDS[best]} — my own suit`);
    }
  }
  return pass(`${pts(hcp)} — leaving partner's bid alone`);
}

// --- THIRD AND LATER CALLS --------------------------------------------

// Everything past the first response: only bid on to a game or slam we can
// count the points for, accept an invitation when we are at the top of what
// we promised, and otherwise stop. This is what keeps auctions from
// spiralling up to silly contracts.
function laterCall(a, ctx) {
  const { hcp, len, balanced, hasStopper } = a;
  const pr = ctx.partnerRange;
  const combined = hcp + pr.min;
  // "It takes 26 to make a game" is about the real total, so estimate partner
  // from the middle of what they have shown rather than assuming the worst.
  const combinedMid = hcp + midOf(pr);
  const highest = ctx.highest;
  const weOwnIt = !!highest && sameSide(highest.player, ctx.seat);
  const want = (lvl, suit, why) => (ctx.cheapest(suit) <= lvl ? call(lvl, suit, why) : null);
  if (!highest) return pass('Nothing worth bidding');

  const strain = ctx.agreedSuit;
  const suitFit = strain && strain !== 'NT' ? len[strain] + ctx.partnerLength(strain) : 0;
  const isMajor = !!strain && MAJORS.includes(strain);
  const gameLevel = strain === 'NT' ? 3 : (isMajor ? 4 : 5);
  const flatEnough = balanced || ALL_SUITS.every(s => hasStopper(s) || len[s] >= 3);
  const stoppersOk = ALL_SUITS.every(s => hasStopper(s) || len[s] >= 4);
  // For No Trump, partner covers the suits they bid; I only have to hold
  // up the ones neither of us has mentioned.
  const ourSuits = new Set([...ctx.myBids, ...ctx.partnerBids].map(b => b.suit));
  const unbidCovered = ALL_SUITS.every(s => ourSuits.has(s) || hasStopper(s) || len[s] >= 3);
  const last = ctx.partnerLastBid;

  // 1. Partner invited game — accept it if we have anything to spare.
  //    An invitation describes a narrow range, so judge it on the middle of
  //    that range rather than assuming partner has the bare minimum.
  if (weOwnIt && last && combinedMid >= 25) {
    if (last.suit === 'NT' && last.level === 2) {
      const c = want(3, 'NT', `${pts(hcp)} opposite partner's ${pr.min}+ — accepting the invitation`);
      if (c) return c;
    }
    if (strain && last.suit === strain && strain !== 'NT' &&
        last.level >= gameLevel - 1 && last.level < gameLevel && suitFit >= 8) {
      const c = want(gameLevel, strain, `${pts(hcp)} opposite partner's ${pr.min}+ — accepting the invitation`);
      if (c) return c;
    }
  }

  // 2. Enough for a slam — and only when one of us has shown real power,
  //    never off two limited hands that happen to add up
  if (combinedMid >= 33 && highest.level < 6 && (pr.min >= 19 || hcp >= 18)) {
    if (strain && strain !== 'NT' && suitFit >= 8) {
      const c = want(6, strain, `${pts(hcp)} opposite partner's ${pr.min}+ — enough for a slam`);
      if (c) return c;
    }
    if (flatEnough) {
      const c = want(6, 'NT', `${pts(hcp)} opposite partner's ${pr.min}+ — enough for a slam`);
      if (c) return c;
    }
  }

  // 3. Enough for game
  if (combinedMid >= 26) {
    if (isMajor && suitFit >= 8 && highest.level < 4) {
      const c = want(4, strain, `${pts(hcp)} opposite partner's ${pr.min}+ — bidding the game`);
      if (c) return c;
    }
    if (unbidCovered && !(highest.suit === 'NT' && highest.level >= 3 && weOwnIt)) {
      const c = want(3, 'NT', `${pts(hcp)} opposite partner's ${pr.min}+ — 3 No Trump is game`);
      if (c) return c;
    }
    if (strain && !isMajor && strain !== 'NT' && suitFit >= 8 && combined >= 29 && highest.level < 5) {
      const c = want(5, strain, `${pts(hcp)} opposite partner's ${pr.min}+ — bidding the game`);
      if (c) return c;
    }
  }

  // 4. Close but not certain — invite and let partner decide
  if (combinedMid >= 23 && combinedMid < 26 && weOwnIt) {
    if (isMajor && suitFit >= 8 && highest.level < 3) {
      const c = want(3, strain, `${pts(hcp)} opposite partner's ${pr.min}+ — inviting game`);
      if (c) return c;
    }
    if (flatEnough && stoppersOk && !(highest.suit === 'NT' && weOwnIt)) {
      const c = want(2, 'NT', `${pts(hcp)}, even distribution — inviting game`);
      if (c) return c;
    }
  }

  // 5. The opponents have bought it cheaply and we have a fit — compete once
  if (!weOwnIt && highest.level <= 2 && strain && strain !== 'NT' && suitFit >= 8 && combined >= 21) {
    const c = want(highest.level + 1, strain, `${pts(hcp)} and a good fit — competing once more`);
    if (c) return c;
  }

  return pass('We have described our hands — time to stop');
}

// --- SAFETY NET --------------------------------------------------------

// Last line of defence: never let the computer bid a contract the
// partnership cannot possibly have the strength for.
function applySafety(c, a, ctx) {
  if (c.type !== 'bid') return c;
  if (!c.level || c.level < 1 || c.level > 7 || !BID_SUITS.includes(c.suit)) {
    return pass('Pass');
  }
  if (ctx.bids.length >= 24) {
    return pass('This auction has gone on long enough');
  }

  const combinedMin = a.hcp + ctx.partnerRange.min;
  const combinedMax = a.hcp + ctx.partnerRange.max;
  const fit = c.suit === 'NT' ? 0 : a.len[c.suit] + ctx.partnerLength(c.suit);

  // The highest this partnership could possibly belong, given the most
  // generous reading of partner's calls. Purely a backstop: the bidding
  // rules above decide what to bid, this only blocks the impossible.
  let cap = 1;
  if (combinedMax >= 18) cap = 2;
  if (combinedMax >= 23) cap = 3;
  if (combinedMax >= 26) cap = 4;
  if (combinedMax >= 29) cap = 5;
  if (combinedMax >= 33) cap = 6;
  if (combinedMax >= 37) cap = 7;
  // A suit contract at game level or beyond needs a real fit behind it
  if (c.suit !== 'NT' && fit < 7) cap = Math.min(cap, 3);

  // Never be pushed past game on a hand that cannot hold a slam
  if (c.level > cap) {
    return pass(`Only about ${combinedMin} points between us — ${named(c.level, c.suit)} would be too high`);
  }
  return c;
}

// --- ENTRY POINT -------------------------------------------------------

export function chooseCall(seat, hand, bids) {
  const a = analyzeHand(hand);
  const ctx = buildContext(seat, bids, a);

  let result;
  switch (ctx.role) {
    case 'open':
      result = openingCall(a);
      break;
    case 'responder':
      result = ctx.myBids.length === 0 ? firstResponse(a, ctx) : laterCall(a, ctx);
      break;
    case 'opener':
      result = ctx.myBids.length === 1 ? openerRebid(a, ctx) : laterCall(a, ctx);
      break;
    case 'defend':
      result = overcallOrDouble(a, ctx);
      break;
    case 'advancer':
      result = ctx.myBids.length === 0 ? advance(a, ctx) : laterCall(a, ctx);
      break;
    case 'overcaller':
      result = laterCall(a, ctx);
      break;
    default:
      result = pass('Pass');
  }

  return applySafety(result, a, ctx);
}
