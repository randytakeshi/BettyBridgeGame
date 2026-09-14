/**
 * Card play for BettyBridge.
 *
 * Plays the way a sound club player does: second hand low, third hand
 * high but no higher than needed, cash your winners, draw trumps, and
 * never waste an honour on a trick your partner has already won.
 *
 * Each seat only looks at what it is entitled to see — its own cards,
 * the dummy once it is face up, and (for declarer) both of the hands
 * declarer is actually playing. Nobody peeks.
 */

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SEATS = ['N', 'E', 'S', 'W'];
const ALL_SUITS = ['C', 'D', 'H', 'S'];
const HONOUR = { A: 4, K: 3, Q: 2, J: 1 };

const rankValue = (r) => RANKS.indexOf(r);
const partnerOf = (s) => SEATS[(SEATS.indexOf(s) + 2) % 4];

// Does card a beat card b, given the suit led and the trump suit?
function beats(a, b, ledSuit, trump) {
  if (trump) {
    if (a.suit === trump && b.suit !== trump) return true;
    if (b.suit === trump && a.suit !== trump) return false;
  }
  if (a.suit !== b.suit) return a.suit === ledSuit && b.suit !== ledSuit;
  return rankValue(a.rank) > rankValue(b.rank);
}

export function trickWinner(trick, trump) {
  if (trick.length === 0) return null;
  const ledSuit = trick[0].card.suit;
  let best = trick[0];
  for (let i = 1; i < trick.length; i++) {
    if (beats(trick[i].card, best.card, ledSuit, trump)) best = trick[i];
  }
  return best;
}

/**
 * Everything one seat is allowed to know.
 */
function buildView({ seat, hands, declarer, dummy, dummyVisible, playedCards, trumpSuit }) {
  const visible = new Set([seat]);
  if (dummyVisible && dummy) visible.add(dummy);
  // Declarer plays both hands, so whichever of the two is on lead sees both
  if (declarer && (seat === declarer || seat === dummy)) {
    visible.add(declarer);
    visible.add(dummy);
  }

  // Cards I can account for: everything visible to me plus everything played
  const accounted = new Set();
  for (const s of visible) {
    for (const c of hands[s] || []) accounted.add(`${c.rank}${c.suit}`);
  }
  for (const c of playedCards || []) accounted.add(`${c.rank}${c.suit}`);

  // The best card in a suit that might still be sitting in a hidden hand
  const topHidden = (suit) => {
    for (let i = RANKS.length - 1; i >= 0; i--) {
      if (!accounted.has(`${RANKS[i]}${suit}`)) return RANKS[i];
    }
    return null;
  };

  const hiddenCount = (suit) => {
    let n = 0;
    for (const r of RANKS) if (!accounted.has(`${r}${suit}`)) n++;
    return n;
  };

  const partnerHand = (() => {
    const p = partnerOf(seat);
    return visible.has(p) ? (hands[p] || []) : null;
  })();

  return { visible, topHidden, hiddenCount, partnerHand, trumpSuit };
}

// Cards I am allowed to play right now
function legalIndices(hand, trick) {
  if (trick.length === 0) return hand.map((_, i) => i);
  const led = trick[0].card.suit;
  const following = [];
  for (let i = 0; i < hand.length; i++) if (hand[i].suit === led) following.push(i);
  return following.length > 0 ? following : hand.map((_, i) => i);
}

const lowestOf = (hand, indices) =>
  indices.reduce((best, i) => (rankValue(hand[i].rank) < rankValue(hand[best].rank) ? i : best), indices[0]);

const highestOf = (hand, indices) =>
  indices.reduce((best, i) => (rankValue(hand[i].rank) > rankValue(hand[best].rank) ? i : best), indices[0]);

