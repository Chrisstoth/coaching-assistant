/* The Session Builder's page skeleton (from the artifact), without its library
   drawer, backup files and Excel buttons; "Copy to next week" sits in the bar. */
const ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5"/></svg>'
const ICON_PDF = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 1.8h5.5L13 5.3v8.9H4z"/><path d="M9.5 1.8v3.5H13"/></svg>'
const ICON_NEXT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 8h10M9 4.5 12.5 8 9 11.5"/></svg>'
const ICON_PLUS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3v10M3 8h10"/></svg>'
const ICON_NOTES = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 2.5h7l3 3v8H3z"/><path d="M5.5 8h5M5.5 10.8h3.5"/></svg>'

const SCALE_OPTIONS = '<option value="effort20">Effort /20</option><option value="rpe">RPE 0–10 (Borg CR10)</option><option value="bpsc">BPSC HR colours</option><option value="urbanchek">Urbanchek colours</option><option value="sweetenham">Sweetenham (British Swimming)</option><option value="maglischo">Maglischo energy systems</option>'

export const BUILDER_TEMPLATE = `
<header class="bar">
  <div class="bar-in wrap gut">
    <div class="brand"><span class="bname" id="brandName">Session Builder</span></div>
    <div class="bar-title" id="barTitle"></div>
    <span class="status" id="status" data-s="idle"><i></i><span id="statusText">Opening…</span></span>
    <nav class="bar-actions" aria-label="Session actions">
      <div class="seg" role="group" aria-label="View">
        <button type="button" data-act="view" data-v="edit" aria-pressed="true" id="vEdit">Plan</button>
        <button type="button" data-act="view" data-v="pool" aria-pressed="false" id="vPool">Poolside</button>
      </div>
      <button class="bbtn" type="button" data-act="copy" id="copyBtn">${ICON_COPY}Copy text</button>
      <button class="bbtn" type="button" data-act="pdf" id="pdfBtn">${ICON_PDF}PDF</button>
      <button class="bbtn" type="button" data-act="copy-week" id="nextWeekBtn" title="Copy this session to the same slot next week">${ICON_NEXT}Next week</button>
    </nav>
  </div>
</header>

<main class="wrap gut" id="main">
  <div class="panel loading" id="loading"><b>Opening the session</b>It will appear here in a moment.</div>
  <div id="editor" hidden>
    <div style="display:grid;gap:18px">
      <section class="panel meta" aria-label="Session details">
        <input class="title-input" id="m-title" data-meta="title" aria-label="Session title" autocomplete="off">
        <div class="groups-edit"><span class="glabel">Groups</span><div class="gchips" id="groupsEdit"></div></div>
        <div class="meta-grid">
          <label>Date<input class="field" type="date" id="m-date" data-meta="date"></label>
          <label>Session<select class="field" id="m-slot" data-meta="slot"><option>AM</option><option>PM</option></select></label>
          <label>Start<input class="field" type="time" id="m-start" data-meta="start"></label>
          <label>End<input class="field" type="time" id="m-end" data-meta="end"></label>
          <label class="wide">Pool &amp; lanes<input class="field" id="m-venue" data-meta="venue" placeholder="e.g. BSV shallow end, lanes 1–3"></label>
          <label>Coach<input class="field" id="m-coach" data-meta="coach"></label>
          <label>Week key<input class="field" id="m-week" data-meta="weekKey" placeholder="e.g. 1.2.1"></label>
          <label class="wide">Aim 1<input class="field" id="m-aim0" data-meta="aim0"></label>
          <label class="wide">Aim 2<input class="field" id="m-aim1" data-meta="aim1"></label>
          <label class="wide">Intensity scale for this session<select class="field" id="m-effsys" data-meta="effSys">${SCALE_OPTIONS}</select></label>
        </div>
      </section>
      <nav class="gtabs" id="gtabs" aria-label="Groups" hidden></nav>
      <section class="summary" id="summary" aria-label="Session totals"></section>
      <details class="tipsbox"><summary>Tips for writing sets</summary><div class="tips" id="tips">
        <span><b>Rounds:</b> swipe down the dots beside your sets (or tap them, Shift-click for a run), then press a number or tap 2×, 3×, 4×. Hold the dots to drag.</span>
        <span><b>Numbered lines:</b> press <kbd>Shift</kbd>+<kbd>Enter</kbd> on a set to add 1), 2), 3)… under it, or type <span class="mono">4x100 1) Kick 2) Drill</span>.</span>
        <span><b>Notes:</b> <b>Add notes</b> at the bottom, or from a block’s ⋯ menu, then drag the dots to move them. A line with only words, like <span class="mono">Fins on</span>, prints as a note too.</span>
        <span><b>Talk before a set:</b> <span class="mono">Talk 3 min purpose, then a word with Sam</span> adds the time you spend explaining a set, so the session time and finish stay right. Or use <b>Talk before this set</b> in a set’s ⋯ menu. Put one inside a round for feedback between rounds.</span>
        <span><b>Rest instead of a send-off:</b> <span class="mono">4x100 r20 ~1:20</span> is 20s rest with about 1:20 to swim each, so the session time stays right. <span class="mono">20s rest</span> and <span class="mono">rest 30</span> work too.</span>
        <span id="tipDictate"><b>Speak sets:</b> tap an add box and use the mic on your keyboard (on a PC, Windows key + H; on a Mac, press Fn twice). Say it how you’d say it: “4 by 50 on 1 10”, “20 seconds rest, about 1 20 each”, “line 2 build on 4 45”.</span>
        <span id="tipSpeech" hidden><b>Speak sets:</b> tap the mic in an add box and talk, one set at a time: “4 by 50 on 1 10”, “line 2 build on 4 45”, “3 rounds”, “end round”, “undo”, “stop”.</span>
        <span><b>Alternating:</b> <span class="mono">4 x 50 alt max dive start (1:10) and max finish (1:50)</span> alternates the two, each on its own turnaround.</span>
        <span><b>Different turnaround per line:</b> give a numbered line its own, like <span class="mono">2) Build @4:45</span> or <span class="mono">3) Fast r30</span>. Lines without one, and reps with no line, go on line 1’s.</span>
        <span><b>Two lanes:</b> <span class="mono">4x100 off 1:30/1:40</span> gives the second lane its own send-off and session time.</span>
        <span><b>Fast entry:</b> <span class="mono">2 x (4 x 50 off 60, 2 x 100)</span> in an add box makes a 2× round of both. <span class="mono">3x</span> on its own starts an empty round you then fill.</span>
        <span class="keys"><kbd>Enter</kbd> next empty cell, then a new set · <kbd>Shift</kbd>+<kbd>Enter</kbd> numbered line · <kbd>Ctrl</kbd>+<kbd>]</kbd> / <kbd>[</kbd> in or out of a round · <kbd>Alt</kbd>+<kbd>↑↓</kbd> move</span>
      </div></details>
      <details class="scales"><summary>How the intensity scales line up</summary><div class="chart" id="scaleChart"></div>
        <p>Every value is stored on one common scale, so switching scale only changes the labels. The line-up is approximate because the systems are defined by different markers (heart rate, lactate, pace). It follows Sweetenham’s and the BPSC HR colours’ heart-rate bands and how Effort /20 is used alongside them. Editing a set in a coarser scale snaps it to the middle of that zone.</p></details>
      <div id="blocks"></div>
      <div class="addrow"><button class="btn addblock" type="button" data-act="add-block">${ICON_PLUS}Add block</button><button class="btn" type="button" data-act="add-notes">${ICON_NOTES}Add notes</button></div>
    </div>
  </div>
  <div id="pool" class="pool" hidden></div>
</main>

<datalist id="groupList"></datalist>
<div class="pop" id="pop" role="menu" hidden></div>
<div class="dock"><div class="selbar" id="selbar" hidden></div><div class="toast" id="toast" role="status" hidden></div></div>
<div class="modal" id="textModal" hidden>
  <div class="modal-card" role="dialog" aria-label="Session as text">
    <h3>Session as text</h3>
    <textarea id="textOut" readonly></textarea>
    <div class="row"><button class="btn" type="button" data-act="close-modal">Close</button></div>
  </div>
</div>
`
