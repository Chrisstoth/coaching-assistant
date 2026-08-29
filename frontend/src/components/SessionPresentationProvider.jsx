import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { DEFAULT_PRESENTATION, energyPresentation, normalisePresentation } from '../sessionPresentation'


const SessionPresentationContext = createContext({
  settings: DEFAULT_PRESENTATION,
  energy: zone => energyPresentation(zone, DEFAULT_PRESENTATION),
  ready: false,
  refresh: () => Promise.resolve(DEFAULT_PRESENTATION),
})

export function SessionPresentationProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_PRESENTATION)
  const [ready, setReady] = useState(false)

  const refresh = async () => {
    try {
      const value = normalisePresentation(await api.getSessionPresentation())
      setSettings(value)
      return value
    } finally {
      setReady(true)
    }
  }

  useEffect(() => {
    refresh().catch(() => {})
  }, [])

  const value = useMemo(() => ({
    settings,
    ready,
    refresh,
    energy: zone => energyPresentation(zone, settings),
  }), [settings, ready])

  return <SessionPresentationContext.Provider value={value}>{children}</SessionPresentationContext.Provider>
}

export function useSessionPresentation() {
  return useContext(SessionPresentationContext)
}
