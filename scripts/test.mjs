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

// --- Saving and resuming ------------------------------------------------
// Betty's iPad sleeps mid-hand. The board has to come back exactly as it was
// and still play out to thirteen tricks.
function saveResumeTest(boards = 80) {
  const FIELDS = ['boardNumber', 'phase', 'declarer', 'dummy', 'currentTurn',
    'leader', 'trumpSuit', 'openingLeadMade', 'doubledStatus'];

  for (let board = 1; board <= boards; board++) {
    const e = new GameEngine(() => {});
    e.boardNumber = board;
    e.resetGame();
    e.humanControlsSeat = () => false;

    // Stop at the end of the auction rather than playing the whole board
    const startPlay = e.startPlayingPhase.bind(e);
    e.startPlayingPhase = function () { this.phase = 'playing'; };
    e.deal();
    e.startPlayingPhase = startPlay;

    // Save in the middle of the auction on every third board
    const midAuction = board % 3 === 0;
    if (!midAuction) {
      if (e.phase !== 'playing') continue;
      // Play a handful of cards so the save lands mid-trick sometimes
      const realCheck = e.checkAITurn.bind(e);
      e.checkAITurn = () => {};
      const cards = 1 + (board % 9);
      for (let i = 0; i < cards && e.phase === 'playing'; i++) {
        const idx = e.determineAIPlay(e.currentTurn);
        if (idx === null) break;
        e.playCard(e.currentTurn, idx);
      }
      e.checkAITurn = realCheck;
    } else {
      // Rewind to a partly-finished auction
      e.resetGame();
      e.startPlayingPhase = function () { this.phase = 'playing'; };
      e.deal();
      e.startPlayingPhase = startPlay;
      e.phase = 'bidding';
      e.bids = e.bids.slice(0, Math.max(1, e.bids.length - 2));
      e.currentTurn = PLAYERS[(PLAYERS.indexOf(e.getDealer()) + e.bids.length) % 4];
    }

    const saved = JSON.parse(JSON.stringify(e.serialize()));
    check(GameEngine.isRestorable(saved, false),
      `board ${board}: a freshly written save was rejected`);

    // Come back to it in a brand new engine, as a page reload would
    const e2 = new GameEngine(() => {});
    e2.humanControlsSeat = () => false;
    check(e2.restore(saved) === true, `board ${board}: restore refused a good save`);

    for (const f of FIELDS) {
      check(JSON.stringify(e2[f]) === JSON.stringify(e[f]),
        `board ${board}: ${f} came back as ${JSON.stringify(e2[f])}, expected ${JSON.stringify(e[f])}`);
    }
    for (const p of PLAYERS) {
      check(JSON.stringify(e2.hands[p]) === JSON.stringify(e.hands[p]),
        `board ${board}: ${p}'s hand did not come back intact`);
    }
    check(JSON.stringify(e2.currentTrick) === JSON.stringify(e.currentTrick),
      `board ${board}: the part-played trick did not come back`);
    check(e2.playedCards.length === e.playedCards.length,
      `board ${board}: the played-card record did not come back`);
    check(JSON.stringify(e2.cumulativeScore) === JSON.stringify(e.cumulativeScore),
      `board ${board}: the running score did not come back`);

    // And it still finishes properly from there
    let guard = 0;
    while (e2.phase !== 'finished' && guard++ < 300) e2.checkAITurn();
    check(e2.phase === 'finished', `board ${board}: a resumed board never finished`);
    if (e2.phase === 'finished' && e2.contract) {
      const total = e2.tricksWon['N/S'] + e2.tricksWon['E/W'];
      check(total === 13, `board ${board}: a resumed board scored ${total} tricks`);
    }
  }

  // Junk must be refused rather than trusted. The fixture stops at the end
  // of the auction so every hand still holds thirteen cards — a played-out
  // board would hide the missing-card check behind two empty hands.
  const e = new GameEngine(() => {});
  e.resetGame();
  e.humanControlsSeat = () => false;
  const holdPlay = e.startPlayingPhase.bind(e);
  e.startPlayingPhase = function () { this.phase = 'playing'; };
  e.deal();
  e.startPlayingPhase = holdPlay;
  const good = JSON.parse(JSON.stringify(e.serialize()));
  check(good.hands.N.length === 13 && good.playedCards.length === 0,
    'the corruption fixture was not a full, unplayed deal');
  check(GameEngine.isRestorable({ ...good, v: 99 }, false) === false,
    'a save from another version was accepted');
  check(GameEngine.isRestorable({ ...good, historical: true }, false) === false,
    'a save from the other deal mode was accepted');
  check(GameEngine.isRestorable({ ...good, phase: 'dealing' }, false) === false,
    'a save with no board in progress was accepted');
  check(GameEngine.isRestorable({ ...good, currentTurn: 'X' }, false) === false,
    'a save naming no real seat was accepted');
  const short = JSON.parse(JSON.stringify(good));
  short.hands.N = short.hands.N.slice(1);
  check(GameEngine.isRestorable(short, false) === false,
    'a save missing a card was accepted');
  check(GameEngine.isRestorable(null, false) === false, 'an empty save was accepted');

  // A refused save must leave the engine alone
  const e3 = new GameEngine(() => {});
  e3.resetGame();
  e3.humanControlsSeat = () => false;
  const holdPlay3 = e3.startPlayingPhase.bind(e3);
  e3.startPlayingPhase = function () { this.phase = 'playing'; };
  e3.deal();
  e3.startPlayingPhase = holdPlay3;
  const before = JSON.parse(JSON.stringify(e3.serialize()));
  check(e3.restore({ ...good, v: 99 }) === false, 'restore accepted a bad save');
  check(JSON.stringify(e3.serialize()) === JSON.stringify(before),
    'a refused restore disturbed the game in progress');
}

