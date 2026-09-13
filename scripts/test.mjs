/**
 * Rules and robustness checks for BettyBridge.
 *
 * Plays a few thousand complete boards and asserts the things that must
 * never go wrong: legal follows, thirteen tricks, the right declarer, the
 * dummy staying face down until the opening lead, and correct scoring.
 *
 *   node scripts/test.mjs [boards]
 */
import { GameEngine, PLAYERS } from '../src/GameEngine.js';
import { chooseCall } from '../src/bidding.js';

globalThis.TEST_MODE = true;

const BOARDS = Number(process.argv[2] || 1500);
const SUIT_RANK = { C: 0, D: 1, H: 2, S: 3, NT: 4 };
const failures = [];
let checks = 0;

function check(ok, message) {
  checks++;
  if (!ok) failures.push(message);
}

const hcpOf = (hand) => hand.reduce((s, c) => s + ({ A: 4, K: 3, Q: 2, J: 1 }[c.rank] || 0), 0);

// Score one made or defeated contract from scratch, independently of the
// engine, so a scoring bug cannot hide behind the engine's own arithmetic.
function expectedScore({ level, suit, doubled, vul, declarerSide, tricks }) {
  const need = 6 + level;
  const isVul = vul === 'Both' || vul === declarerSide;
  const mult = doubled === 'redoubled' ? 4 : (doubled === 'doubled' ? 2 : 1);
  if (tricks >= need) {
    const per = (suit === 'C' || suit === 'D') ? 20 : 30;
    const base = suit === 'NT' ? 40 + 30 * (level - 1) : per * level;
    const contractPoints = base * mult;
    let score = contractPoints;
    score += contractPoints >= 100 ? (isVul ? 500 : 300) : 50;
    if (level === 6) score += isVul ? 750 : 500;
    if (level === 7) score += isVul ? 1500 : 1000;
    if (doubled === 'doubled') score += 50;
    if (doubled === 'redoubled') score += 100;
    const over = tricks - need;
    if (over > 0) {
      if (doubled === 'none') score += over * per;
      else if (doubled === 'doubled') score += over * (isVul ? 200 : 100);
      else score += over * (isVul ? 400 : 200);
    }
    return { side: declarerSide, points: score, made: true };
  }
  const down = need - tricks;
  let penalty;
  if (doubled === 'none') {
    penalty = down * (isVul ? 100 : 50);
  } else if (!isVul) {
    penalty = down === 1 ? 100 : (down === 2 ? 300 : (down === 3 ? 500 : 500 + (down - 3) * 300));
    if (doubled === 'redoubled') penalty *= 2;
  } else {
    penalty = down === 1 ? 200 : 200 + (down - 1) * 300;
    if (doubled === 'redoubled') penalty *= 2;
  }
  return { side: declarerSide === 'N/S' ? 'E/W' : 'N/S', points: penalty, made: false };
}

