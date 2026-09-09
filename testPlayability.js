import { GameEngine } from './src/GameEngine.js';

globalThis.TEST_MODE = true;

console.log("Starting automated playability test...");

const engine = new GameEngine(() => {
  // We can track state changes here if needed
});

// Phase 1: Dealing
console.log("Dealing cards...");
engine.deal();

if (engine.phase !== 'bidding') {
  console.error("Test Failed: Game did not enter bidding phase.");
  process.exit(1);
}

// Phase 2: Bidding
console.log("Entering bidding phase. Simulating human bids...");
// In the current logic, South is the only human. The AI auto-passes when it's their turn.
// Wait, the engine deal() calls checkAITurn(). Since S is dealer, it's S's turn first.
let bids = 0;
while (engine.phase === 'bidding' && bids < 10) {
  if (engine.currentTurn === 'S') {
    if (bids === 0) {
      console.log("Human (S) bids 1NT");
      engine.placeBid({ type: 'bid', level: 1, suit: 'NT' });
    } else {
      console.log("Human (S) passes");
      engine.placeBid({ type: 'pass' });
    }
  }
  bids++;
}

if (engine.phase === 'finished' && engine.declarer === 'N') {
  // Sarah declared, so she auto-played the whole hand (human is dummy)
  console.log(`Contract was ${engine.contract.level}${engine.contract.suit} by N — Sarah played the hand herself.`);
  if (engine.tricksWon['N/S'] + engine.tricksWon['E/W'] === 13) {
    console.log("SUCCESS: Exactly 13 tricks were played and scored.");
    process.exit(0);
  }
  console.error("Test Failed: Incorrect number of tricks scored.");
  process.exit(1);
}

if (engine.phase !== 'playing') {
  console.error("Test Failed: Game did not enter playing phase after bidding.");
  process.exit(1);
}

console.log(`Contract finalized: ${engine.contract.level}${engine.contract.suit} by ${engine.declarer}`);
console.log(`Leader is: ${engine.currentTurn}`);

// Phase 3: Playing
console.log("Starting trick-taking simulation...");

let moves = 0;
while (engine.phase === 'playing' && moves < 100) {
  // The human controls South, and also North when N/S win the contract
  if (engine.humanControlsSeat(engine.currentTurn)) {
    const seat = engine.currentTurn;
    const hand = engine.hands[seat];
    let validIndices = [];
    if (engine.currentTrick.length > 0) {
      const ledSuit = engine.currentTrick[0].card.suit;
      for (let i = 0; i < hand.length; i++) {
        if (hand[i].suit === ledSuit) validIndices.push(i);
      }
    }
    if (validIndices.length === 0) {
      for (let i = 0; i < hand.length; i++) validIndices.push(i);
    }
    
    const playIdx = validIndices[0];
    const cardToPlay = hand[playIdx];
    console.log(`Human (${seat}) plays ${cardToPlay.rank}${cardToPlay.suit}`);
    const success = engine.playCard(seat, playIdx);
    if (!success) {
      console.error("Test Failed: Human played an invalid card.");
      process.exit(1);
    }
  }
  // The AI should automatically take its turns due to TEST_MODE synchronous execution
  moves++;
}

if (engine.phase === 'finished') {
  console.log("Game finished successfully!");
  console.log(`Final Score -> N/S: ${engine.tricksWon['N/S']}, E/W: ${engine.tricksWon['E/W']}`);
  if (engine.tricksWon['N/S'] + engine.tricksWon['E/W'] === 13) {
    console.log("SUCCESS: Exactly 13 tricks were played and scored.");
  } else {
    console.error("Test Failed: Incorrect number of tricks scored.");
    process.exit(1);
  }
} else {
  console.error("Test Failed: Game did not finish after 100 moves.");
  process.exit(1);
}