// --- Replaying a deal ---------------------------------------------------
// The same thirteen cards, bid again from scratch, and the running score
// left exactly where it was.
function replayTest(boards = 60) {
  for (let board = 1; board <= boards; board++) {
    const e = new GameEngine(() => {});
    e.boardNumber = board;
    e.resetGame();
    e.humanControlsSeat = () => false;

    const holdPlay = e.startPlayingPhase.bind(e);
    e.startPlayingPhase = function () { this.phase = 'playing'; };
    e.deal();
    e.startPlayingPhase = holdPlay;
    const dealt = JSON.parse(JSON.stringify(e.dealtHands));
    const dealer = e.getDealer();
    const vul = e.getVulnerability();

    // Play the board right out
    let guard = 0;
    while (e.phase !== 'finished' && guard++ < 300) e.checkAITurn();
    if (e.phase !== 'finished') { check(false, `board ${board}: never finished before replay`); continue; }

    const scoreAfterFirst = JSON.parse(JSON.stringify(e.cumulativeScore));
    const firstContract = e.contract ? { ...e.contract } : null;

    check(e.replayBoard() === true, `board ${board}: replay was refused`);

    // The same cards come back out
    for (const p of PLAYERS) {
      const back = e.hands[p].map(c => `${c.rank}${c.suit}`).sort().join(' ');
      const orig = dealt[p].map(c => `${c.rank}${c.suit}`).sort().join(' ');
      check(back === orig || e.phase === 'finished',
        `board ${board}: ${p} was dealt different cards on the replay`);
    }
    check(e.boardNumber === board, `board ${board}: the replay changed the board number`);
    check(e.getDealer() === dealer, `board ${board}: the replay changed the dealer`);
    check(e.getVulnerability() === vul, `board ${board}: the replay changed the vulnerability`);
    check(e.isReplay === true, `board ${board}: the replay was not marked as one`);
    if (firstContract) {
      check(!!e.firstResult, `board ${board}: the first result was not kept for comparison`);
    }

    // Play the replay out — and the running score must not budge
    guard = 0;
    while (e.phase !== 'finished' && guard++ < 300) e.checkAITurn();
    check(e.phase === 'finished', `board ${board}: the replay never finished`);
    check(JSON.stringify(e.cumulativeScore) === JSON.stringify(scoreAfterFirst),
      `board ${board}: a replay moved the running score to ${JSON.stringify(e.cumulativeScore)}`);
    if (e.contract) {
      const total = e.tricksWon['N/S'] + e.tricksWon['E/W'];
      check(total === 13, `board ${board}: the replay scored ${total} tricks`);
    }

    // Replaying twice keeps pointing back at the very first attempt
    const firstKept = JSON.stringify(e.firstResult);
    e.replayBoard();
    check(JSON.stringify(e.firstResult) === firstKept,
      `board ${board}: a second replay forgot the original result`);

    // Moving on clears the replay flag so the next board scores normally
    e.nextBoard();
    check(e.isReplay === false, `board ${board}: the next board was still marked a replay`);
    check(e.firstResult === null, `board ${board}: the next board kept the old result`);
  }

  // Saving during the pause that shows a finished trick. The test engine
  // clears tricks instantly, so this state can only be built by hand — and
  // it is the state the app is in for two and a half seconds of every trick,
  // which is plenty of time for the iPad to go to sleep.
  for (let board = 1; board <= 40; board++) {
    const e = new GameEngine(() => {});
    e.boardNumber = board;
    e.resetGame();
    e.humanControlsSeat = () => false;
    const holdPlay = e.startPlayingPhase.bind(e);
    e.startPlayingPhase = function () { this.phase = 'playing'; };
    e.deal();
    e.startPlayingPhase = holdPlay;
    if (e.phase !== 'playing') continue;

    // Four cards down, trick not yet cleared, no timer running
    const realResolve = e.resolveTrick.bind(e);
    const realCheck = e.checkAITurn.bind(e);
    e.resolveTrick = () => {};
    e.checkAITurn = () => {};
    for (let i = 0; i < 4; i++) e.playCard(e.currentTurn, e.determineAIPlay(e.currentTurn));
    e.resolveTrick = realResolve;
    e.checkAITurn = realCheck;
    if (e.currentTrick.length !== 4) continue;

    const saved = JSON.parse(JSON.stringify(e.serialize()));
    const e2 = new GameEngine(() => {});
    e2.humanControlsSeat = () => false;
    check(e2.restore(saved) === true, `board ${board}: a mid-pause save was refused`);
    check(e2.currentTrick.length === 4, `board ${board}: the finished trick did not come back`);

    // Resuming must clear the trick and carry on, not sit there forever
    let guard = 0;
    while (e2.phase !== 'finished' && guard++ < 400) e2.checkAITurn();
    check(e2.phase === 'finished',
      `board ${board}: a board saved while a trick was on the table could not be resumed`);
    if (e2.phase === 'finished' && e2.contract) {
      const total = e2.tricksWon['N/S'] + e2.tricksWon['E/W'];
      check(total === 13, `board ${board}: resuming mid-trick scored ${total} tricks`);
    }
  }

  // A replay survives being saved and resumed
  const e2 = new GameEngine(() => {});
  e2.resetGame();
  e2.humanControlsSeat = () => false;
  e2.deal();
  e2.replayBoard();
  const saved = JSON.parse(JSON.stringify(e2.serialize()));
  const e3 = new GameEngine(() => {});
  e3.humanControlsSeat = () => false;
  check(e3.restore(saved) === true, 'a replay could not be restored');
  check(e3.isReplay === true, 'a restored replay forgot it was one');
  check(!!e3.dealtHands, 'a restored board could not be replayed again');

  // Speed only changes the pace, never the rules
  const e4 = new GameEngine(() => {});
  e4.setSpeed('fast');
  check(e4.speed === 0.5, 'the fast setting did not take');
  e4.setSpeed('slow');
  check(e4.speed === 1.6, 'the slow setting did not take');
  e4.setSpeed('nonsense');
  check(e4.speed === 1, 'an unknown speed did not fall back to normal');
}