function runBoard(boardNumber, humanSeatsPlay) {
  const engine = new GameEngine(() => {});
  engine.boardNumber = boardNumber;
  engine.resetGame();
  if (!humanSeatsPlay) engine.humanControlsSeat = () => false;

  // Deal without letting the auction start, so the hands can be recorded
  const realCheck = engine.checkAITurn.bind(engine);
  engine.checkAITurn = () => {};
  engine.deal();
  const dealt = JSON.parse(JSON.stringify(engine.hands));
  const startHcp = {};
  for (const p of PLAYERS) startHcp[p] = hcpOf(dealt[p]);
  engine.checkAITurn = realCheck;

  // Watch every play for legality and for the dummy reveal rule
  const plays = [];
  const realPlay = engine.playCard.bind(engine);
  engine.playCard = function (player, index) {
    // The engine plays the rest of the hand before this call returns, so the
    // record has to be taken now, not after.
    const trickBefore = this.currentTrick.slice();
    const handBefore = (this.hands[player] || []).slice();
    const card = handBefore[index];
    const leadMadeBefore = this.openingLeadMade;
    const myIndex = plays.length;
    const record = { player, card, turnIndex: myIndex };
    plays.push(record);

    const ok = realPlay(player, index);
    if (!ok) {
      plays.splice(myIndex, 1);
      return ok;
    }
    if (trickBefore.length > 0) {
      const led = trickBefore[0].card.suit;
      const couldFollow = handBefore.some(c => c.suit === led);
      check(card.suit === led || !couldFollow,
        `board ${boardNumber}: ${player} played ${card.rank}${card.suit} without following ${led}`);
    }
    check(leadMadeBefore || myIndex === 0,
      `board ${boardNumber}: dummy was face up before the opening lead`);
    return ok;
  };

  // Betty's seats, when she is playing them
  let guard = 0;
  const stepHuman = () => {
    while (engine.phase !== 'finished' && guard++ < 400) {
      if (engine.phase === 'bidding' && engine.humanControlsSeat(engine.currentTurn)) {
        engine.placeBid(chooseCall(engine.currentTurn, engine.hands[engine.currentTurn], engine.bids));
      } else if (engine.phase === 'playing' && engine.humanControlsSeat(engine.currentTurn)) {
        const idx = engine.determineAIPlay(engine.currentTurn);
        if (idx === null || !engine.playCard(engine.currentTurn, idx)) {
          check(false, `board ${boardNumber}: Betty could not play a legal card from ${engine.currentTurn}`);
          return;
        }
      } else {
        return; // waiting on the computer, which runs synchronously in tests
      }
    }
  };

  engine.checkAITurn();
  stepHuman();
  let spins = 0;
  while (engine.phase !== 'finished' && spins++ < 200) stepHuman();

  check(engine.phase === 'finished',
    `board ${boardNumber}: game never finished (phase ${engine.phase}, turn ${engine.currentTurn})`);
  if (engine.phase !== 'finished') return null;

  if (!engine.contract) {
    check(engine.bids.length === 4 && engine.bids.every(b => b.type === 'pass'),
      `board ${boardNumber}: no contract but the auction was not four passes`);
    return { passedOut: true };
  }

  // --- Declarer is the first of the winning side to name the strain ---
  const realBids = engine.bids.filter(b => b.type === 'bid');
  const highest = realBids[realBids.length - 1];
  const winningSide = PLAYERS.indexOf(highest.player) % 2;
  const firstNamed = realBids.find(b => b.suit === highest.suit &&
    PLAYERS.indexOf(b.player) % 2 === winningSide);
  check(engine.declarer === firstNamed.player,
    `board ${boardNumber}: declarer should be ${firstNamed.player}, engine said ${engine.declarer}`);
  check(engine.dummy === PLAYERS[(PLAYERS.indexOf(engine.declarer) + 2) % 4],
    `board ${boardNumber}: dummy is not declarer's partner`);
  check(engine.contract.level === highest.level && engine.contract.suit === highest.suit,
    `board ${boardNumber}: contract does not match the final bid`);

  // --- The opening lead comes from declarer's left ---
  const leftOfDeclarer = PLAYERS[(PLAYERS.indexOf(engine.declarer) + 1) % 4];
  check(plays[0] && plays[0].player === leftOfDeclarer,
    `board ${boardNumber}: opening lead came from ${plays[0] && plays[0].player}, not ${leftOfDeclarer}`);

  // --- The auction rose strictly ---
  for (let i = 1; i < realBids.length; i++) {
    const a = realBids[i - 1], b = realBids[i];
    check(b.level > a.level || (b.level === a.level && SUIT_RANK[b.suit] > SUIT_RANK[a.suit]),
      `board ${boardNumber}: ${b.level}${b.suit} did not beat ${a.level}${a.suit}`);
  }

  // --- Every card was played exactly once ---
  check(plays.length === 52, `board ${boardNumber}: ${plays.length} cards played, expected 52`);
  const seen = new Set();
  for (const pl of plays) {
    const key = `${pl.player}:${pl.card.rank}${pl.card.suit}`;
    check(!seen.has(key), `board ${boardNumber}: ${key} was played twice`);
    seen.add(key);
  }
  for (const p of PLAYERS) {
    const fromHand = plays.filter(pl => pl.player === p).map(pl => `${pl.card.rank}${pl.card.suit}`).sort();
    const dealtKeys = dealt[p].map(c => `${c.rank}${c.suit}`).sort();
    check(JSON.stringify(fromHand) === JSON.stringify(dealtKeys),
      `board ${boardNumber}: ${p} played cards that were not dealt to them`);
  }

  const total = engine.tricksWon['N/S'] + engine.tricksWon['E/W'];
  check(total === 13, `board ${boardNumber}: ${total} tricks scored, expected 13`);

  // --- Scoring ---
  const declarerSide = (engine.declarer === 'N' || engine.declarer === 'S') ? 'N/S' : 'E/W';
  const want = expectedScore({
    level: engine.contract.level,
    suit: engine.contract.suit,
    doubled: engine.doubledStatus,
    vul: engine.getVulnerability(),
    declarerSide,
    tricks: engine.tricksWon[declarerSide]
  });
  const got = engine.duplicateScore;
  check(got && got.side === want.side && got.points === want.points && got.made === want.made,
    `board ${boardNumber}: score ${JSON.stringify(got && { side: got.side, points: got.points, made: got.made })}` +
    ` != ${JSON.stringify(want)} for ${engine.contract.level}${engine.contract.suit} ${engine.doubledStatus}` +
    ` taking ${engine.tricksWon[declarerSide]}`);

  return {
    declarer: engine.declarer,
    level: engine.contract.level,
    suit: engine.contract.suit,
    made: want.made,
    sideHcp: declarerSide === 'N/S' ? startHcp.N + startHcp.S : startHcp.E + startHcp.W,
    tricks: engine.tricksWon[declarerSide]
  };
}

