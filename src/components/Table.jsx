import React, { useState, useEffect } from 'react';
import './Table.css';
import Card from './Card';
import { PLAYER_NAMES, humanPlaysSeat } from '../GameEngine';
import { trickWinner } from '../cardPlay';

const SUIT_SYMBOLS = { S: '♠', H: '♥', C: '♣', D: '♦' };
const rankNames = { 'A': 'Ace', 'K': 'King', 'Q': 'Queen', 'J': 'Jack', '2': 'Two', '3': 'Three', '4': 'Four', '5': 'Five', '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Nine', '10': 'Ten' };
const suitNames = { 'S': 'Spades', 'H': 'Hearts', 'D': 'Diamonds', 'C': 'Clubs' };
const SUIT_ORDER = ['S', 'H', 'C', 'D'];

// A hand shown as four large text rows, one per suit. Far more legible for
// low vision than miniature card images. When `onPick` is supplied every
// rank becomes a big button — that is how Betty plays the dummy.
function SuitRows({ hand, onPick, selectedIndex, hintIndex, big }) {
  return (
    <div className={`suit-rows ${big ? 'suit-rows-big' : ''}`}>
      {SUIT_ORDER.map(suit => {
        const entries = hand
          .map((c, i) => ({ c, i }))
          .filter(e => e.c.suit === suit);
        return (
          <div key={suit} className="suit-row">
            <span className={`suit-row-symbol ${suit === 'H' || suit === 'D' ? 'red' : ''}`}>{SUIT_SYMBOLS[suit]}</span>
            {entries.length === 0 ? (
              <span className="suit-row-ranks">—</span>
            ) : onPick ? (
              <span className="suit-row-ranks">
                {entries.map(e => (
                  <button
                    key={e.i}
                    type="button"
                    className={`rank-chip ${selectedIndex === e.i ? 'selected' : ''} ${hintIndex === e.i ? 'hint-highlight' : ''} ${suit === 'H' || suit === 'D' ? 'red' : ''}`}
                    onClick={() => onPick(e.i)}
                  >
                    {e.c.rank}
                  </button>
                ))}
              </span>
            ) : (
              <span className="suit-row-ranks">{entries.map(e => e.c.rank).join(' ')}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// A tall screen has room to lay the trick out as a compass cross, with each
// card at the seat that played it. A wide, short one does not, so there the
// four cards sit in a row in the order they were played. Measured rather
// than guessed from orientation, so it is right on every device.
function useTrickLayout() {
  const pick = () => (typeof window === 'undefined' || window.innerHeight > window.innerWidth * 1.02
    ? 'cross' : 'row');
  const [mode, setMode] = useState(pick);
  useEffect(() => {
    const onResize = () => setMode(pick());
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return mode;
}

export default function Table({ gameState, onPlayCard, showAllCards, activeHint, selectedCard, setSelectedCard }) {
  const trickLayout = useTrickLayout();
  const { hands, currentTrick, currentTurn, dummy, phase, declarer, dummyVisible, trumpSuit } = gameState;
  const playerHand = hands['S'] || [];

  const isPlaying = phase === 'playing';
  const getActiveClass = (player) => currentTurn === player ? 'active-turn' : '';

  // Whoever won the contract plays both their own hand and the dummy, so
  // Betty plays two hands when she declares, her own when she is defending,
  // and none at all when her cards are the dummy.
  const humanIsDeclarer = isPlaying && declarer === 'S';
  const humanIsDummy = isPlaying && dummy === 'S';
  const humanControls = (player) => humanPlaysSeat(gameState, player);

  const announceCard = (card) => {
    // Guarded for the same reason as everywhere else: a tap must select the
    // card even if the browser refuses to say its name.
    try {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();
      const utterance = new SpeechSynthesisUtterance(`${rankNames[card.rank]} of ${suitNames[card.suit]}`);
      utterance.rate = 0.9;
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.error('Speech failed:', err);
    }
  };

  const handleCardClick = (player, index) => {
    if (!isPlaying) return;
    if (currentTrick.length >= 4) return; // wait for the trick to clear
    if (currentTurn !== player || !humanControls(player)) return;

    if (selectedCard && selectedCard.player === player && selectedCard.index === index) {
      // Second tap: play the card
      onPlayCard(player, index);
      setSelectedCard(null);
    } else {
      // First tap: select the card and say its name
      announceCard(hands[player][index]);
      setSelectedCard({ player, index });
    }
  };

  const hintIndexFor = (player) =>
    (activeHint && activeHint.type === 'card' && currentTurn === player) ? activeHint.value : null;
  const isHintCard = (player, index) => hintIndexFor(player) === index;

  // North's cards only go face up once the opening lead is on the table,
  // and only Betty gets to tap them — and only when she is the declarer.
  const northIsDummy = isPlaying && dummy === 'N' && dummyVisible;
  const northPlayable = northIsDummy && humanIsDeclarer;

  const renderHand = (player) => {
    if (!hands[player]) return null;
    // The dummy's hand is public in bridge — but not before the opening lead
    if (isPlaying && dummy === player && dummyVisible) {
      return (
        <SuitRows
          hand={hands[player]}
          big={player === 'N' && northPlayable}
          onPick={player === 'N' && northPlayable ? (i) => handleCardClick('N', i) : undefined}
          selectedIndex={selectedCard?.player === player ? selectedCard.index : null}
          hintIndex={hintIndexFor(player)}
        />
      );
    }
    if (showAllCards) return <SuitRows hand={hands[player]} />;
    return <div className="cards-left">{hands[player].length} cards</div>;
  };

  const seatTag = (player) => {
    if (!isPlaying) return '';
    if (declarer === player) return ' — DECLARER';
    if (dummy === player) return dummyVisible ? ' — DUMMY (face up)' : ' — DUMMY';
    return '';
  };

  // Big status line so it is always obvious whose turn it is and, just as
  // importantly, whose hand Betty is being asked to play from.
  let turnBanner = null;
  if (isPlaying && currentTrick.length === 4) {
    // Hold the completed trick on screen and say who took it
    const winner = trickWinner(currentTrick, trumpSuit);
    turnBanner = winner
      ? { main: `${PLAYER_NAMES[winner.player]} ${winner.player === 'S' ? 'win' : 'wins'} this trick` }
      : null;
  } else if (isPlaying) {
    if (humanControls(currentTurn)) {
      turnBanner = currentTurn === 'S'
        ? { main: 'YOUR TURN', sub: 'play from your own cards below' }
        : { main: 'YOUR TURN', sub: "now play one of Sarah's cards above" };
    } else if (humanIsDummy) {
      turnBanner = {
        main: `${PLAYER_NAMES[declarer]} is playing this hand`,
        sub: 'your cards are the dummy — sit back and watch'
      };
    } else {
      turnBanner = { main: `${PLAYER_NAMES[currentTurn]} is thinking…` };
    }
  }

  return (
    <div className={`table-layout layout-${trickLayout} ${northPlayable ? 'with-dummy-band' : ''}`}>
      {/* North. When Betty is declaring, Sarah's dummy becomes a band across
          the top of the table instead of a floating name panel. */}
      {northPlayable ? (
        <div className={`dummy-band ${getActiveClass('N')}`}>
          <div className="name">
            SARAH'S HAND — DUMMY
            <span className="name-hint"> · you play these · tap a card twice</span>
          </div>
          {renderHand('N')}
        </div>
      ) : (
        <div className={`player-info info-N ${getActiveClass('N')}`}>
          <div className="name">SARAH (N) — Your Partner{seatTag('N')}</div>
          {renderHand('N')}
        </div>
      )}

      {/* West */}
      <div className={`player-info info-W ${getActiveClass('W')}`}>
        <div className="name">DAVID (W){seatTag('W')}</div>
        {renderHand('W')}
      </div>

      {/* East */}
      <div className={`player-info info-E ${getActiveClass('E')}`}>
        <div className="name">ROBERT (E){seatTag('E')}</div>
        {renderHand('E')}
      </div>

      <div className="table-center">
        {/* The current trick — each card labelled with who played it */}
        {currentTrick.map((play, index) => (
          <div key={index} className={`played-card ${play.player}`} style={{ zIndex: index }}>
            <Card suit={play.card.suit} rank={play.card.rank} simplified={true} />
            <div className="played-card-label">{PLAYER_NAMES[play.player]}</div>
          </div>
        ))}
      </div>

      {/* Whose turn it is — always directly above Betty's own cards, so it
          can never sit on top of a played card */}
      {turnBanner && (
        <div className="turn-banner">
          {turnBanner.main}
          {turnBanner.sub && <span className="turn-banner-sub">{turnBanner.sub}</span>}
        </div>
      )}

      {/* Betty's own hand */}
      <div className="player-hand-container">
        {humanIsDummy && (
          <div className="your-hand-tag">YOUR CARDS — DUMMY · {PLAYER_NAMES[declarer]} plays these</div>
        )}
        <div className="player-hand-fan">
          {playerHand.map((c, i) => {
            const total = playerHand.length;
            const middle = (total - 1) / 2;
            const offset = i - middle;
            const rotation = offset * 2;
            const yOffset = Math.abs(offset) * 2;
            const selected = selectedCard?.player === 'S' && selectedCard?.index === i;

            return (
              <div key={i} className={`playable-card-wrapper ${isHintCard('S', i) ? 'hint-highlight' : ''} ${selected ? 'selected' : ''}`} style={{
                marginLeft: i === 0 ? 0 : 'clamp(-56px, -5vw, -18px)',
                transform: `rotate(${rotation}deg) translateY(${yOffset}px)`,
                transformOrigin: 'bottom center',
                zIndex: selected ? 50 : i,
                transition: 'transform 0.2s, box-shadow 0.2s',
                cursor: currentTurn === 'S' && humanControls('S') ? 'pointer' : 'default',
                borderRadius: '12px'
              }} onClick={() => handleCardClick('S', i)}>
                <Card suit={c.suit} rank={c.rank} simplified={selected} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
