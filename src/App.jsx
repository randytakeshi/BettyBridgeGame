import { useState, useEffect, useRef } from 'react';
import './App.css';
import Table from './components/Table';
import BiddingBox from './components/BiddingBox';
import { GameEngine, PLAYER_NAMES, bidName, humanPlaysSeat, SPEEDS, DEFAULT_SPEED, speedMultiplier } from './GameEngine';
import { parsePBN } from './utils/pbnParser';
import { loadSavedGame, saveGame, clearSavedGame, loadPrefs, savePrefs } from './saveGame';
import { NT_RANGES, DEFAULT_NT_RANGE, setNoTrumpRange, DEFAULT_WEAK_TWOS, setWeakTwos, DEFAULT_TRANSFERS, setTransfers } from './bidding';

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

// Is the current turn one Betty acts on?
function isHumanTurn(state) {
  if (state.phase !== 'bidding' && state.phase !== 'playing') return false;
  return humanPlaysSeat(state, state.currentTurn);
}

// One short line telling Betty what her job is on this hand
function roleOf(state) {
  if (state.phase !== 'playing') return null;
  if (state.declarer === 'S') return { label: 'You are DECLARER', tone: '#4ade80' };
  if (state.dummy === 'S') return { label: `You are DUMMY — ${PLAYER_NAMES[state.declarer]} plays`, tone: '#fbd38d' };
  return { label: 'You are DEFENDING', tone: '#93c5fd' };
}

const HCP_VALUE = { A: 4, K: 3, Q: 2, J: 1 };
const SUIT_ORDER = ['S', 'H', 'C', 'D'];

