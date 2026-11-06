import { Link } from 'react-router-dom'

// A small "?" that opens the matching part of "How the app works".
export default function HelpLink({ topic, label = 'How this works', className = '' }) {
  return (
    <Link to={`/help#${topic}`} aria-label={label} title={label}
      className={`inline-grid place-items-center w-6 h-6 rounded-full border border-pool-600 text-pool-400 text-xs font-semibold hover:text-accent-300 hover:border-accent-500 shrink-0 ${className}`}>
      ?
    </Link>
  )
}
