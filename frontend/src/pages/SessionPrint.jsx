import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api'
import { LaneWatchWordmark } from '../components/LaneWatchBrand'

export default function SessionPrint() {
  const { id } = useParams()
  const [session, setSession] = useState(null)

  useEffect(() => {
    api.getSession(id).then(setSession)
  }, [id])

  useEffect(() => {
    if (session) {
      document.title = `${session.squad || 'Session'} - ${session.date}`
    }
  }, [session])

  if (!session) return <div className="p-8 text-gray-500">Loading...</div>

  const squadLabel = session.squad || 'Session'
  const dateLabel = new Date(session.date + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  return (
    <div className="print-page bg-white text-black min-h-screen p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between border-b-2 border-black pb-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold">BPSC Session Plan: {squadLabel}</h1>
          <p className="text-base mt-1">{dateLabel}</p>
          {session.energy_system_focus && (
            <p className="text-sm text-gray-600 mt-0.5">Energy focus: {session.energy_system_focus}</p>
          )}
        </div>
        <LaneWatchWordmark tone="ink" className="scale-125 origin-right" />
      </div>

      {/* Coach intent */}
      {session.coach_intent && (
        <div className="mb-6 bg-gray-50 border border-gray-200 rounded p-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Session intent</p>
          <p className="text-sm">{session.coach_intent}</p>
        </div>
      )}

      {/* Groups */}
      {(session.groups || []).sort((a, b) => a.group_number - b.group_number).map(group => (
        <div key={group.id ?? group.group_number} className="mb-8">
          <h2 className="text-lg font-bold border-b border-black pb-1 mb-3">
            Group {group.group_number}
            {group.description && (
              <span className="text-sm font-normal text-gray-600 ml-2">— {group.description}</span>
            )}
          </h2>

          {/* Sub-groups */}
          {(group.sub_groups || []).length > 0 ? (
            <div className="space-y-4">
              {group.sub_groups.map(sg => (
                <div key={sg.id} className="pl-4 border-l-2 border-gray-300">
                  <div className="flex items-baseline gap-3 mb-1">
                    <span className="font-semibold text-sm">Sub-group {sg.label}</span>
                    {sg.aim && <span className="text-sm text-gray-600 italic">{sg.aim}</span>}
                  </div>
                  {(sg.sets || []).map((set, i) => (
                    <p key={i} className="text-sm ml-2">• {set}</p>
                  ))}
                  {sg.volume_breakdown && Object.values(sg.volume_breakdown).some(v => v > 0) && (
                    <div className="mt-1 flex flex-wrap gap-2">
                      {Object.entries(sg.volume_breakdown)
                        .filter(([, v]) => v > 0)
                        .map(([k, v]) => (
                          <span key={k} className="text-xs bg-gray-100 rounded px-1.5 py-0.5">
                            {k.replace(/_/g, ' ')}: {v}m
                          </span>
                        ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            /* Fallback: no sub-groups, show sets directly */
            <div className="pl-4">
              {(Array.isArray(group.sets)
                ? group.sets
                : group.sets?.raw
                  ? group.sets.raw.split('\n').filter(Boolean)
                  : []
              ).map((set, i) => (
                <p key={i} className="text-sm">• {set}</p>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Notes section for handwriting */}
      <div className="mt-8 border-t border-gray-300 pt-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Notes</p>
        <div className="border border-gray-200 rounded h-24" />
      </div>

      {/* Print button — hidden when printing */}
      <div className="mt-6 no-print">
        <button
          onClick={() => window.print()}
          className="bg-black text-white px-6 py-2.5 rounded-lg font-semibold text-sm"
        >
          Print / Save as PDF
        </button>
        <button
          onClick={() => window.history.back()}
          className="ml-3 text-gray-500 text-sm"
        >
          Back
        </button>
      </div>
    </div>
  )
}
