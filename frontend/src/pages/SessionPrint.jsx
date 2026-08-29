import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api'
import { buildSessionPrintHtml, DEFAULT_PRESENTATION } from '../sessionPresentation'


export default function SessionPrint() {
  const { id } = useParams()
  const [session, setSession] = useState(null)
  const [settings, setSettings] = useState(DEFAULT_PRESENTATION)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([api.getSession(id), api.getSessionPresentation().catch(() => DEFAULT_PRESENTATION)])
      .then(([sessionValue, settingsValue]) => {
        setSession(sessionValue)
        setSettings(settingsValue)
      })
      .catch(err => setError(err.message))
  }, [id])

  useEffect(() => {
    if (session) document.title = `${session.title || session.squad || 'Session'} — print`
  }, [session])

  const html = useMemo(() => session
    ? buildSessionPrintHtml({ session, settings, autoPrint: false })
    : '', [session, settings])

  if (error) return <div className="fixed inset-0 bg-white text-red-700 p-8">Could not load session sheet: {error}</div>
  if (!session) return <div className="fixed inset-0 bg-white text-gray-500 p-8">Preparing session sheet…</div>

  return <iframe title="Printable session sheet" srcDoc={html} className="fixed inset-0 w-screen h-screen border-0 bg-white z-50" />
}
