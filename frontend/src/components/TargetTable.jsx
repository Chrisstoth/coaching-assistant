import { Link } from 'react-router-dom'

// One target set's times: a row per event, grouped under each swimmer.
// `light` is the printed sheet; `single` hides the swimmer rows (their own page).
export default function TargetTable({ columns = [], swimmers = [], light = false, single = false, linkNames = true }) {
  const c = light
    ? { head: 'text-gray-500 border-gray-300', name: 'text-gray-900 bg-gray-100', cell: 'text-gray-900 border-gray-200', muted: 'text-gray-500', time: 'text-gray-900', first: 'text-gray-900' }
    : { head: 'text-pool-500 border-pool-700', name: 'text-pool-100 bg-pool-750', cell: 'text-pool-200 border-pool-700/60', muted: 'text-pool-500', time: 'text-pool-100', first: 'text-accent-300' }

  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-sm border-collapse tabular-nums">
        <thead>
          <tr className={`border-b text-[11px] uppercase tracking-wide ${c.head}`}>
            <th className="text-left font-medium py-1.5 px-1">Event</th>
            <th className="text-right font-medium py-1.5 px-1">PB</th>
            {columns.map(col => (
              <th key={col.offset} className="text-right font-medium py-1.5 px-1.5 whitespace-nowrap">{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {swimmers.map(s => [
            !single && (
              <tr key={`n${s.id}`} className="break-inside-avoid">
                <td colSpan={columns.length + 2} className={`px-2 py-1 text-xs font-semibold ${c.name}`}>
                  {linkNames ? <Link to={`/swimmers/${s.id}`}>{s.name}</Link> : s.name}
                </td>
              </tr>
            ),
            s.note && (
              <tr key={`x${s.id}`}>
                <td colSpan={columns.length + 2} className={`px-1 py-1.5 text-xs italic ${c.muted}`}>{s.note}</td>
              </tr>
            ),
            ...s.rows.map(row => (
              <tr key={`${s.id}-${row.event}`} className={`border-b ${c.cell}`}>
                <td className="py-1.5 px-1 whitespace-nowrap">{row.short_event}</td>
                {row.pb ? (<>
                  <td className={`py-1.5 px-1 text-right text-xs ${c.muted}`} title={[row.pb.meet, row.pb.date].filter(Boolean).join(' · ')}>{row.pb.display}</td>
                  {row.times.map(t => (
                    <td key={t.offset} className={`py-1.5 px-1.5 text-right font-semibold ${t.offset === 0 ? c.first : c.time}`}>{t.display}</td>
                  ))}
                </>) : (
                  <td colSpan={columns.length + 1} className={`py-1.5 px-1 text-right text-xs ${c.muted}`}>{row.missing}</td>
                )}
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </div>
  )
}
