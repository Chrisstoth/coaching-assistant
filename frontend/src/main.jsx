import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

function Root() {
  const [splash, setSplash] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setSplash(false), 1500)
    return () => clearTimeout(t)
  }, [])

  if (splash) {
    return (
      <div className="fixed inset-0 bg-pool-900 flex items-center justify-center">
        <div className="w-72 h-72 rounded-[32px] overflow-hidden">
          <img src="/Loadimage.png" alt="Deckxtra" className="w-full h-full object-cover" />
        </div>
      </div>
    )
  }

  return (
    <BrowserRouter>
      <App />
    </BrowserRouter>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
