export const SUITS = ['C', 'D', 'H', 'S', 'NT'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const PLAYERS = ['N', 'E', 'S', 'W'];
export const PLAYER_NAMES = { N: 'Sarah', E: 'Robert', S: 'You', W: 'David' };

const SUIT_WORDS = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades', NT: 'No Trump' };
const rankWord = (r) => ({ A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack' }[r] || r);

// Display order alternates suit colors (Spades, Hearts, Clubs, Diamonds) so
// two red suits never sit next to each other — easier for low-vision players.
const DISPLAY_SUIT_ORDER = { S: 3, H: 2, C: 1, D: 0 };

export class GameEngine {
  constructor(updateCallback, pbnDatabase = null, announceCallback = null) {
    this.updateCallback = updateCallback;
    this.pbnDatabase = pbnDatabase; // Array of parsed PBN games
    this.announceCallback = announceCallback;
    this.boardNumber = 1;
    this.cumulativeScore = { 'N/S': 0, 'E/W': 0 };
    this.aiTimer = null;
    this.trickTimer = null;
    this.resetGame();
  }

  destroy() {
    this.clearTimers();
    this.updateCallback = null;
    this.announceCallback = null;
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

  announce(text) {
    if (this.announceCallback) {
      this.announceCallback(text);
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

    // Scoring state
    this.doubledStatus = 'none'; // 'none', 'doubled', 'redoubled'
    this.duplicateScore = null;

    // Undo state
    this.historyStack = [];
  }

  // The human sits South. When South declares, she also plays North's
  // cards (declarer runs the dummy). When Sarah (N) wins the contract,
  // Sarah plays the whole hand herself — including the human's cards,
  // which are the dummy — just like real bridge.
  humanControlsSeat(seat) {
    if (this.phase === 'playing' && this.declarer === 'N') return false;
    if (seat === 'S') return true;
    if (seat === 'N' && this.phase === 'playing' && this.declarer === 'S') return true;
    return false;
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
      doubledStatus: this.doubledStatus,
      duplicateScore: this.duplicateScore ? { ...this.duplicateScore } : null
    });
  }

  undo() {
    this.clearTimers();

    const isHumanTurnState = (st) => {
      if (st.phase === 'playing' && st.declarer === 'N') return false;
      return st.currentTurn === 'S' ||
        (st.currentTurn === 'N' && st.phase === 'playing' && st.declarer === 'S');
    };

    // Pop states until it is a human-controlled turn, or the stack is empty
    let lastState = null;
    while (this.historyStack.length > 0) {
      lastState = this.historyStack.pop();
      if (isHumanTurnState(lastState)) {
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
      this.doubledStatus = lastState.doubledStatus;
      this.duplicateScore = lastState.duplicateScore;
      this.notifyUpdate();
      // If we somehow landed on an AI turn (e.g. stack ran out), keep the game moving
      this.checkAITurn();
    }
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

    this.phase = 'bidding';
    this.notifyUpdate();
    this.checkAITurn();
  }

  nextBoard() {
    this.boardNumber++;
    this.resetGame();
    this.deal();
  }

  notifyUpdate() {
    if (this.updateCallback) {
      this.updateCallback(this.getState());
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
      canUndo: this.historyStack && this.historyStack.length > 0
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
      bidText = `${name} ${player === 'S' ? 'bid' : 'bids'} ${bid.level} ${SUIT_WORDS[bid.suit]}`;
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
    } else if (this.phase === 'finished') {
      // Passed out
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
      `The contract is ${c.level} ${SUIT_WORDS[c.suit]}${dbl} played by ${PLAYER_NAMES[this.declarer]}. ` +
      `${PLAYER_NAMES[leader]} ${leader === 'S' ? 'lead' : 'leads'} the first card.`;
    if (this.declarer === 'N') {
      announcement += ' Your hand is the dummy — Sarah will play both hands for your side.';
    }
    this.announce(announcement);
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

    // Announce card with the player's name
    if (player === 'S' && this.declarer === 'N') {
      // Sarah is running the hand and just played one of the human's dummy cards
      this.announce(`Sarah plays your ${rankWord(card.rank)} of ${SUIT_WORDS[card.suit]}`);
    } else {
      const name = PLAYER_NAMES[player];
      this.announce(`${name} ${player === 'S' ? 'play' : 'plays'} the ${rankWord(card.rank)} of ${SUIT_WORDS[card.suit]}`);
    }

    if (this.currentTrick.length === 4) {
      // Trick complete
      this.notifyUpdate();
      if (globalThis.TEST_MODE) {
        this.resolveTrick();
      } else {
        this.trickTimer = setTimeout(() => this.resolveTrick(), 2500); // Pause so the full trick can be seen
      }
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
          this.announce(`${ds.side === 'N/S' ? 'Your side' : 'They'} made the contract! ${ds.points} points.`);
        } else {
          this.announce(`The contract went down. ${ds.points} points to ${ds.side === 'N/S' ? 'your side' : 'them'}.`);
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
      this.cumulativeScore[declarerSide] += score;

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
      this.cumulativeScore[defendersSide] += penalty;
    }
  }

  advanceTurn() {
    const idx = PLAYERS.indexOf(this.currentTurn);
    this.currentTurn = PLAYERS[(idx + 1) % 4];
    this.notifyUpdate();
  }

  // --- AI LOGIC ---

  checkAITurn() {
    // Always clear any stale timer first so two AI actions can never race
    if (this.aiTimer) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
    if (this.humanControlsSeat(this.currentTurn)) return;

    const aiAction = () => {
      this.aiTimer = null;
      // Re-check at fire time: the situation may have changed
      if (this.humanControlsSeat(this.currentTurn)) return;
      if (this.phase === 'bidding') {
        this.makeAIBid();
      } else if (this.phase === 'playing') {
        this.makeAIPlay();
      }
    };

    if (globalThis.TEST_MODE) {
      aiAction();
    } else {
      // Slower during play so the spoken card names have time to finish
      const delay = this.phase === 'playing' ? 2000 : 1500;
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
    const { hcp, suitCounts } = this.evaluateHand(player);
    const partner = PLAYERS[(PLAYERS.indexOf(player) + 2) % 4];

    let highestBid = null;
    let partnerLastBid = null;
    let myCalls = 0;
    for (const b of this.bids) {
      if (b.type === 'bid') {
        highestBid = b;
        if (b.player === partner) partnerLastBid = b;
      }
      if (b.player === player && b.type !== 'pass') myCalls++;
    }

    // Each player describes their hand at most twice — keeps auctions
    // short and guarantees the bidding always ends
    if (myCalls >= 2) {
      return { type: 'pass', explanation: 'Already bid twice — nothing more to say' };
    }

    // Cheapest level at which `suit` can legally be bid
    const cheapestLevel = (suit) => {
      if (!highestBid) return 1;
      return SUITS.indexOf(suit) > SUITS.indexOf(highestBid.suit)
        ? highestBid.level
        : highestBid.level + 1;
    };

    // "Even distribution": no void or singleton, at most one doubleton
    const counts = ['C', 'D', 'H', 'S'].map(s => suitCounts[s]);
    const isBalanced = counts.every(c => c >= 2) && counts.filter(c => c === 2).length <= 1;

    // 1. Nobody has bid yet: decide whether to open
    if (!highestBid) {
      if (hcp < 13) return { type: 'pass', explanation: `${hcp} points — too weak to open` };
      if (hcp >= 16 && hcp <= 18 && isBalanced && suitCounts.S < 5 && suitCounts.H < 5) {
        return { type: 'bid', level: 1, suit: 'NT', explanation: '16-18 points, even distribution' };
      }
      if (suitCounts.S >= 5 && suitCounts.S >= suitCounts.H) {
        return { type: 'bid', level: 1, suit: 'S', explanation: `${hcp} points, 5+ Spades` };
      }
      if (suitCounts.H >= 5) {
        return { type: 'bid', level: 1, suit: 'H', explanation: `${hcp} points, 5+ Hearts` };
      }
      const minor = suitCounts.D > suitCounts.C ? 'D' : 'C';
      return { type: 'bid', level: 1, suit: minor, explanation: `${hcp} points, no 5-card major — opening a minor` };
    }

    // 2. Partner has bid: raise with support, but never past game level
    if (partnerLastBid) {
      if (hcp < 6) return { type: 'pass', explanation: `${hcp} points — too weak to respond` };

      const pSuit = partnerLastBid.suit;
      if (pSuit !== 'NT' && suitCounts[pSuit] >= 3) {
        // With a strong balanced hand and only a minor fit, prefer 3 No Trump
        // (the standard game contract) over the harder 5-of-a-minor
        if ((pSuit === 'C' || pSuit === 'D') && hcp >= 13 && isBalanced && cheapestLevel('NT') <= 3) {
          return { type: 'bid', level: 3, suit: 'NT', explanation: `${hcp} points, balanced — going for 3 No Trump` };
        }
        const gameLevel = (pSuit === 'H' || pSuit === 'S') ? 4 : 5;
        const target = hcp >= 13
          ? gameLevel
          : Math.min(gameLevel, partnerLastBid.level + (hcp >= 10 ? 2 : 1));
        const needed = cheapestLevel(pSuit);
        if (needed <= target) {
          return { type: 'bid', level: target, suit: pSuit, explanation: `${hcp} points, ${suitCounts[pSuit]}-card support — raising ${SUIT_WORDS[pSuit]}` };
        }
        return { type: 'pass', explanation: 'Bidding higher would be too risky' };
      }
      if (hcp <= 9) {
        if (cheapestLevel('NT') === 1) {
          return { type: 'bid', level: 1, suit: 'NT', explanation: '6-9 points, no fit — 1 No Trump' };
        }
        return { type: 'pass', explanation: '6-9 points, no fit for partner' };
      }
      // 10+ points, no fit: show own best suit if it's cheap enough
      let best = 'C';
      for (const s of ['D', 'H', 'S']) {
        if (suitCounts[s] > suitCounts[best]) best = s;
      }
      const lvl = cheapestLevel(best);
      if (lvl <= 2) {
        return { type: 'bid', level: lvl, suit: best, explanation: `${hcp} points — showing my ${SUIT_WORDS[best]}` };
      }
      return { type: 'pass', explanation: 'No safe bid available' };
    }

    // 3. Opponents opened and partner is silent: simple overcall
    if (hcp >= 13) {
      let best = null;
      for (const s of ['S', 'H', 'D', 'C']) {
        if (suitCounts[s] >= 5 && (!best || suitCounts[s] > suitCounts[best])) best = s;
      }
      if (best) {
        const lvl = cheapestLevel(best);
        if (lvl <= 2) {
          return { type: 'bid', level: lvl, suit: best, explanation: `${hcp} points, 5+ ${SUIT_WORDS[best]} — overcall` };
        }
      }
    }
    return { type: 'pass', explanation: hcp < 6 ? `${hcp} points — too weak to bid` : 'Nothing useful to bid' };
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
    const hand = this.hands[player];
    if (!hand || hand.length === 0) return null;

    let validIndices = [];
    const ledSuit = this.currentTrick.length > 0 ? this.currentTrick[0].card.suit : null;

    if (ledSuit) {
      for (let i = 0; i < hand.length; i++) {
        if (hand[i].suit === ledSuit) validIndices.push(i);
      }
    }

    if (validIndices.length === 0) {
      for (let i = 0; i < hand.length; i++) validIndices.push(i);
    }

    validIndices.sort((a, b) => RANKS.indexOf(hand[a].rank) - RANKS.indexOf(hand[b].rank));

    let cardIndexToPlay = validIndices[0];

    if (!ledSuit) {
      const { suitCounts } = this.evaluateHand(player);
      let bestIdx = validIndices[0];
      let bestScore = -1;
      for (const idx of validIndices) {
        const c = hand[idx];
        const score = suitCounts[c.suit] * 10 + RANKS.indexOf(c.rank);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = idx;
        }
      }
      cardIndexToPlay = bestIdx;
    } else if (this.currentTrick.length === 1) {
      cardIndexToPlay = validIndices[0];
    } else if (this.currentTrick.length === 2) {
      cardIndexToPlay = validIndices[validIndices.length - 1];
    } else if (this.currentTrick.length === 3) {
      let winningIsPartner = false;
      let winningPlay = this.currentTrick[0];
      for (let i = 1; i < 3; i++) {
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

      winningIsPartner = winningPlay.player === PLAYERS[(PLAYERS.indexOf(player) + 2) % 4];

      if (!winningIsPartner) {
         const winningRankValue = winningPlay.card.suit === ledSuit ? RANKS.indexOf(winningPlay.card.rank) : (winningPlay.card.suit === this.trumpSuit ? RANKS.indexOf(winningPlay.card.rank) : -1);
         for (const idx of validIndices) {
           const c = hand[idx];
           if (c.suit === winningPlay.card.suit && RANKS.indexOf(c.rank) > winningRankValue) {
             cardIndexToPlay = idx;
             break;
           } else if (c.suit === this.trumpSuit && winningPlay.card.suit !== this.trumpSuit) {
             cardIndexToPlay = idx;
             break;
           }
         }
      }
    }

    return cardIndexToPlay;
  }

  makeAIPlay() {
    const cardIndexToPlay = this.determineAIPlay(this.currentTurn);
    if (cardIndexToPlay !== null) {
      this.playCard(this.currentTurn, cardIndexToPlay);
    }
  }
}
