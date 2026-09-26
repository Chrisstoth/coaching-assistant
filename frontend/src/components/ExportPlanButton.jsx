import { useState } from 'react'
import { downloadPlanExport } from '../api'

// Saves the whole plan - season calendar, macros, mesos and the weekly micro
// layout - as a spreadsheet to share with other coaches.
export default function ExportPlanButton({ macroId = null, squad = null, className = '' }) {
  const [busy, setBusy] = useState(false)

  const exportPlan = async () => {
    setBusy(true)
    try {
      await downloadPlanExport({ macro_id: macroId, squad })
    } catch (e) {
      alert('Could not export the plan: ' + e.message)
    }
    setBusy(false)
  }

  return (
    <button onClick={exportPlan} disabled={busy} title="Download the plan as a spreadsheet"
      className={`bg-pool-700 border border-pool-600 rounded-lg px-2.5 py-1 text-xs font-semibold text-pool-200 disabled:opacity-40 shrink-0 ${className}`}>
      {busy ? 'Exporting…' : 'Export'}
    </button>
  )
}
