import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api'
import { buildPlanHtml } from '../swimmerPlan'

// The athlete plan as a clean page to print or save as a PDF.
export default function SwimmerPlanPrint() {
  const { planId } = useParams()
  const [plan, setPlan] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getSwimmerPlan(planId).then(setPlan).catch(err => setError(err.message))
  }, [planId])

  useEffect(() => {
    if (plan) document.title = plan.title
  }, [plan])

  const html = useMemo(() => (plan ? buildPlanHtml(plan) : ''), [plan])

  if (error) return <div className="fixed inset-0 bg-white text-red-700 p-8">Could not load the plan: {error}</div>
  if (!plan) return <div className="fixed inset-0 bg-white text-gray-500 p-8">Preparing the plan…</div>

  return <iframe title="Printable athlete plan" srcDoc={html} className="fixed inset-0 w-screen h-screen border-0 bg-white z-50" />
}