// --- Betty's own rules, checked on every board ---------------------------
// "When opening bid is made, just high card points matter" and "if you repeat
// your 5 card major it means you have 6 cards". Both are things she will spot
// instantly at the table, so both are asserted rather than assumed.
function houseRulesTest(boards = 600) {
  const partnerOf = (s) => PLAYERS[(PLAYERS.indexOf(s) + 2) % 4];
  const hcpOf = (h) => h.reduce((s, c) => s + ({ A: 4, K: 3, Q: 2, J: 1 }[c.rank] || 0), 0);

  for (let board = 1; board <= boards; board++) {
    const e = new GameEngine(() => {});
    e.boardNumber = board;
    e.resetGame();
    e.humanControlsSeat = () => false;
    const holdPlay = e.startPlayingPhase.bind(e);
    e.startPlayingPhase = function () { this.phase = 'playing'; };
    e.deal();
    e.startPlayingPhase = holdPlay;

    const dealt = {};
    for (const p of PLAYERS) dealt[p] = e.hands[p].slice();
    const lenIn = (p, suit) => dealt[p].filter(c => c.suit === suit).length;
    const bids = e.bids.filter(c => c.type === 'bid');
    if (!bids.length) continue;

    // Nobody opens on fewer than thirteen high cards
    const opener = bids[0];
    check(hcpOf(dealt[opener.player]) >= 13,
      `board ${board}: ${opener.player} opened ${opener.level}${opener.suit} on ` +
      `${hcpOf(dealt[opener.player])} high cards`);

    // Naming your own suit a second time, without partner ever having bid it,
    // promises six
    const firstAt = {};
    bids.forEach((c, i) => {
      const k = `${c.player}${c.suit}`;
      if (firstAt[k] !== undefined && c.suit !== 'NT') {
        const partnerBidIt = bids.slice(0, i)
          .some(x => x.player === partnerOf(c.player) && x.suit === c.suit);
        if (!partnerBidIt) {
          check(lenIn(c.player, c.suit) >= 6,
            `board ${board}: ${c.player} rebid ${c.level}${c.suit} holding only ` +
            `${lenIn(c.player, c.suit)} — a repeat promises six`);
        }
      }
      if (firstAt[k] === undefined) firstAt[k] = i;
    });

    // No artificial calls: every suit bid means that suit
    check(!bids.some(c => c.level === 2 && c.suit === 'C' && c === bids[0]),
      `board ${board}: an artificial 2 Clubs opening slipped back in`);
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
saveResumeTest();
replayTest();
houseRulesTest();

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
