import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import TargetTable from '../components/TargetTable'

// A target set on paper, for the poolside clipboard.
export default function TargetSetPrint() {
  const { id } = useParams()
  const [table, setTable] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getTargetSetTable(id).then(setTable).catch(e => setError(e.message))
  }, [id])

  useEffect(() => {
    if (table) document.title = `${table.set.name} — target times`
  }, [table])

  if (error) return <div className="fixed inset-0 bg-white text-red-700 p-8">Could not load the target times: {error}</div>
  if (!table) return <div className="fixed inset-0 bg-white text-gray-500 p-8">Preparing the sheet…</div>

  const printed = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  return (
    <div className="target-print min-h-screen bg-white text-gray-900 p-6 print:p-0">
      <div className="no-print flex items-center gap-3 mb-4">
        <Link to="/swimmers?view=targets" className="text-sm text-blue-700">‹ Back</Link>
        <button onClick={() => window.print()} className="ml-auto rounded-lg bg-blue-700 text-white px-4 py-2 text-sm font-semibold">Print</button>
      </div>
      <header className="mb-3">
        <h1 className="text-lg font-bold">{table.set.name}</h1>
        <p className="text-xs text-gray-600">{table.set.summary} · {table.squad || 'All squads'} · PBs as of {printed}</p>
      </header>
      <div className="columns-1 md:columns-2 print:columns-2 gap-6">
        {table.swimmers.map(s => (
          <div key={s.id} className="break-inside-avoid mb-2">
            <TargetTable columns={table.columns} swimmers={[s]} light linkNames={false} />
          </div>
        ))}
      </div>
    </div>
  )
}