function HandSummary({ hand }) {
  // High cards only, which is exactly how Betty counts and exactly what the
  // opening rule uses — the number on screen is the number that decides.
  const points = hand.reduce((sum, c) => sum + (HCP_VALUE[c.rank] || 0), 0);

  return (
    <div className="hand-summary">
      <div className="hand-summary-head">
        YOUR HAND — <span className="hand-points">{points} point{points === 1 ? '' : 's'}</span>
      </div>
      <div className="hand-summary-rows">
        {SUIT_ORDER.map(suit => {
          const ranks = hand.filter(c => c.suit === suit).map(c => c.rank);
          const red = suit === 'H' || suit === 'D';
          return (
            <div key={suit} className="hand-summary-row">
              <span className={`hand-summary-suit ${red ? 'red' : ''}`}>{SUIT_SYMBOLS[suit]}</span>
              <span className="hand-summary-ranks">{ranks.length ? ranks.join(' ') : '—'}</span>
              <span className="hand-summary-count">({ranks.length})</span>
            </div>
          );
        })}
      </div>
    </div>
  );
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
  const [hintText, setHintText] = useState(null);
  const [showRules, setShowRules] = useState(false);

  // Read the saved board once, before the engine is built, so the menu can
  // offer to carry on from it
  // Opening the app deals a board straight away, so a save exists before she
  // has touched anything. Only offer to carry on when there is something to
  // carry on with — otherwise the very first launch says "right where you
  // left off" to someone who has never played.
  const hasProgress = (g) => !!g && (
    g.boardNumber > 1 ||
    (Array.isArray(g.bids) && g.bids.length > 0) ||
    (Array.isArray(g.playedCards) && g.playedCards.length > 0)
  );
  const pendingRestoreRef = useRef(undefined);
  if (pendingRestoreRef.current === undefined) {
    const loaded = loadSavedGame();
    pendingRestoreRef.current = hasProgress(loaded) ? loaded : null;
  }
  const [savedBoard, setSavedBoard] = useState(
    () => (pendingRestoreRef.current ? pendingRestoreRef.current.boardNumber : null)
  );
  const prefsRef = useRef(undefined);
  if (prefsRef.current === undefined) prefsRef.current = loadPrefs();
  const [soundEnabled, setSoundEnabled] = useState(() => prefsRef.current.sound !== false);
  const [speed, setSpeed] = useState(
    () => (SPEEDS.some(s => s.key === prefsRef.current.speed) ? prefsRef.current.speed : DEFAULT_SPEED)
  );
  const [ntRange, setNtRange] = useState(
    () => (NT_RANGES.some(r => r.key === prefsRef.current.ntRange) ? prefsRef.current.ntRange : DEFAULT_NT_RANGE)
  );
  const [weakTwos, setWeakTwosPref] = useState(
    () => (typeof prefsRef.current.weakTwos === 'boolean' ? prefsRef.current.weakTwos : DEFAULT_WEAK_TWOS)
  );
  const [transfers, setTransfersPref] = useState(
    () => (typeof prefsRef.current.transfers === 'boolean' ? prefsRef.current.transfers : DEFAULT_TRANSFERS)
  );
  // Apply them all before the engine ever evaluates a call
  const settingsKey = `${ntRange}|${weakTwos}|${transfers}`;
  if (prefsRef.current.__applied !== settingsKey) {
    setNoTrumpRange(ntRange);
    setWeakTwos(weakTwos);
    setTransfers(transfers);
    prefsRef.current.__applied = settingsKey;
  }
  const soundEnabledRef = useRef(soundEnabled);
  const speedRef = useRef(speed);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    savePrefs({ sound: soundEnabled, speed, ntRange, weakTwos, transfers });
  }, [soundEnabled, speed, ntRange, weakTwos, transfers]);

  useEffect(() => {
    setNoTrumpRange(ntRange);
    setWeakTwos(weakTwos);
    setTransfers(transfers);
  }, [ntRange, weakTwos, transfers]);

  // The engine paces the computer players; auto-play uses the same dial
  useEffect(() => {
    if (engine) engine.setSpeed(speed);
  }, [engine, speed]);

  // Safari's speech engine is unreliable: it can be left paused after the app
  // has been in the background, and it throws in situations it has no business
  // throwing in. Every call is guarded, because losing the spoken card name is
  // an annoyance while losing the hand is not.
  const say = (text, queued) => {
    if (!soundEnabledRef.current) return;
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      if (!queued) synth.cancel();
      synth.resume(); // undo the paused state iOS can leave behind
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.9; // Slightly slower for readability
      synth.speak(utterance);
    } catch (err) {
      console.error('Speech failed:', err);
    }
  };

  const speak = (text) => say(text, false);
  // Like speak(), but queues after current speech instead of cutting it off
  const speakQueued = (text) => say(text, true);

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
    let ge;
    ge = new GameEngine((newState) => {
      setGameState({ ...newState });
      if (!isHumanTurn(newState)) {
        setActiveHint(null);
        setHintText(null);
      }
      setSelectedCard(null);
      // Keep her place after every single change, so nothing is ever lost
      if (ge) saveGame(ge.serialize());
    }, useHistoricalMode ? pbnRef.current : null, (text, queued) => (queued ? speakQueued(text) : speak(text)));

    ge.setSpeed(speedRef.current);
    ge.startWatchdog();
    setEngine(ge);
    // Handy for poking at a game from the dev console; never ships
    if (import.meta.env.DEV) window.__engine = ge;

    // The saved board stays on the ref until she actually starts playing, so
    // that a remount (React runs effects twice in development) restores it
    // again rather than dealing over the top of it.
    const toRestore = pendingRestoreRef.current;
    if (toRestore && ge.restore(toRestore)) {
      // Leave the computer players parked until she taps Continue
      ge.notifyUpdate();
    } else {
      setSavedBoard(null);
      ge.deal();
    }

    return () => ge.destroy(); // Kill old timers so two games never fight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useHistoricalMode]);

  // Coming back to the app is the moment a stalled timer shows up as "it was
  // David's turn and nothing happened" — iPads throttle and drop timers in
  // backgrounded tabs. Restart the move rather than waiting on a timer that
  // may never fire.
  useEffect(() => {
    if (!engine) return;
    const wake = () => {
      // Only on the way back in. A timer that was pending while the app was
      // in the background cannot be trusted, so restart rather than nudge.
      if (document.visibilityState === 'visible') engine.resume();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
    };
  }, [engine]);

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
      else if (currentTurn === 'N') speakQueued("Your turn. Play one of Sarah's cards from the dummy at the top.");
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

      const pace = speedMultiplier(speed);
      if (hint && hint.type === 'bid') {
        timer1 = setTimeout(() => engine.placeBid(hint.value), 1200 * pace);
      } else if (hint && hint.type === 'card') {
        timer1 = setTimeout(() => {
          setSelectedCard({ player: currentTurn, index: hint.value });
          timer2 = setTimeout(() => {
            engine.playCard(currentTurn, hint.value);
            setSelectedCard(null);
          }, 1000 * pace);
        }, 800 * pace);
      }
    }

    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [gameState, isAutoPlaying, engine, speed]);

  if (!gameState) return <div style={{ color: 'white', fontSize: '2rem', padding: '40px', textAlign: 'center' }}>Loading…</div>;

  const handleBid = (bidEvent) => {
    setActiveHint(null);
    setHintText(null);
    engine.placeBid(bidEvent);
  };

  const handlePlayCard = (player, cardIndex) => {
    setActiveHint(null);
    setHintText(null);
    engine.playCard(player, cardIndex);
  };

  const handleHint = () => {
    const { currentTurn } = gameState;
    if (!isHumanTurn(gameState)) {
      setHintText('It is not your turn just now.');
      return;
    }
    const hint = engine.getHint(currentTurn);
    setActiveHint(hint);

    if (hint && hint.type === 'bid') {
      const v = hint.value;
      const what = v.type === 'bid'
        ? `Bid ${bidName(v.level, v.suit)}`
        : (v.type === 'double' ? 'Double' : 'Pass');
      const why = v.explanation ? ` — ${v.explanation}` : '';
      setHintText(`${what}${why}`);
      speak(`Hint. ${what}. ${v.explanation || ''}`);
    } else if (hint && hint.type === 'card') {
      const card = gameState.hands[currentTurn][hint.value];
      if (card) {
        const whose = currentTurn === 'N' ? " from Sarah's dummy" : ' from your hand';
        const what = `Play the ${RANK_WORDS[card.rank] || card.rank} of ${SUIT_WORDS[card.suit]}${whose}`;
        setHintText(what);
        speak(`Hint. ${what}`);
      }
    }
  };

  const toggleShowAllCards = () => setShowAllCards(!showAllCards);
  const toggleShowAuction = () => {
    setShowAuction(!showAuction);
    if (showAuction) setSelectedBid(null);
  };
  const toggleAutoPlay = () => setIsAutoPlaying(!isAutoPlaying);

  // One button cycling Slow / Normal / Fast, like the Sound and Deals toggles
  const cycleSpeed = () => {
    const i = SPEEDS.findIndex(s => s.key === speed);
    setSpeed(SPEEDS[(i + 1) % SPEEDS.length].key);
  };
  const speedLabel = (SPEEDS.find(s => s.key === speed) || SPEEDS[1]).label;

  const toggleSound = () => {
    if (!soundEnabled) {
      // iOS Safari requires a gesture to unlock speech synthesis
      try {
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
      } catch { /* no speech available; the game plays on silently */ }
    }
    setSoundEnabled(!soundEnabled);
  };

  const { phase, contract, tricksWon, currentTurn } = gameState;
  const role = roleOf(gameState);
  const ntLabel = (NT_RANGES.find(r => r.key === ntRange) || NT_RANGES[0]).label;
  const highestBid = gameState.bids.filter(b => b.type === 'bid').pop();

  // Double / Redouble are only legal against the opponents' last call
  const lastAction = [...gameState.bids].reverse().find(b => b.type !== 'pass');
  const canDouble = !!lastAction && lastAction.type === 'bid' && (lastAction.player === 'E' || lastAction.player === 'W');
  const canRedouble = !!lastAction && lastAction.type === 'double' && (lastAction.player === 'E' || lastAction.player === 'W');

  // 'continue' picks up the saved board, 'new' starts a fresh session,
  // 'watch' carries on with the computer playing Betty's seat too
  const handleStartGame = (mode) => {
    // Unlock speech synthesis on iOS — this tap is the gesture it needs
    try {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    } catch { /* no speech available; the game plays on silently */ }

    // From here the live game is the truth, not the snapshot we loaded with
    pendingRestoreRef.current = null;

    if (mode === 'new') {
      clearSavedGame();
      setSavedBoard(null);
      engine.newSession();
    }
    if (mode === 'watch') setIsAutoPlaying(true);
    setAppState('game');
    // A restored board has been sitting idle — get the table moving again
    engine.checkAITurn();
  };

  if (appState === 'menu') {
    return (
      <div className="app-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0f172a', padding: '20px' }}>
        <h1 style={{ color: 'white', fontSize: '4rem', marginBottom: '10px', textAlign: 'center' }}>BettyBridge ♠️</h1>
        <p style={{ color: '#cbd5e1', fontSize: '1.5rem', marginBottom: '50px', textAlign: 'center' }}>The Accessible Duplicate Bridge Experience</p>

        <div className="menu-buttons">
          {savedBoard !== null && (
            <button className="menu-btn menu-btn-primary" onClick={() => handleStartGame('continue')}>
              Carry on with Board {savedBoard} ▶️
              <span className="menu-btn-sub">right where you left off</span>
            </button>
          )}

          <button
            className={`menu-btn ${savedBoard === null ? 'menu-btn-primary' : 'menu-btn-plain'}`}
            onClick={() => handleStartGame('new')}
          >
            {savedBoard === null ? 'Play Bridge ♠️' : 'Start a New Game ♠️'}
            {savedBoard !== null && <span className="menu-btn-sub">board 1, scores back to nothing</span>}
          </button>

          <button className="menu-btn menu-btn-plain menu-btn-watch" onClick={() => handleStartGame('watch')}>
            Just Watch 👀
            <span className="menu-btn-sub">the computer plays every hand — you only watch</span>
          </button>

          {pbnDatabase && pbnDatabase.length > 0 && (
            <button
              className="menu-btn menu-btn-toggle"
              onClick={() => {
                // A different set of deals means the saved board no longer applies
                clearSavedGame();
                setSavedBoard(null);
                pendingRestoreRef.current = null;
                setUseHistoricalMode(!useHistoricalMode);
              }}
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
          {role && (
            <div className="stat-badge">
              <div className="stat-label">Your job</div>
              <div className="stat-value" style={{ fontSize: '1.15rem', color: role.tone }}>{role.label}</div>
            </div>
          )}
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
          <button className="header-btn btn-show" onClick={cycleSpeed}>Speed: {speedLabel} ⏱️</button>
          <button className={`header-btn ${isAutoPlaying ? 'btn-stop-auto' : 'btn-show'}`} onClick={toggleAutoPlay}>{isAutoPlaying ? 'Stop Auto ⏹️' : 'Watch 👀'}</button>
          <button className="header-btn btn-hint" onClick={handleHint}>Hint 💡</button>
          {gameState.canUndo && (
            <button className="header-btn btn-undo" onClick={() => engine.undo()}>Undo ↩️</button>
          )}
          {phase === 'playing' && (
            <button className="header-btn btn-show" onClick={toggleShowAuction}>Auction 📜</button>
          )}
          <button className="header-btn btn-show" onClick={toggleShowAllCards}>{showAllCards ? 'Hide Cards' : 'Show Cards 👁️'}</button>
          <button className="header-btn btn-show" onClick={() => setShowRules(true)}>Rules ❓</button>
        </div>
      </header>

      {isAutoPlaying && (
        <div className="autoplay-bar">
          <span className="autoplay-bar-text">
            <b>The computer is playing your cards for you.</b> You are just watching.
          </span>
          <button className="autoplay-bar-btn" onClick={() => setIsAutoPlaying(false)}>
            Let me play ✋
          </button>
        </div>
      )}

      {hintText && (
        <div className="hint-bar" onClick={() => setHintText(null)}>
          <span className="hint-bar-label">HINT</span>
          <span>{hintText}</span>
          <span className="hint-bar-close">✖</span>
        </div>
      )}

      <main className="table-area">
        <Table gameState={gameState} onPlayCard={handlePlayCard} showAllCards={showAllCards} activeHint={activeHint} selectedCard={selectedCard} setSelectedCard={setSelectedCard} isAutoPlaying={isAutoPlaying} />

      {/* Bidding Modal Overlay */}
      {phase === 'bidding' && (
        <div className="bidding-modal-overlay bidding-overlay-top">
          <div className="bidding-modal-content bidding-columns">
            <div className="bidding-col-left">
              <h2 className="bidding-turn-head" style={{ color: currentTurn === 'S' ? '#ffd66b' : 'white' }}>
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

              <HandSummary hand={gameState.hands.S || []} />

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
      </main>

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

            {gameState.isReplay && gameState.firstResult && gameState.firstResult.score && (
              <div className="first-try">
                <h3>First time through</h3>
                <p>
                  {gameState.firstResult.contract.level}
                  {SUIT_SYMBOLS[gameState.firstResult.contract.suit]} by {PLAYER_NAMES[gameState.firstResult.declarer]}
                  {' — '}
                  {gameState.firstResult.score.made
                    ? `made ${gameState.firstResult.score.tricks}`
                    : `down ${gameState.firstResult.score.undertricks}`}
                  {', '}
                  {gameState.firstResult.score.side === 'N/S' ? 'we' : 'they'} scored {gameState.firstResult.score.points}
                </p>
              </div>
            )}

            <p style={{ fontSize: '1.2rem', color: '#94a3b8', marginBottom: '25px' }}>
              {gameState.isReplay
                ? 'A replay is practice — the running score has not moved.'
                : null}
              {gameState.isReplay && <br />}
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

            <div className="board-done-buttons">
              <button
                className="header-btn btn-auto-play board-done-btn"
                onClick={() => engine.nextBoard()}
              >
                Next Board ▶️
              </button>
              {gameState.canReplay && (
                <button
                  className="header-btn btn-show board-done-btn board-done-replay"
                  onClick={() => engine.replayBoard()}
                >
                  Play This Deal Again ↺
                  <span className="board-done-sub">same cards, bid it again — just for practice</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* House Rules */}
      {showRules && (
        <div className="bidding-modal-overlay" onClick={() => setShowRules(false)}>
          <div className="rules-card" onClick={e => e.stopPropagation()}>
            <div className="rules-head">
              <h2>How We Play</h2>
              <button onClick={() => setShowRules(false)} aria-label="Close">✖</button>
            </div>
            <div className="rules-body">
              <h3>Counting your hand</h3>
              <p>Ace 4 · King 3 · Queen 2 · Jack 1.</p>

              <h3>Opening the bidding</h3>
              <p>You need <b>13 high card points</b> to open. Only the aces, kings,
                 queens and jacks count — a long suit does not add anything yet.</p>
              <p>Once a fit is found, <b>then</b> you count your distribution.</p>
              <p>Open 1 Spade or 1 Heart with <b>five cards</b> in that major.</p>
              <p>Otherwise open a five-card minor, or three cards in Clubs or Diamonds.</p>
              <p>Open <b>1 No Trump with {ntLabel}</b> and even distribution.</p>
              <div className="rules-setting">
                <span>
                  {ntRange === '16-18'
                    ? 'Some play 15 to 17 now. Tap to try it — you can always tap back.'
                    : 'This is the newer range. Tap to go back to 16 to 18.'}
                </span>
                <button
                  className="header-btn btn-show"
                  onClick={() => setNtRange(ntRange === '16-18' ? '15-17' : '16-18')}
                >
                  1 No Trump: {ntLabel} — tap to change
                </button>
              </div>
              <p>With seven cards in one suit you can open <b>3 of that suit on just
                 6 points</b>. It is a defensive bid — the shape is worth more than the
                 points, and it takes away the opponents' room.</p>
              <p>With <b>six</b> cards and 6 to 10 points, open <b>2 of that suit</b> —
                 a weak two. Two Clubs is never weak; it is always the strong hand.</p>
              <div className="rules-setting">
                <span>
                  {weakTwos
                    ? 'Some play all the two-bids as strong hands instead. Tap to switch.'
                    : 'Two-bids are all strong at the moment. Tap to play weak twos.'}
                </span>
                <button
                  className="header-btn btn-show"
                  onClick={() => setWeakTwosPref(!weakTwos)}
                >
                  Two-bids: {weakTwos ? 'weak' : 'strong'} — tap to change
                </button>
              </div>

              <h3>Doubling</h3>
              <p>Double their <b>1 or 2 level</b> opening and it means "I have a good
                 hand — partner, pick a suit."</p>
              <p>Double them at <b>3 or higher</b>, or once <b>both sides have bid</b>,
                 and it is for <b>penalty</b> — you can beat them. Partner leaves it in.</p>

              <p>Repeating your own five-card major says you actually have <b>six</b>.</p>

              <h3>The three conventions we play</h3>
              <p><b>2 Clubs to open</b> means 22 points or more. It says nothing about
                 Clubs — partner answers 2 Diamonds and waits to hear more.</p>
              <p><b>Stayman.</b> Over partner's 1 No Trump, 2 Clubs asks whether they
                 hold a four-card major. They answer 2 Hearts or 2 Spades if they do,
                 2 Diamonds if they do not.</p>
              <p><b>4 No Trump asks for aces.</b> Partner answers 5 Clubs with none or
                 all four, 5 Diamonds with one, 5 Hearts with two, 5 Spades with three.</p>
              <p><b>5 No Trump after that asks for kings</b>, answered the same way one
                 level up — 6 Clubs with none or all four, and so on.</p>
              <p>Over 1 No Trump, <b>2 Diamonds means you have at least five diamonds</b>.
                 Partner with three can raise — but No Trump is where game is, so with
                 the points for it you bid No Trump instead: nine tricks, not eleven.</p>
              <p>If partner has a maximum they can answer <b>2 No Trump</b>, and you can
                 then bid <b>3 No Trump with 10 or 11</b>. On a minimum they leave you in
                 your suit.</p>
              <p>There is another system where 2 Diamonds tells partner to bid Hearts:</p>
              <div className="rules-setting">
                <span>
                  {transfers
                    ? '2 Diamonds now says "bid Hearts", and 2 Hearts says "bid Spades".'
                    : '2 Diamonds and 2 Hearts mean what they say. Tap if you play them the other way.'}
                </span>
                <button
                  className="header-btn btn-show"
                  onClick={() => setTransfersPref(!transfers)}
                >
                  2 Diamonds over 1 No Trump: {transfers ? 'asks for Hearts' : 'means Diamonds'} — tap to change
                </button>
              </div>
              <p>Over 1 No Trump, <b>4 Clubs just means Clubs</b> — we do not use it to
                 ask for aces.</p>
              <p>Everything else means exactly what it says.</p>

              <h3>Suit order</h3>
              <p>Clubs · Diamonds · Hearts · Spades · No Trump. Over 1 Spade you can bid
                 1 No Trump, or go to 2 of another suit.</p>

              <h3>Making your contract</h3>
              <p>Bid 1 of a suit and you must win <b>7 tricks</b> out of 13. Each level adds one more.</p>
              <p>Game is <b>4 Hearts or 4 Spades</b> (120 points), <b>5 Clubs or 5 Diamonds</b> (100 points),
                 or <b>3 No Trump</b> (100 points).</p>
              <p>Between the two of you it takes about <b>26 points to make a game</b>
                 and <b>33 for a slam</b>.</p>
              <p>A game scores <b>300 extra</b> — or <b>500</b> when you are vulnerable.</p>

              <h3>Playing the hand</h3>
              <p>Whoever <b>first named the suit</b> for the winning side is the declarer.</p>
              <p>After the opening lead, the declarer's partner lays their cards face up as the
                 <b> dummy</b>, and the declarer plays <b>both hands</b>.</p>
              <p>We score each board on its own, duplicate style.</p>
            </div>
            <button className="header-btn btn-auto-play rules-done" onClick={() => setShowRules(false)}>Got it</button>
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
