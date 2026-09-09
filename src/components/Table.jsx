import React from 'react';
import './Table.css';
import Card from './Card';
import { PLAYER_NAMES } from '../GameEngine';

const SUIT_SYMBOLS = { S: '♠', H: '♥', C: '♣', D: '♦' };
const rankNames = { 'A': 'Ace', 'K': 'King', 'Q': 'Queen', 'J': 'Jack', '2': 'Two', '3': 'Three', '4': 'Four', '5': 'Five', '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Nine', '10': 'Ten' };
const suitNames = { 'S': 'Spades', 'H': 'Hearts', 'D': 'Diamonds', 'C': 'Clubs' };

// A hand shown as four large text rows, one per suit. Far more legible for
// low vision than miniature card images.
function SuitRows({ hand }) {
  return (
    <div className="suit-rows">
      {['S', 'H', 'C', 'D'].map(suit => {
        const cards = hand.filter(c => c.suit === suit);
        return (
          <div key={suit} className="suit-row">
            <span className={`suit-row-symbol ${suit === 'H' || suit === 'D' ? 'red' : ''}`}>{SUIT_SYMBOLS[suit]}</span>
            <span className="suit-row-ranks">{cards.length > 0 ? cards.map(c => c.rank).join(' ') : '—'}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function Table({ gameState, onPlayCard, showAllCards, activeHint, selectedCard, setSelectedCard }) {
  const { hands, currentTrick, currentTurn, dummy, phase, declarer } = gameState;
  const playerHand = hands['S'] || [];

  const isPlaying = phase === 'playing';
  const getActiveClass = (player) => currentTurn === player ? 'active-turn' : '';

  // The human plays South (plus the dummy when she declares). When Sarah (N)
  // declares, Sarah plays both hands and the human's cards are the dummy.
  const humanControls = (player) => {
    if (isPlaying && declarer === 'N') return false;
    return player === 'S' || (player === 'N' && isPlaying && declarer === 'S');
  };

  const announceCard = (card) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(`${rankNames[card.rank]} of ${suitNames[card.suit]}`);
      utterance.rate = 0.9;
      window.speechSynthesis.speak(utterance);
    }
  };

  const handleCardClick = (player, index) => {
    if (!isPlaying) return;
    if (currentTurn !== player || !humanControls(player)) return;

    if (selectedCard && selectedCard.player === player && selectedCard.index === index) {
      // Second tap: Play the card
      onPlayCard(player, index);
      setSelectedCard(null);
    } else {
      // First tap: Select the card and say its name
      const card = hands[player][index];
      announceCard(card);
      setSelectedCard({ player, index });
    }
  };

  const isHintCard = (player, index) => {
    return activeHint && activeHint.type === 'card' && currentTurn === player && activeHint.value === index;
  };

  // North's cards are laid out as real cards in the center only when North
  // is dummy (the human plays them). When Sarah declares, her hand stays
  // hidden like a real declarer's.
  const northShownInCenter = isPlaying && dummy === 'N';

  const renderOpponentHand = (player) => {
    if (!hands[player]) return null;

    if (player === 'N' && northShownInCenter) {
      return <div className="cards-left">{hands[player].length} cards — shown below</div>;
    }
    // The dummy's hand is public in bridge: always show it, large
    if (isPlaying && dummy === player) {
      return <SuitRows hand={hands[player]} />;
    }
    if (showAllCards) {
      return <SuitRows hand={hands[player]} />;
    }
    return <div className="cards-left">{hands[player].length} cards</div>;
  };

  const seatTag = (player) => {
    if (isPlaying && dummy === player) return ' — Dummy';
    if (isPlaying && declarer === player) return ' — Declarer';
    return '';
  };

  // Big status line so it's always obvious whose turn it is
  let turnBanner = '';
  if (isPlaying && currentTrick.length < 4) {
    if (declarer === 'N') {
      turnBanner = currentTurn === 'S'
        ? 'Sarah is playing your cards — you are the dummy this hand'
        : `${PLAYER_NAMES[currentTurn]} is thinking…`;
    } else if (currentTurn === 'S') {
      turnBanner = 'YOUR TURN — tap a card, tap again to play it';
    } else if (humanControls('N') && currentTurn === 'N') {
      turnBanner = "YOUR TURN — play from Sarah's cards above";
    } else {
      turnBanner = `${PLAYER_NAMES[currentTurn]} is thinking…`;
    }
  }

  return (
    <div className="table-layout">
      {/* North */}
      <div className={`player-info info-N ${getActiveClass('N')}`}>
        <div className="name">SARAH (N) — Your Partner{seatTag('N')}</div>
        {renderOpponentHand('N')}
      </div>

      {/* West */}
      <div className={`player-info info-W ${getActiveClass('W')}`}>
        <div className="name">DAVID (W){seatTag('W')}</div>
        {renderOpponentHand('W')}
      </div>

      {/* East */}
      <div className={`player-info info-E ${getActiveClass('E')}`}>
        <div className="name">ROBERT (E){seatTag('E')}</div>
        {renderOpponentHand('E')}
      </div>


      <div className="table-center">
        {/* Whose turn is it? */}
        {turnBanner && <div className="turn-banner">{turnBanner}</div>}

        {/* Render current trick here */}
        {currentTrick.map((play, index) => (
          <div key={index} className={`played-card ${play.player}`} style={{ zIndex: index }}>
            <Card suit={play.card.suit} rank={play.card.rank} simplified={true} />
          </div>
        ))}

        {/* North's hand as real cards when the human needs to play or see it */}
        {northShownInCenter && (
           <div className={`dummy-hand-container ${getActiveClass('N')}`}>
            {hands['N'].map((c, i) => (
              <div key={i} className={`dummy-card-wrapper ${isHintCard('N', i) ? 'hint-highlight' : ''} ${selectedCard?.player === 'N' && selectedCard?.index === i ? 'selected' : ''}`} onClick={() => handleCardClick('N', i)}>
                <Card suit={c.suit} rank={c.rank} simplified={selectedCard?.player === 'N' && selectedCard?.index === i} />
              </div>
            ))}
           </div>
        )}
      </div>

      {/* Player Hand */}
      <div className="player-hand-container">
        {playerHand.map((c, i) => {
          const total = playerHand.length;
          const middle = (total - 1) / 2;
          const offset = i - middle;
          const rotation = offset * 3;
          const yOffset = Math.abs(offset) * 2;

          return (
            <div key={i} className={`playable-card-wrapper ${isHintCard('S', i) ? 'hint-highlight' : ''} ${selectedCard?.player === 'S' && selectedCard?.index === i ? 'selected' : ''}`} style={{
              marginLeft: i === 0 ? 0 : 'clamp(-40px, -5vw, -15px)',
              transform: `rotate(${rotation}deg) translateY(${yOffset}px)`,
              transformOrigin: 'bottom center',
              zIndex: selectedCard?.player === 'S' && selectedCard?.index === i ? 50 : i,
              transition: 'transform 0.2s, box-shadow 0.2s',
              cursor: currentTurn === 'S' && isPlaying && humanControls('S') ? 'pointer' : 'default',
              borderRadius: '12px'
            }} onClick={() => handleCardClick('S', i)}>
              <Card suit={c.suit} rank={c.rank} simplified={selectedCard?.player === 'S' && selectedCard?.index === i} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