// --- Undo ---------------------------------------------------------------
function undoTest() {
  const engine = new GameEngine(() => {});
  engine.resetGame();
  engine.deal();
  let guard = 0;
  // Bid on until Betty has made a call, then take it back
  while (engine.phase === 'bidding' && guard++ < 40) {
    if (engine.humanControlsSeat(engine.currentTurn)) {
      engine.placeBid({ type: 'pass' });
      break;
    }
  }
  if (engine.phase === 'bidding' && engine.bids.some(b => b.player === 'S')) {
    const before = engine.bids.length;
    engine.undo();
    check(engine.bids.length < before, 'undo did not take back the bid');
    check(engine.currentTurn === 'S', 'undo did not return the turn to Betty');
    check(engine.phase === 'bidding', 'undo left the wrong phase');
  }

  // Undo must never offer to rewind a hand Betty is not playing, and must
  // never throw her from the play back into the auction.
  for (let board = 1; board <= 60; board++) {
    const e2 = new GameEngine(() => {});
    e2.boardNumber = board;
    e2.resetGame();
    e2.humanControlsSeat = () => false;
    const startPlay = e2.startPlayingPhase.bind(e2);
    e2.startPlayingPhase = function () { this.phase = 'playing'; };  // stop before any card
    e2.deal();
    e2.startPlayingPhase = startPlay;
    if (e2.phase !== 'playing') continue;

    if (e2.declarer !== 'S') {
      check(e2.canUndo() === false,
        `board ${board}: undo was offered on a hand Betty is not playing (declarer ${e2.declarer})`);
      const bidsBefore = e2.bids.length;
      e2.undo();
      check(e2.phase === 'playing' && e2.bids.length === bidsBefore,
        `board ${board}: undo during the play rewound into the auction`);
    }
  }
}

// --- Run ---------------------------------------------------------------
console.log(`Playing ${BOARDS} boards…\n`);
const results = [];
for (let b = 1; b <= BOARDS; b++) {
  // Alternate between "Betty plays her seats" and "all four automated"
  const r = runBoard(b, b % 2 === 0);
  if (r && !r.passedOut) results.push(r);
}
undoTest();

const isGame = c => (c.suit === 'NT' && c.level >= 3) ||
  (['H', 'S'].includes(c.suit) && c.level >= 4) ||
  (['C', 'D'].includes(c.suit) && c.level >= 5);
const made = results.filter(r => r.made).length;
const games = results.filter(isGame);
const disasters = results.filter(r => (6 + r.level) - r.tricks >= 3);
const overbids = results.filter(r => isGame(r) && r.sideHcp < 23);

console.log(`contracts played : ${results.length} of ${BOARDS} boards`);
console.log(`contracts made   : ${made} (${(100 * made / results.length).toFixed(0)}%)`);
console.log(`games bid        : ${games.length} (${(100 * games.length / results.length).toFixed(0)}%)`);
console.log(`down three or more: ${disasters.length} (${(100 * disasters.length / results.length).toFixed(1)}%)`);
console.log(`game on <23 points: ${overbids.length} (${(100 * overbids.length / results.length).toFixed(1)}%)`);
console.log(`\n${checks} assertions run.`);

if (failures.length) {
  console.error(`\nFAILED — ${failures.length} problem${failures.length === 1 ? '' : 's'}:`);
  for (const f of failures.slice(0, 25)) console.error('  ' + f);
  process.exit(1);
}
console.log('All checks passed.');
