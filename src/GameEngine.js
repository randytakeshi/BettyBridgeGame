import { chooseCall } from './bidding.js';
import { chooseCard } from './cardPlay.js';

export const SUITS = ['C', 'D', 'H', 'S', 'NT'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const PLAYERS = ['N', 'E', 'S', 'W'];
export const PLAYER_NAMES = { N: 'Sarah', E: 'Robert', S: 'You', W: 'David' };

const SUIT_WORDS = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades', NT: 'No Trump' };
const SUIT_WORDS_ONE = { C: 'Club', D: 'Diamond', H: 'Heart', S: 'Spade', NT: 'No Trump' };
// "1 Spade" but "2 Spades"
export const bidName = (level, suit) =>
  `${level} ${level === 1 ? SUIT_WORDS_ONE[suit] : SUIT_WORDS[suit]}`;
const rankWord = (r) => ({ A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack' }[r] || r);

// Display order alternates suit colors (Spades, Hearts, Clubs, Diamonds) so
// two red suits never sit next to each other — easier for low-vision players.
const DISPLAY_SUIT_ORDER = { S: 3, H: 2, C: 1, D: 0 };

// Bump this whenever the saved shape changes, so an old save is ignored
// rather than restored into a game that no longer understands it.
const SAVE_VERSION = 1;
const SAVED_HISTORY = 8;

// How many times a board may be dealt again after being passed out before the
// game gives up and scores it. Five is far beyond anything that happens by
// chance; it exists so a fault can never turn into an endless reshuffle.
export const MAX_REDEALS = 5;

// How long the computer players pause, as a multiple of the normal pace.
// Slow gives the spoken card names plenty of room; Fast is for when Betty
// is the dummy and just wants to see how the hand comes out.
export const SPEEDS = [
  { key: 'slow', label: 'Slow', mult: 1.6 },
  { key: 'normal', label: 'Normal', mult: 1 },
  { key: 'fast', label: 'Fast', mult: 0.5 }
];
export const DEFAULT_SPEED = 'normal';
export const speedMultiplier = (key) =>
  (SPEEDS.find(s => s.key === key) || SPEEDS[1]).mult;

/**
 * Which seats Betty acts on. She sits South and always bids for herself.
 * During the play, whoever won the contract plays both their own hand and
 * the dummy — so she plays two hands when she declares, her own hand when
 * she is defending, and none at all when her cards are the dummy.
 *
 * Shared by the engine and the interface so the two can never disagree
 * about whose turn it is.
 */
export function humanPlaysSeat(state, seat) {
  if (state.phase !== 'playing') return seat === 'S';
  if (state.declarer === 'S') return seat === 'S' || seat === 'N';
  if (state.dummy === 'S') return false;
  return seat === 'S';
}

export class GameEngine {
  constructor(updateCallback, pbnDatabase = null, announceCallback = null) {
    this.updateCallback = updateCallback;
    this.pbnDatabase = pbnDatabase; // Array of parsed PBN games
    this.announceCallback = announceCallback;
    this.boardNumber = 1;
    this.cumulativeScore = { 'N/S': 0, 'E/W': 0 };
    this.redealCount = 0;
    this.aiTimer = null;
    this.trickTimer = null;
    this.watchdogTimer = null;
    this.speed = 1;
    this.resetGame();
  }

  destroy() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.clearTimers();
    this.updateCallback = null;
    this.announceCallback = null;
  }

  // Every computer move lives in a timer, and a timer does not always survive
  // the iPad sleeping or the app being switched away from. Nothing else would
  // ever restart one, which leaves the game sitting on somebody's turn with
  // nothing coming. So it watches itself and starts the move again.
  startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this.nudge(), 3000);
  }

  // Coming back after the app has been away. A timer set while the iPad was
  // asleep or the tab was in the background may have been stretched to
  // minutes or dropped altogether — and it still looks "pending", so trusting
  // it would leave her waiting on a move that is never coming. Throw away
  // whatever is pending and start again from where the board actually is.
  resume() {
    if (this.phase !== 'bidding' && this.phase !== 'playing') return;
    this.clearTimers();
    if (this.phase === 'playing' && this.currentTrick.length >= 4) {
      this.scheduleTrickResolution();
      return;
    }
    this.checkAITurn();
  }

  nudge() {
    if (this.phase !== 'bidding' && this.phase !== 'playing') return;
    if (this.aiTimer || this.trickTimer) return;        // a move is already on its way
    if (this.phase === 'playing' && this.currentTrick.length >= 4) {
      this.scheduleTrickResolution();
      return;
    }
    if (this.humanControlsSeat(this.currentTurn)) return;  // waiting on Betty, as it should
    this.checkAITurn();
  }

  clearTimers() {
    if (this.aiTimer) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
    if (this.trickTimer) {
      clearTimeout(this.trickTimer);
      this.trickTimer = null;
    }
  }

  setSpeed(key) {
    this.speed = speedMultiplier(key);
  }

  // Speaking normally cuts off whatever is still being said, which is right
  // for a fresh event but wrong for a follow-on — "Sarah wins the trick" must
  // not swallow the score that comes straight after it. Pass queued for those.
  announce(text, queued = false) {
    if (!this.announceCallback) return;
    // Speaking is a nicety layered on top of the game. If the browser's
    // speech engine misbehaves — and Safari's does — it must not take a
    // half-played trick down with it.
    try {
      this.announceCallback(text, queued);
    } catch (err) {
      console.error('Announcement failed:', err);
    }
  }

  getVulnerability() {
    if (this.pbnDatabase && this.pbnDatabase.length > 0) {
      const idx = (this.boardNumber - 1) % this.pbnDatabase.length;
      if (this.pbnDatabase[idx].vulnerability) return this.pbnDatabase[idx].vulnerability;
    }
    const vulMap = [
      'None', 'N/S', 'E/W', 'Both',
      'N/S', 'E/W', 'Both', 'None',
      'E/W', 'Both', 'None', 'N/S',
      'Both', 'None', 'N/S', 'E/W'
    ];
    return vulMap[(this.boardNumber - 1) % 16];
  }

  getDealer() {
    if (this.pbnDatabase && this.pbnDatabase.length > 0) {
      const idx = (this.boardNumber - 1) % this.pbnDatabase.length;
      if (this.pbnDatabase[idx].dealer) return this.pbnDatabase[idx].dealer;
    }
    return PLAYERS[(this.boardNumber - 1) % 4];
  }

  resetGame() {
    this.clearTimers();
    this.deck = this.createDeck();
    this.hands = { N: [], E: [], S: [], W: [] };
    this.phase = 'dealing'; // 'dealing', 'bidding', 'playing', 'finished'
    this.bids = [];
    this.contract = null;
    this.declarer = null;
    this.dummy = null;
    this.currentTurn = this.getDealer();

    // Play state
    this.currentTrick = []; // Array of { player, card }
    this.tricksWon = { 'N/S': 0, 'E/W': 0 };
    this.leader = null;
    this.trumpSuit = null;
    this.playedCards = []; // Every card played so far this board
    // The dummy stays face down until the opening lead is on the table,
    // exactly as in real bridge
    this.openingLeadMade = false;

    // Scoring state
    this.doubledStatus = 'none'; // 'none', 'doubled', 'redoubled'
    this.duplicateScore = null;

    // Undo state
    this.historyStack = [];

    // Replay state. dealtHands is the board exactly as it came off the
    // shuffle, so the same deal can be played again from the auction.
    this.dealtHands = null;
    this.isReplay = false;
    this.firstResult = null;
  }

  // Betty: "Game one passed out — redeal if it has not been played. We all
  // play the same cards." Nobody has seen these cards, so there is nothing to
  // score and no reason to move on a board: the same board number is dealt
  // again, by the same dealer, exactly as at a table.
  //
  // Capped, because the one failure that must never happen is dealing for
  // ever. If something ever made every hand pass out, she would sit watching
  // the cards reshuffle with no way in, which from her side is the game
  // hanging. After the cap it scores the pass-out and moves on instead.
  redealPassedOutBoard() {
    if (this.isReplay) return false;          // she asked to see THIS deal again
    if (this.redealCount >= MAX_REDEALS) return false;
    this.redealCount++;
    this.announce('Nobody has played these cards, so we deal this board again.', true);
    this.resetGame();                          // leaves boardNumber alone
    // deal() tells the screen and starts the new auction by itself. Calling
    // either again here would run the whole next board inside this one.
    this.deal();
    return true;
  }

  humanControlsSeat(seat) {
    return humanPlaysSeat(this, seat);
  }

  saveState() {
    this.historyStack.push({
      phase: this.phase,
      hands: JSON.parse(JSON.stringify(this.hands)),
      bids: JSON.parse(JSON.stringify(this.bids)),
      contract: this.contract ? { ...this.contract } : null,
      declarer: this.declarer,
      dummy: this.dummy,
      currentTurn: this.currentTurn,
      currentTrick: JSON.parse(JSON.stringify(this.currentTrick)),
      tricksWon: { ...this.tricksWon },
      leader: this.leader,
      trumpSuit: this.trumpSuit,
      playedCards: JSON.parse(JSON.stringify(this.playedCards)),
      openingLeadMade: this.openingLeadMade,
      doubledStatus: this.doubledStatus,
      duplicateScore: this.duplicateScore ? { ...this.duplicateScore } : null
    });
  }

  // A saved state Betty could actually act on. Undo only ever rewinds within
  // the phase she is in — pressing it during the play must never throw her
  // back into the auction, and it does nothing at all on a hand she is not
  // playing (when she is the dummy or defending, there is nothing of hers
  // to take back).
  isHumanTurnState(st) {
    if (st.phase !== this.phase) return false;
    if (this.phase !== 'bidding' && this.phase !== 'playing') return false;
    return humanPlaysSeat(st, st.currentTurn);
  }

  canUndo() {
    return this.historyStack.some(st => this.isHumanTurnState(st));
  }

  undo() {
    if (!this.canUndo()) return;
    this.clearTimers();

    // Pop states until it is a human-controlled turn
    let lastState = null;
    while (this.historyStack.length > 0) {
      const st = this.historyStack.pop();
      if (this.isHumanTurnState(st)) {
        lastState = st;
        break;
      }
    }

    if (lastState) {
      this.phase = lastState.phase;
      this.hands = lastState.hands;
      this.bids = lastState.bids;
      this.contract = lastState.contract;
      this.declarer = lastState.declarer;
      this.dummy = lastState.dummy;
      this.currentTurn = lastState.currentTurn;
      this.currentTrick = lastState.currentTrick;
      this.tricksWon = lastState.tricksWon;
      this.leader = lastState.leader;
      this.trumpSuit = lastState.trumpSuit;
      this.playedCards = lastState.playedCards || [];
      this.openingLeadMade = !!lastState.openingLeadMade;
      this.doubledStatus = lastState.doubledStatus;
      this.duplicateScore = lastState.duplicateScore;
      this.notifyUpdate();
      // If we somehow landed on an AI turn (e.g. stack ran out), keep the game moving
      this.checkAITurn();
    }
  }

  // --- SAVING AND RESUMING ---------------------------------------------

  // Everything needed to put the board back exactly as it was. The undo
  // history is trimmed: undo only ever steps back to Betty's last turn, so
  // a handful of recent states is plenty and keeps the save small.
  serialize() {
    return {
      v: SAVE_VERSION,
      historical: !!(this.pbnDatabase && this.pbnDatabase.length > 0),
      boardNumber: this.boardNumber,
      cumulativeScore: { ...this.cumulativeScore },
      phase: this.phase,
      hands: this.hands,
      bids: this.bids,
      contract: this.contract,
      declarer: this.declarer,
      dummy: this.dummy,
      currentTurn: this.currentTurn,
      currentTrick: this.currentTrick,
      tricksWon: { ...this.tricksWon },
      leader: this.leader,
      trumpSuit: this.trumpSuit,
      playedCards: this.playedCards,
      openingLeadMade: this.openingLeadMade,
      redealCount: this.redealCount,
      doubledStatus: this.doubledStatus,
      duplicateScore: this.duplicateScore,
      dealtHands: this.dealtHands,
      isReplay: this.isReplay,
      firstResult: this.firstResult,
      history: this.historyStack.slice(-SAVED_HISTORY)
    };
  }

  // A save from another version, another deal mode, or a half-written one
  // is ignored rather than trusted — a fresh board beats a broken one.
  static isRestorable(data, historicalMode) {
    if (!data || data.v !== SAVE_VERSION) return false;
    if (!!data.historical !== !!historicalMode) return false;
    if (!['bidding', 'playing', 'finished'].includes(data.phase)) return false;
    if (!data.hands || !Array.isArray(data.bids) || !Array.isArray(data.playedCards)) return false;
    if (!PLAYERS.includes(data.currentTurn)) return false;

    let inHands = 0;
    for (const p of PLAYERS) {
      if (!Array.isArray(data.hands[p])) return false;
      inHands += data.hands[p].length;
    }
    const onTable = Array.isArray(data.currentTrick) ? data.currentTrick.length : -1;
    if (onTable < 0) return false;
    // Every one of the 52 cards is either still in a hand or already played
    return inHands + data.playedCards.length === 52;
  }

  restore(data) {
    if (!GameEngine.isRestorable(data, this.pbnDatabase && this.pbnDatabase.length > 0)) {
      return false;
    }
    this.clearTimers();
    this.boardNumber = data.boardNumber;
    this.cumulativeScore = { ...data.cumulativeScore };
    this.phase = data.phase;
    this.hands = data.hands;
    this.bids = data.bids;
    this.contract = data.contract;
    this.declarer = data.declarer;
    this.dummy = data.dummy;
    this.currentTurn = data.currentTurn;
    this.currentTrick = data.currentTrick;
    this.tricksWon = { ...data.tricksWon };
    this.leader = data.leader;
    this.trumpSuit = data.trumpSuit;
    this.playedCards = data.playedCards;
    this.openingLeadMade = !!data.openingLeadMade;
    this.redealCount = data.redealCount || 0;
    this.doubledStatus = data.doubledStatus || 'none';
    this.duplicateScore = data.duplicateScore || null;
    this.historyStack = Array.isArray(data.history) ? data.history : [];
    // Older saves predate replay; without the deal we simply cannot offer it
    this.dealtHands = data.dealtHands || null;
    this.isReplay = !!data.isReplay;
    this.firstResult = data.firstResult || null;
    return true;
  }

  // Start the session over from board one with a clean scorecard
  newSession() {
    this.boardNumber = 1;
    this.redealCount = 0;
    this.cumulativeScore = { 'N/S': 0, 'E/W': 0 };
    this.resetGame();
    this.deal();
  }

  createDeck() {
    const deck = [];
    for (const suit of ['C', 'D', 'H', 'S']) {
      for (const rank of RANKS) {
        deck.push({ suit, rank });
      }
    }
    return deck;
  }

  shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
  }

  deal() {
    if (this.pbnDatabase && this.pbnDatabase.length > 0) {
      // Historical mode!
      const idx = (this.boardNumber - 1) % this.pbnDatabase.length;
      const gameData = this.pbnDatabase[idx];

      this.hands = JSON.parse(JSON.stringify(gameData.deal)); // Deep copy the hands
    } else {
      // Random mode
      this.shuffle(this.deck);
      let currentPlayerIndex = 0;

      for (const card of this.deck) {
        this.hands[PLAYERS[currentPlayerIndex]].push(card);
        currentPlayerIndex = (currentPlayerIndex + 1) % 4;
      }
    }

    // Sort hands (works for both modes)
    for (const p of PLAYERS) {
      this.hands[p].sort((a, b) => {
        if (a.suit !== b.suit) return DISPLAY_SUIT_ORDER[b.suit] - DISPLAY_SUIT_ORDER[a.suit];
        return RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank);
      });
    }

    // Keep the deal so she can play the same cards again afterwards
    this.dealtHands = JSON.parse(JSON.stringify(this.hands));

    this.phase = 'bidding';
    this.notifyUpdate();
    this.checkAITurn();
  }

  // Play the same thirteen cards over again, from the auction. The board
  // number, dealer and vulnerability all stay put; the score does not move,
  // because a second go at a deal she has already seen is practice.
  replayBoard() {
    if (!this.dealtHands) return false;
    const hands = JSON.parse(JSON.stringify(this.dealtHands));
    const first = this.isReplay
      ? this.firstResult
      : (this.duplicateScore
        ? { contract: this.contract, declarer: this.declarer, score: this.duplicateScore }
        : null);

    this.resetGame();
    this.hands = hands;
    this.dealtHands = JSON.parse(JSON.stringify(hands));
    this.isReplay = true;
    this.redealCount = 0;
    this.firstResult = first;
    this.phase = 'bidding';
    this.notifyUpdate();
    this.checkAITurn();
    return true;
  }

  nextBoard() {
    this.boardNumber++;
    this.redealCount = 0;
    this.resetGame();
    this.deal();
  }

  notifyUpdate() {
    if (!this.updateCallback) return;
    // Same reasoning: whatever the interface does with a new state, the
    // engine's own state must survive it intact.
    try {
      this.updateCallback(this.getState());
    } catch (err) {
      console.error('Update failed:', err);
    }
  }

  getState() {
    let historicalData = null;
    if (this.pbnDatabase && this.pbnDatabase.length > 0) {
      const idx = (this.boardNumber - 1) % this.pbnDatabase.length;
      historicalData = this.pbnDatabase[idx];
    }

    return {
      boardNumber: this.boardNumber,
      vulnerability: this.getVulnerability(),
      dealer: this.getDealer(),
      phase: this.phase,
      hands: this.hands,
      bids: this.bids,
      contract: this.contract,
      doubledStatus: this.doubledStatus,
      declarer: this.declarer,
      dummy: this.dummy,
      currentTurn: this.currentTurn,
      currentTrick: this.currentTrick,
      tricksWon: this.tricksWon,
      trumpSuit: this.trumpSuit,
      duplicateScore: this.duplicateScore,
      cumulativeScore: this.cumulativeScore,
      historicalData: historicalData,
      canUndo: this.canUndo(),
      canReplay: !!this.dealtHands,
      isReplay: this.isReplay,
      firstResult: this.firstResult,
      dummyVisible: this.phase === 'playing' && this.openingLeadMade,
      openingLeadMade: this.openingLeadMade
    };
  }

  // --- BIDDING LOGIC ---

  isLegalCall(bid) {
    if (bid.type === 'pass') return true;

    let highest = null;
    let lastAction = null;
    for (const b of this.bids) {
      if (b.type === 'bid') highest = b;
      if (b.type !== 'pass') lastAction = b;
    }

    if (bid.type === 'bid') {
      if (!bid.level || bid.level < 1 || bid.level > 7 || !SUITS.includes(bid.suit)) return false;
      if (!highest) return true;
      if (bid.level > highest.level) return true;
      return bid.level === highest.level && SUITS.indexOf(bid.suit) > SUITS.indexOf(highest.suit);
    }

    const opponents = lastAction &&
      (PLAYERS.indexOf(lastAction.player) % 2) !== (PLAYERS.indexOf(this.currentTurn) % 2);

    if (bid.type === 'double') {
      return !!lastAction && lastAction.type === 'bid' && opponents;
    }
    if (bid.type === 'redouble') {
      return !!lastAction && lastAction.type === 'double' && opponents;
    }
    return false;
  }

  placeBid(bid) {
    if (this.phase !== 'bidding') return false;
    if (!this.isLegalCall(bid)) return false;
    this.saveState();

    const player = this.currentTurn;
    this.bids.push({ player, ...bid });

    // Announce the call with the caller's name so it's clear who did what
    const name = PLAYER_NAMES[player];
    let bidText;
    if (bid.type === 'bid') {
      bidText = `${name} ${player === 'S' ? 'bid' : 'bids'} ${bidName(bid.level, bid.suit)}`;
    } else if (bid.type === 'double') {
      bidText = `${name} ${player === 'S' ? 'double' : 'doubles'}`;
    } else if (bid.type === 'redouble') {
      bidText = `${name} ${player === 'S' ? 'redouble' : 'redoubles'}`;
    } else {
      bidText = `${name} ${player === 'S' ? 'pass' : 'passes'}`;
    }
    this.announce(bidText);

    if (this.checkBiddingFinished()) {
      this.startPlayingPhase();
    } else if (this.phase === 'finished' && !this.contract) {
      // Passed out — deal it again rather than scoring a board nobody played
      this.redealPassedOutBoard();
      return true;
    } else {
      this.advanceTurn();
      this.checkAITurn();
    }
    return true;
  }

  checkBiddingFinished() {
    if (this.bids.length >= 4) {
      const lastThree = this.bids.slice(-3);
      if (lastThree.every(b => b.type === 'pass')) {
        // Find highest bid
        let highest = null;
        let doubledStatus = 'none';

        for (const b of this.bids) {
          if (b.type === 'bid') {
            highest = b;
            doubledStatus = 'none';
          } else if (b.type === 'double') {
            doubledStatus = 'doubled';
          } else if (b.type === 'redouble') {
            doubledStatus = 'redoubled';
          }
        }

        if (highest) {
          this.contract = { level: highest.level, suit: highest.suit };
          this.doubledStatus = doubledStatus;
          this.trumpSuit = highest.suit === 'NT' ? null : highest.suit;

          // Declarer is the first player of the winning partnership
          // who named the contract suit
          const winningSide = PLAYERS.indexOf(highest.player) % 2;
          const firstOfSide = this.bids.find(b =>
            b.type === 'bid' && b.suit === highest.suit &&
            PLAYERS.indexOf(b.player) % 2 === winningSide
          );
          this.declarer = firstOfSide ? firstOfSide.player : highest.player;
          const declarerIdx = PLAYERS.indexOf(this.declarer);
          this.dummy = PLAYERS[(declarerIdx + 2) % 4];
          this.currentTurn = PLAYERS[(declarerIdx + 1) % 4]; // Left of declarer leads
          this.leader = this.currentTurn;
          return true;
        } else {
          // Passed out
          this.phase = 'finished';
          this.duplicateScore = { side: 'None', points: 0, made: null };
          this.announce('Everyone passed. No contract this time.');
          this.notifyUpdate();
          return false;
        }
      }
    }
    return false;
  }

  startPlayingPhase() {
    this.phase = 'playing';
    const c = this.contract;
    const dbl = this.doubledStatus === 'doubled' ? ', doubled,' : (this.doubledStatus === 'redoubled' ? ', redoubled,' : '');
    const leader = this.currentTurn;
    let announcement =
      `The contract is ${bidName(c.level, c.suit)}${dbl} played by ${PLAYER_NAMES[this.declarer]}. ` +
      `${PLAYER_NAMES[leader]} ${leader === 'S' ? 'lead' : 'leads'} the first card.`;
    if (this.declarer === 'N') {
      announcement += ' Your hand is the dummy — Sarah will play both hands for your side.';
    }
    this.announce(announcement, true);
    this.notifyUpdate();
    this.checkAITurn();
  }

  // --- PLAYING LOGIC ---

  playCard(player, cardIndex) {
    if (this.phase !== 'playing') return false;
    if (player !== this.currentTurn) return false;
    // A completed trick must resolve before anyone plays again — without
    // this, a play during the display pause stuffs a 5th card into the
    // trick and that card vanishes when the trick resolves
    if (this.currentTrick.length >= 4) return false;

    const hand = this.hands[player];
    const card = hand && hand[cardIndex];
    if (!card) return false;

    // Validate follow suit
    if (this.currentTrick.length > 0) {
      const ledSuit = this.currentTrick[0].card.suit;
      const hasSuit = hand.some(c => c.suit === ledSuit);
      if (hasSuit && card.suit !== ledSuit) {
        return false; // Must follow suit
      }
    }

    this.saveState();

    // Play it
    hand.splice(cardIndex, 1);
    this.currentTrick.push({ player, card });
    this.playedCards.push({ ...card, player });

    // Announce the card with the player's name. Speaking cancels whatever is
    // already being said, so the opening lead and the news about the dummy
    // have to go out as one sentence or the card name gets cut off.
    let spoken;
    if (player === this.dummy && this.declarer !== 'S') {
      // The declarer is running both hands and just played from the dummy
      const owner = player === 'S' ? 'your' : `${PLAYER_NAMES[player]}'s`;
      spoken = `${PLAYER_NAMES[this.declarer]} plays ${owner} ${rankWord(card.rank)} of ${SUIT_WORDS[card.suit]}`;
    } else {
      const name = PLAYER_NAMES[player];
      spoken = `${name} ${player === 'S' ? 'play' : 'plays'} the ${rankWord(card.rank)} of ${SUIT_WORDS[card.suit]}`;
    }

    // The opening lead is on the table, so the dummy goes face up now
    if (!this.openingLeadMade) {
      this.openingLeadMade = true;
      const who = this.dummy === 'S' ? 'Your cards go face up' : `${PLAYER_NAMES[this.dummy]}'s cards go face up`;
      const by = this.declarer === 'S' ? 'you play both hands' : `${PLAYER_NAMES[this.declarer]} plays both hands`;
      spoken += `. ${who} as the dummy, and ${by}.`;
    }
    this.announce(spoken);

    if (this.currentTrick.length === 4) {
      // Trick complete — pause so the full trick can be seen
      this.notifyUpdate();
      this.scheduleTrickResolution();
    } else {
      this.advanceTurn();
      this.checkAITurn();
    }
    return true;
  }

  resolveTrick() {
    this.trickTimer = null;
    if (this.currentTrick.length < 4) return;

    const ledSuit = this.currentTrick[0].card.suit;
    let winningPlay = this.currentTrick[0];

    for (let i = 1; i < 4; i++) {
      const play = this.currentTrick[i];
      if (this.trumpSuit && play.card.suit === this.trumpSuit) {
        if (winningPlay.card.suit !== this.trumpSuit || RANKS.indexOf(play.card.rank) > RANKS.indexOf(winningPlay.card.rank)) {
          winningPlay = play;
        }
      } else if (play.card.suit === ledSuit && winningPlay.card.suit !== this.trumpSuit) {
        if (RANKS.indexOf(play.card.rank) > RANKS.indexOf(winningPlay.card.rank)) {
          winningPlay = play;
        }
      }
    }

    const winner = winningPlay.player;
    if (winner === 'N' || winner === 'S') {
      this.tricksWon['N/S']++;
    } else {
      this.tricksWon['E/W']++;
    }

    this.announce(`${PLAYER_NAMES[winner]} ${winner === 'S' ? 'win' : 'wins'} the trick.`);

    this.currentTrick = [];
    this.currentTurn = winner;
    this.leader = winner;

    if (this.hands.S.length === 0 && this.hands.N.length === 0) {
      this.phase = 'finished';
      this.calculateDuplicateScore();
      if (this.duplicateScore) {
        const ds = this.duplicateScore;
        if (ds.made) {
          this.announce(`${ds.side === 'N/S' ? 'Your side' : 'They'} made the contract! ${ds.points} points.`, true);
        } else {
          this.announce(`The contract went down. ${ds.points} points to ${ds.side === 'N/S' ? 'your side' : 'them'}.`, true);
        }
      }
    }

    this.notifyUpdate();
    if (this.phase !== 'finished') {
      this.checkAITurn();
    }
  }

  calculateDuplicateScore() {
    if (!this.contract) return;

    const declarerSide = (this.declarer === 'N' || this.declarer === 'S') ? 'N/S' : 'E/W';
    const defendersSide = declarerSide === 'N/S' ? 'E/W' : 'N/S';

    const tricksTaken = this.tricksWon[declarerSide];
    const tricksContracted = 6 + this.contract.level;
    const vul = this.getVulnerability();
    const isVul = vul === 'Both' || vul === declarerSide;
    const isDbl = this.doubledStatus === 'doubled';
    const isRedbl = this.doubledStatus === 'redoubled';
    const mult = isRedbl ? 4 : (isDbl ? 2 : 1);

    let score = 0;

    if (tricksTaken >= tricksContracted) {
      // Made!
      const overtricks = tricksTaken - tricksContracted;

      // 1. Contract Points (Base)
      let basePoints = 0;
      if (this.contract.suit === 'C' || this.contract.suit === 'D') {
        basePoints = 20 * this.contract.level;
      } else if (this.contract.suit === 'H' || this.contract.suit === 'S') {
        basePoints = 30 * this.contract.level;
      } else {
        basePoints = 40 + 30 * (this.contract.level - 1);
      }

      const contractPoints = basePoints * mult;
      score += contractPoints;

      // 2. Game/Part Score Bonus
      if (contractPoints >= 100) {
        score += isVul ? 500 : 300; // Game bonus
      } else {
        score += 50; // Part score bonus
      }

      // 3. Slam Bonus
      if (this.contract.level === 6) {
        score += isVul ? 750 : 500;
      } else if (this.contract.level === 7) {
        score += isVul ? 1500 : 1000;
      }

      // 4. Insult Bonus
      if (isDbl) score += 50;
      if (isRedbl) score += 100;

      // 5. Overtricks
      if (overtricks > 0) {
        if (!isDbl && !isRedbl) {
           score += overtricks * ((this.contract.suit === 'C' || this.contract.suit === 'D') ? 20 : 30);
        } else if (isDbl) {
           score += overtricks * (isVul ? 200 : 100);
        } else if (isRedbl) {
           score += overtricks * (isVul ? 400 : 200);
        }
      }

      this.duplicateScore = { side: declarerSide, points: score, made: true, tricks: tricksTaken, overtricks, contract: this.contract, doubled: this.doubledStatus };
      if (!this.isReplay) this.cumulativeScore[declarerSide] += score;

    } else {
      // Failed (Undertricks)
      const undertricks = tricksContracted - tricksTaken;
      let penalty = 0;

      if (!isDbl && !isRedbl) {
        penalty = undertricks * (isVul ? 100 : 50);
      } else {
        // Doubled
        if (!isVul) {
          if (undertricks === 1) penalty = 100;
          else if (undertricks === 2) penalty = 300; // 100 + 200
          else if (undertricks === 3) penalty = 500; // 100 + 200 + 200
          else penalty = 500 + (undertricks - 3) * 300;
        } else {
          if (undertricks === 1) penalty = 200;
          else penalty = 200 + (undertricks - 1) * 300;
        }

        if (isRedbl) penalty *= 2;
      }

      this.duplicateScore = { side: defendersSide, points: penalty, made: false, tricks: tricksTaken, undertricks, contract: this.contract, doubled: this.doubledStatus };
      if (!this.isReplay) this.cumulativeScore[defendersSide] += penalty;
    }
  }

  advanceTurn() {
    const idx = PLAYERS.indexOf(this.currentTurn);
    this.currentTurn = PLAYERS[(idx + 1) % 4];
    this.notifyUpdate();
  }

  // --- AI LOGIC ---

  // Start the pause that clears a finished trick off the table. Normally
  // playCard does this, but a board resumed from a save can come back with
  // four cards already down and no timer running — without this, nobody can
  // ever play again and the game is stuck for good.
  scheduleTrickResolution() {
    if (this.trickTimer) return;
    if (globalThis.TEST_MODE) {
      this.resolveTrick();
    } else {
      this.trickTimer = setTimeout(() => this.resolveTrick(), 2500 * this.speed);
    }
  }

  checkAITurn() {
    // Always clear any stale timer first so two AI actions can never race
    if (this.aiTimer) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
    if (this.phase !== 'bidding' && this.phase !== 'playing') return;
    if (this.phase === 'playing' && this.currentTrick.length >= 4) {
      this.scheduleTrickResolution();
      return;
    }
    if (this.humanControlsSeat(this.currentTurn)) return;

    const aiAction = () => {
      this.aiTimer = null;
      // Re-check at fire time: the situation may have changed
      if (this.humanControlsSeat(this.currentTurn)) return;
      const wasAt = this.playedCards.length + this.bids.length;
      try {
        if (this.phase === 'bidding') {
          this.makeAIBid();
        } else if (this.phase === 'playing') {
          this.makeAIPlay();
        }
      } catch (err) {
        // Anything at all going wrong in here used to stop the game dead,
        // because this timer was the only thing that would ever move that
        // seat and nothing would fire again. Whatever happened, the hand has
        // to go on.
        console.error('The computer failed to move:', err);
      }
      if (this.playedCards.length + this.bids.length === wasAt) {
        this.forceProgress();
      }
    };

    if (globalThis.TEST_MODE) {
      aiAction();
    } else {
      // Slower during play so the spoken card names have time to finish
      const delay = (this.phase === 'playing' ? 2000 : 1500) * this.speed;
      this.aiTimer = setTimeout(aiAction, delay);
    }
  }

  evaluateHand(player) {
    const hand = this.hands[player];
    let hcp = 0;
    const suitCounts = { C: 0, D: 0, H: 0, S: 0 };

    for (const card of hand) {
      suitCounts[card.suit]++;
      if (card.rank === 'A') hcp += 4;
      else if (card.rank === 'K') hcp += 3;
      else if (card.rank === 'Q') hcp += 2;
      else if (card.rank === 'J') hcp += 1;
    }
    return { hcp, suitCounts };
  }

  getHint(player) {
    if (this.phase === 'bidding') {
      return { type: 'bid', value: this.determineAIBid(player) };
    } else if (this.phase === 'playing') {
      return { type: 'card', value: this.determineAIPlay(player) };
    }
    return null;
  }

  determineAIBid(player) {
    return chooseCall(player, this.hands[player], this.bids);
  }

  makeAIBid() {
    const bid = this.determineAIBid(this.currentTurn);
    // Safety net: if the AI ever produces an illegal call, pass instead
    // so the auction can never stall
    if (!this.placeBid(bid)) {
      this.placeBid({ type: 'pass', explanation: 'Pass' });
    }
  }

  determineAIPlay(player) {
    return chooseCard({
      seat: player,
      hands: this.hands,
      trick: this.currentTrick,
      trumpSuit: this.trumpSuit,
      declarer: this.declarer,
      dummy: this.dummy,
      dummyVisible: this.openingLeadMade,
      playedCards: this.playedCards
    });
  }

  // Last resort when a computer seat has somehow failed to act: make the
  // simplest legal move there is, so the hand can never stall.
  forceProgress() {
    if (this.humanControlsSeat(this.currentTurn)) return;
    try {
      if (this.phase === 'bidding') {
        this.placeBid({ type: 'pass', explanation: 'Pass' });
        return;
      }
      if (this.phase !== 'playing') return;
      if (this.currentTrick.length >= 4) {
        this.scheduleTrickResolution();
        return;
      }
      const seat = this.currentTurn;
      const hand = this.hands[seat] || [];
      const led = this.currentTrick.length > 0 ? this.currentTrick[0].card.suit : null;
      const order = hand.map((c, i) => i).sort((a, b) => {
        if (!led) return 0;
        return (hand[b].suit === led ? 1 : 0) - (hand[a].suit === led ? 1 : 0);
      });
      for (const i of order) {
        if (this.playCard(seat, i)) return;
      }
    } catch (err) {
      console.error('Could not force the game onwards:', err);
    }
  }

  makeAIPlay() {
    const seat = this.currentTurn;
    const hand = this.hands[seat];
    if (!hand || hand.length === 0) return;

    const chosen = this.determineAIPlay(seat);
    if (chosen !== null && this.playCard(seat, chosen)) return;

    // Whichever card it wanted was refused, or it could not choose one. A
    // seat that fails to move stops the entire game with no way back, so
    // play anything legal rather than leaving Betty staring at the table.
    const led = this.currentTrick.length > 0 ? this.currentTrick[0].card.suit : null;
    const order = hand.map((c, i) => i).sort((a, b) => {
      if (!led) return 0;
      return (hand[b].suit === led ? 1 : 0) - (hand[a].suit === led ? 1 : 0);
    });
    for (const i of order) {
      if (this.playCard(seat, i)) return;
    }
    console.error(`No legal card could be played for ${seat}`);
  }
}
