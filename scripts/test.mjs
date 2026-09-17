/**
 * Rules and robustness checks for BettyBridge.
 *
 * Plays a few thousand complete boards and asserts the things that must
 * never go wrong: legal follows, thirteen tricks, the right declarer, the
 * dummy staying face down until the opening lead, and correct scoring.
 *
 *   node scripts/test.mjs [boards]
 */
import { GameEngine, PLAYERS, humanPlaysSeat, MAX_REDEALS } from '../src/GameEngine.js';
import { chooseCall, classifyCall, classifyDouble, setWeakTwos, DEFAULT_WEAK_TWOS, analyzeHand } from '../src/bidding.js';

globalThis.TEST_MODE = true;

const BOARDS = Number(process.argv[2] || 1500);
const SUIT_RANK = { C: 0, D: 1, H: 2, S: 3, NT: 4 };
const ALL_SUITS_ORDER = ['S', 'H', 'D', 'C'];
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

  // Deal without letting the auction start. The hands themselves are read
  // later from engine.dealtHands: a board that is passed out is dealt again,
  // and snapshotting here would record a deal that was then thrown away.
  const realCheck = engine.checkAITurn.bind(engine);
  engine.checkAITurn = () => {};
  engine.deal();
  engine.checkAITurn = realCheck;

  // Watch every play for legality and for the dummy reveal rule
  const plays = [];
  const realPlay = engine.playCard.bind(engine);
  // Set only for the call Betty herself makes. The engine runs the rest of
  // the hand before that call returns, so it is cleared immediately and any
  // play nested inside is correctly recorded as the computer's.
  let bettyIsPlaying = false;
  engine.playCard = function (player, index) {
    const by = bettyIsPlaying ? 'betty' : 'computer';
    bettyIsPlaying = false;
    // The engine plays the rest of the hand before this call returns, so the
    // record has to be taken now, not after.
    const trickBefore = this.currentTrick.slice();
    const handBefore = (this.hands[player] || []).slice();
    const card = handBefore[index];
    const leadMadeBefore = this.openingLeadMade;
    const myIndex = plays.length;
    const record = { player, card, turnIndex: myIndex, by };
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
        bettyIsPlaying = true;
        const played = idx !== null && engine.playCard(engine.currentTurn, idx);
        bettyIsPlaying = false;
        if (!played) {
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

  // The deal as it came off the shuffle. The engine replaces this on a redeal,
  // so it always describes the cards that were really played.
  const dealt = engine.dealtHands;
  const startHcp = {};
  for (const p of PLAYERS) startHcp[p] = hcpOf(dealt[p]);

  if (!engine.contract) {
    check(engine.bids.length === 4 && engine.bids.every(b => b.type === 'pass'),
      `board ${boardNumber}: no contract but the auction was not four passes`);
    check(engine.redealCount === MAX_REDEALS,
      `board ${boardNumber}: given up after only ${engine.redealCount} redeal(s) — a board nobody ` +
      `has played should be dealt again up to ${MAX_REDEALS} times first`);
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

  // --- "The winner always plays his and his partner's hand" (Betty) ---
  // From Betty's chair in the South seat that means she plays two hands when
  // she declares, none at all when her own hand is the dummy, and only her
  // own when she is defending. Checked on the boards where she is playing
  // her seats for real; on the others every seat is automated by design.
  if (humanSeatsPlay) {
    const hers = engine.declarer === 'S' ? ['S', 'N']
      : engine.dummy === 'S' ? []
      : ['S'];
    const label = hers.length ? hers.join(' and ') : 'no hands at all';
    for (const pl of plays) {
      const shouldBeHers = hers.includes(pl.player);
      check(shouldBeHers ? pl.by === 'betty' : pl.by === 'computer',
        `board ${boardNumber}: ${pl.card.rank}${pl.card.suit} from ${pl.player} was played by ` +
        `${pl.by === 'betty' ? 'Betty' : 'the computer'}, but with ${engine.declarer} declaring ` +
        `she plays ${label}`);
    }
    check(plays.filter(pl => pl.by === 'betty').length === hers.length * 13,
      `board ${boardNumber}: Betty played ${plays.filter(pl => pl.by === 'betty').length} cards ` +
      `with ${engine.declarer} declaring, expected ${hers.length * 13}`);
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
// "Just high card points matter" to open, "if you repeat your 5 card major it
// means you have 6 cards", 2 Clubs for 22, Stayman, and 4 No Trump for aces.
// All of them are things she will spot instantly, so all are asserted.
function houseRulesTest(boards = 600) {
  const partnerOf = (s) => PLAYERS[(PLAYERS.indexOf(s) + 2) % 4];
  const sameSideAs = (a, b) => (PLAYERS.indexOf(a) % 2) === (PLAYERS.indexOf(b) % 2);
  const hcpOf = (h) => h.reduce((s, c) => s + ({ A: 4, K: 3, Q: 2, J: 1 }[c.rank] || 0), 0);
  const acesOf = (h) => h.filter(c => c.rank === 'A').length;
  const ACE_SUIT = { C: 0, D: 1, H: 2, S: 3 };

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
    const meaning = bids.map((_, i) => classifyCall(bids, i));
    // Deals are random, so a board number is not reproducible. Any failure
    // has to carry the auction with it or it cannot be diagnosed afterwards.
    const auction = e.bids
      .map(c => `${c.player}:${c.type === 'bid' ? c.level + c.suit : c.type === 'double' ? 'X' : 'p'}`)
      .join(' ');

    // Nobody opens on fewer than thirteen high cards — except the defensive
    // openings, which trade points for shape.
    const opener = bids[0];
    const openerHcp = hcpOf(dealt[opener.player]);
    if (opener.level === 2 && ['S', 'H', 'D'].includes(opener.suit)) {
      // A weak two is exactly six cards and six to ten points
      check(dealt[opener.player].filter(c => c.suit === opener.suit).length === 6,
        `board ${board}: ${opener.player} opened a weak ${opener.level}${opener.suit} without six cards`);
      check(openerHcp >= 6 && openerHcp <= 10,
        `board ${board}: ${opener.player} opened ${opener.level}${opener.suit} on ${openerHcp} points ` +
        `— a weak two is six to ten`);
    } else if (opener.level === 3 && opener.suit !== 'NT') {
      check(dealt[opener.player].filter(c => c.suit === opener.suit).length >= 7,
        `board ${board}: ${opener.player} opened ${opener.level}${opener.suit} without seven cards`);
      check(openerHcp >= 6 && openerHcp <= 12,
        `board ${board}: ${opener.player} opened ${opener.level}${opener.suit} on ${openerHcp} points ` +
        `— the defensive opening is six to twelve`);
    } else {
      // Below thirteen there are only two ways in: the seven-card three-bid
      // handled above, and twelve points with a suit strong enough to play in
      // and a control to go with it. Betty: "if you have just queens and jacks
      // you have no control of the game."
      const topThree = (suit) => dealt[opener.player]
        .filter(c => c.suit === suit && ['A', 'K', 'Q'].includes(c.rank)).length;
      const acesHeld = dealt[opener.player].filter(c => c.rank === 'A').length;
      const kingsHeld = dealt[opener.player].filter(c => c.rank === 'K').length;
      const controlled = acesHeld >= 1 || kingsHeld >= 2;
      const openLen = lenIn(opener.player, opener.suit);
      const strongEnough = (openLen >= 5 && topThree(opener.suit) >= 2) ||
                           (openLen >= 6 && topThree(opener.suit) >= 1);
      const twelveOpening = openerHcp === 12 && opener.level === 1 &&
        opener.suit !== 'NT' && controlled && strongEnough;
      check(openerHcp >= 13 || twelveOpening,
        `board ${board}: ${opener.player} opened ${opener.level}${opener.suit} on ` +
        `${openerHcp} high cards` +
        (openerHcp === 12 && !controlled ? ' with no ace and fewer than two kings' : '') +
        (openerHcp === 12 && !strongEnough ? ` with only ${openLen} to the suit` : ''));
    }

    // The 2 Clubs opening means 22 or more, not clubs
    if (meaning[0] === 'strong2C') {
      check(hcpOf(dealt[opener.player]) >= 22,
        `board ${board}: opened 2 Clubs on only ${hcpOf(dealt[opener.player])} points`);
    }

    // Naming your own suit a second time, without partner ever having bid it,
    // promises six. Artificial calls name no suit, so they do not count.
    const firstAt = {};
    bids.forEach((c, i) => {
      if (meaning[i] !== null) return;            // artificial, says nothing about the suit
      const k = `${c.player}${c.suit}`;
      if (firstAt[k] !== undefined && c.suit !== 'NT') {
        const partnerBidIt = bids.slice(0, i)
          .some((x, j) => meaning[j] === null && x.player === partnerOf(c.player) && x.suit === c.suit);
        if (!partnerBidIt) {
          check(lenIn(c.player, c.suit) >= 6,
            `board ${board}: ${c.player} rebid ${c.level}${c.suit} holding only ` +
            `${lenIn(c.player, c.suit)} — a repeat promises six`);
        }
      }
      if (firstAt[k] === undefined) firstAt[k] = i;
    });

    // A suit bid at the two level over partner's 1 No Trump is that suit, and
    // she was specific: at least five of them.
    bids.forEach((c, i) => {
      if (meaning[i] !== null) return;                 // artificial calls name nothing
      if (i === 0 || c.level !== 2 || c.suit === 'NT') return;
      const prev = bids[i - 1];
      if (!(prev && prev === bids[0] && prev.level === 1 && prev.suit === 'NT')) return;
      if (!sameSideAs(prev.player, c.player)) return;
      check(dealt[c.player].filter(x => x.suit === c.suit).length >= 5,
        `${c.player} answered 1 No Trump with ${c.level}${c.suit} holding only ` +
        `${dealt[c.player].filter(x => x.suit === c.suit).length} — that shows five — ${auction}`);
    });

    // Partner never pulls a penalty double. She was explicit: at the three
    // level, or once both sides have bid, a double means she can beat them.
    e.bids.forEach((c, i) => {
      if (c.type !== 'double') return;
      if (classifyDouble(e.bids, i) !== 'penalty') return;
      const next = e.bids.slice(i + 1).find(x => x.player === partnerOf(c.player));
      if (!next) return;
      check(next.type !== 'bid',
        `board ${board}: ${next.player} pulled ${c.player}'s penalty double with ` +
        `${next.level}${next.suit}`);
    });

    // A question must never go unanswered — the whole auction depends on it
    bids.forEach((c, i) => {
      const asked = meaning[i];
      if (!['stayman', 'blackwood', 'strong2C', 'kingAsk', 'transfer'].includes(asked)) return;
      const reply = bids.slice(i + 1).find(x => x.player === partnerOf(c.player));
      const replyMeaning = reply ? meaning[bids.indexOf(reply)] : null;
      // The opponents are allowed to bid over a question, and partner is then
      // released from answering it. Partner is at fault only if they had a
      // clear run — nothing bid between the question and their own next turn.
      const askAt = e.bids.indexOf(c);
      const partnerTurnAt = e.bids.findIndex((x, j) => j > askAt && x.player === partnerOf(c.player));
      const theyInterfered = partnerTurnAt < 0 || e.bids
        .slice(askAt + 1, partnerTurnAt)
        .some(x => x.type === 'bid' && !sameSideAs(x.player, c.player));
      if (asked === 'transfer' && !theyInterfered) {
        check(replyMeaning === 'transferDone',
          `a transfer went uncompleted (got ${reply ? reply.level + reply.suit : 'a pass'}) — ${auction}`);
      }
      if (asked === 'stayman' && !theyInterfered) {
        check(replyMeaning === 'staymanReply',
          `Stayman went unanswered (got ${reply ? reply.level + reply.suit : 'a pass'}) — ${auction}`);
      }
      if (asked === 'strong2C' && !theyInterfered) {
        check(!!reply, `the 2 Clubs opening was passed out — ${auction}`);
      }
      if (asked === 'kingAsk' && !theyInterfered) {
        check(replyMeaning === 'kingShow',
          `5 No Trump went unanswered (got ${reply ? reply.level + reply.suit : 'a pass'}) — ${auction}`);
        if (replyMeaning === 'kingShow') {
          const shown = ACE_SUIT[reply.suit];
          const held = dealt[reply.player].filter(c => c.rank === 'K').length;
          check(held === shown || (reply.suit === 'C' && held === 4),
            `${reply.player} showed ${shown} kings holding ${held} — ${auction}`);
        }
      }
      if (asked === 'blackwood' && !theyInterfered) {
        check(replyMeaning === 'aceShow',
          `4 No Trump went unanswered (got ${reply ? reply.level + reply.suit : 'a pass'}) — ${auction}`);
        if (replyMeaning === 'aceShow') {
          // and the answer must be the truth
          const shown = ACE_SUIT[reply.suit];
          const held = acesOf(dealt[reply.player]);
          check(held === shown || (reply.suit === 'C' && held === 4),
            `${reply.player} showed ${shown} aces holding ${held} — ${auction}`);
        }
      }
    });
  }
}

// --- Never sitting there with nothing coming -----------------------------
// Betty reported "it was David's turn and nothing was played". Every computer
// move lives in a timer, and a timer does not survive an iPad going to sleep,
// so the game has to be able to start itself again.
function noFreezeTest(boards = 120) {
  for (let board = 1; board <= boards; board++) {
    const e = new GameEngine(() => {});
    e.boardNumber = board;
    e.resetGame();
    e.humanControlsSeat = () => false;
    const holdPlay = e.startPlayingPhase.bind(e);
    e.startPlayingPhase = function () { this.phase = 'playing'; };
    e.deal();
    e.startPlayingPhase = holdPlay;
    if (e.phase !== 'playing') continue;

    // A move was due and the timer is gone. One nudge has to restart it.
    const before = e.playedCards.length;
    e.nudge();
    check(e.playedCards.length > before || e.phase === 'finished',
      `board ${board}: a stranded computer turn did not restart`);
  }

  // It must never play for Betty, however stranded it looks
  for (let board = 1; board <= 60; board++) {
    const e = new GameEngine(() => {});
    e.boardNumber = board;
    e.resetGame();
    const holdPlay = e.startPlayingPhase.bind(e);
    e.startPlayingPhase = function () { this.phase = 'playing'; };
    e.deal();
    e.startPlayingPhase = holdPlay;
    if (e.phase !== 'playing') continue;
    // Move the turn to a seat Betty controls
    while (!e.humanControlsSeat(e.currentTurn)) {
      const before = e.playedCards.length;
      e.nudge();
      if (e.playedCards.length === before || e.phase !== 'playing') break;
    }
    if (e.phase !== 'playing' || !e.humanControlsSeat(e.currentTurn)) continue;
    const hers = e.playedCards.length;
    e.nudge();
    e.nudge();
    check(e.playedCards.length === hers,
      `board ${board}: the game played a card for Betty while waiting on her`);
  }

  // Nothing to do once the board is over
  const done = new GameEngine(() => {});
  done.resetGame();
  done.humanControlsSeat = () => false;
  done.deal();
  if (done.phase === 'finished') {
    const snapshot = JSON.stringify(done.serialize());
    done.nudge();
    check(JSON.stringify(done.serialize()) === snapshot,
      'nudging a finished board changed it');
  }

  // An iPad in the background does not cancel timers, it stretches them —
  // sometimes to minutes. Such a timer still looks pending, so the watchdog
  // rightly leaves it alone; only coming back to the app can tell the
  // difference. This is the shape of what Betty actually saw.
  for (let board = 1; board <= 60; board++) {
    const e = new GameEngine(() => {});
    e.boardNumber = board;
    e.resetGame();
    e.humanControlsSeat = () => false;
    const holdPlay = e.startPlayingPhase.bind(e);
    e.startPlayingPhase = function () { this.phase = 'playing'; };
    e.deal();
    e.startPlayingPhase = holdPlay;
    if (e.phase !== 'playing') continue;

    // Leave a computer seat on move with a timer that will never usefully fire
    const realCheck = e.checkAITurn.bind(e);
    e.checkAITurn = () => {};
    for (let i = 0; i < 3 && e.phase === 'playing'; i++) {
      const idx = e.determineAIPlay(e.currentTurn);
      if (idx === null) break;
      e.playCard(e.currentTurn, idx);
    }
    e.checkAITurn = realCheck;
    e.clearTimers();
    e.aiTimer = setTimeout(() => {}, 600000);

    const stalled = e.playedCards.length;
    e.nudge();
    check(e.playedCards.length === stalled,
      `board ${board}: the watchdog interfered with a timer that was still pending`);

    e.resume();
    clearTimeout(e.aiTimer);
    check(e.playedCards.length > stalled || e.phase === 'finished',
      `board ${board}: coming back to the app did not restart a stalled turn`);
    e.destroy();
  }

  // Whatever goes wrong inside a computer's turn, the hand must go on. That
  // timer is the only thing that would ever move the seat, so an exception in
  // there used to stop the game dead with no way back.
  {
    const quiet = console.error;
    console.error = () => {};
    for (const breakWhat of ['play', 'bid']) {
      let finished = 0, correct = 0, boards = 0;
      for (let board = 1; board <= 40; board++) {
        const e = new GameEngine(() => {});
        e.boardNumber = board;
        e.resetGame();
        e.humanControlsSeat = () => false;
        if (breakWhat === 'play') e.determineAIPlay = () => { throw new Error('boom'); };
        else e.determineAIBid = () => { throw new Error('boom'); };
        e.deal();
        let guard = 0;
        while (e.phase !== 'finished' && guard++ < 400) e.checkAITurn();
        boards++;
        if (e.phase === 'finished') finished++;
        if (!e.contract || e.tricksWon['N/S'] + e.tricksWon['E/W'] === 13) correct++;
      }
      console.error = quiet;
      check(finished === boards,
        `with the ${breakWhat} chooser throwing, only ${finished} of ${boards} boards finished`);
      check(correct === boards,
        `with the ${breakWhat} chooser throwing, ${boards - correct} boards scored the wrong tricks`);
      console.error = () => {};
    }
    console.error = quiet;
  }

  // And if the chosen card is refused, something legal still gets played
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

    const realCheck = e.checkAITurn.bind(e);
    e.checkAITurn = () => {};
    e.determineAIPlay = () => null;          // as if it could not choose
    const before = e.playedCards.length;
    e.makeAIPlay();
    check(e.playedCards.length === before + 1,
      `board ${board}: nothing was played when the chosen card came back empty`);
    e.checkAITurn = realCheck;
  }
}

// --- A new suit from partner is forcing -----------------------------------
// Betty: "If responder has 10 pts game is a possibility after a one bid."
// They cannot show that if opener is allowed to pass their answer. Opener
// used to: 1 Club — 1 Heart — pass, twenty-seven points between them and
// eleven tricks in the hand. A new suit says nothing about strength yet, so
// opener always owes one more call.
function forcingResponseTest(boards = 900) {
  let seen = 0;
  const failures = [];
  for (let board = 1; board <= boards; board++) {
    const e = new GameEngine(() => {});
    e.boardNumber = board;
    e.resetGame();
    e.humanControlsSeat = () => false;
    const holdPlay = e.startPlayingPhase.bind(e);
    e.startPlayingPhase = function () { this.phase = 'playing'; };
    e.deal();
    e.startPlayingPhase = holdPlay;

    const bids = e.bids;
    const openIdx = bids.findIndex(c => c.type === 'bid');
    if (openIdx < 0) continue;
    const opener = bids[openIdx];
    const lho = bids[openIdx + 1];
    const answer = bids[openIdx + 2];
    const rho = bids[openIdx + 3];
    const rebid = bids[openIdx + 4];
    if (!lho || lho.type !== 'pass') continue;                  // uncontested only
    if (!rho || rho.type !== 'pass') continue;
    if (!answer || answer.type !== 'bid') continue;
    if (answer.suit === opener.suit || answer.suit === 'NT') continue;  // must be a NEW suit

    // Two shapes are forcing: a new suit over a plain one-bid, and a suit at
    // the three level over a No Trump opening. (A suit at the TWO level over
    // 1 No Trump is partner choosing where to play, and may be passed.)
    const overOneBid = opener.level === 1 && opener.suit !== 'NT';
    const overNoTrump = opener.suit === 'NT' && answer.level === 3;
    if (!overOneBid && !overNoTrump) continue;
    seen++;
    if (!rebid || rebid.type === 'pass') {
      if (failures.length < 4) {
        failures.push(`board ${board}: ` + bids
          .map(c => `${c.player}:${c.type === 'bid' ? c.level + c.suit : c.type === 'double' ? 'X' : 'p'}`)
          .join(' '));
      }
    }
  }
  check(seen > 0, `no uncontested new-suit answer came up in ${boards} boards, so nothing was tested`);
  check(failures.length === 0,
    `opener passed partner's forcing answer ${failures.length} time(s): ` +
    failures.join(' | '));
}

// --- A passed-out board is dealt again ------------------------------------
// Betty: "Game one passed out — redeal if it has not been played. We all play
// the same cards." Nobody has seen the cards, so the board is dealt again by
// the same dealer rather than scored and skipped.
function redealTest() {
  const allPass = (e) => {
    e.determineAIBid = () => ({ type: 'pass', explanation: 'Pass' });
  };
  const dealt = (e) => e.hands.S.map(c => c.rank + c.suit).join(' ');
  const sitAndPass = (e, limit) => {
    const seen = new Set();
    let guard = 0;
    while (e.phase !== 'finished' && guard++ < limit) {
      seen.add(dealt(e));
      if (!humanPlaysSeat(e, e.currentTurn)) break;
      e.placeBid({ type: 'pass', explanation: 'Pass' });
    }
    return seen;
  };

  const e = new GameEngine(() => {});
  e.boardNumber = 7;
  e.resetGame();
  const realCheck = e.checkAITurn.bind(e);
  e.checkAITurn = () => {};
  e.deal();
  e.checkAITurn = realCheck;
  allPass(e);
  e.checkAITurn();
  const seen = sitAndPass(e, 60);

  check(e.phase === 'finished',
    `a board passed out over and over never settled — it would reshuffle in front of her for ever`);
  check(e.boardNumber === 7,
    `the board number moved to ${e.boardNumber}: a passed-out board is dealt again, not skipped`);
  check(seen.size === MAX_REDEALS + 1,
    `passing everything out should deal ${MAX_REDEALS + 1} hands before giving up, it dealt ${seen.size}`);
  check(e.redealCount === MAX_REDEALS,
    `the redeal count finished at ${e.redealCount}, expected ${MAX_REDEALS}`);
  check(!!e.duplicateScore && e.duplicateScore.side === 'None',
    'once it gives up redealing, the pass-out has to be scored so the game can move on');

  // A replay is a particular deal she asked to see again. Swapping it for a
  // different one would defeat the whole point of the button.
  const r = new GameEngine(() => {});
  r.boardNumber = 3;
  r.resetGame();
  const rCheck = r.checkAITurn.bind(r);
  r.checkAITurn = () => {};
  r.deal();
  r.checkAITurn = rCheck;
  allPass(r);
  r.replayBoard();
  const replayed = dealt(r);
  sitAndPass(r, 20);
  check(r.phase === 'finished', 'a replayed board that was passed out never settled');
  check(dealt(r) === replayed,
    'a replayed board was dealt again after being passed out — she asked to see that exact deal');
}

// --- Distribution points --------------------------------------------------
// Betty: "to answer your partner, this responder should have at least three of
// the suit to support it. You try to have at least eight in your big suit,
// usually five in your hand and three in your partner's hand. After the first
// bid you can count the distributional points... if you have none of one of
// the suits you get either five or three points."
//
// Five is the number for the hand supporting partner, which is the only place
// the game counts shortness at all. These are the figures printed in the Rules
// card, so if the table here changes, what she is told becomes a lie.
function distributionTest() {
  const handOf = (spec) => {
    const out = [];
    for (const suit of ALL_SUITS_ORDER) for (const rank of (spec[suit] || [])) out.push({ rank, suit });
    return out;
  };

  const cases = [
    { name: 'a void', want: 5, spec: { S: ['K', '7', '2'], H: [], D: ['Q', '8', '6', '5', '4'], C: ['J', '9', '8', '4', '3'] } },
    { name: 'a singleton', want: 3, spec: { S: ['K', '7', '2'], H: ['4'], D: ['Q', '8', '6', '5', '4'], C: ['J', '9', '8', '4'] } },
    { name: 'a doubleton', want: 1, spec: { S: ['K', '7', '2'], H: ['4', '3'], D: ['Q', '8', '6', '5'], C: ['J', '9', '8', '4'] } },
    { name: 'nothing short', want: 0, spec: { S: ['K', '7', '2'], H: ['4', '3', '2'], D: ['Q', '8', '6', '5'], C: ['J', '9', '8'] } }
  ];
  for (const c of cases) {
    const hand = handOf(c.spec);
    check(hand.length === 13, `distribution fixture "${c.name}" has ${hand.length} cards, not 13`);
    const got = analyzeHand(hand).shortnessPts('S');
    check(got === c.want, `supporting Spades with ${c.name} should add ${c.want}, the game added ${got}`);
  }

  // Shortness in the trump suit itself is worth nothing — you cannot ruff
  // with the suit you are ruffing into.
  const shortTrumps = handOf({ S: ['K', '2'], H: ['A', '9', '7', '5', '3'], D: ['Q', '8', '6'], C: ['J', '9', '4'] });
  check(shortTrumps.length === 13, 'trump-shortness fixture is not thirteen cards');
  check(analyzeHand(shortTrumps).shortnessPts('S') === 0,
    'a doubleton in the trump suit was counted as distribution, and it must not be');

  // "When opening bid is made, just high card points matter." A void must not
  // push a 12-point hand into opening.
  // Deliberately nothing that could legitimately open on twelve: no five-card
  // major, no seven-card suit, and no suit strong enough for the shape route
  // (the five-card diamonds hold only one of the top three). The void is the
  // only thing left that could lift it — and it must not.
  const twelveWithVoid = handOf({ S: ['K', 'J', '5', '3'], H: [], D: ['Q', '9', '7', '6', '4'], C: ['A', 'Q', '8', '2'] });
  check(twelveWithVoid.length === 13, 'opening fixture is not thirteen cards');
  check(analyzeHand(twelveWithVoid).hcp === 12, `opening fixture should be 12 high card points, it is ${analyzeHand(twelveWithVoid).hcp}`);
  const openCall = chooseCall('N', twelveWithVoid, []);
  check(openCall.type === 'pass',
    `12 points and a void opened ${openCall.type === 'bid' ? openCall.level + openCall.suit : openCall.type} — ` +
    'distribution must not count towards the 13 needed to open');

  // "Open with a good five card major with 12 points" — but only when the
  // honours really are in the suit.
  const goodTwelve = handOf({ S: ['A', 'K', '8', '5', '3'], H: ['9', '4'], D: ['Q', '7', '6', '2'], C: ['K', '5'] });
  check(goodTwelve.length === 13, 'good-major fixture is not thirteen cards');
  check(analyzeHand(goodTwelve).hcp === 12, `good-major fixture should be 12 points, it is ${analyzeHand(goodTwelve).hcp}`);
  const opened = chooseCall('N', goodTwelve, []);
  check(opened.type === 'bid' && opened.level === 1 && opened.suit === 'S',
    `12 points with A K to five Spades should open 1 Spade, the game said ` +
    `${opened.type === 'bid' ? opened.level + opened.suit : opened.type}`);

  // "If you have just queens and jacks you have no control of the game."
  // A good five-card major is not enough on its own without an ace or two
  // kings behind it.
  const noControl = handOf({ S: ['K', 'Q', '8', '5', '3'], H: ['Q', 'J', '4'], D: ['Q', 'J', '2'], C: ['J', '6'] });
  check(noControl.length === 13, 'no-control fixture is not thirteen cards');
  check(analyzeHand(noControl).hcp === 12, `no-control fixture should be 12 points, it is ${analyzeHand(noControl).hcp}`);
  const quacks = chooseCall('N', noControl, []);
  check(quacks.type === 'pass',
    `12 points of queens and jacks with one king opened ` +
    `${quacks.type === 'bid' ? quacks.level + quacks.suit : quacks.type} — there is no control in the hand`);
  // She is judging these by eye now, so the Hint has to say which part is
  // missing rather than quoting a 13 that is no longer the whole rule.
  check(/control/i.test(quacks.explanation || ''),
    `passing on 12 for want of a control said "${quacks.explanation}" — it has to name the reason`);

  // "If I have a strong suit, a void or singleton, and stoppers in the other
  // suits, I would bid one." Six good diamonds, a singleton club, the majors
  // stopped, and an ace to go with it.
  const shapely = handOf({ S: ['Q', 'J', '5'], H: ['Q', '8', '7'], D: ['A', 'K', '9', '6', '4', '2'], C: ['2'] });
  check(shapely.length === 13, 'shapely fixture is not thirteen cards');
  check(analyzeHand(shapely).hcp === 12, `shapely fixture should be 12 points, it is ${analyzeHand(shapely).hcp}`);
  const shaped = chooseCall('N', shapely, []);
  check(shaped.type === 'bid' && shaped.level === 1 && shaped.suit === 'D',
    `12 points with A K to six Diamonds, a singleton and the rest stopped should open 1 Diamond, ` +
    `the game said ${shaped.type === 'bid' ? shaped.level + shaped.suit : shaped.type}`);

  // Same strong suit and the rest stopped, but nothing short anywhere: the
  // hand has no ruffing value, so twelve is not enough. Built so shortness is
  // the only thing missing — every other suit does hold a stopper.
  const noShortness = handOf({ S: ['Q', '5', '4'], H: ['K', '8'], D: ['A', '9', '6', '4', '3', '2'], C: ['K', '7'] });
  check(noShortness.length === 13, 'no-shortness fixture is not thirteen cards');
  check(analyzeHand(noShortness).hcp === 12, `no-shortness fixture should be 12 points, it is ${analyzeHand(noShortness).hcp}`);
  const flat12 = chooseCall('N', noShortness, []);
  check(flat12.type === 'pass',
    `12 points with a long suit and no short suit opened ` +
    `${flat12.type === 'bid' ? flat12.level + flat12.suit : flat12.type} — ` +
    'the void or singleton is part of what makes it worth a bid');
  check(/short/i.test(flat12.explanation || ''),
    `passing on 12 for want of a short suit said "${flat12.explanation}" — it has to name the reason`);

  // The same count with the honours scattered outside the suit is not "good",
  // and passes.
  const weakTwelve = handOf({ S: ['J', '8', '5', '3', '2'], H: ['K', 'Q'], D: ['Q', '7', '6', '2'], C: ['A', '5'] });
  check(weakTwelve.length === 13, 'scattered-twelve fixture is not thirteen cards');
  check(analyzeHand(weakTwelve).hcp === 12, `scattered-twelve fixture should be 12 points, it is ${analyzeHand(weakTwelve).hcp}`);
  const passed = chooseCall('N', weakTwelve, []);
  check(passed.type === 'pass',
    `12 points with a ragged five-card Spade suit opened ` +
    `${passed.type === 'bid' ? passed.level + passed.suit : passed.type} — the suit has to be good`);

  // Three of partner's major is support; two is not.
  const openedOneSpade = [
    { player: 'N', type: 'bid', level: 1, suit: 'S' },
    { player: 'E', type: 'pass' }
  ];
  const three = handOf({ S: ['K', '7', '2'], H: ['A', '9', '4'], D: ['Q', '8', '6', '5'], C: ['9', '4', '3'] });
  check(three.length === 13, 'three-card-support fixture is not thirteen cards');
  const raised = chooseCall('S', three, openedOneSpade);
  check(raised.type === 'bid' && raised.suit === 'S',
    `three spades opposite a 1 Spade opening should support partner, the game bid ` +
    `${raised.type === 'bid' ? raised.level + raised.suit : raised.type}`);

  const two = handOf({ S: ['K', '7'], H: ['A', '9', '4', '3'], D: ['Q', '8', '6', '5'], C: ['9', '4', '3'] });
  check(two.length === 13, 'two-card-support fixture is not thirteen cards');
  const notRaised = chooseCall('S', two, openedOneSpade);
  check(!(notRaised.type === 'bid' && notRaised.suit === 'S'),
    'two spades is not support, but the game raised partner anyway');
}

// --- Weak twos, switched off and on --------------------------------------
// Betty: "I won't use weak two bid anymore after I found out it was a
// defensive bid with 6 to 9 pts." Off is now the default, so it has to be
// genuinely off — nothing but Two Clubs may open at the two level, and a
// six-card suit too weak to open has to pass. Switching them back on has to
// bring the weak two back, or the setting is a lie.
function weakTwoTest(boards = 500) {
  const deals = [];
  for (let b = 1; b <= boards; b++) {
    const e = new GameEngine(() => {});
    e.boardNumber = b;
    e.resetGame();
    const real = e.checkAITurn.bind(e);
    e.checkAITurn = () => {};
    e.deal();
    e.checkAITurn = real;
    deals.push(JSON.parse(JSON.stringify(e.hands)));
    e.clearTimers();
  }
  const lenOf = (hand, s) => hand.filter(c => c.suit === s).length;
  const weakTwoShape = (hand) => {
    const hcp = hcpOf(hand);
    const six = ['S', 'H', 'D'].find(su => lenOf(hand, su) === 6);
    const seven = ['S', 'H', 'D', 'C'].find(su => lenOf(hand, su) >= 7);
    return (!six || seven || hcp < 6 || hcp > 10) ? null : { six, hcp };
  };

  // First, before anything touches the setting, check the game as it ships.
  // Without this the rest of the test passes whichever way the default is
  // set, because it turns the setting on and off for itself.
  let shapesSeen = 0;
  const shipped = [];
  for (const hands of deals) {
    for (const seat of PLAYERS) {
      const shape = weakTwoShape(hands[seat]);
      if (!shape) continue;
      shapesSeen++;
      const c = chooseCall(seat, hands[seat], []);
      if (c.type !== 'pass') {
        shipped.push(`${shape.hcp} pts with 6 ${shape.six} opened ${c.type === 'bid' ? c.level + c.suit : c.type}`);
      }
    }
  }
  check(shapesSeen > 0, `no hand in ${boards} deals had six cards and 6-10 points — nothing was tested`);
  check(shipped.length === 0,
    `as it ships the game still opens weak twos: ${shipped.length} of ${shapesSeen} such hands bid — ` +
    `e.g. ${shipped.slice(0, 3).join('; ')}`);

  const tally = {
    off: { twoBids: 0, weakShapes: 0, passed: 0, opened: [] },
    on: { twoBids: 0, weakShapes: 0, opened: 0 }
  };

  for (const mode of ['off', 'on']) {
    setWeakTwos(mode === 'on');
    for (const hands of deals) {
      for (const seat of PLAYERS) {
        const hand = hands[seat];
        const c = chooseCall(seat, hand, []);          // first to speak
        const twoSuit = c.type === 'bid' && c.level === 2 && ['S', 'H', 'D'].includes(c.suit);
        if (twoSuit) tally[mode].twoBids++;
        const shape = weakTwoShape(hand);
        if (!shape) continue;
        tally[mode].weakShapes++;
        if (mode === 'off') {
          if (c.type === 'pass') tally.off.passed++;
          else tally.off.opened.push(`${shape.hcp} pts, 6 ${shape.six} → ${c.type === 'bid' ? c.level + c.suit : c.type}`);
        } else if (twoSuit && c.suit === shape.six) {
          tally.on.opened++;
        }
      }
    }
  }
  setWeakTwos(DEFAULT_WEAK_TWOS);

  check(tally.off.twoBids === 0,
    `weak twos off: ${tally.off.twoBids} two-level suit openings were made anyway`);
  check(tally.off.passed === tally.off.weakShapes,
    `weak twos off: ${tally.off.weakShapes - tally.off.passed} hands with six cards and 6-10 points ` +
    `opened instead of passing — e.g. ${tally.off.opened.slice(0, 3).join('; ')}`);
  // Without this the first two checks would pass on a deal set that simply
  // never produced the shape, and the test would prove nothing.
  check(tally.off.weakShapes > 0,
    `weak twos off: no hand in ${boards} deals had six cards and 6-10 points, so nothing was actually tested`);
  check(tally.on.opened > 0,
    'weak twos on: the weak two never came back, so the setting does nothing');
}

// --- Who plays which hand ------------------------------------------------
// Betty: "The winner always plays his and his partner's hand." She sits
// South, so the rule seen from her chair is fixed by who declares. This
// checks it straight off the shared rule the engine and the screen both
// use, for every seating, rather than waiting for a deal to produce one.
function bothHandsTest() {
  for (const declarer of PLAYERS) {
    const dummy = PLAYERS[(PLAYERS.indexOf(declarer) + 2) % 4];
    const playing = { phase: 'playing', declarer, dummy };
    for (const seat of PLAYERS) {
      const want = declarer === 'S' ? (seat === 'S' || seat === 'N')
        : dummy === 'S' ? false
        : seat === 'S';
      check(humanPlaysSeat(playing, seat) === want,
        `with ${declarer} declaring, Betty ${want ? 'must' : 'must not'} play ${seat}` +
        ` — the rule says ${humanPlaysSeat(playing, seat) ? 'she does' : 'she does not'}`);
    }
    // Whoever ends up declaring, the auction is always hers to bid
    for (const seat of PLAYERS) {
      check(humanPlaysSeat({ phase: 'bidding', declarer, dummy }, seat) === (seat === 'S'),
        `during the auction Betty should bid for South and nobody else (seat ${seat})`);
    }
    // Before a card is led there is no declarer yet, and still only her seat
    for (const seat of PLAYERS) {
      check(humanPlaysSeat({ phase: 'bidding', declarer: null, dummy: null }, seat) === (seat === 'S'),
        `before the auction settles Betty owns South alone (seat ${seat})`);
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
forcingResponseTest();
redealTest();
distributionTest();
bothHandsTest();
weakTwoTest();
undoTest();
saveResumeTest();
replayTest();
houseRulesTest();
noFreezeTest();

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
