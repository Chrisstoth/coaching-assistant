export default function RegisterSavedOverlay({ queued = false, complete = true, operation = null, sessionId = null, onClose, onHome, onDebrief }) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-pool-950/70 px-6 backdrop-blur-sm"
      role="status"
      aria-live="assertive"
    >
      <div className="w-full max-w-xs rounded-2xl border border-green-700/60 bg-pool-800 px-6 py-7 text-center shadow-2xl">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-600 text-white">
          <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="m5 12 4 4L19 6" />
          </svg>
        </div>
        <p className="mt-4 text-xl font-bold text-pool-100">Saved</p>
        <p className="mt-1 text-sm text-pool-400">
          {queued
            ? 'Saved on this device and ready to sync.'
            : complete ? 'The register is synced. Its AI assessment is now separate.' : 'Attendance is synced. AI preparation is now separate.'}
        </p>
        {operation && (
          <p className="mt-3 rounded-lg bg-pool-900/60 px-3 py-2 text-xs text-teal-300">
            AI operation #{operation.id} queued · track it in Settings
          </p>
        )}
        {queued ? (
          <div className="mt-4 flex gap-2">
            <button onClick={onClose} className="flex-1 rounded-lg bg-pool-700 py-2 text-xs font-semibold text-pool-200">Keep editing</button>
            <button onClick={onHome} className="flex-1 rounded-lg bg-accent-600 py-2 text-xs font-semibold text-white">Go to Today</button>
          </div>
        ) : complete && sessionId ? (
          <div className="mt-4 space-y-2">
            <button onClick={onDebrief} className="w-full rounded-lg bg-teal-600 py-2.5 text-xs font-semibold text-white">
              🎤 Debrief this session
            </button>
            <button onClick={onHome} className="w-full rounded-lg bg-pool-700 py-2 text-xs font-semibold text-pool-200">
              Not now
            </button>
          </div>
        ) : (
          <p className="mt-3 text-xs text-pool-500">Returning to Today…</p>
        )}
      </div>
    </div>
  )
}
