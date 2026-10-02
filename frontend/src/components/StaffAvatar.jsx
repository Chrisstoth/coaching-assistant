import { staffStyle } from '../staffRoom'

// A small portrait for each member of the staff, so the coach knows who is
// speaking at a glance. Each sits on the specialist's own colour and has one
// thing that is theirs: the physiologist's stethoscope, the analyst's glasses,
// the planner's beard, the meet manager's cap, the session writer's whistle.
// Anyone without a portrait (the coach, a decision) gets their initials.

const SKIN = {
  light: '#f6d2b0',
  fair: '#eab98f',
  tan: '#c98e5f',
  brown: '#9a6440',
  deep: '#6b4329',
}

const INK = '#1f2937'

function Face({ skin, shirt }) {
  return (
    <>
      <path d="M12 64 C12 50 21 44 32 44 C43 44 52 50 52 64 Z" fill={shirt} />
      <rect x="28" y="36" width="8" height="10" rx="3" fill={skin} />
      <circle cx="32" cy="28" r="12" fill={skin} />
      <circle cx="27.5" cy="28.5" r="1.4" fill={INK} />
      <circle cx="36.5" cy="28.5" r="1.4" fill={INK} />
      <path d="M28 33 Q32 36.2 36 33" stroke={INK} strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </>
  )
}

const PORTRAITS = {
  // Long dark hair, stethoscope.
  physiologist: () => (
    <>
      <path d="M19 31 C16 13 48 13 45 31 L47 46 L40 46 L42 27 C39 20 25 20 22 27 L24 46 L17 46 Z" fill="#2b1d16" />
      <Face skin={SKIN.tan} shirt="#e5e7eb" />
      <path d="M20 27 C21 16 43 16 44 27 C40 21 34 19 30 20 C26 21 23 23 20 27 Z" fill="#2b1d16" />
      <path d="M25 45 C24 53 32 55 33 50" stroke="#475569" strokeWidth="1.8" fill="none" />
      <path d="M39 45 C40 50 37 53 34 52" stroke="#475569" strokeWidth="1.8" fill="none" />
      <circle cx="33.5" cy="51.5" r="2.4" fill="#94a3b8" stroke="#475569" strokeWidth="1" />
    </>
  ),
  // Short crop, round glasses.
  analyst: () => (
    <>
      <Face skin={SKIN.light} shirt="#1e3a8a" />
      <path d="M20 27 C19 14 45 14 44 27 C43 21 38 18 32 18 C26 18 21 21 20 27 Z" fill="#7c4a1e" />
      <circle cx="27.5" cy="28.5" r="3.6" fill="none" stroke={INK} strokeWidth="1.3" />
      <circle cx="36.5" cy="28.5" r="3.6" fill="none" stroke={INK} strokeWidth="1.3" />
      <path d="M31.1 28.5 L32.9 28.5" stroke={INK} strokeWidth="1.3" />
    </>
  ),
  // Grey hair, beard.
  planner: () => (
    <>
      <Face skin={SKIN.fair} shirt="#7c2d12" />
      <path d="M20 28 C19 15 45 15 44 28 C42 22 37 19.5 32 19.5 C27 19.5 22 22 20 28 Z" fill="#9ca3af" />
      <path d="M21 29 C22 41 27 44 32 44 C37 44 42 41 43 29 C41 33 39 35 36 35.5 Q32 37.5 28 35.5 C25 35 23 33 21 29 Z" fill="#9ca3af" />
      <path d="M29 34 Q32 35.5 35 34" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </>
  ),
  // Curly hair.
  manager: () => (
    <>
      <Face skin={SKIN.deep} shirt="#9d174d" />
      {[[22, 22], [26, 17.5], [32, 16], [38, 17.5], [42, 22], [20.5, 28], [43.5, 28]].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="5" fill="#1c1917" />
      ))}
    </>
  ),
  // Cap.
  meets: () => (
    <>
      <Face skin={SKIN.light} shirt="#3f6212" />
      <path d="M20 26 C20 14 44 14 44 26 Z" fill="#1a2e05" />
      <path d="M40 25 L51 26.5 C51 28 49 28.5 47 28.5 L40 28 Z" fill="#1a2e05" />
      <circle cx="32" cy="15.5" r="1.4" fill="#a3e635" />
    </>
  ),
  // Ponytail, whistle on a lanyard.
  sessions: () => (
    <>
      <path d="M43 22 C52 24 52 38 46 42 C47 34 45 28 41 25 Z" fill="#b45309" />
      <Face skin={SKIN.fair} shirt="#581c87" />
      <path d="M20 27 C19 14 45 14 44 27 C41 20 36 18.5 32 18.5 C27 18.5 22 21 20 27 Z" fill="#b45309" />
      <path d="M26 45 L32 54 L38 45" stroke="#f59e0b" strokeWidth="1.5" fill="none" />
      <rect x="29.5" y="53" width="6" height="3.6" rx="1.6" fill="#cbd5e1" stroke="#475569" strokeWidth="0.8" />
    </>
  ),
  // Neat side parting, collar.
  interviewer: () => (
    <>
      <Face skin={SKIN.brown} shirt="#334155" />
      <path d="M26 44 L32 50 L38 44" fill="#f8fafc" />
      <path d="M20 28 C18 15 44 13 44 26 C38 23 33 19 27 21 C24 22 21 24 20 28 Z" fill="#111827" />
    </>
  ),
}

export default function StaffAvatar({ role, size = 24, style: given, className = '' }) {
  const style = given || staffStyle(role)
  const Portrait = PORTRAITS[role]
  if (!Portrait) {
    return (
      <span
        className={`inline-flex items-center justify-center rounded-full font-bold text-white shrink-0 ${className}`}
        style={{ backgroundColor: style.colour, width: size, height: size, fontSize: Math.max(9, size * 0.38) }}
        title={style.title}
        aria-hidden="true"
      >
        {style.initials}
      </span>
    )
  }
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={`rounded-full shrink-0 ${className}`}
      role="img"
      aria-label={style.title}
    >
      <title>{style.title}</title>
      <clipPath id={`avatar-clip-${role}`}>
        <circle cx="32" cy="32" r="32" />
      </clipPath>
      <g clipPath={`url(#avatar-clip-${role})`}>
        <circle cx="32" cy="32" r="32" fill={style.colour} />
        <Portrait />
      </g>
    </svg>
  )
}