// The least useful card to throw away.
//
// The order of the tests matters, and getting it wrong is visible from
// across the room. This used to weigh the SUIT first — throw from whichever
// suit held the fewest honours — and only then take the lowest card in it.
// A singleton ace makes its own suit look cheap beside a long holding with
// two honours in it, so the ace went straight in the bin: Betty watched an
// opponent discard the ace of hearts while sitting on K Q 10 9 8 of spades.
//
// So the value of the CARD is settled first and the suit only breaks ties:
// never a trump if there is anything else, never a card that is the best
// one left in its suit, never an honour while a spot card is there to go
// instead — and only then throw from the suit that can spare it.
function discardIndex(hand, indices, trump, view) {
  const nonTrump = indices.filter(i => hand[i].suit !== trump);
  let pool = nonTrump.length > 0 ? nonTrump : indices;

  // A card nothing outstanding can beat is a trick already in hand
  if (view) {
    const notMaster = pool.filter(i => {
      const top = view.topHidden(hand[i].suit);
      return top !== null && rankValue(hand[i].rank) < rankValue(top);
    });
    if (notMaster.length > 0) pool = notMaster;
  }

  // Spot cards before honours, whatever suit they are in
  const plain = pool.filter(i => !HONOUR[hand[i].rank]);
  if (plain.length > 0) pool = plain;

  const honourValue = {};
  for (const s of ALL_SUITS) honourValue[s] = 0;
  for (const c of hand) honourValue[c.suit] += HONOUR[c.rank] || 0;

  let best = pool[0];
  for (const i of pool) {
    const a = hand[i];
    const b = hand[best];
    const ha = HONOUR[a.rank] || 0;
    const hb = HONOUR[b.rank] || 0;
    if (ha !== hb) {
      if (ha < hb) best = i;
    } else if (honourValue[a.suit] !== honourValue[b.suit]) {
      if (honourValue[a.suit] < honourValue[b.suit]) best = i;
    } else if (rankValue(a.rank) < rankValue(b.rank)) {
      best = i;
    }
  }
  return best;
}

// --- LEADING -----------------------------------------------------------

function chooseLead(hand, indices, view, info) {
  const { seat, declarer, dummy, trumpSuit } = info;
  const iAmDeclaringSide = seat === declarer || seat === dummy;

  const lenOf = (suit) => hand.filter(c => c.suit === suit).length;

  if (iAmDeclaringSide) {
    // 1. Draw the defenders' trumps first
    if (trumpSuit) {
      const outstanding = view.hiddenCount(trumpSuit);
      const mine = indices.filter(i => hand[i].suit === trumpSuit);
      if (outstanding > 0 && mine.length > 0) {
        const top = view.topHidden(trumpSuit);
        const high = highestOf(hand, mine);
        // Only bother if our top trump actually beats theirs
        if (!top || rankValue(hand[high].rank) > rankValue(top)) return high;
      }
    }

    // 2. Cash anything that cannot be beaten
    const winners = indices.filter(i => {
      const c = hand[i];
      if (trumpSuit && c.suit !== trumpSuit && view.hiddenCount(trumpSuit) > 0) {
        // A side-suit winner can still be ruffed once opponents are void
        if (view.hiddenCount(c.suit) === 0) return false;
      }
      const top = view.topHidden(c.suit);
      return top === null || rankValue(c.rank) > rankValue(top);
    });
    if (winners.length > 0) {
      // Cash from the longest suit so the length gets established
      let best = winners[0];
      for (const i of winners) {
        if (lenOf(hand[i].suit) > lenOf(hand[best].suit)) best = i;
      }
      return best;
    }

    // 3. Otherwise lead low from our longest side suit to knock out honours
    const side = indices.filter(i => hand[i].suit !== trumpSuit);
    const pool = side.length > 0 ? side : indices;
    let longest = pool[0];
    for (const i of pool) {
      if (lenOf(hand[i].suit) > lenOf(hand[longest].suit)) longest = i;
    }
    const sameSuit = pool.filter(i => hand[i].suit === hand[longest].suit);
    return lowestOf(hand, sameSuit);
  }

  // --- Defender's lead ---

  // 1. Top of a run of touching honours is the safest lead there is
  for (const suit of ALL_SUITS) {
    const inSuit = indices.filter(i => hand[i].suit === suit)
      .sort((a, b) => rankValue(hand[b].rank) - rankValue(hand[a].rank));
    for (let i = 0; i + 1 < inSuit.length; i++) {
      const hi = hand[inSuit[i]];
      const lo = hand[inSuit[i + 1]];
      if (HONOUR[hi.rank] && rankValue(hi.rank) === rankValue(lo.rank) + 1) {
        return inSuit[i];
      }
    }
  }

  // 2. Long suit, low card — but never lead away from a bare ace, and
  //    never lead a singleton trump
  const suitScore = (suit) => {
    const cards = hand.filter(c => c.suit === suit);
    if (cards.length === 0) return -Infinity;
    let score = cards.length * 2;
    const hasAce = cards.some(c => c.rank === 'A');
    const hasKing = cards.some(c => c.rank === 'K');
    if (hasAce && !hasKing) score -= 5;      // leading under an ace gives tricks away
    if (suit === trumpSuit) score -= 4;      // trump leads help declarer
    if (cards.length === 1) score -= 2;
    return score;
  };
  let bestSuit = null;
  for (const s of ALL_SUITS) {
    if (!hand.some(c => c.suit === s)) continue;
    if (bestSuit === null || suitScore(s) > suitScore(bestSuit)) bestSuit = s;
  }
  const inBest = indices.filter(i => hand[i].suit === bestSuit);
  if (inBest.length === 0) return lowestOf(hand, indices);
  if (inBest.length >= 4) {
    // Fourth highest from our longest and strongest
    const sorted = inBest.slice().sort((a, b) => rankValue(hand[b].rank) - rankValue(hand[a].rank));
    return sorted[3];
  }
  return lowestOf(hand, inBest);
}

