import React from 'react';
import './BiddingBox.css';

const SUITS = ['C', 'D', 'H', 'S', 'NT'];
const SUIT_SYMBOLS = { C: '♣', D: '♦', H: '♥', S: '♠', NT: 'NT' };

export default function BiddingBox({ onBid, currentHighestBid, activeHint, canDouble = false, canRedouble = false }) {
  
  const handleBidClick = (level, suit) => {
    onBid({ type: 'bid', level, suit });
  };

  const handlePass = () => onBid({ type: 'pass' });
  const handleDouble = () => onBid({ type: 'double' });
  const handleRedouble = () => onBid({ type: 'redouble' });

  // Determine if a bid is valid (must be higher than current highest)
  const isBidValid = (level, suit) => {
    if (!currentHighestBid) return true;
    if (level > currentHighestBid.level) return true;
    if (level === currentHighestBid.level) {
      return SUITS.indexOf(suit) > SUITS.indexOf(currentHighestBid.suit);
    }
    return false;
  };

  const isHintBid = (level, suit) => {
    return activeHint && activeHint.type === 'bid' && activeHint.value.type === 'bid' && activeHint.value.level === level && activeHint.value.suit === suit;
  };

  const isHintPass = () => activeHint && activeHint.type === 'bid' && activeHint.value.type === 'pass';

  return (
    <div className="bidding-box">
      <div className="bidding-header">CHOOSE YOUR BID</div>

      {/* PASS first — it's the most common action */}
      <div className="special-bids">
        <button className={`bid-btn btn-pass ${isHintPass() ? 'hint-highlight' : ''}`} onClick={handlePass}>PASS</button>
        <button className="bid-btn btn-double" onClick={handleDouble} disabled={!canDouble}>DOUBLE</button>
        <button className="bid-btn btn-redouble" onClick={handleRedouble} disabled={!canRedouble}>REDOUBLE</button>
      </div>

      <div className="bids-grid">
        {[1, 2, 3, 4, 5, 6, 7].map(level => (
          <React.Fragment key={level}>
            {SUITS.map(suit => {
              const valid = isBidValid(level, suit);
              const hintClass = isHintBid(level, suit) ? 'hint-highlight' : '';
              return (
                <button
                  key={`${level}${suit}`}
                  className={`bid-btn suit-${suit} ${!valid ? 'disabled' : ''} ${hintClass}`}
                  onClick={() => valid && handleBidClick(level, suit)}
                  disabled={!valid}
                >
                  {level} {SUIT_SYMBOLS[suit]}
                </button>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
