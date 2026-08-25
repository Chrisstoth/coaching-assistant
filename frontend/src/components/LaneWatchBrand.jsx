export function LaneWatchMark({ className = '', tone = 'light', label = 'LaneWatch' }) {
  const source = tone === 'ink' ? '/lanewatch-mark-ink.png' : '/lanewatch-mark.png'

  return (
    <img
      src={source}
      alt={label}
      className={`lanewatch-mark ${className}`}
      draggable="false"
    />
  )
}

export function LaneWatchWordmark({ className = '', tone = 'light', markClassName = '' }) {
  return (
    <span className={`lanewatch-wordmark lanewatch-wordmark--${tone} ${className}`}>
      <LaneWatchMark
        className={markClassName}
        tone={tone === 'ink' ? 'ink' : 'light'}
        label=""
      />
      <span className="lanewatch-name">LANEWATCH</span>
      <span className="lanewatch-ai-badge">AI</span>
    </span>
  )
}

export function LaneWatchLockup({ className = '', compact = false }) {
  return (
    <div className={`lanewatch-lockup ${compact ? 'lanewatch-lockup--compact' : ''} ${className}`}>
      <LaneWatchMark className="lanewatch-lockup-mark" label="LaneWatch AI" />
      <div className="lanewatch-lockup-name">
        <span className="lanewatch-name">LANEWATCH</span>
        <span className="lanewatch-ai-badge">AI</span>
      </div>
      {!compact && <span className="lanewatch-descriptor">POOL-SIDE COACHING SYSTEM</span>}
    </div>
  )
}

export function LaneWatchAIButton({ active = false }) {
  return (
    <span className={`lanewatch-ai-button ${active ? 'is-active' : ''}`} aria-hidden="true">
      <span className="lanewatch-ai-button-glow" />
      <LaneWatchMark className="lanewatch-ai-button-mark" label="" />
      <span className="lanewatch-ai-button-badge">AI</span>
    </span>
  )
}
