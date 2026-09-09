import { useState, useEffect, useRef } from 'react';
import './App.css';
import Table from './components/Table';
import BiddingBox from './components/BiddingBox';
import { GameEngine, PLAYER_NAMES } from './GameEngine';
import { parsePBN } from './utils/pbnParser';

const SUIT_SYMBOLS = { C: '♣', D: '♦', H: '♥', S: '♠', NT: 'NT' };
const SUIT_WORDS = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades', NT: 'No Trump' };
const RANK_WORDS = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack' };
const VUL_LABELS = { 'None': 'No one', 'N/S': 'We', 'E/W': 'They', 'Both': 'Both' };
const BID_COLUMN_SEATS = ['N', 'E', 'S', 'W'];
const BID_COLUMN_LABELS = { N: 'Sarah', E: 'Robert', S: 'You', W: 'David' };
const THINKING_LABELS = {
  N: 'Sarah (your partner) is thinking…',
  E: 'Robert (East) is thinking…',
  W: 'David (West) is thinking…'
};

// Is the current turn one the human acts on? South always bids for herself.
// During play she also runs the dummy when she declares; when Sarah (N)
// declares, Sarah plays both hands and the human just watches.
function isHumanTurn(state) {
  if (state.phase === 'playing' && state.declarer === 'N') return false;
  return state.currentTurn === 'S' ||
    (state.currentTurn === 'N' && state.phase === 'playing' && state.declarer === 'S');
}

// Render one auction call in large, color-coded form
function CallText({ call }) {
  if (call.type === 'pass') return <span style={{ color: '#94a3b8' }}>Pass</span>;
  if (call.type === 'double') return <span style={{ color: '#f87171', fontWeight: 700 }}>X</span>;
  if (call.type === 'redouble') return <span style={{ color: '#f87171', fontWeight: 700 }}>XX</span>;
  const red = call.suit === 'H' || call.suit === 'D';
  return (
    <span style={{ fontWeight: 700 }}>
      {call.level}
      <span style={{ color: red ? '#ff7b7b' : 'white' }}>{SUIT_SYMBOLS[call.suit]}</span>
    </span>
  );
}