// --- FOLLOWING ---------------------------------------------------------

function chooseFollow(hand, indices, view, info) {
  const { seat, trick, trumpSuit } = info;
  const ledSuit = trick[0].card.suit;
  const winning = trickWinner(trick, trumpSuit);
  const partner = partnerOf(seat);
  const partnerWinning = winning.player === partner;
  const position = trick.length; // 1 = second hand, 2 = third, 3 = fourth
  const canFollow = hand[indices[0]].suit === ledSuit && indices.some(i => hand[i].suit === ledSuit);

  // Cards of mine that would take the trick as it stands
  const winners = indices.filter(i => beats(hand[i], winning.card, ledSuit, trumpSuit));
  const cheapestWinner = () => winners.reduce(
    (best, i) => (rankValue(hand[i].rank) < rankValue(hand[best].rank) ? i : best), winners[0]);

  if (canFollow) {
    if (partnerWinning) {
      // Last to play and partner is already home — save the good cards
      if (position === 3) return lowestOf(hand, indices);
      // Third hand: only overtake if partner's card is not already the best left
      const top = view.topHidden(ledSuit);
      const partnerSafe = top === null || rankValue(winning.card.rank) > rankValue(top);
      if (partnerSafe) return lowestOf(hand, indices);
      if (winners.length > 0 && position === 2) return cheapestWinner();
      return lowestOf(hand, indices);
    }

    if (position === 1) {
      // Second hand low, unless a cheap winner settles it right now
      if (winners.length > 0) {
        const cheap = cheapestWinner();
        const top = view.topHidden(ledSuit);
        const sure = top === null || rankValue(hand[cheap].rank) > rankValue(top);
        if (sure && HONOUR[winning.card.rank]) return cheap;
      }
      return lowestOf(hand, indices);
    }

    // Third or fourth hand: take it as cheaply as we can
    if (winners.length > 0) return cheapestWinner();
    return lowestOf(hand, indices);
  }

  // --- Void in the suit led ---
  if (partnerWinning && position === 3) return discardIndex(hand, indices, trumpSuit, view);

  if (trumpSuit && !partnerWinning) {
    const trumps = indices.filter(i => hand[i].suit === trumpSuit);
    const winningTrumps = trumps.filter(i => beats(hand[i], winning.card, ledSuit, trumpSuit));
    if (winningTrumps.length > 0) {
      return winningTrumps.reduce(
        (best, i) => (rankValue(hand[i].rank) < rankValue(hand[best].rank) ? i : best), winningTrumps[0]);
    }
  }

  return discardIndex(hand, indices, trumpSuit, view);
}

/**
 * Pick a card for `seat`. Returns an index into that seat's hand, or null
 * when the hand is empty.
 */
export function chooseCard(info) {
  const { seat, hands, trick } = info;
  const hand = hands[seat];
  if (!hand || hand.length === 0) return null;

  const indices = legalIndices(hand, trick);
  if (indices.length === 1) return indices[0];

  const view = buildView(info);
  return trick.length === 0
    ? chooseLead(hand, indices, view, info)
    : chooseFollow(hand, indices, view, info);
}