function App() {
  const [engine, setEngine] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [showAllCards, setShowAllCards] = useState(false);
  const [showAuction, setShowAuction] = useState(false);
  const [selectedBid, setSelectedBid] = useState(null);
  const [activeHint, setActiveHint] = useState(null);
  const [isAutoPlaying, setIsAutoPlaying] = useState(false);
  const [selectedCard, setSelectedCard] = useState(null);
  const [appState, setAppState] = useState('menu');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const soundEnabledRef = useRef(soundEnabled);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  const speak = (text) => {
    if (!soundEnabledRef.current) return;
    window.speechSynthesis.cancel(); // Stop current speech
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9; // Slightly slower for readability
    window.speechSynthesis.speak(utterance);
  };

  // Like speak(), but queues after current speech instead of cutting it off
  const speakQueued = (text) => {
    if (!soundEnabledRef.current) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
  };

  // PBN Mode State
  const [pbnDatabase, setPbnDatabase] = useState(null);
  const [useHistoricalMode, setUseHistoricalMode] = useState(false);
  const pbnRef = useRef(null);
  useEffect(() => {
    pbnRef.current = pbnDatabase;
  }, [pbnDatabase]);

  // Load PBN data once on mount. This only stores the data — it must NOT
  // restart a game in progress (that was the "game keeps starting over" bug).
  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}historical_hands.pbn`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(text => {
        if (cancelled) return;
        const parsed = parsePBN(text);
        if (parsed.length > 0) setPbnDatabase(parsed);
      })
      .catch(err => console.error('Failed to load historical hands:', err));
    return () => { cancelled = true; };
  }, []);

  // Initialize GameEngine — only on mount or when the deal mode is switched
  // (which can only happen from the start menu, never mid-game)
  useEffect(() => {
    const ge = new GameEngine((newState) => {
      setGameState({ ...newState });
      if (!isHumanTurn(newState)) {
        setActiveHint(null);
      }
      setSelectedCard(null);
    }, useHistoricalMode ? pbnRef.current : null, (text) => speak(text));

    setEngine(ge);
    ge.deal();
    return () => ge.destroy(); // Kill old timers so two games never fight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useHistoricalMode]);

  // Spoken "your turn" prompts so Mom always knows when to act
  const prevHumanSeatRef = useRef(null);
  useEffect(() => {
    if (!gameState || appState !== 'game') {
      prevHumanSeatRef.current = null;
      return;
    }
    const { phase, currentTurn } = gameState;
    const seatKey = isHumanTurn(gameState) ? `${phase}:${currentTurn}` : null;
    if (seatKey && seatKey !== prevHumanSeatRef.current && !isAutoPlaying) {
      if (phase === 'bidding') speakQueued('Your turn to bid.');
      else if (currentTurn === 'N') speakQueued("Your turn. Play a card from Sarah's hand at the top.");
      else speakQueued('Your turn.');
    }
    prevHumanSeatRef.current = seatKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState, isAutoPlaying, appState]);

  // Auto-Play Logic
  useEffect(() => {
    if (!isAutoPlaying || !gameState) return;
    // Never act while a completed trick is waiting to be cleared
    if (gameState.phase === 'playing' && gameState.currentTrick.length >= 4) return;

    let timer1, timer2;
    const { currentTurn } = gameState;

    if (isHumanTurn(gameState)) {
      const hint = engine.getHint(currentTurn);

      if (hint && hint.type === 'bid') {
        timer1 = setTimeout(() => engine.placeBid(hint.value), 1200);
      } else if (hint && hint.type === 'card') {
        timer1 = setTimeout(() => {
          setSelectedCard({ player: currentTurn, index: hint.value });
          timer2 = setTimeout(() => {
            engine.playCard(currentTurn, hint.value);
            setSelectedCard(null);
          }, 1000);
        }, 800);
      }
    }

    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [gameState, isAutoPlaying, engine]);

  if (!gameState) return <div style={{ color: 'white', fontSize: '2rem', padding: '40px', textAlign: 'center' }}>Loading…</div>;

  const handleBid = (bidEvent) => {
    setActiveHint(null);
    engine.placeBid(bidEvent);
  };

  const handlePlayCard = (player, cardIndex) => {
    setActiveHint(null);
    engine.playCard(player, cardIndex);
  };

  const handleHint = () => {
    const { currentTurn } = gameState;
    if (isHumanTurn(gameState)) {
      const hint = engine.getHint(currentTurn);
      setActiveHint(hint);

      if (hint && hint.type === 'bid') {
        if (hint.value.type === 'bid') {
          speak(`Hint: Bid ${hint.value.level} ${SUIT_WORDS[hint.value.suit]}`);
        } else {
          speak('Hint: Pass');
        }
      } else if (hint && hint.type === 'card') {
        const card = gameState.hands[currentTurn][hint.value];
        if (card) {
          speak(`Hint: Play the ${RANK_WORDS[card.rank] || card.rank} of ${SUIT_WORDS[card.suit]}`);
        }
      }
    }
  };

  const toggleShowAllCards = () => setShowAllCards(!showAllCards);
  const toggleShowAuction = () => {
    setShowAuction(!showAuction);
    if (showAuction) setSelectedBid(null);
  };
  const toggleAutoPlay = () => setIsAutoPlaying(!isAutoPlaying);

  const toggleSound = () => {
    if (!soundEnabled) {
      // iOS Safari requires a gesture to unlock speech synthesis
      const utterance = new SpeechSynthesisUtterance('');
      window.speechSynthesis.speak(utterance);
    }
    setSoundEnabled(!soundEnabled);
  };

  const { phase, contract, tricksWon, currentTurn } = gameState;
  const highestBid = gameState.bids.filter(b => b.type === 'bid').pop();

  // Double / Redouble are only legal against the opponents' last call
  const lastAction = [...gameState.bids].reverse().find(b => b.type !== 'pass');
  const canDouble = !!lastAction && lastAction.type === 'bid' && (lastAction.player === 'E' || lastAction.player === 'W');
  const canRedouble = !!lastAction && lastAction.type === 'double' && (lastAction.player === 'E' || lastAction.player === 'W');

  const handleStartGame = (autoPlay) => {
    // Unlock speech synthesis on iOS
    const utterance = new SpeechSynthesisUtterance('');
    window.speechSynthesis.speak(utterance);

    if (autoPlay) setIsAutoPlaying(true);
    setAppState('game');
  };

  if (appState === 'menu') {
    return (
      <div className="app-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0f172a', padding: '20px' }}>
        <h1 style={{ color: 'white', fontSize: '4rem', marginBottom: '10px', textAlign: 'center' }}>BettyBridge ♠️</h1>
        <p style={{ color: '#cbd5e1', fontSize: '1.5rem', marginBottom: '50px', textAlign: 'center' }}>The Accessible Duplicate Bridge Experience</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%', maxWidth: '440px' }}>
          <button
            onClick={() => handleStartGame(false)}
            style={{ padding: '24px', fontSize: '2rem', backgroundColor: '#22c55e', color: 'white', border: 'none', borderRadius: '12px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 4px 6px rgba(0,0,0,0.3)' }}
          >
            Play Bridge ♠️
          </button>

          <button
            onClick={() => handleStartGame(true)}
            style={{ padding: '24px', fontSize: '2rem', backgroundColor: '#3b82f6', color: 'white', border: 'none', borderRadius: '12px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 4px 6px rgba(0,0,0,0.3)' }}
          >
            Auto-Play / Watch 👀
          </button>

          {pbnDatabase && pbnDatabase.length > 0 && (
            <button
              onClick={() => setUseHistoricalMode(!useHistoricalMode)}
              style={{ padding: '16px', fontSize: '1.3rem', backgroundColor: 'transparent', color: '#cbd5e1', border: '2px solid #475569', borderRadius: '12px', cursor: 'pointer', fontWeight: 'bold' }}
            >
              Deals: {useHistoricalMode ? 'Famous Tournament Hands ✓' : 'Random Shuffle'}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="game-header">
        <div className="header-stats">
          <div className="stat-badge">
            <div className="stat-label">Board {gameState.boardNumber}</div>
            <div className="stat-value" style={{ fontSize: '1.3rem', color: gameState.vulnerability === 'None' ? '#a0aec0' : '#fca5a5' }}>
              Vul: {VUL_LABELS[gameState.vulnerability] || gameState.vulnerability}
            </div>
            <div className="stat-label" style={{ marginTop: '4px' }}>Dealer: {PLAYER_NAMES[gameState.dealer]}</div>
          </div>
          <div className="stat-badge contract-badge">
            <div className="stat-label">Contract</div>
            <div className="stat-value">
              {contract ? (
                <span>
                  {contract.level}
                  <span style={{ color: (contract.suit === 'H' || contract.suit === 'D') ? '#ff7b7b' : undefined }}>{SUIT_SYMBOLS[contract.suit]}</span>
                  {gameState.doubledStatus === 'doubled' ? 'x' : (gameState.doubledStatus === 'redoubled' ? 'xx' : '')}
                  {' by '}{PLAYER_NAMES[gameState.declarer]}
                </span>
              ) : (highestBid ? <span>{highestBid.level}{SUIT_SYMBOLS[highestBid.suit]}</span> : '—')}
            </div>
          </div>
          <div className="stat-badge score-badge">
            <div className="stat-label">We (N/S)</div>
            <div className="stat-value">{tricksWon['N/S']}</div>
          </div>
          <div className="stat-badge score-badge">
            <div className="stat-label">They (E/W)</div>
            <div className="stat-value">{tricksWon['E/W']}</div>
          </div>
        </div>
        <div className="settings-btn" style={{ gap: '10px' }}>
          <button className={`header-btn ${soundEnabled ? 'btn-auto-play' : 'btn-stop-auto'}`} onClick={toggleSound}>
            {soundEnabled ? 'Sound 🔊' : 'Muted 🔇'}
          </button>
          <button className={`header-btn ${isAutoPlaying ? 'btn-stop-auto' : 'btn-auto-play'}`} onClick={toggleAutoPlay}>{isAutoPlaying ? 'Stop Auto ⏹️' : 'Auto-Play ▶️'}</button>
          <button className="header-btn btn-hint" onClick={handleHint}>Hint 💡</button>
          {gameState.canUndo && (
            <button className="header-btn btn-undo" onClick={() => engine.undo()}>Undo ↩️</button>
          )}
          {phase === 'playing' && (
            <button className="header-btn btn-show" onClick={toggleShowAuction}>Auction 📜</button>
          )}
          <button className="header-btn btn-show" onClick={toggleShowAllCards}>{showAllCards ? 'Hide Cards' : 'Show Cards 👁️'}</button>
        </div>
      </header>

      <main className="table-area">
        <Table gameState={gameState} onPlayCard={handlePlayCard} showAllCards={showAllCards} activeHint={activeHint} selectedCard={selectedCard} setSelectedCard={setSelectedCard} />
      </main>

      {/* Bidding Modal Overlay */}
      {phase === 'bidding' && (
        <div className="bidding-modal-overlay bidding-overlay-top">
          <div className="bidding-modal-content bidding-columns">
            <div className="bidding-col-left">
              <h2 style={{ color: currentTurn === 'S' ? '#ffd66b' : 'white', textAlign: 'center', marginBottom: '15px', fontSize: currentTurn === 'S' ? '2.2rem' : '1.8rem' }}>
                 {currentTurn === 'S' ? 'YOUR TURN TO BID' : THINKING_LABELS[currentTurn]}
              </h2>

              {/* Live Auction Table */}
              <div style={{ backgroundColor: 'rgba(15, 23, 42, 0.9)', padding: '15px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.15)', width: '100%' }}>
                 <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', textAlign: 'center', fontSize: '1.25rem', fontWeight: 'bold', marginBottom: '8px' }}>
                    {BID_COLUMN_SEATS.map(seat => (
                      <div key={seat} style={{
                        color: currentTurn === seat ? '#ffd66b' : '#cbd5e1',
                        borderBottom: currentTurn === seat ? '3px solid #ffd66b' : '3px solid transparent',
                        paddingBottom: '4px'
                      }}>
                        {BID_COLUMN_LABELS[seat]}
                      </div>
                    ))}
                 </div>
                 <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', textAlign: 'center', fontSize: '1.5rem', maxHeight: '200px', overflowY: 'auto' }}>
                   {Array.from({ length: BID_COLUMN_SEATS.indexOf(gameState.dealer) }).map((_, i) => (
                     <div key={`pad-${i}`}></div>
                   ))}
                   {gameState.bids.map((b, i) => (
                     <div key={i} style={{ padding: '4px 0' }}>
                       <CallText call={b} />
                     </div>
                   ))}
                 </div>
              </div>

              {currentTurn === 'S' && gameState.canUndo && gameState.bids.some(b => b.player === 'S') && (
                <button
                  className="header-btn btn-undo"
                  style={{ marginTop: '14px', fontSize: '1.2rem' }}
                  onClick={() => engine.undo()}
                >
                  Undo my last bid ↩️
                </button>
              )}
            </div>

            {currentTurn === 'S' && (
              <div className="bidding-col-right">
                <BiddingBox onBid={handleBid} currentHighestBid={highestBid} activeHint={activeHint} canDouble={canDouble} canRedouble={canRedouble} />
              </div>
            )}
          </div>
        </div>
      )}
      {/* End of Hand Duplicate Score Modal */}
      {phase === 'finished' && gameState.duplicateScore && (
        <div className="bidding-modal-overlay">
          <div className="bidding-modal-content" style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)', padding: '40px', borderRadius: '16px', color: 'white', textAlign: 'center', boxShadow: '0 10px 40px rgba(0,0,0,0.8)', border: '1px solid rgba(255,255,255,0.2)', flexDirection: 'column', alignItems: 'center', maxWidth: '520px' }}>
            <h2 style={{ fontSize: '2rem', marginBottom: '10px' }}>Board {gameState.boardNumber} Complete</h2>

            {gameState.duplicateScore.made !== null ? (
              <>
                <p style={{ fontSize: '1.5rem', marginBottom: '20px', color: '#fbd38d' }}>
                  Contract: {gameState.duplicateScore.contract.level}{SUIT_SYMBOLS[gameState.duplicateScore.contract.suit]}
                  {gameState.duplicateScore.doubled === 'doubled' ? 'x' : (gameState.duplicateScore.doubled === 'redoubled' ? 'xx' : '')} by {PLAYER_NAMES[gameState.declarer]}
                </p>
                <div style={{ fontSize: '4rem', fontWeight: 'bold', margin: '20px 0', color: gameState.duplicateScore.side === 'N/S' ? '#4ade80' : '#f87171' }}>
                  {gameState.duplicateScore.side === 'N/S' ? 'We' : 'They'} +{gameState.duplicateScore.points}
                </div>
                <p style={{ fontSize: '1.3rem', color: '#cbd5e1', marginBottom: '20px' }}>
                  {gameState.duplicateScore.made
                    ? (gameState.duplicateScore.overtricks > 0
                        ? `Made with ${gameState.duplicateScore.overtricks} overtrick${gameState.duplicateScore.overtricks > 1 ? 's' : ''}`
                        : 'Made exactly')
                    : `Down ${gameState.duplicateScore.undertricks}`}
                  <br/>
                  (Tricks taken: {gameState.duplicateScore.tricks} — needed {6 + gameState.duplicateScore.contract.level})
                </p>
              </>
            ) : (
              <p style={{ fontSize: '1.5rem', marginBottom: '30px', color: '#cbd5e1' }}>Passed Out — no contract</p>
            )}

            <p style={{ fontSize: '1.2rem', color: '#94a3b8', marginBottom: '25px' }}>
              Total score — We: {gameState.cumulativeScore['N/S']} · They: {gameState.cumulativeScore['E/W']}
            </p>

            {/* Historical Comparison */}
            {gameState.historicalData && gameState.historicalData.historicalContract && (
              <div style={{ marginTop: '10px', marginBottom: '30px', padding: '15px', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: '10px', border: '1px dashed #64748b' }}>
                <h3 style={{ fontSize: '1.2rem', color: '#c084fc', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '1px' }}>Tournament Result</h3>
                <p style={{ fontSize: '1.1rem', color: '#e2e8f0', margin: '5px 0' }}>
                  {gameState.historicalData.event ? `${gameState.historicalData.event}` : 'Historical Play'}
                </p>
                <p style={{ fontSize: '1.3rem', color: '#fbd38d', fontWeight: 'bold' }}>
                  {gameState.historicalData.historicalContract} by {gameState.historicalData.historicalDeclarer}
                  {gameState.historicalData.historicalResult ? ` (Took ${gameState.historicalData.historicalResult})` : ''}
                </p>
                {gameState.historicalData.historicalScore && (
                  <p style={{ fontSize: '1.2rem', color: '#4ade80' }}>
                    Score: {gameState.historicalData.historicalScore}
                  </p>
                )}
              </div>
            )}

            <button
              className="header-btn btn-auto-play"
              style={{ fontSize: '1.6rem', padding: '18px 40px', width: '100%', justifyContent: 'center' }}
              onClick={() => engine.nextBoard()}
            >
              Next Board ▶️
            </button>
          </div>
        </div>
      )}

      {/* Auction Review Modal */}
      {showAuction && phase === 'playing' && (
        <div className="bidding-modal-overlay" onClick={toggleShowAuction}>
          <div className="bidding-modal-content" style={{ backgroundColor: 'rgba(15, 23, 42, 0.95)', padding: '30px', borderRadius: '16px', color: 'white', maxWidth: '440px', width: '90%', border: '2px solid rgba(255,255,255,0.1)', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.2)', paddingBottom: '10px' }}>
              <h2 style={{ fontSize: '1.8rem', margin: 0, color: '#fbd38d' }}>Auction History</h2>
              <button onClick={toggleShowAuction} style={{ background: 'transparent', border: 'none', color: 'white', fontSize: '2rem', cursor: 'pointer', padding: '5px 12px' }}>✖</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', textAlign: 'center', fontSize: '1.2rem', fontWeight: 'bold', marginBottom: '10px' }}>
              {BID_COLUMN_SEATS.map(seat => (
                <div key={seat} style={{ color: '#cbd5e1' }}>{BID_COLUMN_LABELS[seat]}</div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', textAlign: 'center', fontSize: '1.4rem', maxHeight: '400px', overflowY: 'auto' }}>
              {/* Pad the beginning if dealer wasn't N */}
              {Array.from({ length: BID_COLUMN_SEATS.indexOf(gameState.dealer) }).map((_, i) => (
                <div key={`pad-${i}`}></div>
              ))}

              {gameState.bids.map((b, i) => (
                <div key={i} onClick={() => setSelectedBid(b)} style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer', backgroundColor: selectedBid === b ? 'rgba(255,255,255,0.1)' : 'transparent', borderRadius: '4px' }}>
                  <CallText call={b} />
                </div>
              ))}
            </div>

            {selectedBid && (
              <div style={{ marginTop: '20px', padding: '15px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '8px' }}>
                <h4 style={{ margin: 0, color: '#fbd38d', fontSize: '1rem', textTransform: 'uppercase', letterSpacing: '1px' }}>Bid Explanation</h4>
                <p style={{ margin: '5px 0 0 0', fontSize: '1.2rem' }}>{selectedBid.explanation || 'Your bid'}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
