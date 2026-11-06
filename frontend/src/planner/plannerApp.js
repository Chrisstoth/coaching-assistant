/* The coach's Season Planner, running inside the app.

   This is the Silver 1 Season Planner artifact's own script, unchanged, wrapped
   in mountPlanner() so a React page can mount and unmount it. Where the
   artifact used claude.ai's storage (window.claude: db, downloads, user), it
   now gets a stand-in backed by the app's API (opts.store), so every behaviour
   is exactly the planner's. Listeners stay inside the planner and are removed
   on unmount. backend/services/season_planner.py is the Python twin of its
   week logic.
*/
const PLANNER_TEMPLATE = "<div class=\"app\" id=\"app\">\n  <header class=\"top\">\n    <div class=\"top-row\">\n      <span class=\"mark\">BPSC</span>\n      <div class=\"title\"><h1>Silver 1 Season Planner</h1><p id=\"subtitle\">2026–27 · three macros · branches by swimmer group</p></div>\n      <div class=\"spacer\"></div>\n      <span class=\"status\" id=\"status\" data-s=\"idle\">Loading…</span>\n      <button class=\"btn ghost sm\" data-cmd=\"undo\" id=\"undoBtn\" title=\"Undo (Ctrl+Z)\">Undo</button>\n      <button class=\"btn ghost sm\" data-cmd=\"redo\" id=\"redoBtn\" title=\"Redo (Ctrl+Shift+Z)\">Redo</button>\n      <button class=\"btn sm\" data-cmd=\"versions\" id=\"versBtn\">Versions</button>\n    </div>\n    <nav class=\"tabs\" role=\"tablist\">\n      <button class=\"tab\" role=\"tab\" data-cmd=\"view\" data-v=\"season\" aria-selected=\"true\">Season</button>\n      <button class=\"tab\" role=\"tab\" data-cmd=\"view\" data-v=\"squad\" aria-selected=\"false\">Squad</button>\n      <button class=\"tab\" role=\"tab\" data-cmd=\"view\" data-v=\"calendar\" aria-selected=\"false\">Calendar</button>\n      <button class=\"tab\" role=\"tab\" data-cmd=\"view\" data-v=\"sessions\" aria-selected=\"false\">Sessions</button>\n    </nav>\n  </header>\n  <section id=\"versPanel\" class=\"card vers\" hidden style=\"margin-top:12px\"></section>\n  <main id=\"main\">\n    <section class=\"view\" id=\"v-season\">\n      <div class=\"toolbar\">\n        <div class=\"focusbar\">\n          <label class=\"label\" for=\"focusSel\">Swimmer</label>\n          <select class=\"inp\" id=\"focusSel\"><option value=\"\">All groups (no swimmer)</option></select>\n        </div>\n        <div class=\"grow\"></div>\n        <div class=\"legend\" id=\"legendTop\"></div>\n      </div>\n      <div id=\"focusBanner\"></div>\n      <div id=\"qstrip\"></div>\n      <div class=\"summary\" id=\"summary\"><div class=\"card bcard\" style=\"--b:var(--line)\"><div class=\"bc-head\"><b>Loading the season plan…</b></div><div class=\"bc-diff\">Branches, macros and loads appear here once the saved plan arrives.</div></div></div>\n      <div class=\"card overview\">\n        <div class=\"ov-head\"><span class=\"label\">Weekly load · whole season</span><div class=\"legend\" id=\"ovLegend\"></div></div>\n        <svg id=\"ov\" viewBox=\"0 0 1000 100\" preserveAspectRatio=\"none\" role=\"img\" aria-label=\"Weekly load per branch across the season\"></svg>\n      </div>\n      <div class=\"toolbar\">\n        <span class=\"label\">Timeline</span>\n        <span class=\"small muted\" id=\"hint\">Drag a block edge to move a boundary · drag a bar's top edge to set load · double-click a week to open it</span>\n        <div class=\"grow\"></div>\n        <button class=\"btn sm\" data-cmd=\"newgroup\">+ New group</button>\n        <button class=\"btn sm\" data-cmd=\"compall\" id=\"compAllBtn\">▸ Load detail for all</button>\n        <button class=\"btn sm\" data-cmd=\"today\">Today</button>\n        <button class=\"btn sm\" data-cmd=\"zoom\" data-d=\"-6\" aria-label=\"Zoom out\">−</button>\n        <button class=\"btn sm\" data-cmd=\"zoom\" data-d=\"6\" aria-label=\"Zoom in\">+</button>\n      </div>\n      <div class=\"card timeline\" id=\"timeline\">\n        <div class=\"tl-labels\" id=\"tlLabels\"></div>\n        <div class=\"tl-scroll\" id=\"tlScroll\"><svg id=\"tl\" xmlns=\"http://www.w3.org/2000/svg\"></svg></div>\n      </div>\n      <div class=\"card detail\" id=\"detail\"></div>\n    </section>\n    <section class=\"view\" id=\"v-squad\" hidden></section>\n    <section class=\"view\" id=\"v-calendar\" hidden></section>\n    <section class=\"view\" id=\"v-sessions\" hidden></section>\n  </main>\n</div>\n<div id=\"tip\" hidden></div>\n<div class=\"overlay\" id=\"sheetOverlay\" hidden></div>\n\n"

export function mountPlanner(root, opts){
  /* ---- the planner's page and its storage, provided by the app ---- */
  const INSIDE_ONLY = new Set(['click', 'dblclick', 'input', 'change', 'keydown', 'focusout'])
  const listeners = []
  const store = opts.store
  const anchorSave = ({ filename, data }) => {
    const blob = data instanceof Blob ? data : new Blob([data])
    const url = URL.createObjectURL(blob), a = globalThis.document.createElement('a')
    a.href = url; a.download = filename; a.rel = 'noopener'; globalThis.document.body.appendChild(a); a.click()
    setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 8000)
    return Promise.resolve({ status: 'saved' })
  }
  const KEYS = { 'plans/main': 'plan', 'squad/roster': 'roster' }
  const fakeDb = {
    doc(path){
      const key = KEYS[path] || path
      return {
        async set(data){ await store.putDoc(key, data) },
        onSnapshot(cb, err){
          store.getDocs().then(d => { const x = d[key]; cb({ exists: !!x, data: () => (x ? x.data : null), metadata: {} }) }).catch(e => err && err(e))
          return () => {}
        },
      }
    },
    collection(){
      const coll = {
        _limit: 40,
        orderBy(){ return coll },
        limit(n){ coll._limit = n; return coll },
        async get(){ const list = await store.listVersions(coll._limit); return { empty: !list.length, docs: list.map(v => ({ id: v.id, data: () => v })) } },
        doc(id){
          return {
            async get(){ try { const v = await store.getVersion(id); return { exists: true, data: () => v } } catch (e) { return { exists: false, data: () => null } } },
            async delete(){ await store.deleteVersion(id) },
          }
        },
        async add(v){ return { id: (await store.addVersion(v)).id } },
      }
      return coll
    },
  }
  const claudeShim = { use: async name => (name === 'db' ? fakeDb : name === 'downloads' ? { save: anchorSave } : name === 'user' ? { can: async () => true } : null) }
  const track = target => new Proxy(target, {
    get(t, p){
      if (p === 'claude') return claudeShim
      if (p === 'addEventListener') return (type, fn, o) => {
        const h = INSIDE_ONLY.has(type)
          ? e => { const x = e.target; if (x && x.nodeType === 1 && x !== t.body && !root.contains(x)) return; fn(e) }
          : fn
        t.addEventListener(type, h, o); listeners.push([t, type, h, o])
      }
      const v = Reflect.get(t, p, t)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
  const document = track(globalThis.document)
  const window = track(globalThis.window)
  root.classList.add('sp')
  root.innerHTML = PLANNER_TEMPLATE
  { const h = root.querySelector('.title h1'); if (h) h.textContent = 'Season plan' }
  const mark = root.querySelector('.mark'); if (mark) mark.textContent = opts.mark || 'PLAN'
  // A finger needs bigger rows, and taps that don't fire while scrolling.
  const COARSE = !!(globalThis.matchMedia && globalThis.matchMedia('(pointer: coarse)').matches);
  const icon = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  [['#undoBtn', 'Undo', 'M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3'],
   ['#redoBtn', 'Redo', 'm15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3'],
   ['#versBtn', 'Saved versions', 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z']].forEach(([sel, label, d]) => {
    const b = root.querySelector(sel); if (!b) return
    b.innerHTML = icon(d); b.setAttribute('aria-label', label); b.title = label; b.classList.add('icon')
  });
  const hintEl = root.querySelector('#hint')
  if (hintEl && COARSE) hintEl.textContent = 'Tap a block, a week or a swimmer to open it · to change the plan, press and hold a bar or a block edge, then slide'

'use strict';
const DAY=864e5, WK=7*DAY, NS='http://www.w3.org/2000/svg';
const S={plan:null,roster:null,view:'season',sel:null,colW:46,names:typeof root!=='undefined'&&root.clientWidth>=760?'full':'short',ro:false,undo:[],redo:[],focus:'',sheet:'',hidden:[],collapsed:[],expanded:[],expandAll:false,adding:false,wwLine:'',wwDiff:false,tplOpen:[],loaded:{plan:false,roster:false}};
let db=null, planRef=null, rosterRef=null, verCol=null, downloads=null;
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone=o=>JSON.parse(JSON.stringify(o));
function sv(tag,attrs,parent){const e=document.createElementNS(NS,tag);for(const k in attrs){if(attrs[k]!=null)e.setAttribute(k,attrs[k]);}if(parent)parent.appendChild(e);return e;}
function stitle(el,t){const x=document.createElementNS(NS,'title');x.textContent=t;el.appendChild(x);return el;}
function stext(g,x,y,t,cls,anchor){const e=sv('text',{x,y,class:cls,'text-anchor':anchor||null},g);e.textContent=t;return e;}
function fit(t,px,cw){t=String(t||'');const n=Math.floor(px/cw);if(n<=1)return '';return t.length>n?t.slice(0,Math.max(1,n-1))+'…':t;}
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const iso=s=>{const [y,m,d]=String(s).split('-').map(Number);return Date.UTC(y,m-1,d);};
const toISO=t=>new Date(t).toISOString().slice(0,10);
const fd=t=>{const d=new Date(t);return d.getUTCDate()+' '+MON[d.getUTCMonth()];};
const fdy=t=>{const d=new Date(t);return d.getUTCDate()+' '+MON[d.getUTCMonth()]+' '+d.getUTCFullYear();};
const fdow=t=>{const d=new Date(t);return DOW[d.getUTCDay()]+' '+d.getUTCDate()+' '+MON[d.getUTCMonth()];};
const range=(a,b)=>{const A=new Date(a),B=new Date(b);return A.getUTCMonth()===B.getUTCMonth()&&A.getUTCFullYear()===B.getUTCFullYear()?(a===b?fd(a):A.getUTCDate()+'–'+fd(b)):fd(a)+' – '+fd(b);};
const today=()=>{const n=new Date();return Date.UTC(n.getFullYear(),n.getMonth(),n.getDate());};
const D0=()=>iso(S.plan.settings.start), NW=()=>S.plan.settings.weeks;
const wkS=i=>D0()+i*WK, wkE=i=>D0()+i*WK+6*DAY;
const weekOf=t=>Math.floor((t-D0())/WK);
const r2=x=>Math.round(x*100)/100;
const pct=x=>Math.round((x||0)*100)+'%';
const L={HEAD:48,CAL:76,MAC:17,MES:34,GAP:14,LOAD:108,CODE:18,PAD:9};
const LANE=L.MAC+L.MES+L.GAP+L.LOAD+L.CODE+L.PAD+4;
const LMAX=1.1;
const PAL=['#8E44AD','#D1495B','#00798C','#B8860B','#5C6BC0','#2E7D32','#C2185B'];
const HR=[['White','≤24','#F4F5F6'],['Yellow','25','#FFF2A8'],['Pink','26–28','#F8CBDA'],['Red','29–30','#F4A6A6'],['Purple','31–33','#C9B3E6'],['Blue','race pace','#9DC3E6'],['Gold','speed & power','#F2CF5B']];

/* ---------- plan model ---------- */
/* groups are stored branches; each planned swimmer is a virtual branch "sw:<id>" whose parent is their group,
   with personal overrides kept per group in plan.personal[<id>] = {own:{<groupId>:{i:{p,load,...}}}, ownPrio:{<groupId>:{meetId:'A'}}, away:[...]}.
   A swimmer's own change belongs to the group they were in when it was made: in any other group they take that group's plan,
   and the change comes back if they return. */
function BR(id){if(!id)return null;
  if(String(id).startsWith('sw:')){const sid=id.slice(3);const sw=S.roster&&S.roster.swimmers.find(s=>s.id===sid);if(!sw||!planned(sw))return null;const cg=curGroup(sw);const g=S.plan.branches.find(b=>b.id===cg);
    return{id,kind:'swimmer',swId:sid,sw,name:sw.name,parent:cg,color:g?g.color:'#888'};}
  return S.plan.branches.find(b=>b.id===id);}
const swBid=sw=>'sw:'+sw.id;
/* group history: sw.branch is the group at the start of the season; sw.moves = [{w:weekIndex,to:groupId}] change it from that week on */
const nowWk=()=>Math.max(0,Math.min(NW()-1,weekOf(today())));
function groupAt(sw,i){let g=sw.branch;(sw.moves||[]).forEach(m=>{if(i>=m.w&&S.plan.branches.some(b=>b.id===m.to))g=m.to;});return g;}
const curGroup=sw=>groupAt(sw,nowWk());
function normMoves(sw){const ms=(sw.moves||[]).filter(m=>m&&m.to&&m.w>0&&m.w<NW()).sort((a,b)=>a.w-b.w);const out=[];let g=sw.branch;
  ms.forEach(m=>{if(out.length&&out[out.length-1].w===m.w)out.pop();const prev=out.length?out[out.length-1].to:sw.branch;if(m.to!==prev)out.push({w:m.w,to:m.to});});sw.moves=out;}
function assignFrom(sw,bid,w){if(!bid||w<=0){sw.branch=bid;sw.moves=[];return;}sw.moves=(sw.moves||[]).filter(m=>m.w<w);if(groupAt(sw,w)!==bid)sw.moves.push({w,to:bid});normMoves(sw);}
function groupRuns(sw){const r=[];for(let i=0;i<NW();i++){const g=groupAt(sw,i);const l=r[r.length-1];if(l&&l.g===g)l.b=i;else r.push({g,a:i,b:i});}return r;}
/* individual absences: plan.personal[id].away = [{id,type,from,to,note,mods}] — missed sessions take their share of the week off; an injury trains at mods */
function awayFor(sid){return ((S.plan.personal||{})[sid]||{}).away||[];}
const INJ={load:.5,aer:.6,ana:.2,spd:0};
function awayIn(sw,i){const list=awayFor(sw.id);if(!list.length)return null;const tot=S.plan.sessions.reduce((s,x)=>s+(+x.hours||0),0)||1;const F={load:1,aer:1,ana:1,spd:1},items=[];
  list.forEach(a=>{if(!a.from)return;const A=iso(a.from),Z=iso(a.to||a.from);if(Z<wkS(i)||A>wkE(i))return;let miss=0;S.plan.sessions.forEach(x=>{const d=wkS(i)+x.day*DAY;if(d>=A&&d<=Z)miss+=(+x.hours||0);});const frac=miss/tot;if(frac<=0)return;
    const m=a.type==='Injury'?Object.assign({},INJ,a.mods||{}):{load:0,aer:0,ana:0,spd:0};['load','aer','ana','spd'].forEach(k=>{F[k]*=1-frac*(1-m[k]);});items.push({type:a.type,frac,note:a.note||''});});
  return items.length?{F,items}:null;}
const allSw=()=>S.roster?S.roster.swimmers:[];
const nextMove=sw=>(sw.moves||[]).find(m=>m.w>nowWk()&&BR(m.to))||null;
/* move a swimmer from this week on (keeps where they were earlier in the season) */
function moveNow(sw,bid){if(!bid){sw.branch='';sw.moves=[];return;}if(!planned(sw)){sw.branch=bid;sw.moves=[];return;}assignFrom(sw,bid,nowWk());}
const AWT=['Holiday','Injury','Illness','Away'];
const awayShort=t=>({Holiday:'Hol',Injury:'Inj',Illness:'Ill',Away:'Away'})[t]||'Away';
function awayTxt(a){return a.items.map(x=>x.type==='Injury'?`Injury: modified training for ${Math.round(x.frac*100)}% of the week${x.note?' ('+x.note+')':''}`:`${x.type}: misses ${x.frac>=.999?'the whole week':Math.round(x.frac*100)+'% of the week'}${x.note?' ('+x.note+')':''}`).join('<br>');}
function miniTag(sw){const n=personalDiff(sw),cg=curGroup(sw);const og=[...new Set(groupRuns(sw).map(r=>r.g).filter(g=>g!==cg))].map(g=>(BR(g)||{}).name);const aw=TL(swBid(sw)).some(w=>w.away);
  const t=[n?n+' wk':'',og.length?og.join(', '):'',aw?'away':''].filter(Boolean);return esc(t.join(' · ')||'same');}
function groupStory(sw){return groupRuns(sw).map((r,k)=>(BR(r.g)||{}).name+(k?' from '+fd(wkS(r.a)):'')).join(' → ');}
/* personal goals live on the swimmer: sw.goals = [{id,text,event,target(seconds),course 'SC'|'LC',meet(meetId),done}] */
const goalsOf=sw=>(sw&&sw.goals)||[];
function starPts(x,y,r){const p=[];for(let j=0;j<10;j++){const a=-Math.PI/2+j*Math.PI/5,rr=j%2?r*.45:r;p.push((x+rr*Math.cos(a)).toFixed(1)+','+(y+rr*Math.sin(a)).toFixed(1));}return p.join(' ');}
function goalInfo(sw,g){const c=g.meet?S.plan.calendar.find(x=>x.id===g.meet)||null:null;const course=c&&c.course?(c.course==='50m'?'LC':'SC'):(g.course||'SC');
  const ev=(sw.events||[]).find(x=>x.e===g.event);const best=ev?(course==='LC'?ev.lc:ev.sc):null;const gap=g.target&&best?(best-g.target)/g.target:null;
  const tgt=g.event?`${g.event}${g.target?' in '+ft(g.target):''} ${course}`:'';const label=(g.text||'').trim()||tgt||'New goal';
  return{c,course,best,gap,tgt,label,wk:c?meetWk(c):null};}
function goalStatus(sw,g){const x=goalInfo(sw,g);if(g.done)return 'Achieved';if(!g.event||!g.target)return '';if(!x.best)return `No ${x.course} PB yet`;
  return x.gap<=0?`PB ${ft(x.best)} is already under this`:`PB ${ft(x.best)} · ${(x.best-g.target).toFixed(2)}s (${(x.gap*100).toFixed(1)}%) to find`;}
function goalLine(sw,g){const x=goalInfo(sw,g);const st=goalStatus(sw,g);
  return `<div class="goal-l${g.done?' done':''}"><b>${esc(x.label)}</b>${x.tgt&&g.text?` <span class="muted">· ${esc(x.tgt)}</span>`:''}${x.c?` <span class="muted">· by ${esc(x.c.short||x.c.name)} ${range(iso(x.c.start),iso(x.c.end))}</span>`:''}${st?` <span class="small ${g.done||(x.gap!=null&&x.gap<=0)?'pos':'muted'}">· ${esc(st)}</span>`:''}</div>`;}
function awayNow(sw){const t=today();return awayFor(sw.id).find(a=>a.from&&iso(a.from)<=t&&iso(a.to||a.from)>=t)||null;}
const gName=b=>b?(/group$/i.test(b.name)?b.name:b.name+' group'):'';
const meetWk=c=>Math.max(0,Math.min(NW()-1,weekOf(iso(c.start))));
const persOf=sid=>(S.plan.personal||{})[sid]||{};
function ownPrio(sw,c){const g=groupAt(sw,meetWk(c));return ((persOf(sw.id).ownPrio||{})[g]||{})[c.id]||'';}
function prioOf(bid,c){if(bid&&String(bid).startsWith('sw:')){const b=BR(bid);if(!b)return '—';return ownPrio(b.sw,c)||prioOf(groupAt(b.sw,meetWk(c)),c);}return (c.prio||{})[bid]||'—';}
function personalDiff(sw){return planned(sw)?TL(swBid(sw)).filter(w=>w.diff).length:0;}
/* weeks that look different from the swimmer's current group: own changes, a stretch in another group, or time away */
function personalWeeks(sw){if(!planned(sw))return 0;const cg=curGroup(sw);return TL(swBid(sw)).filter(w=>w.diff||w.g!==cg||w.away).length;}
function personalPrio(sw){return S.plan.calendar.filter(c=>{const v=ownPrio(sw,c);return v&&v!==((c.prio||{})[groupAt(sw,meetWk(c))]||'—');}).map(c=>c.id);}
function lanes(){const out=[];const walk=p=>S.plan.branches.filter(b=>(b.parent||null)===p).forEach(b=>{out.push(b);walk(b.id);});walk(null);return out;}
function rootId(){return lanes()[0].id;}
/* Load components. Overall load drives volume (km); aerobic / anaerobic-endurance / anaerobic-speed are separate %s.
   A component is load × the template's weight unless it has been set for that week (then it is stored on the week). */
const COMPS=[{k:'aer',label:'Aerobic',short:'Aerobic'},{k:'ana',label:'Anaerobic · endurance',short:'Ana · end'},{k:'spd',label:'Anaerobic · speed',short:'Ana · speed'}];
const CK=COMPS.map(c=>c.k);
const DEFW={'Pre-season':{aer:.9,ana:.3,spd:.6},'General prep':{aer:1,ana:.8,spd:.8},'Specific prep':{aer:.85,ana:1.1,spd:1},'Taper':{aer:.8,ana:1.2,spd:1.9},
  'Aerobic rebuild':{aer:1.1,ana:.5,spd:.6},'LC base':{aer:1,ana:.9,spd:.8},'Competition window':{aer:.9,ana:1,spd:1.1},'Race-specific build':{aer:.9,ana:1.15,spd:1},
  'Taper & hold':{aer:.8,ana:1.2,spd:1.8},'Exam maintenance':{aer:.9,ana:.5,spd:1},'Post-exam build':{aer:1,ana:.9,spd:.9},'Off-season':{aer:0,ana:0,spd:0}};
function wts(tpl){const t=tplOf(tpl);return Object.assign({aer:1,ana:1,spd:1},DEFW[tpl]||{},(t&&t.w)||{});}
function effC(w){const o={aer:0,ana:0,spd:0};if(!w)return o;const W=wts((S.plan.phases[w.p]||{}).template);CK.forEach(k=>{o[k]=w[k]!=null?+w[k]:r2(Math.max(0,(w.load||0)*W[k]));});return o;}
function rawC(w){const o={};if(w)CK.forEach(k=>{if(w[k]!=null)o[k]=w[k];});return o;}
function sameW(a,b){if(!a||!b)return false;if(a.p!==b.p||Math.abs((a.load||0)-(b.load||0))>1e-6||!a.camp!==!b.camp)return false;const x=effC(a),y=effC(b);return CK.every(k=>Math.abs(x[k]-y[k])<1e-6);}
/* camps: attendees get the camp's load/components for the camp week(s), unless they have their own override */
function campFor(sid,i){const a=wkS(i),e=wkE(i);return S.plan.events.find(x=>x.type==='Camp'&&x.camp&&(x.camp.attendees||[]).includes(sid)&&iso(x.start)<=e&&iso(x.end)>=a)||null;}
/* a swimmer's own weeks, stored under the group they were made in */
function ownGet(sw,i,g){g=g||groupAt(sw,i);return ((persOf(sw.id).own||{})[g]||{})[i]||null;}
function ownSet(sw,i,v){const g=groupAt(sw,i);S.plan.personal=S.plan.personal||{};const P=S.plan.personal[sw.id]=S.plan.personal[sw.id]||{};P.own=P.own||{};(P.own[g]=P.own[g]||{})[i]=v;}
function ownDel(sw,i){const g=groupAt(sw,i);const o=(persOf(sw.id).own||{})[g];if(o)delete o[i];}
function rw(bid,i){let b=BR(bid);while(b){
    if(b.kind==='swimmer'){const gi=groupAt(b.sw,i);const w=ownGet(b.sw,i,gi);if(w)return w;const ev=campFor(b.swId,i);if(ev){const base=rw(gi,i)||{};const c=ev.camp;const o={p:base.p,load:c.load!=null?c.load:base.load,camp:ev.id};CK.forEach(k=>{if(c[k]!=null)o[k]=c[k];});return o;}
      b=BR(gi);continue;}
    const w=b.weeks&&b.weeks[i];if(w)return w;
    b=b.parent?BR(b.parent):null;}return null;}
const memo=new Map(),sMemo=new Map();const inval=()=>{memo.clear();sMemo.clear();};
function TL(bid){
  if(memo.has(bid))return memo.get(bid);
  const n=NW(),b=BR(bid),arr=[];let pp=null,pm=null,meso=0,micro=0;
  for(let i=0;i<n;i++){
    const w=rw(bid,i)||{p:null,load:0};const ph=S.plan.phases[w.p]||{macro:'–',name:'—',template:'',course:''};
    const m=String(ph.macro);
    if(w.p!==pp){micro=1;meso=(m!==pm)?1:meso+1;}else micro++;
    pp=w.p;pm=m;
    const pg=b.kind==='swimmer'?groupAt(b.sw,i):b.parent;const pw=pg?rw(pg,i):null;
    const diff=!!(b.parent&&pw&&!sameW(w,pw));const c=effC(w),pc=pw?effC(pw):null;let load=w.load||0;
    const c0=Object.assign({},c);const away=b.kind==='swimmer'?awayIn(b.sw,i):null;if(away){load=r2(load*away.F.load);CK.forEach(k=>{c[k]=r2(c[k]*away.F[k]);});}
    const cd={};CK.forEach(k=>{cd[k]=!!(pc&&Math.abs(c[k]-pc[k])>1e-6);});
    arr.push({i,p:w.p,load,plan:w.load||0,c0,ph,macro:m,meso,micro,code:m==='–'?'Off':m+'.'+meso+'.'+micro,diff,pload:pw?pw.load:null,raw:w,c,pc,cd,camp:w.camp||null,g:pg,away});
  }
  memo.set(bid,arr);return arr;
}
function runs(arr,key){const out=[];arr.forEach(w=>{const k=key(w);const l=out[out.length-1];if(l&&l.k===k&&l.end===w.i-1)l.end=w.i;else out.push({k,start:w.i,end:w.i});});return out;}
function setWeek(bid,i,w){const b=BR(bid);const v={p:w.p,load:r2(Math.max(0,w.load||0))};CK.forEach(k=>{if(w[k]!=null)v[k]=r2(Math.max(0,+w[k]));});
  if(b.kind==='swimmer'){if(sameW(v,rw(groupAt(b.sw,i),i)))ownDel(b.sw,i);else ownSet(b.sw,i,v);return;}
  b.weeks=b.weeks||{};if(!b.parent){b.weeks[i]=v;return;}
  if(sameW(v,rw(b.parent,i)))delete b.weeks[i];else b.weeks[i]=v;}
function clearWeek(bid,i){const b=BR(bid);if(!b)return;if(b.kind==='swimmer')ownDel(b.sw,i);else if(b.weeks)delete b.weeks[i];}
/* own changes kept from another group, not in use right now: [{g,a,b}] */
function dormantRuns(sw){const own=persOf(sw.id).own||{};const out=[];
  Object.keys(own).forEach(g=>{Object.keys(own[g]).map(Number).filter(i=>i<NW()&&groupAt(sw,i)!==g).sort((a,b)=>a-b).forEach(i=>{const l=out[out.length-1];if(l&&l.g===g&&l.b===i-1)l.b=i;else out.push({g,a:i,b:i});});});
  return out.sort((x,y)=>x.a-y.a);}
/* older saves kept own weeks in .weeks (optionally tagged .g) and targets in .prio/.prioG: file them under their group */
function upgradePersonal(){if(!S.plan||!S.roster||!S.plan.personal)return;const isG=g=>S.plan.branches.some(b=>b.id===g);
  Object.keys(S.plan.personal).forEach(sid=>{const P=S.plan.personal[sid];const sw=S.roster.swimmers.find(x=>x.id===sid);if(!sw||!(P.weeks||P.prio))return;
    if(P.weeks){P.own=P.own||{};Object.keys(P.weeks).forEach(k=>{const w=Object.assign({},P.weeks[k]);const g=w.g&&isG(w.g)?w.g:groupAt(sw,+k);delete w.g;P.own[g]=P.own[g]||{};if(!P.own[g][k])P.own[g][k]=w;});delete P.weeks;}
    if(P.prio){P.ownPrio=P.ownPrio||{};Object.keys(P.prio).forEach(k=>{const c=S.plan.calendar.find(x=>x.id===k);if(!c)return;const g=(P.prioG||{})[k]&&isG(P.prioG[k])?P.prioG[k]:groupAt(sw,meetWk(c));P.ownPrio[g]=P.ownPrio[g]||{};if(!P.ownPrio[g][k])P.ownPrio[g][k]=P.prio[k];});delete P.prio;delete P.prioG;}});}
function setLoad(bid,i,v){const w=rw(bid,i);if(w)setWeek(bid,i,Object.assign(rawC(w),{p:w.p,load:v}));}
function setComp(bid,i,k,v){const w=rw(bid,i);if(!w)return;const o=Object.assign(rawC(w),{p:w.p,load:w.load});o[k]=v;setWeek(bid,i,o);}
function reshape(bid,pid){const ph=S.plan.phases[pid];if(!ph||!ph.taper||!ph.taper.length)return;inval();
  runs(TL(bid),w=>w.p).filter(r=>r.k===pid).forEach(r=>{for(let i=r.start;i<=r.end;i++)setWeek(bid,i,Object.assign(rawC(rw(bid,i)),{p:pid,load:ph.taper[Math.min(r.end-i,ph.taper.length-1)]}));});inval();}
function moveBoundary(bid,j,nj){inval();const arr=TL(bid);const rr=runs(arr,w=>w.p);const ri=rr.findIndex(r=>r.start===j);if(ri<1)return j;
  const Lr=rr[ri-1],R=rr[ri];nj=Math.max(Lr.start+1,Math.min(R.end,nj));if(nj===j)return j;
  if(nj<j){for(let i=nj;i<j;i++)setWeek(bid,i,Object.assign(rawC(arr[i].raw),{p:R.k,load:arr[i].plan}));}else{for(let i=j;i<nj;i++)setWeek(bid,i,Object.assign(rawC(arr[i].raw),{p:Lr.k,load:arr[i].plan}));}
  inval();reshape(bid,Lr.k);reshape(bid,R.k);inval();return nj;}
function runAt(bid,i){inval();return runs(TL(bid),w=>w.p).find(r=>i>=r.start&&i<=r.end);}
function diffRanges(bid){const b=BR(bid);if(!b.parent)return[];return runs(TL(bid).filter(w=>w.diff),()=>1).map(r=>({a:r.start,b:r.end}));}
function macroEnds(bid){const arr=TL(bid);const o={};['0','1','2','3'].forEach(m=>{const ws=arr.filter(w=>w.macro===m);if(ws.length)o[m]={a:ws[0].i,b:ws[ws.length-1].i};});return o;}
function meetsInWeek(i){return S.plan.calendar.filter(c=>weekOf(iso(c.start))===i).sort((a,b)=>a.start.localeCompare(b.start));}
function eventsInWeek(i){const a=wkS(i),b=wkE(i);return S.plan.events.filter(e=>iso(e.start)<=b&&iso(e.end)>=a);}
function peakMeets(bid,lvl){return S.plan.calendar.filter(c=>prioOf(bid,c)===(lvl||'A')).sort((a,b)=>a.start.localeCompare(b.start));}
function peakVol(){return S.plan.sessions.reduce((s,x)=>s+(+x.hours||0)*(+x.mph||0),0);}
function tplOf(name){return S.plan.templates.find(t=>t.name===name);}
/* ---------- intensity notation ----------
   Every focus is stored as an RPE /20 value (21 = HVO, high-velocity overload above race pace).
   A notation is a lens over that scale: each level covers an RPE range, so switching notation converts every target. */
const TINT=r=>r<=8?'#E6ECF1':r<=10?'#D6E7F2':r<=12?'#CDEBD6':r<=14?'#FBEDB0':r<=16?'#FFD6A3':r<=18?'#F6B29B':r<=20?'#EE9FB7':'#D7C1F2';
const BORG={1:'Rest',2:'Very, very easy',3:'Very easy',4:'Easy',5:'Easy',6:'No exertion',7:'Extremely light',8:'Extremely light',9:'Very light',10:'Very light',11:'Light',12:'Light',13:'Somewhat hard',14:'Somewhat hard',15:'Hard',16:'Hard',17:'Very hard',18:'Very hard',19:'Extremely hard',20:'Maximal',21:'HVO: faster than race pace'};
const LV=(k,label,lo,hi,color,desc)=>({k,label,lo,hi,color:color||TINT(hi),desc});
const NOTS=[
  {id:'rpe',name:'RPE /20 + HVO',desc:'Rate of perceived exertion out of 20. 21 is HVO: high-velocity overload, faster than race pace.',
    levels:Array.from({length:21},(_,j)=>LV('r'+(j+1),j===20?'HVO':'RPE '+(j+1),j+1,j+1,TINT(j+1),BORG[j+1]))},
  {id:'club',name:'BPSC colours',desc:'Heart rate counted over 10 seconds, plus race pace and speed.',levels:[
    LV('white','White',1,10,'#F4F5F6','≤24 beats in 10 s · recovery, easy aerobic'),LV('yellow','Yellow',11,12,'#FFF2A8','25 beats · aerobic'),
    LV('pink','Pink',13,14,'#F8CBDA','26–28 beats · aerobic development'),LV('red','Red',15,16,'#F4A6A6','29–30 beats · threshold'),
    LV('purple','Purple',17,18,'#C9B3E6','31–33 beats · aerobic overload'),LV('blue','Blue',19,20,'#9DC3E6','Max effort, race pace'),
    LV('gold','Gold',21,21,'#F2CF5B','Speed and power (HVO)')]},
  {id:'brit',name:'Energy systems (British Swimming)',desc:'Energy-system zones as used by British Swimming.',levels:[
    LV('a1','A1',1,10,null,'Aerobic low intensity · recovery, technique'),LV('a2','A2',11,12,null,'Aerobic maintenance'),
    LV('a3','A3',13,14,null,'Aerobic development'),LV('at','AT',15,16,null,'Anaerobic threshold'),
    LV('vo2','VO2',17,18,null,'Aerobic overload, critical speed'),LV('lt','LT',19,19,null,'Lactate tolerance'),
    LV('lp','LP',20,20,null,'Lactate production'),LV('sp','SP',21,21,null,'Speed · alactic, neuromuscular')]},
  {id:'usa',name:'Maglischo / USA Swimming',desc:'Maglischo\'s training categories, as adopted by USA Swimming.',levels:[
    LV('rec','REC',1,10,null,'Recovery'),LV('en1','EN1',11,13,null,'Basic endurance'),LV('en2','EN2',14,16,null,'Threshold endurance'),
    LV('en3','EN3',17,18,null,'Overload endurance (VO2max)'),LV('sp1','SP1',19,19,null,'Lactate tolerance'),
    LV('sp2','SP2',20,20,null,'Lactate production'),LV('sp3','SP3',21,21,null,'Power')]},
  {id:'urb',name:'Urbanchek colours',desc:'Jon Urbanchek\'s colour system (Michigan).',levels:[
    LV('uw','White',1,11,'#F4F5F6','Recovery, warm-up · HR about 120–140'),LV('up','Pink',12,13,'#F8CBDA','Aerobic · HR about 140–150'),
    LV('ur','Red',14,15,'#F4A6A6','Threshold, T-30 pace · HR about 150–170'),LV('ub','Blue',16,17,'#9DC3E6','Overload, just above threshold · HR about 160–180'),
    LV('uu','Purple',18,19,'#C9B3E6','VO2 and race pace, about 7% faster than Red · HR about 180–190'),LV('ug','Green',20,21,'#B9E3C6','Lactate production, sprints with long rest')]},
  {id:'olb',name:'Olbrecht (capacity / power)',desc:'Jan Olbrecht\'s capacity and power zones (The Science of Winning).',levels:[
    LV('orec','REC',1,9,null,'Recovery'),LV('aec1','AEC1',10,12,null,'Aerobic capacity, extensive'),LV('aec2','AEC2',13,15,null,'Aerobic capacity, intensive'),
    LV('aep','AEP',16,18,null,'Aerobic power (VO2max)'),LV('anp','ANP',19,19,null,'Anaerobic power · lactate tolerance'),
    LV('anc','ANC',20,20,null,'Anaerobic capacity · lactate production'),LV('os','S',21,21,null,'Speed')]}];
function notations(){return NOTS.concat(((S.plan&&S.plan.notation)||{}).custom||[]);}
function nsys(){const id=((S.plan&&S.plan.notation)||{}).active||'club';return notations().find(x=>x.id===id)||NOTS[1];}
function lvlOf(r,sys){sys=sys||nsys();if(r==null||r==='')return null;r=+r;let best=null,bd=1e9;sys.levels.forEach(l=>{const d=r<l.lo?l.lo-r:r>l.hi?r-l.hi:0;if(d<bd){bd=d;best=l;}});return best;}
const lvlRep=l=>l.lo+Math.floor((l.hi-l.lo)/2);
const fLabel=(r,sys)=>{const l=lvlOf(r,sys);return l?l.label:'';};
const fColor=(r,sys)=>{const l=lvlOf(r,sys);return l?l.color:'#FFFFFF';};
function fChip(r,cls){if(r==null)return '';const sys=nsys(),l=lvlOf(r,sys);return `<span class="fchip${cls?' '+cls:''}" style="background:${esc(l.color)}" title="${esc(sys.name+': '+l.label+' · RPE '+(+r===21?'21 (HVO)':r)+(l.desc?' · '+l.desc:''))}">${esc(l.label)}</span>`;}
function focusSel(r,attrs,none){const sys=nsys(),cur=r!=null?lvlOf(r,sys):null;
  return `<select class="inp fsel" ${attrs}${cur?` style="background:${esc(cur.color)};color:#14191F"`:''}><option value="">${esc(none||'—')}</option>${sys.levels.map(l=>`<option value="${esc(l.k)}"${cur&&cur.k===l.k?' selected':''}>${esc(l.label)}${sys.id==='rpe'?(l.desc?' · '+esc(l.desc):''):' · RPE '+(l.lo===l.hi?l.lo:l.lo+'–'+l.hi)}</option>`).join('')}</select>`;}
/* picking a level keeps the exact RPE if it already sits inside that level */
function rFromLevel(k,cur){const l=nsys().levels.find(x=>x.k===k);if(!l)return null;return cur!=null&&+cur>=l.lo&&+cur<=l.hi?+cur:lvlRep(l);}

/* ---------- session targets ----------
   A target is {a: main, b: secondary, c: optional third (RPE values), n: notes}.
   Templates hold one per session (t.f[sid] for focuses, t.s[sid] for notes). A group's week follows its parent's targets
   while it is on the same block, otherwise its block's template; overrides live in branch.sess[i][sid].
   A swimmer follows the group they are in that week (or their camp), with overrides in personal.ownSess[group][i][sid]. */
const CLUBREP={white:9,yellow:11,pink:13,red:15,purple:17,blue:19,gold:21};
function parseFocus(t){t=String(t||'');if(/^\s*off\b/i.test(t))return {};const hits=[];
  t.replace(/\b(white|yellow|pink|red|purple|blue|gold)\b/gi,(m,c,i)=>{hits.push({i,r:CLUBREP[c.toLowerCase()],col:true});return m;});
  const kw=[[/lact(?:ate)?\s+removal|flush/gi,9],[/recovery/gi,9],[/aerobic/gi,13],[/threshold/gi,15],[/descend/gi,15],[/\blact\w*|tolerance/gi,19],[/race[- ]?pace|\bRP\b|\brace\b/gi,19],[/speed|power|sprint/gi,21]];
  kw.forEach(([re,r])=>{let m;re.lastIndex=0;while((m=re.exec(t))){const before=t.slice(Math.max(0,m.index-10),m.index).toLowerCase(),after=t.slice(m.index+m[0].length);
    if(r===19&&/^lact/i.test(m[0])&&/^\s*removal/i.test(after))continue;if(r===19&&/\bno\b|\bnot\b/.test(before))continue;
    if(hits.some(h=>h.col&&h.i>=m.index&&h.i-m.index<=16))continue;hits.push({i:m.index,r});}});
  hits.sort((x,y)=>x.i-y.i);const rs=[];hits.forEach(h=>{if(!rs.includes(h.r))rs.push(h.r);});
  const o={};['a','b','c'].forEach((k,j)=>{if(rs[j]!=null)o[k]=rs[j];});return o;}
function upgradeTemplates(){S.plan.templates.forEach(t=>{if(t.f)return;t.f={};S.plan.sessions.forEach(x=>{const o=parseFocus((t.s||{})[x.id]);if(Object.keys(o).length)t.f[x.id]=o;});});}
const normT=o=>({a:o&&o.a!=null&&o.a!==''?+o.a:null,b:o&&o.b!=null&&o.b!==''?+o.b:null,c:o&&o.c!=null&&o.c!==''?+o.c:null,n:(o&&o.n)||''});
const sKey=t=>t.camp?'camp:'+t.camp:[t.a,t.b,t.c,String(t.n||'').trim()].join('|');
function tplTarget(p,sid){const ph=S.plan.phases[p];const t=ph&&tplOf(ph.template);return normT(Object.assign({},t&&t.f&&t.f[sid],{n:t&&t.s&&t.s[sid]||''}));}
function sessOwn(bid,i,sid){const b=BR(bid);if(!b)return null;if(b.kind==='swimmer'){const g=groupAt(b.sw,i);return ((((persOf(b.sw.id).ownSess||{})[g]||{})[i])||{})[sid]||null;}return (((b.sess||{})[i])||{})[sid]||null;}
function sessBase(bid,i,sid){const b=BR(bid);const w=TL(bid)[i];
  if(b.kind==='swimmer'){if(w.camp){const ev=S.plan.events.find(e=>e.id===w.camp)||{};return {camp:w.camp,a:null,b:null,c:null,n:'Camp: '+(ev.name||'')};}
    const g=groupAt(b.sw,i);return TL(g)[i].p===w.p?sessT(g,i,sid):tplTarget(w.p,sid);}
  return b.parent&&TL(b.parent)[i].p===w.p?sessT(b.parent,i,sid):tplTarget(w.p,sid);}
function sessT(bid,i,sid){const k=bid+'|'+i+'|'+sid;if(sMemo.has(k))return sMemo.get(k);const o=sessOwn(bid,i,sid);const r=o?Object.assign(normT(o),{own:true}):sessBase(bid,i,sid);sMemo.set(k,r);return r;}
function sessStore(bid,i,make){const b=BR(bid);if(b.kind==='swimmer'){const g=groupAt(b.sw,i);if(make){S.plan.personal=S.plan.personal||{};const P=S.plan.personal[b.sw.id]=S.plan.personal[b.sw.id]||{};P.ownSess=P.ownSess||{};return P.ownSess[g]=P.ownSess[g]||{};}return (persOf(b.sw.id).ownSess||{})[g]||null;}
  if(make)b.sess=b.sess||{};return b.sess||null;}
function setSess(bid,i,sid,patch){const cur=sessT(bid,i,sid);const nv=normT(Object.assign({},cur.camp?{n:''}:cur,patch));sMemo.clear();const base=sessBase(bid,i,sid);
  if(!base.camp&&sKey(nv)===sKey(base)){clearSess(bid,i,sid);return;}const st=sessStore(bid,i,true);(st[i]=st[i]||{})[sid]={a:nv.a,b:nv.b,c:nv.c,n:nv.n};sMemo.clear();}
function clearSess(bid,i,sid){const st=sessStore(bid,i,false);if(st&&st[i]){delete st[i][sid];if(!Object.keys(st[i]).length)delete st[i];}sMemo.clear();}
function membersAt(bid,i){return allSw().filter(s=>planned(s)&&groupAt(s,i)===bid);}
/* the different versions of one session in week i, across groups (with swimmers in them that week) and individuals who differ */
function sessVersions(i,sid){const vs=new Map();const add=(t,who,sw)=>{const k=sKey(t);if(!vs.has(k))vs.set(k,{t,groups:[],swimmers:[]});const v=vs.get(k);if(sw)v.swimmers.push(sw);else v.groups.push(who);};
  lanes().forEach(b=>{if(membersAt(b.id,i).length)add(sessT(b.id,i,sid),b);});
  allSw().filter(planned).forEach(sw=>{const t=sessT(swBid(sw),i,sid);if(sKey(t)!==sKey(sessT(groupAt(sw,i),i,sid)))add(t,null,sw);});
  return [...vs.values()];}
function tgtHTML(t,withNotes){if(t.camp)return `<span class="fchip" style="background:#D6E8F7">Camp</span>${withNotes?` <span class="small muted">${esc(t.n)}</span>`:''}`;
  const ch=[fChip(t.a),fChip(t.b,'sm'),fChip(t.c,'sm')].filter(Boolean).join(' ');return (ch||'<span class="small muted">—</span>')+(withNotes&&t.n?`<div class="small tnote">${esc(t.n)}</div>`:'');}
function versionsHTML(vs,curKey){const fk=t=>t.camp?'camp':[t.a,t.b,t.c].join('|');const dupF=k=>vs.filter(v=>fk(v.t)===k).length>1;
  return vs.map(v=>`<div class="ver${sKey(v.t)===curKey?' cur':''}">${tgtHTML(v.t)} <span class="small">${esc(v.groups.map(b=>b.name).concat(v.swimmers.map(s=>s.name)).join(', '))}</span>${dupF(fk(v.t))&&v.t.n?`<span class="small muted vnote" title="${esc(v.t.n)}">“${esc(v.t.n.length>48?v.t.n.slice(0,47)+'…':v.t.n)}”</span>`:''}</div>`).join('');}

function members(bid){return S.roster?S.roster.swimmers.filter(s=>planned(s)&&curGroup(s)===bid):[];}
const planned=s=>!!(s&&s.branch&&BR(s.branch));
function unplanned(){return S.roster?S.roster.swimmers.filter(s=>!planned(s)):[];}
function usedBy(pid){return lanes().filter(b=>TL(b.id).some(w=>w.p===pid)).map(b=>b.name);}
function prune(){
  S.plan.branches.forEach(b=>{if(!b.parent||!b.weeks)return;Object.keys(b.weeks).forEach(k=>{if(sameW(b.weeks[k],rw(b.parent,+k)))delete b.weeks[k];});});
  inval();S.plan.branches.forEach(b=>{if(!b.sess)return;Object.keys(b.sess).forEach(i=>{if(+i>=NW()){delete b.sess[i];return;}Object.keys(b.sess[i]).forEach(sid=>{if(!S.plan.sessions.some(x=>x.id===sid)||sKey(normT(b.sess[i][sid]))===sKey(sessBase(b.id,+i,sid)))delete b.sess[i][sid];});if(!Object.keys(b.sess[i]).length)delete b.sess[i];});if(!Object.keys(b.sess).length)delete b.sess;});
  const P=S.plan.personal||{};
  upgradePersonal();
  if(S.roster)Object.keys(P).forEach(sid=>{const sw=S.roster.swimmers.find(s=>s.id===sid);if(!sw){delete P[sid];return;}const X=P[sid];const isG=g=>S.plan.branches.some(b=>b.id===g);
    if(planned(sw)){
      const own=X.own||{};Object.keys(own).forEach(g=>{if(!isG(g)){delete own[g];return;}Object.keys(own[g]).forEach(k=>{if(+k>=NW()){delete own[g][k];return;}const live=g===groupAt(sw,+k);if(!(live&&campFor(sid,+k))&&sameW(own[g][k],rw(g,+k)))delete own[g][k];});if(!Object.keys(own[g]).length)delete own[g];});
      if(X.own&&!Object.keys(X.own).length)delete X.own;
      const op=X.ownPrio||{};Object.keys(op).forEach(g=>{if(!isG(g)){delete op[g];return;}Object.keys(op[g]).forEach(k=>{const c=S.plan.calendar.find(x=>x.id===k);if(!c||op[g][k]===((c.prio||{})[g]||'—'))delete op[g][k];});if(!Object.keys(op[g]).length)delete op[g];});
      if(X.ownPrio&&!Object.keys(X.ownPrio).length)delete X.ownPrio;}
      const os=X.ownSess||{};Object.keys(os).forEach(g=>{if(!isG(g)){delete os[g];return;}Object.keys(os[g]).forEach(i=>{if(+i>=NW()){delete os[g][i];return;}if(planned(sw)&&groupAt(sw,+i)===g){inval();Object.keys(os[g][i]).forEach(sid=>{const base=sessBase(swBid(sw),+i,sid);if(!base.camp&&sKey(normT(os[g][i][sid]))===sKey(base))delete os[g][i][sid];});}if(!Object.keys(os[g][i]).length)delete os[g][i];});if(!Object.keys(os[g]).length)delete os[g];});
      if(X.ownSess&&!Object.keys(X.ownSess).length)delete X.ownSess;
    if(!X.own&&!X.ownPrio&&!X.ownSess&&!X.weeks&&!X.prio&&!(X.away||[]).length)delete P[sid];});
  const used=new Set();S.plan.branches.forEach(b=>Object.values(b.weeks||{}).forEach(w=>used.add(w.p)));Object.values(P).forEach(x=>Object.values(x.own||{}).forEach(o=>Object.values(o).forEach(w=>used.add(w.p))));
  Object.keys(S.plan.phases).forEach(p=>{if(!used.has(p))delete S.plan.phases[p];});inval();
}
/* qualifying */
const band=y=>y>=2010?'10+':y>=2008?'08-09':'07-';
function qtN(sw,e){const t=S.roster.qts.nats[e];return t?t[sw.g+' '+band(+sw.dob.slice(0,4))]:null;}
function qtE(sw,e){const t=S.roster.qts.er[e];return t?t[sw.g]:null;}
function stats(sw){const nq=[],near=[],eq=[],enear=[];let close=null,eclose=null;const th=S.plan.settings.near||.015;
  (sw.events||[]).forEach(ev=>{const q=qtN(sw,ev.e);if(q&&ev.wn){const g=(ev.wn-q)/q;if(g<=0)nq.push(ev.e);else{if(!close||g<close.g)close={e:ev.e,g};if(g<=th)near.push({e:ev.e,g});}}
    const r=qtE(sw,ev.e);if(r&&ev.er){const g=(ev.er-r)/r;if(g<=0)eq.push(ev.e);else{if(!eclose||g<eclose.g)eclose={e:ev.e,g};if(g<=th)enear.push({e:ev.e,g});}}});
  return{nq,near,eq,enear,close,eclose};}
/* which QT set a meet uses: explicit c.qt, else inferred from the name */
function qtKey(c){if(c.qt!=null)return c.qt;if(/winter champ/i.test(c.name))return 'nats';if(/east region/i.test(c.name)&&c.course==='25m')return 'er';return '';}
const QSET={nats:{label:'Winter Nationals',meet:c=>/winter champ/i.test(c.name),q:'nq',n:'near',cl:'close',color:'var(--good)',badge:'q'},
            er:{label:'Regionals · East Region SC',meet:c=>/east region/i.test(c.name)&&c.course==='25m',q:'eq',n:'enear',cl:'eclose',color:'var(--reg)',badge:'r'}};
function qualifiers(key){const K=QSET[key];const rows=(S.roster?S.roster.swimmers:[]).filter(planned).map(s=>({s,st:stats(s)}));
  const un=unplanned().map(s=>({s,st:stats(s)})).filter(r=>r.st[K.q].length);
  const q=rows.filter(r=>r.st[K.q].length).sort((a,b)=>b.st[K.q].length-a.st[K.q].length||a.s.name.localeCompare(b.s.name));
  const near=rows.filter(r=>!r.st[K.q].length&&r.st[K.n].length).sort((a,b)=>a.st[K.n][0].g-b.st[K.n][0].g);
  const none=rows.filter(r=>!r.st[K.q].length&&!r.st[K.n].length).sort((a,b)=>a.s.name.localeCompare(b.s.name));return{q,near,none,un};}
function qualCard(key){const K=QSET[key];const {q,near,none,un}=qualifiers(key);const meet=S.plan.calendar.find(K.meet);const dot=s=>{const b=planned(s)?BR(curGroup(s)):null;return b?`<b style="color:${esc(b.color)}" title="${esc(gName(b))}">●</b>`:'';};
  return `<div class="card qcard" style="--qc:${K.color}"><div class="qhead"><div><span class="label">${meet?esc(range(iso(meet.start),iso(meet.end)))+' · '+esc(meet.venue||''):''}</span><h2>${esc(K.label)}</h2></div><div style="text-align:right"><div class="count">${q.length}</div><div class="small muted">of ${q.length+near.length+none.length} planned swimmers</div></div></div>
  <ul class="qlist">${q.map(r=>`<li><button class="nm" data-cmd="focus" data-id="${esc(r.s.id)}">${dot(r.s)}<span>${esc(r.s.name)}</span></button><span class="ev">${r.st[K.q].map(e=>`<span class="badge ${K.badge}">${esc(e)}</span>`).join('')}</span></li>`).join('')||'<li class="qnone">Nobody yet.</li>'}</ul>
  ${near.length?`<div class="qsub">Within ${(S.plan.settings.near*100).toFixed(1)}%</div><ul class="qlist">${near.map(r=>`<li><button class="nm" data-cmd="focus" data-id="${esc(r.s.id)}">${dot(r.s)}<span>${esc(r.s.name)}</span></button><span class="ev">${r.st[K.n].map(n=>`<span class="badge n">${esc(n.e)} +${(n.g*100).toFixed(1)}%</span>`).join('')}</span></li>`).join('')}</ul>`:''}
  ${none.length?`<div class="qsub">Not yet</div><div class="qnone">${none.map(r=>{const c=r.st[K.cl];return `<button class="nm" style="display:inline;border:0;background:none;padding:0;cursor:pointer;color:inherit;font:inherit" data-cmd="focus" data-id="${esc(r.s.id)}">${esc(r.s.name)}</button>${c?` <span class="small">(${esc(c.e)} +${(c.g*100).toFixed(1)}%)</span>`:' <span class="small">(no eligible times)</span>'}`;}).join(' · ')}</div>`:''}
  ${un.length?`<div class="qsub">Also qualified · not planned (Uniboard)</div><div class="qnone">${un.map(r=>`<button class="nm" style="display:inline;border:0;background:none;padding:0;cursor:pointer;color:inherit;font:inherit" data-cmd="focus" data-id="${esc(r.s.id)}">${esc(r.s.name)}</button> <span class="small">(${esc(r.st[K.q].join(', '))})</span>`).join(' · ')}</div>`:''}
  <div class="small muted">${esc(key==='nats'?S.roster.rules.nats:S.roster.rules.er)}</div></div>`;}
function ft(s){if(s==null||s==='')return '';s=+s;const m=Math.floor(s/60),r=(s-m*60).toFixed(2);return m?m+':'+(r<10?'0':'')+r:r;}
function pt(t){t=String(t||'').trim();if(!t)return null;const p=t.split(':');const v=p.length===2?(+p[0])*60+(+p[1]):+t;return isFinite(v)&&v>0?r2(v):NaN;}

/* ---------- persistence ---------- */
let saveTimer=null,saving=false;const pend={plan:false,roster:false};
function setStatus(s,t){const el=$('#status');el.dataset.s=s;el.textContent=t;}
function pushUndo(){S.undo.push(JSON.stringify({plan:S.plan,roster:S.roster}));if(S.undo.length>60)S.undo.shift();S.redo=[];}
function dirty(which){if(which!=='roster')pend.plan=true;if(which!=='plan')pend.roster=true;setStatus('dirty','Unsaved changes');clearTimeout(saveTimer);saveTimer=setTimeout(flush,700);}
async function flush(){if(saving||!db||S.ro)return;saving=true;setStatus('saving','Saving…');
  try{while(pend.plan||pend.roster){if(pend.plan){pend.plan=false;prune();await planRef.set(clone(S.plan));}if(pend.roster){pend.roster=false;await rosterRef.set(clone(S.roster));}}
    const d=new Date();setStatus('saved','Saved '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'));}
  catch(e){const c=e&&e.code;if(c==='invalid_argument'){S.ro=true;setStatus('error','View only: changes not saved');renderAll();}
    else if(c==='quota_exceeded'){setStatus('error','Storage full: delete old versions');}
    else{setStatus('error','Not saved: retrying');pend.plan=true;pend.roster=true;setTimeout(()=>{saving=false;flush();},2500+Math.random()*1500);return;}}
  finally{saving=false;}}
function commit(fn,which){if(S.ro||!S.plan)return;pushUndo();fn();inval();dirty(which||'plan');renderAll();}
function undo(){if(!S.undo.length||S.ro)return;S.redo.push(JSON.stringify({plan:S.plan,roster:S.roster}));const s=JSON.parse(S.undo.pop());S.plan=s.plan;S.roster=s.roster;inval();dirty('both');renderAll();}
function redo(){if(!S.redo.length||S.ro)return;S.undo.push(JSON.stringify({plan:S.plan,roster:S.roster}));const s=JSON.parse(S.redo.pop());S.plan=s.plan;S.roster=s.roster;inval();dirty('both');renderAll();}

/* ---------- render: shell ---------- */
let rafId=0,rafFns=new Set();
function later(fn){rafFns.add(fn);if(!rafId)rafId=requestAnimationFrame(()=>{rafId=0;const f=[...rafFns];rafFns.clear();f.forEach(x=>x());});}
function renderAll(){
  if(S.plan&&S.roster&&S.plan.personal&&Object.values(S.plan.personal).some(x=>x.weeks||x.prio))upgradePersonal();
  if(S.plan&&S.plan.templates&&S.plan.templates.some(t=>!t.f))upgradeTemplates();
  document.querySelectorAll('.tab').forEach(t=>t.setAttribute('aria-selected',String(t.dataset.v===S.view)));
  ['season','squad','calendar','sessions'].forEach(v=>{$('#v-'+v).hidden=S.view!==v;});
  $('#undoBtn').disabled=!S.undo.length||S.ro;$('#redoBtn').disabled=!S.redo.length||S.ro;
  if(!S.plan){renderEmpty();return;}
  inval();
  $('#subtitle').textContent=`${S.plan.settings.season} · ${S.plan.settings.squad} · three macros · ${S.plan.branches.length} groups`;
  renderFocus();
  if(S.view==='season'){renderQStrip();renderSummary();renderOverview();renderTimeline();renderDetail();}
  else if(S.view==='squad')renderSquad();
  else if(S.view==='calendar')renderCalendar();
  else renderSessions();
  if(S.sheet)renderSheet();
  if(S.ro)document.querySelectorAll('#main input,#main select:not(#focusSel):not(#weekBranch),#main textarea,#main .edit').forEach(el=>{el.disabled=true;});
}
function renderEmpty(){
  const loading=!(S.loaded.plan);
  $('#summary').innerHTML=`<div class="card empty" style="grid-column:1/-1">${loading?
    `<h2>Loading the season plan…</h2><p class="muted">The saved plan, branches and squad appear here once they arrive.</p>`:
    db?`<h2>No plan saved yet</h2><p class="muted">This page keeps one shared season plan. Start a blank one here, or ask Claude to load the Silver 1 plan into this page.</p><div><button class="btn primary" data-cmd="blank">Start a blank plan</button></div>`:
    `<h2>Open this page in Claude to load the plan</h2><p class="muted">The season plan is stored with this page and loads when you're signed in to Claude.</p>`}</div>`;
  ['#detail','#tlLabels'].forEach(s=>$(s).innerHTML='');$('#tl').innerHTML='';$('#ov').innerHTML='';
}
function renderFocus(){
  const sel=$('#focusSel');const cur=S.focus;
  if(S.roster){const o=s=>`<option value="${esc(s.id)}"${s.id===cur?' selected':''}>${esc(s.name)}</option>`;const un=unplanned();
    const opts=['<option value="">All groups (no swimmer)</option>'].concat(lanes().map(b=>`<optgroup label="${esc(b.name)}">`+members(b.id).map(o).join('')+'</optgroup>')).concat(un.length?[`<optgroup label="Not planned (Uniboard)">`+un.map(o).join('')+'</optgroup>']:[]);sel.innerHTML=opts.join('');}
  const sw=curSwimmer();const fb=$('#focusBanner');
  if(!sw){fb.innerHTML='';return;}
  if(!planned(sw)){const st=stats(sw);fb.innerHTML=`<div class="card focus-banner" style="--b:var(--line)"><div><b>${esc(sw.name)}</b><div class="small muted">Not planned (Uniboard / visiting). Put them on a branch on the Squad tab to give them a plan.</div></div>
    <div class="chips">${st.nq.length?`<span class="badge q">Winter Nats: ${esc(st.nq.join(', '))}</span>`:''}${st.eq.length?`<span class="badge r">Regionals: ${esc(st.eq.join(', '))}</span>`:''}</div><div class="spacer"></div><button class="btn ghost sm" data-cmd="focus" data-id="">Clear</button></div>`;return;}
  const b=BR(curGroup(sw));const st=stats(sw);const me=macroEnds(swBid(sw));const nd=personalDiff(sw),np=personalPrio(sw).length;const mv=groupRuns(sw).length>1,an=awayNow(sw),na=TL(swBid(sw)).filter(w=>w.away).length;
  fb.innerHTML=`<div class="card focus-banner" style="--b:${esc(b.color)}"><div><b>${esc(sw.name)}</b>${an?` <span class="badge away">${esc(an.type)} until ${fd(iso(an.to||an.from))}</span>`:''}<div class="small muted">${mv?esc(groupStory(sw)):esc(gName(b))} · ${nd||np?`${nd} week${nd===1?'':'s'} and ${np} meet target${np===1?'':'s'} of their own`:'no changes of their own'}${na?` · away or injured ${na} wk`:''} · Macro 1 ends ${me['1']?fd(wkE(me['1'].b)):'—'}</div>${goalsOf(sw).length?`<div class="small banner-goals"><span class="label">Goals</span> ${goalsOf(sw).map(g=>{const x=goalInfo(sw,g);return `<span class="${g.done?'pos':''}">${g.done?'✓ ':''}${esc(x.label)}${x.c?' ('+esc(x.c.short||x.c.name)+')':''}</span>`;}).join(' · ')}</div>`:''}</div>
    <div class="chips">${st.nq.length?`<span class="badge q">Winter Nats: ${esc(st.nq.join(', '))}</span>`:''}${st.near.map(n=>`<span class="badge n">${esc(n.e)} +${(n.g*100).toFixed(1)}%</span>`).join('')}${st.eq.length?`<span class="badge r">Regionals: ${esc(st.eq.join(', '))}</span>`:`<span class="badge e">No regionals QT yet${st.eclose?' · closest '+esc(st.eclose.e)+' +'+(st.eclose.g*100).toFixed(1)+'%':''}</span>`}</div>
    <div class="spacer"></div><button class="btn primary sm" data-cmd="sheet" data-id="${esc(sw.id)}">Swimmer plan sheet</button><button class="btn sm" data-cmd="focus" data-id="">← Back to groups</button></div>`;
}
function renderQStrip(){const el=$('#qstrip');if(!S.roster){el.innerHTML='';return;}const n=qualifiers('nats'),r=qualifiers('er');
  el.innerHTML=`<div class="card qstrip"><span class="label">Who's qualified</span>
    <button class="pillq" data-cmd="gosquad"><b style="color:var(--good)">${n.q.length}</b> Winter Nationals${n.near.length?` <span class="small muted">· ${n.near.length} close</span>`:''}</button>
    <button class="pillq" data-cmd="gosquad"><b style="color:var(--reg)">${r.q.length}</b> Regionals (East Region SC)${r.near.length?` <span class="small muted">· ${r.near.length} close</span>`:''}</button>
    <span class="small muted">Names and events on the Squad tab</span></div>`;}
const curSwimmer=()=>S.roster&&S.focus?S.roster.swimmers.find(s=>s.id===S.focus):null;
function focusSwimmer(id,openPanel){
  S.focus=id||'';S.adding=false;const sw=curSwimmer();
  if(sw&&planned(sw)){if(S.hidden.includes(curGroup(sw)))S.hidden=S.hidden.filter(x=>x!==curGroup(sw));if(openPanel||S.view==='season')S.sel={type:'person',id:sw.id};}
  else if(S.sel&&(S.sel.type==='person'||(S.sel.bid&&String(S.sel.bid).startsWith('sw:'))))S.sel=null;
  renderAll();
  if(sw&&planned(sw)&&S.view==='season')later(()=>{const el=document.querySelector('.lab-lane.person');if(el)el.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});});
}
const focusBranch=()=>{const s=curSwimmer();return s&&planned(s)?curGroup(s):null;};

/* ---------- summary + overview ---------- */
function renderSummary(){
  $('#summary').innerHTML=lanes().map(b=>{const me=macroEnds(b.id);const dr=diffRanges(b.id);const pk=peakMeets(b.id,'A');
    const pkTxt=pk.length?pk.map(c=>esc(c.short||c.name)).join(' · '):'none set';const pers=members(b.id).filter(s=>personalWeeks(s)||personalPrio(s).length);
    return `<div role="button" tabindex="0" class="card bcard" style="--b:${esc(b.color)}" data-cmd="selbranch" data-id="${esc(b.id)}">
      <div class="bc-head"><b>${esc(b.name)}</b><span>${members(b.id).length} swimmer${members(b.id).length===1?'':'s'}</span></div>
      <dl class="bc-macros">${['1','2','3'].map(m=>`<div><dt>MACRO ${m} ENDS</dt><dd>${me[m]?fd(wkE(me[m].b)):'—'}</dd></div>`).join('')}</dl>
      <div class="bc-diff">A meets: ${pkTxt}</div>
      <div class="bc-diff">${pers.length?`Personal plans: <em>${pers.map(s=>esc(s.name)).join(', ')}</em>`:'No personal changes: everyone follows the group'}</div>
      <div class="bc-diff">${b.parent?(dr.length?`Differs from ${esc(BR(b.parent).name)}: <em>${dr.map(r=>range(wkS(r.a),wkE(r.b))).join(', ')}</em>`:`Same as ${esc(BR(b.parent).name)} all season`):'Root plan: other branches start from here'}</div></div>`;}).join('');
  $('#legendTop').innerHTML=[['m1','Macro 1'],['m2','Macro 2'],['m3','Macro 3']].map(([c,t])=>`<span><i class="sw" style="background:var(--${c})"></i>${t}</span>`).join('')+`<span><i class="sw" style="background:var(--sh-exam)"></i>Exams</span><span><i class="sw" style="background:var(--sh-hol)"></i>Holidays</span>`;
}
function renderOverview(){
  const svg=$('#ov');svg.innerHTML='';const n=NW(),cw=1000/n,H=100,base=94,sc=86/LMAX;const fsw=curSwimmer()&&planned(curSwimmer())?curSwimmer():null;const fb=fsw?curGroup(fsw):null;
  runs(TL(rootId()),w=>w.macro).forEach(r=>{sv('rect',{x:r.start*cw,y:0,width:(r.end-r.start+1)*cw,height:H,class:mc(r.k),opacity:.16},svg);});
  for(let i=0;i<n;i++){const e=eventsInWeek(i);if(e.some(x=>x.type==='Exams'))sv('rect',{x:i*cw,y:base,width:cw,height:6,class:'sh-exam'},svg);}
  [.5,1].forEach(v=>sv('line',{x1:0,x2:1000,y1:base-v*sc,y2:base-v*sc,class:'grid','vector-effect':'non-scaling-stroke'},svg));
  lanes().forEach(b=>{const pts=TL(b.id).map(w=>`${w.i*cw+cw/2},${base-w.load*sc}`).join(' ');
    const pl=sv('polyline',{points:pts,fill:'none',stroke:b.color,'stroke-width':2,'stroke-opacity':fb&&fb!==b.id?.45:1,'vector-effect':'non-scaling-stroke','stroke-linejoin':'round'},svg);stitle(pl,b.name);});
  if(fsw){const pts=TL(swBid(fsw)).map(w=>`${w.i*cw+cw/2},${base-w.load*sc}`).join(' ');const pl=sv('polyline',{points:pts,fill:'none',stroke:BR(curGroup(fsw)).color,'stroke-width':3.5,'stroke-dasharray':'7 4','vector-effect':'non-scaling-stroke','stroke-linejoin':'round'},svg);stitle(pl,fsw.name+' (personal)');}
  const x=(today()-D0())/WK*cw;if(x>0&&x<1000)sv('line',{x1:x,x2:x,y1:0,y2:H,class:'now','vector-effect':'non-scaling-stroke'},svg);
  $('#ovLegend').innerHTML=lanes().map(b=>`<span><i style="background:${esc(b.color)}"></i>${esc(b.name)}</span>`).join('');
}
const mc=m=>m==='–'?'moff':'m'+m;

/* ---------- timeline ---------- */
/* rows: each group lane, a group header with its swimmer list, one slim line per swimmer (full lane when selected) */
const MINI=COARSE?30:22,GH=COARSE?32:24,CH=62;
const isX=bid=>S.expandAll||S.expanded.includes(bid);
const laneH=bid=>LANE+(isX(bid)?CK.length*CH+6:0);
function tlRows(){const out=[];lanes().filter(b=>!S.hidden.includes(b.id)).forEach(b=>{out.push({t:'lane',bid:b.id,h:laneH(b.id)});const ms=members(b.id);if(!ms.length&&!allSw().some(s=>planned(s)&&groupRuns(s).some(r=>r.g===b.id)))return;
  const open=!S.collapsed.includes(b.id);const vis=allSw().filter(s=>planned(s)&&curGroup(s)!==b.id&&groupRuns(s).some(r=>r.g===b.id));
  out.push({t:'grp',bid:b.id,h:GH,n:ms.length,k:ms.filter(s=>personalWeeks(s)).length,v:vis.length,open});
  ms.forEach(sw=>{if(S.focus===sw.id)out.push({t:'lane',bid:swBid(sw),h:laneH(swBid(sw)),sw});else if(open||personalWeeks(sw))out.push({t:'mini',bid:swBid(sw),h:MINI,sw});});
  if(open)vis.forEach(sw=>out.push({t:'mini',bid:swBid(sw),h:MINI,sw,vis:b.id}));});return out;}
function renderTimeline(){
  const svg=$('#tl');svg.innerHTML='';const cw=S.colW,n=NW();const rs=tlRows();const W=n*cw,H=L.HEAD+L.CAL+rs.reduce((s,r)=>s+r.h,0);
  svg.setAttribute('width',W);svg.setAttribute('height',H);svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  const defs=sv('defs',{},svg);const pat=sv('pattern',{id:'hatch',width:7,height:7,patternUnits:'userSpaceOnUse',patternTransform:'rotate(45)'},defs);sv('rect',{width:7,height:7,class:'hatch-bg'},pat);sv('line',{x1:0,y1:0,x2:0,y2:7,class:'hatch-ln'},pat);const pa=sv('pattern',{id:'awayHatch',width:6,height:6,patternUnits:'userSpaceOnUse',patternTransform:'rotate(-45)'},defs);sv('rect',{width:6,height:6,class:'away-bg'},pa);sv('line',{x1:0,y1:0,x2:0,y2:6,class:'away-ln'},pa);
  const g0=sv('g',{},svg);
  for(let i=0;i<n;i++){const t=new Set(eventsInWeek(i).map(e=>e.type));if(i%2)sv('rect',{x:i*cw,y:0,width:cw,height:H,class:'col-alt'},g0);
    if(t.has('Holiday'))sv('rect',{x:i*cw,y:L.HEAD,width:cw,height:H-L.HEAD,class:'sh-hol'},g0);
    if(t.has('Exams'))sv('rect',{x:i*cw,y:L.HEAD,width:cw,height:H-L.HEAD,class:'sh-exam'},g0);
    if(t.has('Camp'))sv('rect',{x:i*cw,y:L.HEAD,width:cw,height:H-L.HEAD,class:'sh-camp'},g0);}
  // header
  const gh=sv('g',{},svg);let pm=-1;
  for(let i=0;i<n;i++){const d=new Date(wkS(i));const isSel=S.sel&&S.sel.type==='week'&&S.sel.i===i;
    const hit=sv('rect',{x:i*cw,y:16,width:cw,height:L.HEAD-16,class:isSel?'hd-sel':'hd-hit','data-act':'week','data-i':i},gh);stitle(hit,`Week ${i+1} · ${range(wkS(i),wkE(i))} · click to open`);
    if(d.getUTCMonth()!==pm){pm=d.getUTCMonth();sv('line',{x1:i*cw,x2:i*cw,y1:2,y2:L.HEAD,class:'hd-line'},gh);stext(gh,i*cw+4,13,MON[pm]+(pm===0||i===0?' '+String(d.getUTCFullYear()).slice(2):''),'hd-m');}
    stext(gh,i*cw+cw/2,31,d.getUTCDate(),'hd-d','middle');stext(gh,i*cw+cw/2,43,'w'+(i+1),'hd-w','middle');}
  sv('line',{x1:0,x2:W,y1:L.HEAD,y2:L.HEAD,class:'lane-sep'},gh);
  // calendar strip
  const gc=sv('g',{},svg);const cy=L.HEAD+5;
  for(let i=0;i<n;i++){const ms=meetsInWeek(i);ms.slice(0,2).forEach((c,k)=>{const more=k===1&&ms.length>2;const anyA=Object.values(c.prio||{}).includes('A');const isSel=S.sel&&S.sel.type==='meet'&&S.sel.id===c.id;
      const r=sv('rect',{x:i*cw+2,y:cy+k*19,width:cw-4,height:17,rx:4,class:'pill'+(c.course==='50m'?' c50':'')+(anyA?' pa':'')+(c.kind==='camp'?' pk':'')+(isSel?' sel':''),'data-act':'meet','data-id':c.id},gc);
      stitle(r,`${c.name} · ${range(iso(c.start),iso(c.end))} · ${c.course} · ${c.venue||''}${c.level?' · '+c.level:''}${c.note?'\n'+c.note:''}`);
      stext(gc,i*cw+5,cy+k*19+12.5,fit((more?'+'+(ms.length-1)+' ':'')+(c.short||c.name),cw-8,5.3),'pill-t');});}
  S.plan.events.forEach(e=>{let a=weekOf(iso(e.start)),b=weekOf(iso(e.end));if(b<0||a>=n)return;a=Math.max(0,a);b=Math.min(n-1,b);
    const cls=e.type==='Bank holiday'?'ev-Bank':'ev-'+e.type;const y=cy+(e.type==='Exams'||e.type==='Camp'?55:40);
    const r=sv('rect',{x:a*cw+1,y:e.type==='Bank holiday'?y+7:y,width:(b-a+1)*cw-2,height:e.type==='Bank holiday'?5:12,rx:3,class:'ev '+cls,'data-act':e.type==='Camp'?'event':null,'data-id':e.type==='Camp'?e.id:null},gc);stitle(r,`${e.name} · ${range(iso(e.start),iso(e.end))}${e.type==='Camp'?` · ${((e.camp||{}).attendees||[]).length} going · click to edit`:''}`);
    if(e.type!=='Bank holiday'&&(b-a+1)*cw>48)stext(gc,a*cw+5,y+9.5,fit(e.name,(b-a+1)*cw-8,5),'ev-t');});
  // lanes
  let y=L.HEAD+L.CAL;
  rs.forEach(r=>{if(r.t==='lane')drawLane(svg,BR(r.bid),y,cw);else if(r.t==='grp'){sv('rect',{x:0,y,width:W,height:r.h,class:'grp-band'},svg);sv('line',{x1:0,x2:W,y1:y,y2:y,class:'lane-sep'},svg);}else drawMini(svg,r.sw,y,cw,r.vis);y+=r.h;});
  const x=(today()-D0())/WK*cw;if(x>=0&&x<=W){sv('line',{x1:x,x2:x,y1:14,y2:H,class:'now'},svg);stext(svg,x+4,11,'TODAY','now-t');}
  renderLabels(rs);
}
/* one slim line per swimmer; vis = drawn under a group they only join for part of the season */
function drawMini(svg,sw,y,cw,vis){
  const bid=swBid(sw),arr=TL(bid),n=arr.length,cg=curGroup(sw),col=(BR(cg)||{}).color||'#888';const dv=personalWeeks(sw)>0;
  const g=sv('g',{class:'mini'+(dv?' dv':'')+(vis?' vis':'')},svg);
  const bg=sv('rect',{x:0,y,width:n*cw,height:MINI,class:'mini-bg','data-act':'swrow','data-id':sw.id},g);stitle(bg,`${sw.name}: ${vis?'in '+gName(BR(vis))+' for part of the season':dv?'personal plan':'same as the group'} · click to open`);
  if(vis)arr.forEach(w=>{if(w.g!==vis)sv('rect',{x:w.i*cw,y:y+1,width:cw,height:MINI-2,class:'mini-out'},g);});
  arr.forEach(w=>{if(w.away)sv('rect',{x:w.i*cw+1,y:y+2,width:cw-2,height:MINI-4,rx:2,class:'away-ov'},g);
    const og=w.g!==cg?BR(w.g):null;const h=Math.max(1.5,Math.min(LMAX,w.load)/LMAX*(MINI-7));const r=sv('rect',{x:w.i*cw+cw*.28,y:y+MINI-4-h,width:Math.max(2,cw*.44),height:h,rx:1,class:'mb'+(w.diff||og?' dif':'')},g);if(w.diff)r.style.fill=col;else if(og)r.style.fill=og.color;});
  runs(arr,w=>w.g).forEach(r=>{if(r.k===cg)return;const gb=BR(r.k);if(!gb)return;const u=sv('rect',{x:r.start*cw+2,y:y+MINI-2.5,width:(r.end-r.start+1)*cw-4,height:2,rx:1},g);u.style.fill=gb.color;});
  diffRanges(bid).forEach(r=>{const u=sv('rect',{x:r.a*cw+2,y:y+MINI-2.5,width:(r.b-r.a+1)*cw-4,height:2,rx:1},g);u.style.fill=col;});
  sv('line',{x1:0,x2:n*cw,y1:y+MINI,y2:y+MINI,class:'mini-sep'},g);
}
function drawLane(svg,b,y0,cw){
  const g=sv('g',{class:'lane'+(b.kind==='swimmer'?' person':'')},svg);const arr=TL(b.id);const n=arr.length;const child=!!b.parent;
  sv('line',{x1:0,x2:n*cw,y1:y0,y2:y0,class:'lane-sep'},g);
  const yM=y0+5,yP=yM+L.MAC+1,yL=yP+L.MES+L.GAP,yC=yL+L.LOAD;
  runs(arr,w=>w.macro).forEach(r=>{const x=r.start*cw,w=(r.end-r.start+1)*cw;sv('rect',{x:x+.5,y:yM,width:w-1,height:L.MAC-2,rx:3,class:'mac '+mc(r.k)},g);
    const lbl=r.k==='–'?'Off season':r.k==='0'?'Pre-season':'Macro '+r.k;stext(g,x+5,yM+11,fit(w>90?lbl:(r.k==='–'?'Off':r.k==='0'?'Pre':'M'+r.k),w-8,6),'mac-t');});
  const pr=runs(arr,w=>w.p);
  pr.forEach(r=>{const x=r.start*cw,w=(r.end-r.start+1)*cw;const ph=S.plan.phases[r.k]||{name:'—'};const isSel=S.sel&&S.sel.type==='run'&&S.sel.bid===b.id&&S.sel.start===r.start;
    const rect=sv('rect',{x:x+.5,y:yP,width:w-1,height:L.MES-2,rx:4,class:'mes '+mc(String(ph.macro))+(isSel?' sel':''),'data-act':'run','data-bid':b.id,'data-start':r.start},g);
    stitle(rect,`${ph.name} · ${arr[r.start].code} → ${arr[r.end].code} · ${range(wkS(r.start),wkE(r.end))} · ${r.end-r.start+1} wk\n${ph.objective||''}`);
    stext(g,x+6,yP+13,fit(ph.name,w-10,5.7),'mes-t');stext(g,x+6,yP+26,fit(arr[r.start].code.replace(/\.\d+$/,'')+' · '+(r.end-r.start+1)+' wk',w-10,5.8),'mes-s');});
  if(child)arr.forEach(w=>{if(!w.diff)sv('rect',{x:w.i*cw,y:yM-1,width:cw,height:L.MAC+L.MES+2,class:'veil'},g);});
  pr.forEach((r,k)=>{if(!k)return;const x=r.start*cw;const me=arr[r.start].macro!==arr[r.start-1].macro;const y1=me?yM:yP,hh=(me?L.MAC+1:0)+L.MES-2;
    sv('line',{x1:x-2,x2:x-2,y1:y1+8,y2:y1+hh-8,class:'grip'},g);sv('line',{x1:x+2,x2:x+2,y1:y1+8,y2:y1+hh-8,class:'grip'},g);
    const hd=sv('rect',{x:x-(COARSE?12:7),y:y1,width:COARSE?24:14,height:hh,class:'handle','data-act':'bnd','data-bid':b.id,'data-j':r.start},g);stitle(hd,'Drag to move this boundary');});
  [.25,.5,.75,1].forEach(v=>{const y=yC-v/LMAX*L.LOAD;sv('line',{x1:0,x2:n*cw,y1:y,y2:y,class:v===1?'grid g100':'grid'},g);});
  // a bar chart with draggable top edges; used for overall load and for each component
  const chart=(top,hh,key,val,pval,dif,barCls)=>{const base=top+hh;
    sv('rect',{x:0,y:top-2,width:n*cw,height:hh+2,class:'zone','data-act':'zone','data-bid':b.id},g);
    arr.forEach(w=>{const v=val(w),h=Math.min(LMAX,Math.max(0,v))/LMAX*hh,x=w.i*cw,d=dif(w);
      const bar=sv('rect',{x:x+4,y:base-h,width:Math.max(2,cw-8),height:h,rx:2,class:barCls(w)+(child&&!d?' inh':'')+(d?' dif':'')},g);if(d)bar.style.stroke=b.color;
      if(w.camp){sv('rect',{x:x+2,y:top,width:cw-4,height:hh,rx:3,class:'campmark'},g);}
      if(cw>=34&&v>0){const t=stext(g,x+cw/2,base-h-3,(v>LMAX?'▲':'')+Math.round(v*100),'bar-v'+(d?' dif':''),'middle');if(d)t.style.fill=b.color;}});
    if(child)sv('polyline',{points:arr.map(w=>`${w.i*cw+cw/2},${base-Math.min(LMAX,pval(w)||0)/LMAX*hh}`).join(' '),class:'pline'},g);
    arr.forEach(w=>{const h=Math.min(LMAX,Math.max(0,val(w)))/LMAX*hh;const hd=sv('rect',{x:w.i*cw+2,y:base-h-(COARSE?14:7),width:cw-4,height:COARSE?28:13,class:'tophandle','data-act':'paint','data-bid':b.id,'data-y':top,'data-h':hh,'data-c':key},g);});};
  if(b.kind==='swimmer'){const gr=groupRuns(b.sw);const yS=yP+L.MES;
    if(gr.length>1)gr.forEach(r=>{const gb=BR(r.g);if(!gb)return;const x=r.a*cw,w=(r.b-r.a+1)*cw;const rr=sv('rect',{x:x+1,y:yS,width:w-2,height:11,rx:3,class:'gstrip'},g);rr.style.fill=gb.color;stitle(rr,`${gName(gb)} · ${range(wkS(r.a),wkE(r.b))}`);
      if(w>44)stext(g,x+5,yS+8.6,fit(gb.name,w-10,5),'gstrip-t');});}
  chart(yL,L.LOAD,'load',w=>w.load,w=>w.pload,w=>w.diff,w=>'bar '+mc(w.macro));
  if(b.kind==='swimmer')arr.forEach(w=>{if(!w.away)return;const x=w.i*cw;sv('rect',{x:x+1,y:yL-2,width:cw-2,height:L.LOAD+2,rx:3,class:'away-ov'},g);
    const ph=Math.min(LMAX,w.plan)/LMAX*L.LOAD;if(ph>0)sv('rect',{x:x+4,y:yC-ph,width:Math.max(2,cw-8),height:ph,rx:2,class:'ghostbar'},g);
    if(cw>=26)stext(g,x+cw/2,yL+8,awayShort(w.away.items[0].type),'away-t','middle');});
  if(b.kind==='swimmer'){const gw={};goalsOf(b.sw).forEach(gl=>{const x=goalInfo(b.sw,gl);if(x.wk!=null)(gw[x.wk]=gw[x.wk]||[]).push(gl);});
    Object.keys(gw).forEach(k=>{const st=sv('polygon',{points:starPts(+k*cw+cw/2+10,yL+3,5.5),class:'goalstar'+(gw[k].every(gl=>gl.done)?' done':'')},g);stitle(st,'Goal'+(gw[k].length>1?'s':'')+': '+gw[k].map(gl=>goalInfo(b.sw,gl).label+(gl.done?' (achieved)':'')).join('; '));});}
  arr.forEach(w=>{const ms=meetsInWeek(w.i).filter(c=>prioOf(b.id,c)==='A');if(!ms.length)return;const x=w.i*cw+cw/2;const f=sv('path',{d:`M${x-6},${yL-2} L${x+6},${yL-2} L${x},${yL+6} Z`},g);f.style.fill=b.color;stitle(f,'Target (A): '+ms.map(c=>c.name).join(', '));});
  arr.forEach(w=>{const t=stext(g,w.i*cw+cw/2,yC+12,cw<34&&w.code!=='Off'?w.code.split('.').slice(1).join('.'):w.code,'code'+(w.diff?' dif':''),'middle');if(w.diff)t.style.fill=b.color;});
  if(child)diffRanges(b.id).forEach(r=>{const u=sv('rect',{x:r.a*cw+2,y:yC+15,width:(r.b-r.a+1)*cw-4,height:3,rx:1.5},g);u.style.fill=b.color;});
  if(isX(b.id)){let yy=yC+L.CODE+L.PAD;COMPS.forEach(cp=>{sv('line',{x1:0,x2:n*cw,y1:yy,y2:yy,class:'comp-sep'},g);const top=yy+12,hh=CH-18;
      [.5,1].forEach(v=>{const y=top+hh-v/LMAX*hh;sv('line',{x1:0,x2:n*cw,y1:y,y2:y,class:v===1?'grid g100':'grid'},g);});
      chart(top,hh,cp.k,w=>w.c[cp.k],w=>w.pc?w.pc[cp.k]:0,w=>w.cd[cp.k],()=>'cbar c-'+cp.k);yy+=CH;});}
  if(b.kind==='swimmer'){const ring=sv('rect',{x:1,y:y0+1,width:n*cw-2,height:laneH(b.id)-2,rx:6,class:'focus-ring'},g);ring.style.stroke=b.color;}
}
function shortName(sw){const p=String(sw.name||'').trim().split(/\s+/);const f=p[0]||'';const dup=allSw().some(s=>s!==sw&&String(s.name||'').trim().split(/\s+/)[0]===f);return dup&&p.length>1?f+' '+p[p.length-1][0]:f;}
function nameSpans(sw){return `<span class="full">${esc(sw.name)}</span><span class="short">${esc(shortName(sw))}</span>`;}
function renderLabels(rs){
  const el=$('#tlLabels');$('#timeline').classList.toggle('slim',S.names==='short');const yP=5+L.MAC+1,yL=yP+L.MES+L.GAP;
  const yC0=yL+L.LOAD+L.CODE+L.PAD;
  const rowsLbl=bid=>`<div class="lab-rows" style="top:0;height:100%"><span style="top:${yL+L.LOAD-24}px">Load %</span><span style="top:${yL+L.LOAD+4}px">Code</span>${isX(bid)?COMPS.map((c,j)=>`<span class="cl c-${c.k}" style="top:${yC0+j*CH+CH/2-6}px">${c.short}</span>`).join(''):''}</div>`;
  const xbtn=bid=>`<button class="btn ghost sm" data-cmd="togglecomp" data-id="${esc(bid)}" aria-expanded="${isX(bid)}">${isX(bid)?'▾':'▸'} Load detail</button>`;
  let h=`<div class="lab-head" style="height:${L.HEAD}px"><span class="label full">Week</span><button class="namesbtn" data-cmd="names" aria-label="${S.names==='short'?'Show full names':'Make the names column narrow'}">${S.names==='short'?'Names ›':'‹ Narrow'}</button></div><div class="lab-cal" style="height:${L.CAL}px"><div class="label">Meets</div><div class="small muted full" style="margin-top:20px">Holidays · exams · camp</div></div>`;
  rs.forEach(r=>{const b=BR(r.bid);
    if(r.t==='lane'&&b.kind==='swimmer'){const sw=r.sw,arr=TL(b.id),dr=arr.filter(w=>w.diff).length,na=arr.filter(w=>w.away).length,g=BR(b.parent),mv=groupRuns(sw).length>1;
      h+=`<div class="lab-lane person" style="height:${r.h}px;--b:${esc(b.color)}"><button class="lab-name" data-cmd="selperson" data-id="${esc(sw.id)}">${esc(sw.name)}</button>
        <div class="lab-meta" title="${esc(groupStory(sw))}">${mv?esc(groupStory(sw)):'personal · '+esc(gName(g))}</div><div class="lab-meta">${dr?`${dr} wk own changes`:'no own changes'}${na?` · ${na} wk away`:''}</div>
        <div class="acts"><button class="btn sm" data-cmd="sheet" data-id="${esc(sw.id)}">Plan sheet</button><button class="btn ghost sm" data-cmd="focus" data-id="">Close</button>${xbtn(b.id)}</div>${rowsLbl(b.id)}</div>`;}
    else if(r.t==='lane'){const dr=b.parent?TL(b.id).filter(w=>w.diff).length:0;
      h+=`<div class="lab-lane" style="height:${r.h}px;--b:${esc(b.color)}"><button class="lab-name" data-cmd="selbranch" data-id="${esc(b.id)}">${esc(b.name)}</button>
        <div class="lab-meta">group · ${members(b.id).length} swimmer${members(b.id).length===1?'':'s'}</div>
        <div class="lab-meta">${b.parent?(dr?`${dr} wk differ from ${esc(BR(b.parent).name)}`:`same as ${esc(BR(b.parent).name)}`):'root plan'}</div><div class="acts">${xbtn(b.id)}</div>${rowsLbl(b.id)}</div>`;}
    else if(r.t==='grp'){h+=`<div class="lab-grp" style="height:${r.h}px"><button class="grp-tog" data-cmd="togglegroup" data-id="${esc(r.bid)}" aria-expanded="${r.open}">${r.open?'▾':'▸'} ${r.n}<span class="full"> swimmer${r.n===1?'':'s'}${r.v?` <span class="small muted">+${r.v} part-season</span>`:''}</span></button><span class="small muted full">${r.k?r.k+' personal':''}</span></div>`;}
    else if(r.vis){const rr=groupRuns(r.sw).filter(x=>x.g===r.vis);h+=`<div class="lab-mini vis" style="height:${r.h}px;--b:${esc(BR(r.vis).color)}"><button data-cmd="selperson" data-id="${esc(r.sw.id)}" title="${esc(r.sw.name)}: ${esc(groupStory(r.sw))}">${nameSpans(r.sw)}</button><span>${rr.map(x=>fd(wkS(x.a))+'–'+fd(wkE(x.b))).join(', ')}</span></div>`;}
    else{const dv=personalWeeks(r.sw),an=awayNow(r.sw);h+=`<div class="lab-mini${dv?' dv':''}" style="height:${r.h}px;--b:${esc(b.color)}"><button data-cmd="selperson" data-id="${esc(r.sw.id)}" title="Open ${esc(r.sw.name)}'s line${groupRuns(r.sw).length>1?' · '+esc(groupStory(r.sw)):''}">${nameSpans(r.sw)}</button><span>${an?`<b class="awayb">${esc(an.type)}</b>`:miniTag(r.sw)}</span></div>`;}});
  if(S.hidden.length)h+=`<div style="padding:8px 10px"><button class="btn sm" data-cmd="showall">Show hidden lanes (${S.hidden.length})</button></div>`;
  el.innerHTML=h;
}

/* ---------- timeline interaction ---------- */
let drag=null;
const tl=$('#tl');const tip=$('#tip');
function spt(e){const r=tl.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
function showTip(e,html){tip.innerHTML=html;tip.hidden=false;const w=tip.offsetWidth,hh=tip.offsetHeight;let x=e.clientX+14,y=e.clientY-hh-10;if(x+w>innerWidth-8)x=e.clientX-w-14;if(y<8)y=e.clientY+16;tip.style.left=x+'px';tip.style.top=y+'px';}
const hideTip=()=>{tip.hidden=true;};
/* A mouse acts straight away. A finger might be scrolling, so it opens things on a tap
   (lifted without moving) and changes the plan only after a press and hold. */
let press=null;
function tapAct(t){const a=t.dataset.act;
  if(a==='week'){select({type:'week',i:+t.dataset.i});return true;}
  if(a==='meet'){select({type:'meet',id:t.dataset.id});return true;}
  if(a==='run'){select({type:'run',bid:t.dataset.bid,start:+t.dataset.start});return true;}
  if(a==='swrow'){focusSwimmer(t.dataset.id,true);return true;}
  if(a==='event'){select({type:'event',id:t.dataset.id});return true;}
  return false;}
function startDrag(t,e){if(S.ro)return;const a=t.dataset.act;
  if(a==='bnd'){tl.setPointerCapture(e.pointerId);t.classList.add('on');drag={type:'bnd',bid:t.dataset.bid,j:+t.dataset.j,x0:e.clientX,base:JSON.stringify(S.plan),cur:+t.dataset.j};return;}
  if(a==='paint'){tl.setPointerCapture(e.pointerId);drag={type:'paint',bid:t.dataset.bid,top:+t.dataset.y,h:+t.dataset.h,c:t.dataset.c||'load',base:JSON.stringify(S.plan),last:null,moved:false,x0:e.clientX,y0:e.clientY};}}
/* A finger drag can't redraw the chart (the browser would lose the element under the finger
   and start scrolling), so it draws a light preview on top; the chart redraws on release. */
function touchMark(kind,a,b,v){let g=tl.querySelector('#tguide');if(!g)g=sv('g',{id:'tguide'},tl);
  if(kind==='bnd'){g.innerHTML='';const x=a*S.colW;sv('line',{x1:x,x2:x,y1:L.HEAD,y2:+tl.getAttribute('height'),class:'guide'},g);return;}
  const h=Math.min(LMAX,Math.max(0,v))/LMAX*drag.h,base=drag.top+drag.h;
  for(let k=a;k<=b;k++){const old=g.querySelector('[data-k="'+k+'"]');if(old)old.remove();sv('rect',{'data-k':k,x:k*S.colW+4,y:base-h,width:Math.max(2,S.colW-8),height:h,rx:2,class:'tbar'},g);}}
function tapAt(t,e){if(tapAct(t))return;const a=t.dataset.act;
  if(a==='zone'||a==='paint'){const i=Math.max(0,Math.min(NW()-1,Math.floor(spt(e).x/S.colW)));select({type:'week',i,bid:t.dataset.bid});return;}
  if(a==='bnd'){const r=runAt(t.dataset.bid,+t.dataset.j);if(r)select({type:'run',bid:t.dataset.bid,start:r.start});}}
tl.addEventListener('pointerdown',e=>{
  if(!S.plan)return;const t=e.target.closest('[data-act]');if(!t)return;const a=t.dataset.act;
  if(e.pointerType==='mouse'){if(tapAct(t))return;if(!S.ro&&(a==='bnd'||a==='paint'))e.preventDefault();startDrag(t,e);return;}
  if(press)clearTimeout(press.timer);
  const p={t,id:e.pointerId,x:e.clientX,y:e.clientY,timer:0};press=p;
  if(!S.ro&&(a==='bnd'||a==='paint'))p.timer=setTimeout(()=>{if(press!==p)return;press=null;
    try{startDrag(t,{pointerId:p.id,clientX:p.x,clientY:p.y});}catch(err){drag=null;return;}
    if(!drag)return;drag.touch=true;tl.classList.add('dragging');if(navigator.vibrate)navigator.vibrate(10);
    showTip({clientX:p.x,clientY:p.y},drag.type==='bnd'?'Slide left or right to move this edge':'Slide up or down to set the load');},420);
});
// While a finger is changing the plan, the page must not scroll under it.
tl.addEventListener('touchmove',e=>{if(drag)e.preventDefault();},{passive:false});
// double-click anywhere on a lane's charts (or a swimmer line) opens that week
tl.addEventListener('dblclick',e=>{if(!S.plan)return;const t=e.target.closest('[data-act="zone"],[data-act="paint"]');if(!t)return;const i=Math.max(0,Math.min(NW()-1,Math.floor(spt(e).x/S.colW)));select({type:'week',i,bid:t.dataset.bid});});
tl.addEventListener('pointermove',e=>{
  if(press&&e.pointerId===press.id){if(Math.abs(e.clientX-press.x)>8||Math.abs(e.clientY-press.y)>8){clearTimeout(press.timer);press=null;}return;}
  if(!drag){if(e.pointerType==='mouse')hover(e);return;}
  if(drag.type==='bnd'){const nj=drag.j+Math.round((e.clientX-drag.x0)/S.colW);if(nj!==drag.cur){S.plan=JSON.parse(drag.base);inval();drag.cur=moveBoundary(drag.bid,drag.j,nj);if(drag.touch)touchMark('bnd',drag.cur);else later(renderTimeline);}
    showTip(e,`Boundary → <b>w/c ${fd(wkS(drag.cur))}</b>`);}
  else{if(!drag.moved&&Math.abs(e.clientY-drag.y0)<3&&Math.abs(e.clientX-drag.x0)<3)return;drag.moved=true;paint(spt(e),e);}
});
function endDrag(){tl.classList.remove('dragging');if(!drag)return;const d=drag;drag=null;hideTip();if(d.type==='paint'&&!d.moved)return;
  if(JSON.stringify(S.plan)!==d.base){S.undo.push(`{"plan":${d.base},"roster":${JSON.stringify(S.roster)}}`);if(S.undo.length>60)S.undo.shift();S.redo=[];dirty('plan');}
  if(d.type==='bnd'&&d.cur===d.j){const r=runAt(d.bid,d.j);if(r)select({type:'run',bid:d.bid,start:r.start});else renderAll();}else renderAll();}
tl.addEventListener('pointerup',e=>{const p=press;if(p&&e.pointerId===p.id){press=null;clearTimeout(p.timer);tapAt(p.t,e);return;}endDrag();});
tl.addEventListener('pointercancel',()=>{if(press){clearTimeout(press.timer);press=null;}endDrag();});
tl.addEventListener('pointerleave',()=>{if(!drag)hideTip();});
function paint(p,e){const cw=S.colW,n=NW();const i=Math.max(0,Math.min(n-1,Math.floor(p.x/cw)));let v=(drag.top+drag.h-p.y)/drag.h*LMAX;v=Math.max(0,Math.min(LMAX,Math.round(v*20)/20));
  const a=drag.last==null?i:drag.last;const lo=Math.min(a,i),hi=Math.max(a,i);const pb=BR(drag.bid);for(let k=lo;k<=hi;k++){let vv=v;if(pb&&pb.kind==='swimmer'){const aw=awayIn(pb.sw,k);if(aw){const f=aw.F[drag.c];if(f<.05)continue;vv=Math.min(1.5,r2(v/f));}}if(drag.c==='load')setLoad(drag.bid,k,vv);else setComp(drag.bid,k,drag.c,vv);}drag.last=i;inval();if(drag.touch)touchMark('paint',lo,hi,v);else later(renderTimeline);
  const cl=drag.c==='load'?'Load':COMPS.find(c=>c.k===drag.c).label;
  showTip(e,`${esc(BR(drag.bid).name)} · w/c ${fd(wkS(i))}<br><b>${esc(cl)} ${Math.round(v*100)}%</b>${drag.c==='load'?' · '+(v*peakVol()/1000).toFixed(1)+' km':''}`);}
function hover(e){const t=e.target.closest('[data-act="zone"],[data-act="paint"]');if(!t||!t.dataset.bid){hideTip();return;}const p=spt(e);const i=Math.max(0,Math.min(NW()-1,Math.floor(p.x/S.colW)));const w=TL(t.dataset.bid)[i];const b=BR(t.dataset.bid);
  showTip(e,`<b>${esc(w.code)}</b> · w/c ${fd(wkS(i))}${w.camp?' · <b>camp</b>':''}<br>${esc(w.ph.name)}<br>Load ${pct(w.load)} · ${(w.load*peakVol()/1000).toFixed(1)} km${w.away?` <span style="opacity:.75">(planned ${pct(w.plan)})</span>`:''}<br>Aerobic ${pct(w.c.aer)} · Ana end ${pct(w.c.ana)} · Ana speed ${pct(w.c.spd)}${b.kind==='swimmer'&&w.g!==b.parent?`<br>Training with ${esc(gName(BR(w.g)))}`:''}${w.away?'<br><b>'+awayTxt(w.away)+'</b>':''}${w.diff&&w.g?`<br>Differs from ${esc(BR(w.g).name)}`:''}<br><span style="opacity:.75">${t.dataset.act==='paint'?'Drag to set':'Drag a bar\'s top edge · double-click to open the week'}</span>`);}
function select(s){S.sel=s;renderAll();if(S.view==='season'){const d=$('#detail');if(d&&s)d.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}}
function scrollToWeek(i){const sc=$('#tlScroll');sc.scrollLeft=Math.max(0,i*S.colW-sc.clientWidth/3);}

/* ---------- detail panel ---------- */
function renderDetail(){
  const d=$('#detail');const s=S.sel;
  if(!s){d.innerHTML=`<div class="d-head"><div><span class="label">How it works</span><h2>Pick something on the timeline</h2></div></div>
    <div class="tools"><div class="tool"><b>Move a boundary</b><span class="small muted">Drag the grip between two blocks (taller grips also move a macro boundary). Tapers re-shape themselves so race week stays the lightest.</span></div>
    <div class="tool"><b>Set the load</b><span class="small muted">Grab a bar's top edge and drag up or down; keep dragging sideways to draw a curve. Double-click a week to open it. 100% = ${(peakVol()/1000).toFixed(1)} km, a full week of your sessions.</span></div>
    <div class="tool"><b>Load detail</b><span class="small muted">"Load detail" on a lane opens aerobic, anaerobic endurance and anaerobic speed charts. Each one can drop or rise on its own; by default it follows the overall load and the meso's template.</span></div>
    <div class="tool"><b>Groups and swimmers</b><span class="small muted">A group copies its parent until you change something; so does each swimmer's line under their group. Hatched weeks match; weeks in colour are where they train differently. A swimmer can follow another group for a stretch of weeks.</span></div>
    <div class="tool"><b>Camps</b><span class="small muted">Click the camp bar under the meets to choose who's going. Attendees get the camp's load and schedule that week.</span></div></div>`;return;}
  if(s.type==='person')return detailPersonal(d,s);
  if(s.type==='branch'&&String(s.bid).startsWith('sw:'))return detailPersonal(d,{id:s.bid.slice(3)});
  if(s.type==='run')return detailRun(d,s);
  if(s.type==='week')return detailWeek(d,s);
  if(s.type==='branch')return detailBranch(d,s);
  if(s.type==='meet')return detailMeet(d,s);
  if(s.type==='event')return detailEvent(d,s);
}
/* copy weeks a–b from another plan (group) onto a group or swimmer line */
function copyTool(bid){const opts=lanes().filter(b=>b.id!==bid).map(b=>opt(b.id,'',b.name)).join('');const wk=Array.from({length:NW()},(_,i)=>i);
  return `<div class="tool"><b>Follow another group for a stretch</b><div class="row">Follow <select class="inp edit" id="cpSrc" style="width:auto">${opts}</select></div>
    <div class="row">from <select class="inp edit" id="cpA" style="width:auto">${wk.map(i=>opt(i,'',fd(wkS(i)))).join('')}</select> to <select class="inp edit" id="cpB" style="width:auto">${wk.map(i=>opt(i,NW()-1,fd(wkE(i)))).join('')}</select>
    <button class="btn sm edit" data-cmd="copyweeks" data-bid="${esc(bid)}">Apply</button></div>
    <span class="small muted">Copies that group's blocks and loads for those weeks, e.g. Nationals around Winter Nats. Use Reset to go back.</span></div>`;}
function detailEvent(d,s){
  const e=S.plan.events.find(x=>x.id===s.id);if(!e){S.sel=null;return renderDetail();}
  if(e.type!=='Camp'){d.innerHTML=`<div class="d-head"><div><span class="label">${esc(e.type)}</span><h2>${esc(e.name)}</h2><div class="chips"><span class="chip">${range(iso(e.start),iso(e.end))}</span></div></div><button class="btn sm" data-cmd="closesel">Close</button></div>`;return;}
  const c=e.camp||{},att=c.attendees||[],pv=peakVol();
  d.innerHTML=`<div class="d-head"><div><span class="label">Camp · ${range(iso(e.start),iso(e.end))}</span><h2>${esc(e.name)}</h2><div class="chips"><span class="chip">${att.length} going</span>${c.load!=null?`<span class="chip">${(c.load*pv/1000).toFixed(0)} km · ${pct(c.load)} of a home week</span>`:''}</div></div><button class="btn sm" data-cmd="closesel">Close</button></div>
  <p class="small muted" style="margin-top:0">Everyone ticked gets this camp's load and schedule for the camp week instead of their group's week, so it shows in colour on their line. Everyone else stays on the home programme.</p>
  <div class="tools">
    <div class="tool"><b>Who's going</b>${lanes().map(b=>members(b.id).length?`<div><div class="qsub">${esc(b.name)}</div><div class="chips">${members(b.id).map(sw=>`<label class="chip" style="cursor:pointer"><input type="checkbox" data-k="campatt" data-ev="${esc(e.id)}" data-id="${esc(sw.id)}"${att.includes(sw.id)?' checked':''}> ${esc(sw.name)}</label>`).join('')}</div></div>`:'').join('')}</div>
    <div class="tool"><b>Camp load</b>
      <div class="row"><span style="min-width:150px">Volume</span><input class="inp edit" type="number" step="1" min="0" data-k="campf" data-ev="${esc(e.id)}" data-f="km" value="${c.load!=null?(c.load*pv/1000).toFixed(0):''}" placeholder="km"> km</div>
      ${COMPS.map(cp=>`<div class="row"><span style="min-width:150px" class="cl">${cp.label}</span><input class="inp edit" type="number" step="5" min="0" data-k="campf" data-ev="${esc(e.id)}" data-f="${cp.k}" value="${c[cp.k]!=null?Math.round(c[cp.k]*100):''}" placeholder="auto"> %</div>`).join('')}
      <span class="small muted">Blank = worked out from the volume and the meso's template.</span></div>
  </div>
  <div class="d-head" style="margin:14px 0 0"><div><span class="label">Camp schedule</span></div><button class="btn sm edit" data-cmd="addcampsch" data-id="${esc(e.id)}">Add session</button></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Session</th><th>Focus</th><th></th></tr></thead><tbody>${(c.schedule||[]).map((r,k)=>`<tr><td><input class="inp" style="width:130px" data-k="campsch" data-ev="${esc(e.id)}" data-n="${k}" data-f="s" value="${esc(r.s)}"></td><td><input class="inp" style="width:100%;min-width:260px" data-k="campsch" data-ev="${esc(e.id)}" data-n="${k}" data-f="f" value="${esc(r.f)}"></td><td><button class="btn sm danger edit" data-cmd="delcampsch" data-id="${esc(e.id)}" data-n="${k}">Remove</button></td></tr>`).join('')||'<tr><td colspan="3" class="small muted">No sessions yet.</td></tr>'}</tbody></table></div>`;
}
function opt(v,cur,label){return `<option value="${esc(v)}"${String(v)===String(cur)?' selected':''}>${esc(label==null?v:label)}</option>`;}
function detailRun(d,s){
  const b=BR(s.bid);if(!b){S.sel=null;return renderDetail();}const arr=TL(b.id);let r=runAt(b.id,s.start);if(!r){S.sel=null;return renderDetail();}
  const ph=S.plan.phases[r.k];const ub=usedBy(r.k);const rr=runs(arr,w=>w.p);const ri=rr.findIndex(x=>x.start===r.start);const prev=rr[ri-1],next=rr[ri+1];
  const loads=arr.slice(r.start,r.end+1).map(w=>w.load);
  d.innerHTML=`<div class="d-head"><div><span class="label">Meso · ${esc(b.name)} branch</span><h2>${esc(ph.name)}</h2>
    <div class="chips"><span class="chip b" style="--b:${esc(b.color)}">${esc(arr[r.start].code)} → ${esc(arr[r.end].code)}</span><span class="chip">${range(wkS(r.start),wkE(r.end))}</span><span class="chip">${r.end-r.start+1} weeks</span><span class="chip">avg load ${pct(loads.reduce((a,c)=>a+c,0)/loads.length)}</span>${ub.length>1?`<span class="chip">shared by ${esc(ub.join(', '))}</span>`:''}</div></div>
    <div class="chips"><button class="btn sm" data-cmd="closesel">Close</button></div></div>
  <div class="form">
    <label>Name<input class="inp" data-k="ph" data-p="${esc(r.k)}" data-f="name" value="${esc(ph.name)}"></label>
    <label>Macro<select class="inp" data-k="ph" data-p="${esc(r.k)}" data-f="macro">${['0','1','2','3','–'].map(m=>opt(m,ph.macro,m==='0'?'0 · Pre-season':m==='–'?'– · Off-season':'Macro '+m)).join('')}</select></label>
    <label>Session template<select class="inp" data-k="ph" data-p="${esc(r.k)}" data-f="template">${S.plan.templates.map(t=>opt(t.name,ph.template)).join('')}</select></label>
    <label>Course emphasis<select class="inp" data-k="ph" data-p="${esc(r.k)}" data-f="course">${['SC','LC','SC/LC','–'].map(c=>opt(c,ph.course)).join('')}</select></label>
    <label class="wide">Objective<textarea class="inp" data-k="ph" data-p="${esc(r.k)}" data-f="objective">${esc(ph.objective||'')}</textarea></label>
  </div>
  ${ub.length>1?`<p class="small muted">Name, macro, template and objective are shared by ${esc(ub.join(', '))}. To change them for ${esc(b.name)} only, <button class="btn sm edit" data-cmd="forkphase" data-bid="${esc(b.id)}" data-start="${r.start}">make a ${esc(b.name)} copy</button></p>`:''}
  <div class="tools">
    <div class="tool"><b>Boundaries</b><div class="row"><span class="small muted" style="width:46px">Start</span><button class="btn sm edit" data-cmd="nudge" data-bid="${esc(b.id)}" data-j="${r.start}" data-d="-1" ${prev?'':'disabled'}>◀ 1 wk</button><button class="btn sm edit" data-cmd="nudge" data-bid="${esc(b.id)}" data-j="${r.start}" data-d="1" ${prev&&r.end>r.start?'':'disabled'}>1 wk ▶</button></div>
      <div class="row"><span class="small muted" style="width:46px">End</span><button class="btn sm edit" data-cmd="nudge" data-bid="${esc(b.id)}" data-j="${r.end+1}" data-d="-1" ${next&&r.end>r.start?'':'disabled'}>◀ 1 wk</button><button class="btn sm edit" data-cmd="nudge" data-bid="${esc(b.id)}" data-j="${r.end+1}" data-d="1" ${next?'':'disabled'}>1 wk ▶</button></div></div>
    <div class="tool"><b>Load for this block</b><div class="row">Ramp <input class="inp edit" type="number" min="0" max="110" step="5" id="rampA" value="${Math.round(loads[0]*100)}">% → <input class="inp edit" type="number" min="0" max="110" step="5" id="rampB" value="${Math.round(loads[loads.length-1]*100)}">% <button class="btn sm edit" data-cmd="ramp" data-bid="${esc(b.id)}" data-start="${r.start}">Apply</button></div>
      <div class="row">Taper profile <input class="inp edit" id="taperIn" style="width:150px" value="${esc((ph.taper||[]).map(x=>Math.round(x*100)).join(', '))}" placeholder="40, 65, 75"><button class="btn sm edit" data-cmd="taper" data-bid="${esc(b.id)}" data-start="${r.start}">Apply</button></div>
      <span class="small muted">Taper profile runs from race week backwards and keeps its shape when you move the block's edges. Leave it empty for a normal block.</span></div>
    <div class="tool"><b>Structure</b><div class="row">Split from <select class="inp edit" id="splitAt">${arr.slice(r.start+1,r.end+1).map(w=>opt(w.i,'',`w/c ${fd(wkS(w.i))}`)).join('')}</select><button class="btn sm edit" data-cmd="split" data-bid="${esc(b.id)}" data-start="${r.start}" ${r.end>r.start?'':'disabled'}>Split</button></div>
      <div class="row"><button class="btn sm edit" data-cmd="merge" data-bid="${esc(b.id)}" data-start="${r.start}" data-d="-1" ${prev?'':'disabled'}>Merge into previous</button><button class="btn sm edit" data-cmd="merge" data-bid="${esc(b.id)}" data-start="${r.start}" data-d="1" ${next?'':'disabled'}>Merge into next</button></div>
      ${b.parent?`<div class="row"><button class="btn sm edit" data-cmd="resetrange" data-bid="${esc(b.id)}" data-a="${r.start}" data-b="${r.end}">Reset these weeks to ${esc(BR(b.parent).name)}</button></div>`:''}</div>
  </div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Code</th><th>Week</th><th>Load %</th><th>Volume</th><th>Meets</th><th>Notes</th></tr></thead><tbody>
  ${arr.slice(r.start,r.end+1).map(w=>`<tr><td class="mono">${esc(w.code)}</td><td>${range(wkS(w.i),wkE(w.i))}</td><td class="num"><input class="inp t edit" type="number" min="0" max="110" step="5" data-k="wkload" data-bid="${esc(b.id)}" data-i="${w.i}" value="${Math.round(w.plan*100)}" style="width:66px"></td><td class="num">${(w.load*peakVol()/1000).toFixed(1)} km</td><td>${meetsInWeek(w.i).map(c=>esc(c.short||c.name)).join(', ')}</td><td class="small muted">${esc((S.plan.notes||{})[w.i]||'')}</td></tr>`).join('')}
  </tbody></table></div>`;
}
function detailWeek(d,s){
  const i=s.i;const ms=meetsInWeek(i),ev=eventsInWeek(i);const fsw=curSwimmer()&&planned(curSwimmer())?curSwimmer():null;const rowsB=lanes().concat(fsw?[BR(swBid(fsw))]:[]);
  const bsel=s.bid&&BR(s.bid)?s.bid:(fsw?swBid(fsw):rootId());const pv=peakVol();
  d.innerHTML=`<div class="d-head"><div><span class="label">Week ${i+1} of ${NW()}</span><h2>${fdow(wkS(i))} – ${fdow(wkE(i))}</h2>
    <div class="chips">${ms.map(c=>`<button class="chip" data-cmd="selmeet" data-id="${esc(c.id)}">${esc(c.name)} · ${esc(c.course)}</button>`).join('')}${ev.map(e=>e.type==='Camp'?`<button class="chip" data-cmd="selevent" data-id="${esc(e.id)}">${esc(e.name)} · ${((e.camp||{}).attendees||[]).length} going</button>`:`<span class="chip">${esc(e.name)}</span>`).join('')}${allSw().filter(planned).map(x=>({x,a:awayIn(x,i)})).filter(o=>o.a).map(o=>`<button class="chip awaychip" data-cmd="selperson" data-id="${esc(o.x.id)}" title="${esc(awayTxt(o.a).replace(/<br>/g,' · '))}">${esc(o.x.name)} · ${esc(o.a.items.map(a=>a.type).join(', '))}</button>`).join('')}</div></div>
    <div class="chips"><button class="btn sm" data-cmd="week" data-d="-1" ${i>0?'':'disabled'}>◀ Prev</button><button class="btn sm" data-cmd="week" data-d="1" ${i<NW()-1?'':'disabled'}>Next ▶</button><button class="btn sm" data-cmd="closesel">Close</button></div></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Plan</th><th>Code</th><th>Meso</th><th>Load %</th><th>Volume</th>${COMPS.map(c=>`<th class="cl" style="color:var(--${c.k})">${esc(c.short)} %</th>`).join('')}<th></th></tr></thead><tbody>
  ${rowsB.map(b=>{const x=TL(b.id)[i];return `<tr><td><b style="color:${esc(b.color)}">●</b> ${esc(b.name)}${b.kind==='swimmer'?' <span class="small muted">(personal)</span>':''}</td><td class="mono">${esc(x.code)}</td><td>${esc(x.ph.name)}</td><td class="num"><input class="inp t edit" type="number" min="0" max="300" step="5" data-k="wkload" data-bid="${esc(b.id)}" data-i="${i}" value="${Math.round(x.plan*100)}" style="width:66px"></td><td class="num">${(x.load*pv/1000).toFixed(1)} km${x.away?` <span class="small muted">of ${(x.plan*pv/1000).toFixed(1)}</span>`:''}</td>
    ${COMPS.map(cp=>`<td class="num"><input class="inp t edit" type="number" min="0" max="300" step="5" data-k="wkcomp" data-bid="${esc(b.id)}" data-i="${i}" data-c="${cp.k}" value="${Math.round(x.c0[cp.k]*100)}" style="width:62px${x.cd[cp.k]?';border-color:'+esc(b.color)+';font-weight:600':''}"></td>`).join('')}
    <td class="small">${x.camp?'<span class="near">camp week</span> ':''}${x.away?`<span class="awayb">${esc(x.away.items.map(a=>a.type).join(', '))}</span> `:''}${b.kind==='swimmer'&&x.g!==b.parent?`<span class="near">with ${esc(BR(x.g).name)}</span> `:''}${x.diff&&x.g?`<span class="near">differs from ${esc(BR(x.g).name)}</span>`:''}</td></tr>`;}).join('')}
  </tbody></table></div>
  ${weekSessions(i,bsel)}
  <label class="small muted" style="display:grid;gap:4px;margin-top:12px">Notes for this week<textarea class="inp" data-k="note" data-i="${i}">${esc((S.plan.notes||{})[i]||'')}</textarea></label>`;
}
function detailPersonal(d,s){
  const sw=S.roster&&S.roster.swimmers.find(x=>x.id===s.id);if(!sw||!planned(sw)){S.sel=null;return renderDetail();}
  const cg=curGroup(sw),g=BR(cg),vb=swBid(sw),dr=diffRanges(vb),me=macroEnds(vb),PX=persOf(sw.id),hasOwn=!!(PX.own||PX.ownPrio);
  const cal=[...S.plan.calendar].sort((a,b)=>a.start.localeCompare(b.start)).filter(c=>iso(c.end)>=today()-14*DAY);const first=sw.name.split(' ')[0];
  const gr=groupRuns(sw),mv=sw.moves||[],aw=awayFor(sw.id);const wk=Array.from({length:NW()-1},(_,i)=>i+1);
  const gsel=(cur,attrs)=>`<select class="inp" style="width:auto" ${attrs}>${lanes().map(b=>opt(b.id,cur,b.name)).join('')}</select>`;
  const other=(lanes().find(b=>b.id!==cg)||g).id;const ML={load:'Volume',aer:'Aerobic',ana:'Ana end',spd:'Ana speed'};
  const hit=a=>{let n=0;if(!a.from)return 0;const A=iso(a.from),Z=iso(a.to||a.from);for(let i=Math.max(0,weekOf(A));i<=Math.min(NW()-1,weekOf(Z));i++)S.plan.sessions.forEach(x=>{const t=wkS(i)+x.day*DAY;if(t>=A&&t<=Z)n++;});return n;};
  d.innerHTML=`<div class="d-head"><div><span class="label">Personal plan · ${esc(gName(g))}${gr.length>1?' this week':''}</span><h2>${esc(sw.name)}</h2>
    <div class="chips">${['1','2','3'].map(m=>`<span class="chip">Macro ${m}: ${me[m]?range(wkS(me[m].a),wkE(me[m].b)):'—'}</span>`).join('')}</div></div>
    <div class="chips"><button class="btn primary sm" data-cmd="sheet" data-id="${esc(sw.id)}">Plan sheet</button><button class="btn sm" data-cmd="focus" data-id="">← Back to groups</button></div></div>
  <p class="small muted" style="margin-top:0">${esc(first)}'s line follows whichever group they're in that week, including later changes to that group. Weeks you change on their lane show in colour. Time away cuts their load without touching the group.</p>
  <div class="tools">
    <div class="tool goals"><b>Personal goals</b>
      ${goalsOf(sw).map((g,n)=>{const x=goalInfo(sw,g);const at=`data-id="${esc(sw.id)}" data-n="${n}"`;const st=goalStatus(sw,g);return `<div class="goalrow${g.done?' done':''}">
        <div class="row"><input class="inp" data-k="goal" ${at} data-f="text" value="${esc(g.text||'')}" placeholder="e.g. Sub 28.0 in 50 Fly, or 10m underwater off every wall" style="flex:1;min-width:200px"><button class="btn sm danger edit" data-cmd="delgoal" ${at}>Remove</button></div>
        <div class="row small"><select class="inp" data-k="goal" ${at} data-f="event" style="width:auto" aria-label="Event">${opt('',g.event||'','No event')}${(sw.events||[]).map(e=>opt(e.e,g.event||'',e.e)).join('')}</select>
          <input class="inp t" data-k="goaltime" ${at} value="${ft(g.target)}" placeholder="target" style="width:76px" aria-label="Target time">
          <select class="inp" data-k="goal" ${at} data-f="course" style="width:auto" aria-label="Course"${x.c&&x.c.course?' disabled title="Set by the meet"':''}>${['SC','LC'].map(c=>opt(c,x.course,c)).join('')}</select>
          <select class="inp" data-k="goal" ${at} data-f="meet" style="width:auto;max-width:190px" aria-label="By meet">${opt('',g.meet||'','Any time this season')}${[...S.plan.calendar].sort((a,b)=>a.start.localeCompare(b.start)).map(c=>opt(c.id,g.meet||'','By '+(c.short||c.name)+' · '+fd(iso(c.start)))).join('')}</select>
          <label class="modl"><input type="checkbox" data-k="goaldone" ${at}${g.done?' checked':''}> Achieved</label></div>
        ${st?`<span class="small ${g.done||(x.gap!=null&&x.gap<=0)?'pos':'muted'}">${esc(st)}</span>`:''}</div>`;}).join('')||'<span class="small muted">No goals yet. A goal tied to a meet puts a star on their line that week. All goals go on their plan sheet.</span>'}
      <div class="row"><button class="btn sm edit" data-cmd="addgoal" data-id="${esc(sw.id)}">+ Add goal</button></div></div>
    <div class="tool"><b>Group over the season</b>
      <div class="gtrack">${gr.map(r=>{const gb=BR(r.g);return `<span style="--b:${esc(gb.color)};flex:${r.b-r.a+1}" title="${esc(gName(gb))} · ${range(wkS(r.a),wkE(r.b))}"><b>${esc(gb.name)}</b><i>${fd(wkS(r.a))}</i></span>`;}).join('')}</div>
      <div class="row"><span class="mvl">Starts in</span>${gsel(sw.branch,`data-k="swbranch" data-id="${esc(sw.id)}"`)}</div>
      ${mv.map((m,n)=>`<div class="row"><span class="mvl">From w/c</span><select class="inp" data-k="mvw" data-id="${esc(sw.id)}" data-n="${n}" style="width:auto">${wk.map(i=>opt(i,m.w,fd(wkS(i)))).join('')}</select><span>→</span>${gsel(m.to,`data-k="mvto" data-id="${esc(sw.id)}" data-n="${n}"`)}<button class="btn sm danger edit" data-cmd="delmove" data-id="${esc(sw.id)}" data-n="${n}">Remove</button></div>`).join('')}
      <div class="row addrow"><span class="mvl">Move from w/c</span><select class="inp edit" id="mvW" style="width:auto">${wk.map(i=>opt(i,Math.min(NW()-1,nowWk()+1),fd(wkS(i)))).join('')}</select><span>→</span>${gsel(other,'id="mvTo"')}<button class="btn sm edit" data-cmd="addmove" data-id="${esc(sw.id)}">Add move</button></div>
      <span class="small muted">For example: Regionals group until East Regions, Nationals from the Monday after, back in January. While they're in a group they take that group's plan. Changes you make on their line there stay with that group, and earlier ones are kept for when they're back. Ticking or dragging someone into a group moves them from this week.</span></div>
    <div class="tool"><b>Holidays, injury and illness</b>
      ${aw.map((a,n)=>{const m=Object.assign({},INJ,a.mods||{});const k=hit(a);const at=`data-id="${esc(sw.id)}" data-n="${n}"`;return `<div class="awrow t-${esc(a.type)}">
        <div class="row"><select class="inp" data-k="away" ${at} data-f="type" style="width:auto">${AWT.map(t=>opt(t,a.type)).join('')}</select><input class="inp" type="date" data-k="away" ${at} data-f="from" value="${esc(a.from||'')}" aria-label="From"><span>to</span><input class="inp" type="date" data-k="away" ${at} data-f="to" value="${esc(a.to||'')}" aria-label="To"><button class="btn sm danger edit" data-cmd="delaway" ${at}>Remove</button></div>
        <div class="row"><input class="inp" data-k="away" ${at} data-f="note" value="${esc(a.note||'')}" placeholder="${a.type==='Injury'?'What and what they can do, e.g. shoulder: kick and legs only':'Note, e.g. family holiday'}" style="flex:1;min-width:200px"></div>
        ${a.type==='Injury'?`<div class="row small"><span class="muted">Trains at</span>${['load','aer','ana','spd'].map(x=>`<label class="modl">${ML[x]} <input class="inp t" type="number" step="5" min="0" max="150" data-k="awaymod" ${at} data-f="${x}" value="${Math.round(m[x]*100)}" style="width:60px">%</label>`).join('')}</div>`:''}
        <span class="small muted">${k?(a.type==='Injury'?`${k} session${k===1?'':'s'} modified`:`misses ${k} session${k===1?'':'s'}`):'no sessions in these dates'}</span></div>`;}).join('')||'<span class="small muted">Nothing entered. Add one and their load drops for the sessions it covers.</span>'}
      <div class="row">${AWT.map(t=>`<button class="btn sm edit" data-cmd="addaway" data-id="${esc(sw.id)}" data-t="${t}">+ ${t}</button>`).join('')}</div>
      <span class="small muted">Missed sessions come off that week's load. With an injury they keep training at the percentages you set.</span></div>
    <div class="tool"><b>Their own changes</b>${dr.length?dr.map(r=>`<div class="row"><span>${range(wkS(r.a),wkE(r.b))} · ${r.b-r.a+1} wk</span><button class="btn sm edit" data-cmd="resetrange" data-bid="${esc(vb)}" data-a="${r.a}" data-b="${r.b}">Reset</button></div>`).join(''):'<span class="small muted">No training weeks of their own: they match their group every week.</span>'}
      ${dormantRuns(sw).map(r=>`<div class="row small muted"><span>${range(wkS(r.a),wkE(r.b))}: ${r.b-r.a+1} wk of changes made in ${esc((BR(r.g)||{}).name||'another group')}, not used while they're in ${esc((BR(groupAt(sw,r.a))||{}).name||'')}</span><button class="btn sm edit" data-cmd="deldormant" data-id="${esc(sw.id)}" data-g="${esc(r.g)}" data-a="${r.a}" data-b="${r.b}">Delete</button></div>`).join('')}
      ${dr.length||hasOwn?`<div class="row"><button class="btn sm danger edit" data-cmd="resetperson" data-id="${esc(sw.id)}">Reset own changes and targets</button></div>`:''}
      <label class="small muted" style="display:grid;gap:4px">Notes<textarea class="inp" data-k="swnote" data-id="${esc(sw.id)}">${esc(sw.note||'')}</textarea></label></div>
  </div>
  <div class="d-head" style="margin:16px 0 0"><div><span class="label">Meet targets for ${esc(first)}</span><div class="small muted">Leave "as group" unless ${esc(first)} is aiming at a meet differently. The group is whichever one they're in that week. A personal A puts a target flag on their line and plan sheet.</div></div></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Meet</th><th>Dates</th><th>Group</th><th>${esc(first)}</th></tr></thead><tbody>
  ${cal.map(c=>{const gm=BR(groupAt(sw,meetWk(c)))||g;const gp=(c.prio||{})[gm.id]||'—',own=ownPrio(sw,c);return `<tr><td>${esc(c.name)}</td><td style="white-space:nowrap">${range(iso(c.start),iso(c.end))}</td><td>${esc(gp)} <span class="small muted">${esc(gm.name)}</span></td><td><select class="inp" data-k="pprio" data-id="${esc(sw.id)}" data-c="${esc(c.id)}"${own&&own!==gp?' style="border-color:'+esc(gm.color)+';font-weight:600"':''}>${opt('',own,'As group ('+gp+')')}${['A','B','C','—'].map(p=>opt(p,own,p)).join('')}</select></td></tr>`;}).join('')}</tbody></table></div>`;
}
function detailBranch(d,s){
  const b=BR(s.bid);if(!b){S.sel=null;return renderDetail();}const dr=diffRanges(b.id);const me=macroEnds(b.id);const kids=S.plan.branches.filter(x=>x.parent===b.id);
  const desc=new Set();(function walk(id){S.plan.branches.filter(x=>x.parent===id).forEach(x=>{desc.add(x.id);walk(x.id);});})(b.id);
  const all=S.roster?S.roster.swimmers.filter(planned).sort((a,c)=>a.name.localeCompare(c.name)):[];
  d.innerHTML=`<div class="d-head"><div><span class="label">Group${b.parent?' · follows '+esc(BR(b.parent).name):' · root plan'}</span><h2 style="color:${esc(b.color)}">${esc(b.name)}</h2>
    <div class="chips">${['1','2','3'].map(m=>`<span class="chip">Macro ${m}: ${me[m]?range(wkS(me[m].a),wkE(me[m].b)):'—'}</span>`).join('')}</div></div>
    <div class="chips"><button class="btn sm" data-cmd="hidelane" data-id="${esc(b.id)}">Hide lane</button><button class="btn sm" data-cmd="closesel">Close</button></div></div>
  <div class="form"><label>Name<input class="inp" data-k="br" data-id="${esc(b.id)}" data-f="name" value="${esc(b.name)}"></label>
    <label>Colour<input class="inp" type="color" data-k="br" data-id="${esc(b.id)}" data-f="color" value="${esc(b.color)}" style="height:36px;padding:2px"></label>
    ${b.parent?`<label>Follows<select class="inp" data-k="brparent" data-id="${esc(b.id)}">${lanes().filter(x=>x.id!==b.id&&!desc.has(x.id)).map(x=>opt(x.id,b.parent,x.name)).join('')}</select></label>`:''}
    <label class="wide">Who and why<textarea class="inp" data-k="br" data-id="${esc(b.id)}" data-f="note">${esc(b.note||'')}</textarea></label></div>
  <div class="tools">
    <div class="tool"><b>Who's in ${esc(b.name)} this week (${members(b.id).length})</b><span class="small muted">Tick to move a swimmer in from w/c ${fd(wkS(nowWk()))}; untick to move them back to ${b.parent?esc(BR(b.parent).name):'the first group'}. Weeks before stay as they were. To plan a move for later, open the swimmer.</span>
      <div class="chips">${all.map(m=>{const cur=curGroup(m)===b.id;const part=!cur&&groupRuns(m).some(r=>r.g===b.id);return `<label class="chip" style="cursor:pointer${cur?';font-weight:600;border-color:'+esc(b.color):''}"><input type="checkbox" data-k="brmember" data-bid="${esc(b.id)}" data-id="${esc(m.id)}"${cur?' checked':''}> ${esc(m.name)}${!cur?` <span class="small muted">· ${esc((BR(curGroup(m))||{}).name||'')}${part?', here '+groupRuns(m).filter(r=>r.g===b.id).map(r=>fd(wkS(r.a))+'–'+fd(wkE(r.b))).join(', '):''}</span>`:''}</label>`;}).join('')}</div></div>
    ${b.parent?copyTool(b.id):''}
    ${b.parent?`<div class="tool"><b>Where it differs from ${esc(BR(b.parent).name)}</b>${dr.length?dr.map(r=>`<div class="row"><span>${range(wkS(r.a),wkE(r.b))} · ${r.b-r.a+1} wk</span><button class="btn sm edit" data-cmd="resetrange" data-bid="${esc(b.id)}" data-a="${r.a}" data-b="${r.b}">Reset</button></div>`).join(''):'<span class="small muted">Identical to its parent. Drag a boundary or the bars in this lane to fork it.</span>'}</div>`:''}
    <div class="tool"><b>Group actions</b><div class="row"><button class="btn sm edit" data-cmd="addbranch" data-id="${esc(b.id)}">New group that follows ${esc(b.name)}</button></div>
      ${b.parent?`<div class="row"><button class="btn sm danger edit" data-cmd="delbranch" data-id="${esc(b.id)}" ${kids.length?'disabled title="Delete the groups that follow it first"':''}>Delete group</button></div><span class="small muted">Deleting moves its swimmers to ${esc(BR(b.parent).name)}; their personal changes stay.</span>`:''}</div>
  </div>`;
}
function detailMeet(d,s){
  const c=S.plan.calendar.find(x=>x.id===s.id);if(!c){S.sel=null;return renderDetail();}
  d.innerHTML=`<div class="d-head"><div><span class="label">Meet</span><h2>${esc(c.name)}</h2><div class="chips"><span class="chip">${range(iso(c.start),iso(c.end))}</span><span class="chip">${esc(c.course)}</span>${c.venue?`<span class="chip">${esc(c.venue)}</span>`:''}${c.level?`<span class="chip">${esc(c.level)}</span>`:''}</div></div><div class="chips"><button class="btn sm" data-cmd="closesel">Close</button></div></div>
  ${meetForm(c)}
  <div class="tool" style="margin-top:12px"><b>Priority by branch</b><span class="small muted">A = peak (flag on the lane), B = rest-in, C = train through, — = not entered.</span><div class="row">${lanes().map(b=>`<label class="small" style="display:flex;gap:6px;align-items:center"><b style="color:${esc(b.color)}">●</b>${esc(b.name)}<select class="inp" data-k="prio" data-id="${esc(c.id)}" data-b="${esc(b.id)}">${['A','B','C','—'].map(p=>opt(p,(c.prio||{})[b.id]||'—')).join('')}</select></label>`).join('')}</div></div>
  ${qtKey(c)&&S.roster?`<div style="margin-top:12px">${qualCard(qtKey(c))}</div>`:''}`;
}
function meetForm(c){return `<div class="form">
  <label>Name<input class="inp" data-k="meet" data-id="${esc(c.id)}" data-f="name" value="${esc(c.name)}"></label>
  <label>Short label<input class="inp" data-k="meet" data-id="${esc(c.id)}" data-f="short" value="${esc(c.short||'')}"></label>
  <label>Starts<input class="inp" type="date" data-k="meet" data-id="${esc(c.id)}" data-f="start" value="${esc(c.start)}"></label>
  <label>Ends<input class="inp" type="date" data-k="meet" data-id="${esc(c.id)}" data-f="end" value="${esc(c.end)}"></label>
  <label>Course<select class="inp" data-k="meet" data-id="${esc(c.id)}" data-f="course">${['','25m','50m'].map(x=>opt(x,c.course||'',x||'TBC')).join('')}</select></label>
  <label>Venue<input class="inp" data-k="meet" data-id="${esc(c.id)}" data-f="venue" value="${esc(c.venue||'')}"></label>
  <label>Licence level<input class="inp" data-k="meet" data-id="${esc(c.id)}" data-f="level" value="${esc(c.level||'')}"></label>
  <label>Qualifying times<select class="inp" data-k="meet" data-id="${esc(c.id)}" data-f="qt">${[['','None'],['nats','Winter Nationals'],['er','East Region SC']].map(([v,l])=>opt(v,qtKey(c),l)).join('')}</select></label>
  <label class="wide">Notes<textarea class="inp" data-k="meet" data-id="${esc(c.id)}" data-f="note">${esc(c.note||'')}</textarea></label></div>`;}

/* ---------- squad ---------- */
function renderSquad(){
  const v=$('#v-squad');if(!S.roster){v.innerHTML='<div class="card empty"><h2>No squad loaded</h2></div>';return;}
  const sw=curSwimmer();
  v.innerHTML=`<div class="qboard">${qualCard('nats')}${qualCard('er')}</div>
  <div class="toolbar"><span class="label">Groups</span><span class="small muted">Drag a swimmer onto a group, or open one and change their group. Their plan follows the group, plus any personal changes.</span><div class="grow"></div><button class="btn sm edit" data-cmd="addswimmer">+ Add swimmer</button><button class="btn sm edit" data-cmd="newgroup">+ New group</button></div>
  <div class="split"><div class="squad-cols">${lanes().map(b=>`<div class="card scol" style="--b:${esc(b.color)}" data-drop="${esc(b.id)}"><h3>${esc(b.name)}<span>${members(b.id).length}</span></h3><div class="swl">${members(b.id).map(m=>chip(m)).join('')||'<span class="small muted">Drop swimmers here</span>'}</div></div>`).join('')}
    <div class="card scol" style="--b:var(--line)" data-drop=""><h3>Not planned<span>${unplanned().length}</span></h3><div class="small muted" style="margin:-4px 0 8px">Uniboard / visiting: listed for qualifying, no training plan</div><div class="swl">${unplanned().map(m=>chip(m)).join('')||'<span class="small muted">Drop swimmers here to take them off the plan</span>'}</div></div></div>
  <div class="card detail" id="swDetail">${S.adding?addForm():sw?swDetail(sw):'<span class="label">Swimmer</span><h2>Pick a swimmer</h2><p class="muted">Their details, events, qualifying status and plan sheet open here. Use "+ Add swimmer" for someone new.</p>'}</div></div>`;
}
const yob=sw=>sw.dob?+String(sw.dob).slice(0,4):null;
function chip(m){const st=stats(m);const ng=goalsOf(m).filter(g=>!g.done).length;return `<div role="button" tabindex="0" class="swc${m.id===S.focus?' sel':''}" draggable="${S.ro?'false':'true'}" data-sw="${esc(m.id)}" data-cmd="focus" data-id="${esc(m.id)}"><b>${esc(m.name)}</b><span class="meta">${esc(m.g)} · ${yob(m)||'DOB not set'}${m.camp?' · camp':''}${/uni/i.test(m.tag||'')?' · Uniboard':''}</span>
  <span class="bdg">${planned(m)&&awayNow(m)?`<span class="badge away">${esc(awayNow(m).type)}</span>`:''}${planned(m)&&nextMove(m)?`<span class="badge e" style="border-color:${esc(BR(nextMove(m).to).color)};color:var(--ink)">→ ${esc(BR(nextMove(m).to).name)} ${fd(wkS(nextMove(m).w))}</span>`:''}${personalDiff(m)||personalPrio(m).length?`<span class="badge e" style="border-color:${esc((BR(curGroup(m))||{}).color||'')};color:var(--ink)">Personal plan</span>`:''}${ng?`<span class="badge goal">${ng} goal${ng===1?'':'s'}</span>`:''}${st.nq.length?`<span class="badge q">Nats ×${st.nq.length}</span>`:''}${!st.nq.length&&st.near.length?`<span class="badge n">Nats ${esc(st.near[0].e)} +${(st.near[0].g*100).toFixed(1)}%</span>`:''}${st.eq.length?`<span class="badge r">Regionals ×${st.eq.length}</span>`:`<span class="badge e">No regionals QT</span>`}${!st.eq.length&&st.enear.length?`<span class="badge n">ER ${esc(st.enear[0].e)} +${(st.enear[0].g*100).toFixed(1)}%</span>`:''}</span></div>`;}
/* events, in the usual order: the QT tables plus anything a swimmer already has */
const STK=['Free','Back','Breast','Fly','IM'];
function evRank(e){const m=String(e).match(/^(\d+)\s+(.+)$/);if(!m)return 1e6;const k=STK.indexOf(m[2]);return (k<0?9:k)*1e4+(+m[1]);}
function allEvents(){const s=new Set();if(S.roster){Object.keys(S.roster.qts.nats||{}).forEach(e=>s.add(e));Object.keys(S.roster.qts.er||{}).forEach(e=>s.add(e));S.roster.swimmers.forEach(w=>(w.events||[]).forEach(x=>s.add(x.e)));}return [...s].sort((a,b)=>evRank(a)-evRank(b));}
const blankEv=e=>({e,sc:null,lc:null,sb:null,wn:null,wm:null,wd:null,wc:null,er:null,em:null});
function addForm(){const evs=allEvents();
  return `<div class="d-head"><div><span class="label">New swimmer</span><h2>Add a swimmer</h2></div><button class="btn sm" data-cmd="canceladd">Cancel</button></div>
  <div class="form">
    <label>Name<input class="inp" id="nsName" placeholder="First and last name" autocomplete="off"></label>
    <label>Sex<select class="inp" id="nsG"><option value="M">M</option><option value="F">F</option></select></label>
    <label>Date of birth<input class="inp" type="date" id="nsDob"></label>
    <label>Swim England number<input class="inp" id="nsId" inputmode="numeric" placeholder="Optional" autocomplete="off"></label>
    <label>Group<select class="inp" id="nsGrp">${lanes().map(b=>opt(b.id,rootId(),b.name)).join('')}${opt('','x','Not planned (Uniboard / visiting)')}</select></label>
    <label class="wide">Events<span class="chips" style="margin-top:2px">${evs.map(e=>`<label class="chip" style="cursor:pointer"><input type="checkbox" class="nsEv" value="${esc(e)}"> ${esc(e)}</label>`).join('')}</span></label></div>
  <div class="toolbar" style="margin-top:12px"><button class="btn primary sm edit" data-cmd="createswimmer">Add swimmer</button><span class="small muted" id="nsMsg">Date of birth sets their Winter Nats age band. Times can be typed in once they're added.</span></div>`;}
function swDetail(sw){const st=stats(sw);const y=yob(sw);const have=new Set((sw.events||[]).map(x=>x.e));const free=allEvents().filter(e=>!have.has(e));const id=esc(sw.id);
  return `<div class="d-head"><div><span class="label">${esc(String(sw.tag||'').replace(/_/g,' '))}${sw.camp?' · camp '+esc(sw.camp):''}</span><h2>${esc(sw.name)}</h2>
    <div class="chips"><span class="chip">${esc(sw.g)} · ${y?'born '+y+' · Nats band '+band(y):'date of birth not set'}</span>${st.close&&!st.nq.length?`<span class="chip">closest Nats QT: ${esc(st.close.e)} +${(st.close.g*100).toFixed(1)}%</span>`:''}</div></div>
    <div class="chips"><button class="btn primary sm" data-cmd="sheet" data-id="${id}" ${planned(sw)?'':'disabled title="Not on a plan"'}>Plan sheet</button><button class="btn sm" data-cmd="showplan" data-id="${id}" ${planned(sw)?'':'disabled'}>Show on timeline</button><button class="btn sm danger edit" data-cmd="delswimmer" data-id="${id}">Delete swimmer</button></div></div>
  <div class="form">
    <label>Name<input class="inp" data-k="swf" data-f="name" data-id="${id}" value="${esc(sw.name)}"></label>
    <label>Sex<select class="inp" data-k="swf" data-f="g" data-id="${id}">${['M','F'].map(g=>opt(g,sw.g)).join('')}</select></label>
    <label>Date of birth<input class="inp" type="date" data-k="swf" data-f="dob" data-id="${id}" value="${esc(sw.dob||'')}"></label>
    <label>Group from this week<select class="inp" data-k="swnow" data-id="${id}">${lanes().map(b=>opt(b.id,planned(sw)?curGroup(sw):'',b.name)).join('')}${opt('',planned(sw)?curGroup(sw):'','Not planned (Uniboard / visiting)')}</select></label>
    ${planned(sw)&&groupRuns(sw).length>1?`<label class="wide">Season<span class="small" style="font-weight:400">${esc(groupStory(sw))}</span></label>`:''}
    <label class="wide">Notes<textarea class="inp" data-k="swnote" data-id="${id}">${esc(sw.note||'')}</textarea></label></div>
  ${planned(sw)&&goalsOf(sw).length?`<div class="tool" style="margin-top:12px"><b>Goals</b>${goalsOf(sw).map(g=>goalLine(sw,g)).join('')}<span class="small muted">Edit goals from ${esc(sw.name.split(' ')[0])}'s plan on the Season tab.</span></div>`:''}
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Event</th><th>SC PB</th><th>LC PB</th><th>Nats best</th><th>Nats QT</th><th>Gap</th><th>ER SC best</th><th>ER QT</th><th></th></tr></thead><tbody>
  ${(sw.events||[]).map((ev,k)=>{const q=qtN(sw,ev.e),r=qtE(sw,ev.e);const g=q&&ev.wn?(ev.wn-q)/q:null;const eg=r&&ev.er?(ev.er-r)/r:null;const at=`data-k="swtime" data-id="${id}" data-n="${k}"`;
    return `<tr><td><b>${esc(ev.e)}</b></td><td class="num"><input class="inp t" ${at} data-f="sc" value="${ft(ev.sc)}" placeholder="—"></td><td class="num"><input class="inp t" ${at} data-f="lc" value="${ft(ev.lc)}" placeholder="—"></td>
    <td class="num"><input class="inp t" ${at} data-f="wn" value="${ft(ev.wn)}" placeholder="—" title="${esc(ev.wm?ev.wm+' · '+ev.wd+' · '+(ev.wc||''):'Fastest L1/2 swim since 1 Sep 2025')}"></td>
    <td class="num">${ft(q)}</td><td class="num ${g==null?'':g<=0?'pos':g<=S.plan.settings.near?'near':''}">${g==null?'':g<=0?'Q':'+'+(g*100).toFixed(1)+'%'}</td>
    <td class="num"><input class="inp t" ${at} data-f="er" value="${ft(ev.er)}" placeholder="—" title="${esc(ev.em||'Fastest 25m L1–3 swim since 1 Jan 2025')}"> ${eg!=null&&eg<=0?'<span class="pos">Q</span>':''}</td><td class="num">${ft(r)}</td>
    <td><button class="btn sm ghost danger edit" data-cmd="delevent" data-id="${id}" data-n="${k}" title="Remove ${esc(ev.e)}" aria-label="Remove ${esc(ev.e)}">Remove</button></td></tr>`;}).join('')||'<tr><td colspan="9" class="small muted">No events yet. Add one below.</td></tr>'}
  </tbody></table></div>
  <div class="toolbar" style="margin-top:8px"><select class="inp edit" id="addEv" style="width:auto">${free.map(e=>opt(e,'',e)).join('')}</select><button class="btn sm edit" data-cmd="addevent" data-id="${id}" ${free.length?'':'disabled'}>Add event</button></div>
  <p class="small muted">${esc(S.roster.rules.nats)}<br>${esc(S.roster.rules.er)}<br>Times from ${esc(S.roster.source)}. Type a new time (e.g. 26.31 or 1:02.45) after a meet.</p>`;}

/* ---------- calendar + sessions views ---------- */
function renderCalendar(){
  const v=$('#v-calendar');const cal=[...S.plan.calendar].sort((a,b)=>a.start.localeCompare(b.start));
  v.innerHTML=`<div class="card detail"><div class="d-head"><div><span class="label">Competitions</span><h2>Meets ${S.plan.settings.season}</h2></div><button class="btn primary sm edit" data-cmd="addmeet">Add meet</button></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Meet</th><th>Short</th><th>Starts</th><th>Ends</th><th>Course</th><th>Lvl</th>${lanes().map(b=>`<th style="color:${esc(b.color)}">${esc(b.name)}</th>`).join('')}<th></th></tr></thead><tbody>
  ${cal.map(c=>`<tr><td><input class="inp" style="min-width:210px" data-k="meet" data-id="${esc(c.id)}" data-f="name" value="${esc(c.name)}"></td><td><input class="inp" style="width:110px" data-k="meet" data-id="${esc(c.id)}" data-f="short" value="${esc(c.short||'')}"></td>
    <td><input class="inp" type="date" data-k="meet" data-id="${esc(c.id)}" data-f="start" value="${esc(c.start)}"></td><td><input class="inp" type="date" data-k="meet" data-id="${esc(c.id)}" data-f="end" value="${esc(c.end)}"></td>
    <td><select class="inp" data-k="meet" data-id="${esc(c.id)}" data-f="course">${['','25m','50m'].map(x=>opt(x,c.course||'',x||'TBC')).join('')}</select></td><td><input class="inp" style="width:52px" data-k="meet" data-id="${esc(c.id)}" data-f="level" value="${esc(c.level||'')}"></td>
    ${lanes().map(b=>`<td><select class="inp" data-k="prio" data-id="${esc(c.id)}" data-b="${esc(b.id)}">${['A','B','C','—'].map(p=>opt(p,(c.prio||{})[b.id]||'—')).join('')}</select></td>`).join('')}
    <td><button class="btn sm danger edit" data-cmd="delmeet" data-id="${esc(c.id)}">Delete</button></td></tr>`).join('')}</tbody></table></div></div>
  <div class="card detail"><div class="d-head"><div><span class="label">Holidays · exams · camp</span><h2>Other dates</h2></div><button class="btn primary sm edit" data-cmd="addev">Add date</button></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Type</th><th>Starts</th><th>Ends</th><th></th></tr></thead><tbody>
  ${[...S.plan.events].sort((a,b)=>a.start.localeCompare(b.start)).map(e=>`<tr><td><input class="inp" style="min-width:200px" data-k="ev" data-id="${esc(e.id)}" data-f="name" value="${esc(e.name)}"></td><td><select class="inp" data-k="ev" data-id="${esc(e.id)}" data-f="type">${['Holiday','Bank holiday','Exams','Camp'].map(t=>opt(t,e.type)).join('')}</select></td>
    <td><input class="inp" type="date" data-k="ev" data-id="${esc(e.id)}" data-f="start" value="${esc(e.start)}"></td><td><input class="inp" type="date" data-k="ev" data-id="${esc(e.id)}" data-f="end" value="${esc(e.end)}"></td><td style="white-space:nowrap">${e.type==='Camp'?`<button class="btn sm" data-cmd="selevent" data-id="${esc(e.id)}">Who's going (${((e.camp||{}).attendees||[]).length})</button> `:''}<button class="btn sm danger edit" data-cmd="delev" data-id="${esc(e.id)}">Delete</button></td></tr>`).join('')}</tbody></table></div></div>`;
}
function renderSessions(){
  const v=$('#v-sessions');const pv=peakVol();const sys=nsys();const ses=S.plan.sessions;
  const line=S.wwLine&&BR(S.wwLine)?S.wwLine:(curSwimmer()&&planned(curSwimmer())?swBid(curSwimmer()):rootId());
  const lineOpts=`<optgroup label="Groups">${lanes().map(b=>opt(b.id,line,b.name)).join('')}</optgroup><optgroup label="Swimmers">${allSw().filter(planned).sort((a,b)=>a.name.localeCompare(b.name)).map(s=>opt(swBid(s),line,s.name)).join('')}</optgroup>`;
  const usedIn=name=>{const ps=Object.keys(S.plan.phases).filter(p=>S.plan.phases[p].template===name);return [...new Set(ps.map(p=>S.plan.phases[p].name))];};
  // week-by-week grid for the chosen plan line
  const arr=TL(line);const rows=arr.map(w=>{const cells=ses.map(x=>{const t=sessT(line,w.i,x.id);const vs=sessVersions(w.i,x.id);return {x,t,n:vs.length,vs};});return {w,cells,dif:cells.filter(c=>c.n>1).length};});
  const shown=S.wwDiff?rows.filter(r=>r.dif):rows;
  v.innerHTML=`<div class="card detail"><div class="d-head"><div><span class="label">Intensity notation</span><h2>${esc(sys.name)}</h2></div>
      <div class="chips"><select class="inp" id="notSel" aria-label="Notation">${notations().map(x=>opt(x.id,sys.id,x.name+(x.custom?' (yours)':''))).join('')}</select><button class="btn sm edit" data-cmd="newnotation">Create your own</button></div></div>
    <p class="small muted" style="margin-top:0">${esc(sys.desc||'')} Every focus is stored as RPE /20 (21 = HVO), so switching notation converts your whole plan. ${sys.custom?'':'The RPE ranges for the published systems are a guide; make your own copy to change them.'}</p>
    ${sys.custom?notationEditor(sys):`<div class="nkey">${sys.levels.map(l=>`<div class="lv"><span class="fchip" style="background:${esc(l.color)}">${esc(l.label)}</span><span class="small mono">RPE ${l.lo===l.hi?(l.lo===21?'21 · HVO':l.lo):l.lo+'–'+l.hi}</span><span class="small muted">${esc(l.desc||'')}</span></div>`).join('')}</div>`}</div>
  <div class="card detail"><div class="d-head"><div><span class="label">Weekly timetable</span><h2>${ses.reduce((s,x)=>s+(+x.hours||0),0).toFixed(2)} h · 100% load = ${(pv/1000).toFixed(1)} km</h2></div></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Session</th><th>Time</th><th>Hours</th><th>Pool</th><th>m / hour</th><th>Role</th><th>Metres at 100%</th></tr></thead><tbody>
  ${ses.map(x=>`<tr><td><b>${esc(x.label)}</b></td><td><input class="inp" style="width:120px" data-k="sess" data-id="${x.id}" data-f="time" value="${esc(x.time)}"></td><td><input class="inp t" type="number" step="0.25" min="0" data-k="sess" data-id="${x.id}" data-f="hours" value="${x.hours}"></td>
    <td><select class="inp" data-k="sess" data-id="${x.id}" data-f="pool">${['25m','50m'].map(p=>opt(p,x.pool)).join('')}</select></td><td><input class="inp t" type="number" step="100" min="0" data-k="sess" data-id="${x.id}" data-f="mph" value="${x.mph}"></td>
    <td><input class="inp" style="min-width:220px" data-k="sess" data-id="${x.id}" data-f="role" value="${esc(x.role)}"></td><td class="num">${Math.round(x.hours*x.mph).toLocaleString()} m</td></tr>`).join('')}</tbody></table></div>
  <p class="small muted">Hours and pools are yours. The metres-per-hour figures are assumptions: 2,500 for aerobic sessions (your Silver 1 baseline) and 2,000 where volume drops on speed, tolerance and power work.</p>
  <div class="form" style="margin-top:8px"><label>Season starts (Monday of 0.1.1)<input class="inp" type="date" data-k="set" data-f="start" value="${esc(S.plan.settings.start)}"></label><label>"Near" QT threshold (%)<input class="inp" type="number" step="0.5" min="0" data-k="set" data-f="near" value="${(S.plan.settings.near*100).toFixed(1)}"></label></div></div>
  <div class="card detail"><div class="d-head"><div><span class="label">Session templates</span><h2>What each session does, by type of block</h2></div><button class="btn primary sm edit" data-cmd="addtpl">Add template</button></div>
  <p class="small muted" style="margin-top:0">Each session has a main focus, a second focus and an optional third, plus notes. Every week on that type of block starts from here. Change a single week for a group or swimmer from the week itself.</p>
  ${S.plan.templates.map((t,k)=>{const f=t.f||{};const u=usedIn(t.name);return `<details class="tplcard"${S.tplOpen&&S.tplOpen.includes(t.name)?' open':''} data-tpl="${esc(t.name)}"><summary><b>${esc(t.name)}</b><span class="tpl-mini">${ses.map(x=>`<span title="${esc(x.label)}">${fChip((f[x.id]||{}).a,'sm')||'<span class="fchip sm empty">–</span>'}</span>`).join('')}</span><span class="small muted">${u.length?esc(u.join(' · ')):'not used yet'}</span></summary>
    <div class="tpl-head"><label>Name<input class="inp" data-k="tpl" data-n="${k}" data-f="name" value="${esc(t.name)}"></label>
      ${COMPS.map(c=>`<label><span style="color:var(--${c.k})">${esc(c.short)} ×</span><input class="inp t" type="number" step="0.05" min="0" data-k="tplw" data-n="${k}" data-f="${c.k}" value="${wts(t.name)[c.k]}"></label>`).join('')}
      <label class="wide">Note<textarea class="inp" data-k="tpl" data-n="${k}" data-f="note">${esc(t.note||'')}</textarea></label></div>
    <div class="tpl-grid">${ses.map(x=>{const o=f[x.id]||{};const at=`data-k="tf" data-n="${k}" data-s="${esc(x.id)}"`;return `<div class="stile"><div class="st-h"><b>${esc(x.label)}</b><span class="small muted">${esc(x.pool)} · ${esc(x.role||'')}</span></div>
      <div class="sf"><span>Main</span>${focusSel(o.a,at+' data-f="a"')}<span>2nd</span>${focusSel(o.b,at+' data-f="b"')}<span>3rd</span>${focusSel(o.c,at+' data-f="c"','none')}</div>
      <textarea class="inp" data-k="tpl" data-n="${k}" data-f="${esc(x.id)}" placeholder="Notes for this session">${esc((t.s||{})[x.id]||'')}</textarea></div>`;}).join('')}</div>
    <p class="small muted">The × numbers set how aerobic, anaerobic endurance and speed load follow the overall load on this type of block.</p></details>`;}).join('')}</div>
  <div class="card detail"><div class="d-head"><div><span class="label">Week by week</span><h2>Session targets through the season</h2></div>
    <div class="chips"><label class="small muted">Plan <select class="inp" id="wwLine">${lineOpts}</select></label><label class="small muted" style="display:inline-flex;gap:5px;align-items:center"><input type="checkbox" id="wwDiff"${S.wwDiff?' checked':''}> Only weeks with more than one version</label></div></div>
  <p class="small muted" style="margin-top:0">Cells show ${esc(BR(line).name)}'s targets. A number means the squad has that many different versions of the session that week across groups and individuals. A coloured edge marks a week changed for this plan. Click a week to open it and edit.</p>
  <div class="tbl-wrap ww-wrap"><table class="tbl ww"><thead><tr><th>Week</th><th>Block</th><th class="num">Load</th>${ses.map(x=>`<th>${esc(x.label)}</th>`).join('')}<th class="num">Versions</th></tr></thead><tbody>
  ${shown.map(r=>`<tr class="${r.w.i===nowWk()?'now':''}" data-cmd="openweek" data-i="${r.w.i}" data-bid="${esc(line)}" title="Open week ${r.w.i+1}"><td class="mono" style="white-space:nowrap"><b>${esc(r.w.code)}</b><div class="small muted">${fd(wkS(r.w.i))}</div></td><td class="small" style="min-width:110px">${esc(r.w.ph.name)}</td><td class="num">${pct(r.w.load)}</td>
    ${r.cells.map(c=>`<td class="wc${c.t.own?' own':''}" title="${esc(c.x.label+(c.t.n?': '+c.t.n:'')+(c.n>1?'\n'+c.n+' versions: '+c.vs.map(v=>(v.t.camp?'Camp':[v.t.a,v.t.b,v.t.c].filter(z=>z!=null).map(z=>fLabel(z)).join('/')||'—')+' ('+v.groups.map(b=>b.name).concat(v.swimmers.map(s=>s.name)).join(', ')+')').join('; '):''))}"${c.t.own?` style="--b:${esc(BR(line).color)}"`:''}>${tgtHTML(c.t)}${c.n>1?`<span class="vbadge">${c.n}</span>`:''}</td>`).join('')}
    <td class="num">${r.dif?`<b>${r.dif}</b> <span class="small muted">session${r.dif===1?'':'s'}</span>`:'<span class="small muted">—</span>'}</td></tr>`).join('')||`<tr><td colspan="${ses.length+4}" class="small muted">No weeks with more than one version.</td></tr>`}
  </tbody></table></div></div>`;
}
function notationEditor(sys){return `<div class="form" style="margin-bottom:8px"><label>Name<input class="inp" data-k="nname" value="${esc(sys.name)}"></label><label class="wide">Description<input class="inp" data-k="ndesc" value="${esc(sys.desc||'')}"></label></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Level</th><th>Colour</th><th>RPE from</th><th>RPE to</th><th>What it means</th><th></th></tr></thead><tbody>
  ${sys.levels.map((l,n)=>`<tr><td><input class="inp" style="width:110px;font-weight:600" data-k="nlev" data-n="${n}" data-f="label" value="${esc(l.label)}"></td><td><input class="inp" type="color" data-k="nlev" data-n="${n}" data-f="color" value="${esc(l.color)}" style="width:52px;height:32px;padding:2px"></td>
    <td><input class="inp t" type="number" min="1" max="21" data-k="nlev" data-n="${n}" data-f="lo" value="${l.lo}" style="width:64px"></td><td><input class="inp t" type="number" min="1" max="21" data-k="nlev" data-n="${n}" data-f="hi" value="${l.hi}" style="width:64px"></td>
    <td><input class="inp" style="min-width:220px" data-k="nlev" data-n="${n}" data-f="desc" value="${esc(l.desc||'')}"></td><td><button class="btn sm danger edit" data-cmd="dellevel" data-n="${n}" ${sys.levels.length>1?'':'disabled'}>Remove</button></td></tr>`).join('')}</tbody></table></div>
  <div class="toolbar" style="margin-top:8px"><button class="btn sm edit" data-cmd="addlevel">Add level</button><span class="small muted">${esc(rpeGaps(sys))}</span><div class="grow"></div><button class="btn sm danger edit" data-cmd="delnotation">Delete this notation</button></div>`;}
function rpeGaps(sys){const miss=[];for(let r=1;r<=21;r++)if(!sys.levels.some(l=>r>=l.lo&&r<=l.hi))miss.push(r);return miss.length?'RPE '+miss.join(', ')+' not covered: those values show as the nearest level.':'Covers RPE 1–21.';}
/* the sessions part of a week: one plan line editable, with every version the squad has */
function weekSessions(i,bsel){const pv=peakVol();const w=TL(bsel)[i];const b=BR(bsel);const ses=S.plan.sessions;
  const vsAll=ses.map(x=>sessVersions(i,x.id));const multi=vsAll.filter(v=>v.length>1).length;
  const plans=`<optgroup label="Groups">${lanes().map(x=>opt(x.id,bsel,x.name)).join('')}</optgroup><optgroup label="Swimmers">${allSw().filter(planned).sort((a,c)=>a.name.localeCompare(c.name)).map(s=>opt(swBid(s),bsel,s.name)).join('')}</optgroup>`;
  return `<div class="d-head" style="margin-top:16px;margin-bottom:6px"><div><span class="label">Sessions this week</span><div class="small muted">${multi?`${multi} of ${ses.length} sessions have more than one version across the squad.`:'Everyone has the same target for every session.'}</div></div>
    <label class="small muted">Plan <select class="inp" id="weekBranch">${plans}</select></label></div>
  ${w.camp?(()=>{const ce=S.plan.events.find(x=>x.id===w.camp)||{};const cs=(ce.camp||{}).schedule||[];return `<p class="small muted" style="margin:4px 0">${esc(ce.name||'Camp')}: the camp schedule replaces the home sessions this week for ${esc(b.name)}.</p><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Session</th><th>Focus</th></tr></thead><tbody>${cs.map(r=>`<tr><td><b>${esc(r.s)}</b></td><td>${esc(r.f)}</td></tr>`).join('')||'<tr><td colspan="2" class="small muted">No camp sessions entered yet.</td></tr>'}</tbody></table></div>`;})():''}
  <div class="tbl-wrap"${w.camp?' hidden':''}><table class="tbl wk-sess"><thead><tr><th>Session</th><th>Main</th><th>2nd</th><th>3rd</th><th>Notes · ${esc(w.ph.template||'')}</th><th class="num">Target</th><th>Squad versions</th></tr></thead><tbody>
  ${ses.map((x,j)=>{const t=sessT(bsel,i,x.id);const at=`data-k="sf" data-bid="${esc(bsel)}" data-i="${i}" data-s="${esc(x.id)}"`;const vs=vsAll[j];
    return `<tr class="${t.own?'own':''}" style="--b:${esc(b.color)}"><td><b>${esc(x.label)}</b><div class="small muted">${fdow(wkS(i)+x.day*DAY)} · ${esc(x.pool)}</div>${t.own?`<button class="btn sm ghost edit" data-cmd="resetsess" data-bid="${esc(bsel)}" data-i="${i}" data-s="${esc(x.id)}" title="Go back to what ${esc(b.name)} would have without this change">Reset</button>`:''}</td>
      <td>${focusSel(t.a,at+' data-f="a"')}</td><td>${focusSel(t.b,at+' data-f="b"')}</td><td>${focusSel(t.c,at+' data-f="c"','none')}</td>
      <td><textarea class="inp" ${at} data-f="n" rows="2" style="min-width:200px">${esc(t.n||'')}</textarea></td><td class="num">${Math.round(w.load*x.hours*x.mph/50)*50} m</td>
      <td class="small" style="min-width:180px">${vs.length>1?versionsHTML(vs,sKey(t)):'<span class="muted">Same for everyone</span>'}</td></tr>`;}).join('')}
  </tbody></table></div>
  <p class="small muted">Changes here apply to ${esc(b.name)} in this week only and show as a coloured edge. ${b.kind==='swimmer'?'They belong to the group '+esc(b.sw.name.split(' ')[0])+' is in this week.':'Swimmers in the group follow it unless they have their own change.'}</p>`;}

/* ---------- swimmer plan sheet (export) ---------- */
/* ---------- sessions on plan sheets, the downloadable page and the PDF ---------- */
function wrapT(t,px,s,max){const per=Math.max(4,Math.floor(px/(s*.5)));const words=String(t||'').replace(/\s+/g,' ').trim().split(' ').filter(Boolean);const lines=[];let cur='';
  words.forEach(wd=>{if(wd.length>per)wd=wd.slice(0,per-1)+'…';const nx=cur?cur+' '+wd:wd;if(nx.length<=per)cur=nx;else{lines.push(cur);cur=wd;}});if(cur)lines.push(cur);
  if(lines.length>max){const keep=lines.slice(0,max);let l=keep[max-1];keep[max-1]=(l.length>=per-1?l.slice(0,per-2):l)+'…';return keep;}return lines;}
const sesWeeks=(n)=>{const a=nowWk(),out=[];for(let i=a;i<NW()&&(!n||out.length<n);i++)out.push(i);return out;};
function sessRowData(bid,i,cw,fs,maxL){const w=TL(bid)[i];const ts=S.plan.sessions.map(x=>sessT(bid,i,x.id));const notes=ts.map(t=>t.camp?[]:wrapT(t.n,cw-12,fs,maxL));
  return {i,w,ts,notes,h:Math.max(64,30+Math.max(1,...notes.map(n=>n.length))*(fs+3)+6)};}
function drawSessHead(o,y){const {T,add}=o;add(`<rect x="${o.x}" y="${y}" width="${o.w}" height="26" rx="4" fill="#14191F"/>`);add(T(o.x+8,y+17,'Week',{s:11,c:'#FFFFFF',w:700}));
  S.plan.sessions.forEach((x,j)=>add(T(o.x+o.lw+j*o.cw+6,y+17,x.label+' · '+x.pool,{s:11,c:'#FFFFFF',w:700})));return y+26;}
function drawSessRow(o,r,y){const {T,add,cut}=o;
  if(r.i===nowWk())add(`<rect x="${o.x}" y="${y}" width="${o.w}" height="${r.h}" fill="#FCE6D3" fill-opacity="0.5"/>`);
  add(`<line x1="${o.x}" x2="${o.x+o.w}" y1="${y+r.h}" y2="${y+r.h}" stroke="#E4E9EE"/>`);
  add(T(o.x+8,y+18,r.w.code,{s:12,w:700}));add(T(o.x+8,y+33,'w/c '+fd(wkS(r.i)),{s:10.5,c:'#5A6570'}));add(T(o.x+8,y+47,cut(r.w.ph.name,o.lw-12,10),{s:10,c:'#5A6570'}));add(T(o.x+8,y+60,pct(r.w.load)+' load',{s:10,c:'#5A6570'}));
  r.ts.forEach((t,j)=>{const x=o.x+o.lw+j*o.cw+4,bw=o.cw-8;
    if(t.camp){add(`<rect x="${x}" y="${y+6}" width="${bw}" height="19" rx="4" fill="#D6E8F7"/>`);add(T(x+6,y+19,'Camp',{s:11,w:700}));return;}
    const fs=[t.a,t.b,t.c].filter(z=>z!=null);if(!fs.length){add(T(x+6,y+19,'—',{s:11,c:'#8A949E'}));}
    else{const wts=fs.length===1?[1]:fs.length===2?[.62,.38]:[.5,.25,.25];let xx=x;fs.forEach((r2_,k)=>{const ww=bw*wts[k];add(`<rect x="${xx}" y="${y+6}" width="${ww-(k<fs.length-1?2:0)}" height="19" rx="3" fill="${esc(fColor(r2_))}" stroke="#C9D1D9" stroke-width="0.6"/>`);
      add(T(xx+5,y+19,cut(fLabel(r2_),ww-8,k?9.5:11),{s:k?9.5:11,w:700}));xx+=ww;});}
    r.notes[j].forEach((ln,k)=>add(T(x+2,y+40+k*(o.fs+3),ln,{s:o.fs,c:'#3A434C'})));});
  return y+r.h;}
/* plain-HTML version (full notes) for the downloadable page */
function sessHTMLTable(bid){const ses=S.plan.sessions;const chip=r=>{if(r==null)return '';const l=lvlOf(r);return `<span class="fc" style="background:${esc(l.color)}">${esc(l.label)}</span>`;};
  return `<h2>Sessions week by week</h2><p class="mut">${esc(nsys().name)} · from w/c ${fd(wkS(nowWk()))} to the end of the season</p><table class="ss"><thead><tr><th>Week</th>${ses.map(x=>`<th>${esc(x.label)}<br><span class="mut">${esc(x.pool)}</span></th>`).join('')}</tr></thead><tbody>
  ${sesWeeks().map(i=>{const w=TL(bid)[i];return `<tr${i===nowWk()?' class="now"':''}><td><b>${esc(w.code)}</b><br><span class="mut">w/c ${fd(wkS(i))}<br>${esc(w.ph.name)}<br>${pct(w.load)} load</span></td>${ses.map(x=>{const t=sessT(bid,i,x.id);return `<td>${t.camp?'<span class="fc" style="background:#D6E8F7">Camp</span>':[chip(t.a),chip(t.b),chip(t.c)].join(' ')}<div>${esc(t.camp?'':t.n)}</div></td>`;}).join('')}</tr>`;}).join('')}</tbody></table>`;}
function sessText(bid,weeks){const L=[];weeks.forEach(i=>{const w=TL(bid)[i];L.push(`  w/c ${fd(wkS(i))} (${w.code} · ${w.ph.name})`);S.plan.sessions.forEach(x=>{const t=sessT(bid,i,x.id);
  L.push(`    ${x.label}: ${t.camp?'Camp':[t.a,t.b,t.c].filter(z=>z!=null).map(z=>fLabel(z)).join(' + ')||'—'}${!t.camp&&t.n?' · '+t.n:''}`);});});return L;}
/* ---------- PDF: each page is drawn as an image, so the file looks exactly like the sheet ---------- */
async function svgCanvas(svg,w,h,scale){const img=new Image();await new Promise((res,rej)=>{img.onload=res;img.onerror=rej;img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);});
  const c=document.createElement('canvas');c.width=Math.round(w*scale);c.height=Math.round(h*scale);const ctx=c.getContext('2d');ctx.fillStyle='#FFFFFF';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(img,0,0,c.width,c.height);return c;}
async function jpegOf(canvas){const b=await new Promise(r=>canvas.toBlob(r,'image/jpeg',0.9));return {bytes:new Uint8Array(await b.arrayBuffer()),w:canvas.width,h:canvas.height};}
function pdfFrom(pages){const enc=new TextEncoder();const parts=[];let len=0;const offs=[];const push=x=>{const b=typeof x==='string'?enc.encode(x):x;parts.push(b);len+=b.length;};
  const PW=841.89,PH=595.28,n=pages.length;const obj=(id,body)=>{offs[id]=len;push(id+' 0 obj\n'+body+'\nendobj\n');};
  push('%PDF-1.4\n');push(new Uint8Array([37,226,227,207,211,10]));
  obj(1,'<< /Type /Catalog /Pages 2 0 R >>');obj(2,`<< /Type /Pages /Kids [${pages.map((_,k)=>(3+3*k)+' 0 R').join(' ')}] /Count ${n} >>`);
  pages.forEach((pg,k)=>{const P=3+3*k,C=4+3*k,I=5+3*k;
    obj(P,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im${k} ${I} 0 R >> >> /Contents ${C} 0 R >>`);
    const cs=`q ${PW} 0 0 ${PH} 0 0 cm /Im${k} Do Q`;obj(C,`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`);
    offs[I]=len;push(`${I} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.bytes.length} >>\nstream\n`);push(pg.bytes);push('\nendstream\nendobj\n');});
  const total=3+3*n,xref=len;let x=`xref\n0 ${total}\n0000000000 65535 f \n`;for(let id=1;id<total;id++)x+=String(offs[id]).padStart(10,'0')+' 00000 n \n';push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);return new Blob(parts,{type:'application/pdf'});}
async function buildPdf(sw){const W=1200,PH=Math.round(W/1.41421),SC=2;const pages=[];
  // the plan sheet, cut into landscape pages at section and row boundaries
  const info={};const svg=sheetSVG(sw,info);const full=await svgCanvas(svg,W,info.H,SC);const cuts=[0];let s=0;
  while(info.H-s>PH){const lim=s+PH;const cand=info.brk.filter(b=>b>s+PH*0.35&&b<=lim);const e=cand.length?Math.max(...cand):lim;cuts.push(e);s=e;}cuts.push(info.H);
  for(let k=0;k<cuts.length-1;k++){const c=document.createElement('canvas');c.width=W*SC;c.height=PH*SC;const ctx=c.getContext('2d');ctx.fillStyle='#FFFFFF';ctx.fillRect(0,0,c.width,c.height);
    const h=cuts[k+1]-cuts[k];ctx.drawImage(full,0,cuts[k]*SC,W*SC,h*SC,0,0,W*SC,h*SC);pages.push(await jpegOf(c));}
  // session pages: from this week to the end of the season
  const bid=swBid(sw),PX=40,tw=W-2*PX,lw=118,cw=(tw-lw)/S.plan.sessions.length,fs=10.5;const rows=sesWeeks().map(i=>sessRowData(bid,i,cw,fs,4));
  const F='Arial, Helvetica, sans-serif';const T=(x,y,t,o)=>`<text x="${x}" y="${y}" font-family="${F}" font-size="${o.s||13}" fill="${o.c||'#14191F'}"${o.w?` font-weight="${o.w}"`:''}${o.a?` text-anchor="${o.a}"`:''}>${esc(t)}</text>`;
  const cut=(t,px,s)=>{t=String(t||'');const k=Math.floor(px/(s*.52));return t.length>k?t.slice(0,Math.max(1,k-1))+'…':t;};
  const groupsOf=[];let cur=[],hh=0;const room=PH-76-30;rows.forEach(r=>{if(hh+r.h>room&&cur.length){groupsOf.push(cur);cur=[];hh=0;}cur.push(r);hh+=r.h;});if(cur.length)groupsOf.push(cur);
  for(let k=0;k<groupsOf.length;k++){const out=[];const add=s=>out.push(s);const o={x:PX,w:tw,lw,cw,fs,T,add,cut};
    add(T(PX,30,`${sw.name} · sessions week by week`,{s:18,w:700}));add(T(W-PX,30,`${nsys().name} · page ${k+1} of ${groupsOf.length}`,{s:11,c:'#5A6570',a:'end'}));
    let y=drawSessHead(o,44);groupsOf[k].forEach(r=>{y=drawSessRow(o,r,y);});
    add(T(PX,PH-14,`Basildon & Phoenix SC · ${S.plan.settings.squad} season plan ${S.plan.settings.season} · plan as at ${fdy(today())}`,{s:10,c:'#8A949E'}));
    const pv=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${PH}" viewBox="0 0 ${W} ${PH}"><rect width="${W}" height="${PH}" fill="#FFFFFF"/>${out.join('')}</svg>`;
    pages.push(await jpegOf(await svgCanvas(pv,W,PH,SC)));}
  return pdfFrom(pages);}

function sheetData(sw){
  const g=BR(curGroup(sw))||BR(rootId());const b=BR(swBid(sw))||g;const arr=TL(b.id);const me=macroEnds(b.id);const st=stats(sw);
  const blocks=runs(arr,w=>w.p).map(r=>({a:r.start,b:r.end,ph:S.plan.phases[r.k]||{},code:arr[r.start].code.replace(/\.\d+$/,''),macro:arr[r.start].macro,avg:arr.slice(r.start,r.end+1).reduce((s,w)=>s+w.load,0)/(r.end-r.start+1)}));
  const meets=S.plan.calendar.filter(c=>['A','B'].includes(prioOf(b.id,c))).sort((x,y)=>x.start.localeCompare(y.start));
  return{b,g,arr,me,st,blocks,meets,pers:personalWeeks(sw)>0||personalPrio(sw).length>0};
}
function sheetSVG(sw,info){const BRK=[];
  const {b,g,arr,me,st,blocks,meets,pers}=sheetData(sw);const PR=c=>prioOf(b.id,c);const W=1200,PX=40,F='Arial, Helvetica, sans-serif';const MC={'0':'#AEB8C2','1':'#F0C24B','2':'#55B3A8','3':'#B783A9','–':'#D5DBE0'};
  const E=s=>esc(s);const out=[];const add=s=>out.push(s);const n=arr.length;const tw=W-2*PX,cw=tw/n;
  const T=(x,y,t,o)=>`<text x="${x}" y="${y}" font-family="${F}" font-size="${o.s||13}" fill="${o.c||'#14191F'}"${o.w?` font-weight="${o.w}"`:''}${o.a?` text-anchor="${o.a}"`:''}${o.ls?` letter-spacing="${o.ls}"`:''}>${E(t)}</text>`;
  const cut=(t,px,s)=>{t=String(t||'');const k=Math.floor(px/(s*.52));return t.length>k?t.slice(0,Math.max(1,k-1))+'…':t;};
  let y=0;
  add(`<rect x="0" y="0" width="${W}" height="118" fill="#14191F"/>`);
  add(T(PX,40,`BPSC · ${S.plan.settings.squad.toUpperCase()} · SEASON PLAN ${S.plan.settings.season}`,{s:13,c:'#F28C2E',w:700,ls:1.5}));
  add(T(PX,88,sw.name,{s:40,c:'#FFFFFF',w:700}));
  add(`<rect x="${W-PX-230}" y="34" width="230" height="30" rx="15" fill="${E(b.color)}"/>`);add(T(W-PX-115,54,gName(g)+(pers?' · personal':''),{s:15,c:'#FFFFFF',w:700,a:'middle'}));
  add(T(W-PX,92,'Plan as at '+fdy(today()),{s:12,c:'#AEB8C2',a:'end'}));
  y=146;add(T(PX,y,'THE SEASON IN THREE MACROS',{s:12,c:'#5A6570',w:700,ls:1.5}));y+=12;
  const mw=(tw-2*16)/3;
  ['1','2','3'].forEach((m,k)=>{const x=PX+k*(mw+16);const r=me[m];const pk=r?S.plan.calendar.filter(c=>PR(c)==='A'&&weekOf(iso(c.start))>=r.a&&weekOf(iso(c.start))<=r.b):[];const nb=blocks.filter(x=>x.macro===m).length;
    add(`<rect x="${x}" y="${y}" width="${mw}" height="96" rx="8" fill="${MC[m]}" fill-opacity="0.22" stroke="${MC[m]}"/>`);
    add(T(x+14,y+22,'MACRO '+m,{s:12,c:'#14191F',w:700,ls:1.2}));
    add(T(x+14,y+48,r?fd(wkS(r.a))+' – '+fd(wkE(r.b)):'—',{s:21,w:700}));
    add(T(x+14,y+70,cut(pk.length?'Peak: '+pk.map(c=>c.short||c.name).join(', '):'No A meet set',mw-28,13),{s:13}));
    add(T(x+14,y+87,r?`${r.b-r.a+1} weeks · ${nb} blocks`:'',{s:12,c:'#5A6570'}));});
  y+=96;BRK.push(y+14);const GL=goalsOf(sw);
  if(GL.length){y+=38;add(T(PX,y,'GOALS',{s:12,c:'#5A6570',w:700,ls:1.5}));y+=4;
    GL.forEach(g=>{const x=goalInfo(sw,g);const st=goalStatus(sw,g);y+=28;
      add(`<rect x="${PX}" y="${y-15}" width="18" height="18" rx="4" fill="${g.done?'#1E7F48':'#FFFFFF'}" stroke="#1E7F48" stroke-width="1.5"/>`);if(g.done)add(`<path d="M${PX+4},${y-6} l4,4 l7,-8" fill="none" stroke="#FFFFFF" stroke-width="2"/>`);
      add(T(PX+28,y,cut(x.label+(x.tgt&&g.text?' · '+x.tgt:''),560,15),{s:15,w:700}));
      add(T(PX+600,y,cut([x.c?'by '+(x.c.short||x.c.name)+' ('+range(iso(x.c.start),iso(x.c.end))+')':'',st].filter(Boolean).join(' · '),tw-600,13),{s:13,c:g.done?'#1E7F48':'#5A6570'}));});}
  BRK.push(y+14);y+=38;add(T(PX,y,'WEEK BY WEEK',{s:12,c:'#5A6570',w:700,ls:1.5}));y+=10;
  const yM=y+18,yB=yM+20,yL=yB+46,LH=96,yC=yL+LH;
  let pm=-1;for(let i=0;i<n;i++){const d=new Date(wkS(i));if(d.getUTCMonth()!==pm){pm=d.getUTCMonth();add(`<line x1="${PX+i*cw}" x2="${PX+i*cw}" y1="${y+2}" y2="${yC+4}" stroke="#D3DAE1"/>`);add(T(PX+i*cw+3,y+13,MON[pm],{s:11,c:'#5A6570',w:700}));}
    const ev=eventsInWeek(i);if(ev.some(e=>e.type==='Exams'))add(`<rect x="${PX+i*cw}" y="${yL}" width="${cw}" height="${LH}" fill="#7E5CB8" fill-opacity="0.10"/>`);if(ev.some(e=>e.type==='Holiday'))add(`<rect x="${PX+i*cw}" y="${yL}" width="${cw}" height="${LH}" fill="#5A6570" fill-opacity="0.08"/>`);}
  runs(arr,w=>w.macro).forEach(r=>{add(`<rect x="${PX+r.start*cw+.5}" y="${yM}" width="${(r.end-r.start+1)*cw-1}" height="16" rx="3" fill="${MC[r.k]}"/>`);const w=(r.end-r.start+1)*cw;add(T(PX+r.start*cw+5,yM+12,cut(r.k==='–'?'Off season':r.k==='0'?'Pre':'Macro '+r.k,w-8,10),{s:10,w:700,ls:1}));});
  blocks.forEach(k=>{const x=PX+k.a*cw,w=(k.b-k.a+1)*cw;add(`<rect x="${x+.5}" y="${yB}" width="${w-1}" height="40" rx="4" fill="${MC[k.macro]}" fill-opacity="0.38" stroke="#D3DAE1"/>`);
    add(T(x+5,yB+16,cut(k.ph.name,w-8,11),{s:11,w:700}));add(T(x+5,yB+31,cut(k.code,w-8,10),{s:10,c:'#5A6570'}));});
  [.5,1].forEach(v=>{const yy=yC-v/LMAX*LH;add(`<line x1="${PX}" x2="${PX+tw}" y1="${yy}" y2="${yy}" stroke="#E4E9EE"${v===1?' stroke-dasharray="3 3"':''}/>`);add(T(PX-6,yy+4,Math.round(v*100)+'%',{s:9,c:'#8A949E',a:'end'}));});
  arr.forEach(w=>{const h=w.load/LMAX*LH;add(`<rect x="${PX+w.i*cw+2.5}" y="${yC-h}" width="${cw-5}" height="${h}" rx="2" fill="${MC[w.macro]}"/>`);});
  arr.forEach(w=>{if(!w.away)return;const ph=Math.min(LMAX,w.plan)/LMAX*LH;if(ph>0)add(`<rect x="${PX+w.i*cw+2.5}" y="${yC-ph}" width="${cw-5}" height="${ph}" rx="2" fill="none" stroke="#B03A2E" stroke-width="1.2" stroke-dasharray="3 2"/>`);add(T(PX+w.i*cw+cw/2,yL+16,awayShort(w.away.items[0].type),{s:9,c:'#B03A2E',w:700,a:'middle'}));});
  GL.forEach(g=>{const x=goalInfo(sw,g);if(x.wk!=null)add(`<polygon points="${starPts(PX+x.wk*cw+cw/2+9,yL+3,6)}" fill="${g.done?'#8A949E':'#1E7F48'}" stroke="#FFFFFF"/>`);});
  arr.forEach(w=>{const ms=meetsInWeek(w.i).filter(c=>PR(c)==='A');if(ms.length){const x=PX+w.i*cw+cw/2;add(`<path d="M${x-6},${yL-1} L${x+6},${yL-1} L${x},${yL+7} Z" fill="${E(b.color)}"/>`);}});
  const tx=(today()-D0())/WK*cw;if(tx>0&&tx<tw)add(`<line x1="${PX+tx}" x2="${PX+tx}" y1="${y}" y2="${yC+4}" stroke="#E8731A" stroke-width="2"/>`);
  add(T(PX,yC+20,'Bars = weekly load (100% = a full week of sessions). ▼ = target meet.'+(GL.some(g=>goalInfo(sw,g).wk!=null)?' ★ = goal.':'')+' Shaded = holidays / exams.'+(arr.some(w=>w.away)?' Dashed = planned load in weeks away or injured.':''),{s:11,c:'#5A6570'}));
  y=yC+52;BRK.push(y-22);
  {const wk=sesWeeks(4);if(wk.length){add(T(PX,y,'SESSIONS · NEXT '+wk.length+' WEEK'+(wk.length>1?'S':''),{s:12,c:'#5A6570',w:700,ls:1.5}));add(T(W-PX,y,nsys().name,{s:11,c:'#5A6570',a:'end'}));y+=10;
    const lw=118,scw=(tw-lw)/S.plan.sessions.length;const o={x:PX,w:tw,lw,cw:scw,fs:10.5,T,add,cut};y=drawSessHead(o,y);wk.forEach(i=>{BRK.push(y);y=drawSessRow(o,sessRowData(b.id,i,scw,10.5,3),y);});y+=46;BRK.push(y-24);}}
  const colW=(tw-30)/2;let yl=y,yr=y;
  add(T(PX,yl,'TARGET MEETS',{s:12,c:'#5A6570',w:700,ls:1.5}));yl+=10;
  meets.forEach(c=>{yl+=24;const A=PR(c)==='A';add(`<rect x="${PX}" y="${yl-15}" width="20" height="19" rx="4" fill="${A?E(b.color):'#E4E9EE'}"/>`);add(T(PX+10,yl-1,PR(c),{s:11,w:700,c:A?'#FFFFFF':'#14191F',a:'middle'}));
    add(T(PX+30,yl,range(iso(c.start),iso(c.end)),{s:13,w:700}));add(T(PX+124,yl,cut(c.name+' · '+c.course,colW-130,13),{s:13}));});
  const xr=PX+colW+30;add(T(xr,yr,'QUALIFYING (times to '+(S.roster.source.match(/\d+ \w+ \d{4}/)||[''])[0]+')',{s:12,c:'#5A6570',w:700,ls:1.5}));yr+=10;
  const ql=[];if(st.nq.length)ql.push(['Winter Nats QTs',st.nq.join(', '),'#1E7F48']);else if(st.close)ql.push(['Closest Winter Nats QT',st.close.e+' +'+(st.close.g*100).toFixed(1)+'%','#9A5B00']);
  st.near.filter(x=>!st.nq.includes(x.e)&&!(st.close&&!st.nq.length&&x.e===st.close.e)).forEach(x=>ql.push(['Near (Nats)',x.e+' +'+(x.g*100).toFixed(1)+'%','#9A5B00']));
  ql.push(['Regionals (East Region SC)',st.eq.length?st.eq.join(', '):(st.eclose?'not yet · closest '+st.eclose.e+' +'+(st.eclose.g*100).toFixed(1)+'%':'none yet on 25m times'),st.eq.length?'#1F5FA8':'#9A5B00']);
  ql.forEach(q=>{yr+=24;add(T(xr,yr,q[0],{s:12,c:'#5A6570'}));add(T(xr+175,yr,cut(q[1],colW-180,13),{s:13,w:700,c:q[2]}));});
  y=Math.max(yl,yr)+44;
  const gr=groupRuns(sw),aw=awayFor(sw.id).filter(a=>a.from).sort((p,q)=>p.from.localeCompare(q.from));
  BRK.push(y-20);if(gr.length>1||aw.length){add(T(PX,y,'GROUPS AND TIME AWAY',{s:12,c:'#5A6570',w:700,ls:1.5}));y+=6;
    if(gr.length>1)gr.forEach(r=>{y+=24;const gb=BR(r.g)||g;add(`<rect x="${PX}" y="${y-15}" width="5" height="19" fill="${E(gb.color)}"/>`);add(T(PX+14,y,range(wkS(r.a),wkE(r.b)),{s:12,w:700}));add(T(PX+205,y,gName(gb),{s:12}));});
    aw.forEach(a=>{y+=24;const m=Object.assign({},INJ,a.mods||{});add(`<rect x="${PX}" y="${y-15}" width="5" height="19" fill="#B03A2E"/>`);add(T(PX+14,y,range(iso(a.from),iso(a.to||a.from)),{s:12,w:700}));
      add(T(PX+205,y,cut(a.type+(a.type==='Injury'?` · training at ${Math.round(m.load*100)}% volume`:'')+(a.note?' · '+a.note:''),tw-205,12),{s:12}));});
    y+=44;}
  BRK.push(y-20);add(T(PX,y,'TRAINING BLOCKS',{s:12,c:'#5A6570',w:700,ls:1.5}));y+=26;
  const cx=[PX,PX+60,PX+205,PX+260,PX+500];add(`<line x1="${PX}" x2="${PX+tw}" y1="${y+8}" y2="${y+8}" stroke="#D3DAE1"/>`);
  ['Code','Dates','Weeks','Block','Focus'].forEach((h,k)=>add(T(cx[k],y+2,h,{s:10.5,c:'#5A6570',w:700,ls:1})));y+=8;
  blocks.forEach(k=>{BRK.push(y+9);y+=24;add(`<rect x="${PX}" y="${y-15}" width="5" height="19" fill="${MC[k.macro]}"/>`);add(T(cx[0]+12,y,k.code,{s:12,w:700}));add(T(cx[1],y,range(wkS(k.a),wkE(k.b)),{s:12}));add(T(cx[2],y,String(k.b-k.a+1),{s:12}));
    add(T(cx[3],y,cut(k.ph.name,230,12),{s:12,w:700}));add(T(cx[4],y,cut(k.ph.objective,tw-(cx[4]-PX),12),{s:12,c:'#3A434C'}));add(`<line x1="${PX}" x2="${PX+tw}" y1="${y+8}" y2="${y+8}" stroke="#EEF1F4"/>`);});
  BRK.push(y+12);if(sw.note){y+=36;add(T(PX,y,'NOTES',{s:12,c:'#5A6570',w:700,ls:1.5}));y+=20;add(T(PX,y,cut(sw.note,tw,13),{s:13}));}
  y+=40;add(T(PX,y,`Basildon & Phoenix SC · ${S.plan.settings.squad} · ${gName(g)}${pers?' · personal plan':''} · generated from the season planner`,{s:11,c:'#8A949E'}));
  const H=y+28;if(info){info.brk=BRK;info.H=H;}
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#FFFFFF"/>${out.join('')}</svg>`;
}
function sheetText(sw){const {b,g,me,st,blocks,meets,pers}=sheetData(sw);const L=[];
  L.push(`${sw.name} · ${S.plan.settings.squad} season plan ${S.plan.settings.season} (${gName(g)}${pers?', personal plan':''})`,'');
  ['1','2','3'].forEach(m=>{const r=me[m];if(!r)return;L.push(`MACRO ${m}: ${fd(wkS(r.a))} – ${fd(wkE(r.b))}`);blocks.filter(k=>k.macro===m).forEach(k=>L.push(`  ${k.code}  ${range(wkS(k.a),wkE(k.b))}  ${k.ph.name}${k.ph.objective?' · '+k.ph.objective:''}`));L.push('');});
  const GL=goalsOf(sw);if(GL.length){L.push('GOALS');GL.forEach(g=>{const x=goalInfo(sw,g);const st=goalStatus(sw,g);L.push(`  ${g.done?'[x]':'[ ]'} ${x.label}${x.tgt&&g.text?' · '+x.tgt:''}${x.c?' · by '+(x.c.short||x.c.name)+' ('+range(iso(x.c.start),iso(x.c.end))+')':''}${st&&!g.done?' · '+st:''}`);});L.push('');}
  const gr=groupRuns(sw);if(gr.length>1){L.push('GROUPS');gr.forEach(r=>L.push(`  ${range(wkS(r.a),wkE(r.b))}  ${gName(BR(r.g)||g)}`));L.push('');}
  const aw=awayFor(sw.id).filter(a=>a.from);if(aw.length){L.push('TIME AWAY');aw.forEach(a=>{const m=Object.assign({},INJ,a.mods||{});L.push(`  ${range(iso(a.from),iso(a.to||a.from))}  ${a.type}${a.type==='Injury'?' (training at '+Math.round(m.load*100)+'% volume)':''}${a.note?' · '+a.note:''}`);});L.push('');}
  {const wk=sesWeeks(4);if(wk.length){L.push('SESSIONS · NEXT '+wk.length+' WEEKS ('+nsys().name+')');sessText(b.id,wk).forEach(x=>L.push(x));L.push('');}}
  L.push('TARGET MEETS');meets.forEach(c=>L.push(`  ${prioOf(b.id,c)}  ${range(iso(c.start),iso(c.end))}  ${c.name} (${c.course})`));L.push('');
  L.push('QUALIFYING');if(st.nq.length)L.push('  Winter Nats: '+st.nq.join(', '));else if(st.close)L.push(`  Closest Winter Nats QT: ${st.close.e} +${(st.close.g*100).toFixed(1)}%`);L.push('  Regionals (East Region SC): '+(st.eq.join(', ')||(st.eclose?'not yet, closest '+st.eclose.e+' +'+(st.eclose.g*100).toFixed(1)+'%':'none yet on 25m times')));
  if(sw.note){L.push('','NOTES','  '+sw.note);}return L.join('\n');}
function renderSheet(){const sw=S.roster&&S.roster.swimmers.find(s=>s.id===S.sheet);const ov=$('#sheetOverlay');if(!sw||!planned(sw)){ov.hidden=true;return;}
  ov.hidden=false;ov.innerHTML=`<div class="card sheet" role="dialog" aria-label="Plan sheet for ${esc(sw.name)}"><div class="sheet-actions"><div><span class="label">Plan sheet</span><div style="font-family:var(--f-display);font-size:22px;font-weight:700">${esc(sw.name)}</div></div><div class="spacer"></div>
    <button class="btn primary sm" data-cmd="dl" data-f="pdf" ${downloads?'':'disabled'}>Download PDF</button><button class="btn sm" data-cmd="dl" data-f="png" ${downloads?'':'disabled'}>Download image</button><button class="btn sm" data-cmd="dl" data-f="html" ${downloads?'':'disabled'}>Download page</button><button class="btn sm" data-cmd="copytext">Copy as text</button><button class="btn ghost sm" data-cmd="closesheet">Close</button></div>
    <div class="small muted" id="sheetMsg">${downloads?'The PDF has this sheet plus every session from this week to the end of the season. The image works well in WhatsApp; the page opens in any browser.':'Downloads are not available in this view. Copy as text still works.'}</div>
    <div class="sheet-prev">${sheetSVG(sw)}</div><textarea class="inp" id="sheetText" readonly style="min-height:120px;font-family:var(--f-data);font-size:12px" hidden>${esc(sheetText(sw))}</textarea></div>`;}
async function download(fmt){const sw=S.roster.swimmers.find(s=>s.id===S.sheet);if(!sw||!downloads)return;const base=sw.name.replace(/[^A-Za-z0-9 -]/g,'')+' - season plan '+S.plan.settings.season.replace(/[^0-9-]/g,'-');const msg=$('#sheetMsg');
  try{let data,fn;
    if(fmt==='pdf'){fn=base+'.pdf';msg.textContent='Building the PDF…';data=await buildPdf(sw);}
    else if(fmt==='html'){fn=base+'.html';data=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(sw.name)} · season plan ${esc(S.plan.settings.season)}</title><style>body{margin:0;background:#EDF1F4;font-family:Arial,Helvetica,sans-serif;color:#14191F}main{max-width:1200px;margin:0 auto;padding:16px}svg{width:100%;height:auto;display:block;background:#fff;border-radius:8px}pre{white-space:pre-wrap;background:#fff;padding:16px;border-radius:8px;font-size:13px}
      h2{font-size:18px;margin:24px 0 2px}.mut{color:#5A6570;font-size:12px}table.ss{border-collapse:collapse;width:100%;background:#fff;font-size:12px;margin-top:8px}.ss th{background:#14191F;color:#fff;text-align:left;padding:6px;font-size:11.5px}.ss th .mut{color:#C9D1D9}.ss td{border-bottom:1px solid #E4E9EE;padding:6px;vertical-align:top}.ss tr.now td{background:#FCE6D3}.fc{display:inline-block;border-radius:4px;padding:1px 5px;font-weight:700;font-size:11px;border:1px solid rgba(0,0,0,.12);margin:0 2px 3px 0}
      @media print{body{background:#fff}main{padding:0}svg{border-radius:0}table.ss{page-break-before:always}tr{page-break-inside:avoid}pre{display:none}}</style></head><body><main>${sheetSVG(sw)}${sessHTMLTable(swBid(sw))}<pre>${esc(sheetText(sw))}</pre></main></body></html>`;}
    else{fn=base+'.png';const svg=sheetSVG(sw);const m=svg.match(/width="(\d+)" height="(\d+)"/);const w=+m[1],h=+m[2];const img=new Image();await new Promise((res,rej)=>{img.onload=res;img.onerror=rej;img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);});
      const c=document.createElement('canvas');c.width=w*2;c.height=h*2;const ctx=c.getContext('2d');ctx.scale(2,2);ctx.drawImage(img,0,0);data=await new Promise(r=>c.toBlob(r,'image/png'));}
    await downloads.save({filename:fn,data});msg.textContent='Saved '+fn;}
  catch(e){const c=e&&e.code;msg.textContent=c==='declined'?'Download cancelled.':c==='rate_limited'?'A download prompt is already open.':'Could not create the file here. Copy as text still works.';}}
async function copyText(){const ta=$('#sheetText');const t=ta.value;try{await navigator.clipboard.writeText(t);$('#sheetMsg').textContent='Copied. Paste it into a message or email.';}catch(e){ta.hidden=false;ta.focus();ta.select();$('#sheetMsg').textContent='Select-all is on: copy the text below.';}}

/* ---------- versions ---------- */
async function renderVersions(){const p=$('#versPanel');if(p.hidden)return;
  p.innerHTML=`<div class="d-head" style="margin:0"><div><span class="label">Versions</span><div class="small muted">Save the plan as it stands now, and go back to any saved version.</div></div><button class="btn ghost sm" data-cmd="versions">Close</button></div>
  <div class="toolbar"><input class="inp" id="verName" placeholder="Name this version, e.g. After East Regions" style="flex:1;min-width:200px"><button class="btn primary sm edit" data-cmd="saveversion">Save version</button></div><ul id="verList"><li class="small muted">Loading saved versions…</li></ul>`;
  if(!verCol){$('#verList').innerHTML='<li class="small muted">Versions need the saved plan to be available.</li>';return;}
  try{const q=await verCol.orderBy('savedAt','desc').limit(40).get();$('#verList').innerHTML=q.empty?'<li class="small muted">No saved versions yet.</li>':q.docs.map(d=>{const v=d.data();return `<li><span><b>${esc(v.name||'Untitled')}</b> <span class="small muted">${esc(new Date(v.savedAt).toLocaleString())}</span></span><span><button class="btn sm edit" data-cmd="restore" data-id="${esc(d.id)}">Restore</button> <button class="btn sm danger edit" data-cmd="delversion" data-id="${esc(d.id)}">Delete</button></span></li>`;}).join('');
    if(S.ro)p.querySelectorAll('.edit,input').forEach(x=>x.disabled=true);}
  catch(e){$('#verList').innerHTML='<li class="small muted">Could not load versions. Try again in a moment.</li>';}}

/* ---------- events ---------- */
function arm(btn,fn){if(btn.dataset.armed==='1'){btn.dataset.armed='';fn();return;}btn.dataset.armed='1';const t=btn.textContent;btn.textContent=COARSE?'Tap again to confirm':'Click again to confirm';setTimeout(()=>{if(btn.isConnected&&btn.dataset.armed==='1'){btn.dataset.armed='';btn.textContent=t;}},3500);}
const uid=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
document.addEventListener('click',e=>{
  const t=e.target.closest('[data-cmd]');if(!t||t.disabled)return;const c=t.dataset.cmd,ds=t.dataset;
  switch(c){
  case 'view':S.view=ds.v;S.sheet&&renderSheet();renderAll();break;
  case 'undo':undo();break;case 'redo':redo();break;
  case 'versions':{const p=$('#versPanel');p.hidden=!p.hidden;renderVersions();break;}
  case 'names':S.names=S.names==='short'?'full':'short';renderTimeline();break;
  case 'zoom':S.colW=Math.max(26,Math.min(70,S.colW+(+ds.d)));renderTimeline();break;
  case 'today':scrollToWeek(weekOf(today()));break;
  case 'closesel':S.sel=null;renderAll();break;
  case 'selbranch':S.view='season';select({type:'branch',bid:ds.id});break;
  case 'selmeet':select({type:'meet',id:ds.id});break;
  case 'week':select({type:'week',i:S.sel.i+(+ds.d),bid:S.sel.bid});scrollToWeek(S.sel.i);break;
  case 'focus':focusSwimmer(ds.id||'',false);break;
  case 'selperson':focusSwimmer(ds.id,true);break;
  case 'togglegroup':S.collapsed=S.collapsed.includes(ds.id)?S.collapsed.filter(x=>x!==ds.id):S.collapsed.concat(ds.id);renderTimeline();break;
  case 'resetperson':arm(t,()=>commit(()=>{const P=(S.plan.personal||{})[ds.id];if(P){delete P.own;delete P.ownPrio;delete P.ownSess;delete P.weeks;delete P.prio;delete P.prioG;}}));break;
  case 'deldormant':commit(()=>{const o=(persOf(ds.id).own||{})[ds.g];if(o)for(let i=+ds.a;i<=+ds.b;i++)delete o[i];});break;
  case 'togglecomp':S.expanded=S.expanded.includes(ds.id)?S.expanded.filter(x=>x!==ds.id):S.expanded.concat(ds.id);renderTimeline();break;
  case 'compall':S.expandAll=!S.expandAll;if(!S.expandAll)S.expanded=[];$('#compAllBtn').textContent=(S.expandAll?'▾':'▸')+' Load detail for all';renderTimeline();break;
  case 'newgroup':commit(()=>{const id=uid('b');const used=S.plan.branches.map(b=>b.color);S.plan.branches.push({id,name:'New group',parent:rootId(),color:PAL.find(p=>!used.includes(p))||PAL[0],note:'',weeks:{}});S.view='season';S.sel={type:'branch',bid:id};});later(()=>{const el=document.querySelector('#detail input[data-f="name"]');if(el){el.focus();el.select();}});break;
  case 'selevent':S.view='season';select({type:'event',id:ds.id});break;
  case 'addcampsch':commit(()=>{const e=S.plan.events.find(x=>x.id===ds.id);e.camp=e.camp||{attendees:[]};(e.camp.schedule=e.camp.schedule||[]).push({s:'',f:''});});break;
  case 'delcampsch':commit(()=>{const e=S.plan.events.find(x=>x.id===ds.id);if(e&&e.camp&&e.camp.schedule)e.camp.schedule.splice(+ds.n,1);});break;
  case 'addmove':{const w=+$('#mvW').value,to=$('#mvTo').value;commit(()=>{const sw=S.roster.swimmers.find(s=>s.id===ds.id);sw.moves=(sw.moves||[]).concat({w,to});normMoves(sw);},'roster');break;}
  case 'delmove':commit(()=>{const sw=S.roster.swimmers.find(s=>s.id===ds.id);sw.moves.splice(+ds.n,1);normMoves(sw);},'roster');break;
  case 'addswimmer':S.adding=true;S.focus='';S.view='squad';renderAll();later(()=>{const el=$('#nsName');if(el){el.focus();el.scrollIntoView({block:'nearest'});}});break;
  case 'canceladd':S.adding=false;renderAll();break;
  case 'createswimmer':{if(S.ro||!S.roster)break;const name=($('#nsName').value||'').trim().replace(/\s+/g,' ');const msg=$('#nsMsg');
    if(!name){msg.textContent='Add a name first.';msg.style.color='var(--bad)';$('#nsName').focus();break;}
    let id=($('#nsId').value||'').replace(/\D/g,'');if(id&&S.roster.swimmers.some(x=>x.id===id)){msg.textContent='That Swim England number is already in the squad.';msg.style.color='var(--bad)';break;}
    if(!id)id='n'+Date.now().toString(36);
    const evs=[...document.querySelectorAll('.nsEv:checked')].map(x=>x.value).sort((a,b)=>evRank(a)-evRank(b));
    const sw={id,name,g:$('#nsG').value,dob:$('#nsDob').value||'',tag:'Silver_1',camp:'',branch:$('#nsGrp').value,moves:[],note:'',events:evs.map(blankEv)};
    S.adding=false;S.focus=id;commit(()=>{S.roster.swimmers.push(sw);S.roster.swimmers.sort((a,b)=>a.name.localeCompare(b.name));},'roster');break;}
  case 'delswimmer':arm(t,()=>commit(()=>{const id=ds.id;S.roster.swimmers=S.roster.swimmers.filter(x=>x.id!==id);if(S.plan.personal)delete S.plan.personal[id];
    S.plan.events.forEach(e=>{if(e.camp&&e.camp.attendees)e.camp.attendees=e.camp.attendees.filter(x=>x!==id);});
    if(S.focus===id)S.focus='';if(S.sheet===id){S.sheet='';$('#sheetOverlay').hidden=true;}if(S.sel&&S.sel.type==='person'&&S.sel.id===id)S.sel=null;},'both'));break;
  case 'addevent':{const e=$('#addEv').value;if(!e)break;commit(()=>{const sw=S.roster.swimmers.find(x=>x.id===ds.id);sw.events=sw.events||[];if(!sw.events.some(x=>x.e===e))sw.events.push(blankEv(e));sw.events.sort((a,b)=>evRank(a.e)-evRank(b.e));},'roster');break;}
  case 'delevent':arm(t,()=>commit(()=>{const sw=S.roster.swimmers.find(x=>x.id===ds.id);sw.events.splice(+ds.n,1);},'roster'));break;
  case 'addgoal':commit(()=>{const sw=S.roster.swimmers.find(x=>x.id===ds.id);(sw.goals=sw.goals||[]).push({id:uid('g'),text:'',event:'',target:null,course:'SC',meet:'',done:false});},'roster');later(()=>{const el=[...document.querySelectorAll('#detail .goalrow input[data-f="text"]')].pop();if(el)el.focus();});break;
  case 'delgoal':arm(t,()=>commit(()=>{const sw=S.roster.swimmers.find(x=>x.id===ds.id);sw.goals.splice(+ds.n,1);},'roster'));break;
  case 'newnotation':commit(()=>{const cur=nsys();S.plan.notation=S.plan.notation||{};const N=S.plan.notation;N.custom=N.custom||[];const id=uid('n');N.custom.push({id,name:(cur.custom?cur.name:cur.name.split(' (')[0])+' (my version)',custom:true,desc:cur.desc||'',levels:clone(cur.levels).map(l=>Object.assign(l,{k:uid('l')}))});N.active=id;});break;
  case 'addlevel':commit(()=>{const sys=nsys();const last=sys.levels[sys.levels.length-1];const lo=Math.min(21,(last?last.hi:0)+1);sys.levels.push({k:uid('l'),label:'New level',lo,hi:lo,color:TINT(lo),desc:''});});break;
  case 'dellevel':arm(t,()=>commit(()=>{nsys().levels.splice(+ds.n,1);}));break;
  case 'delnotation':arm(t,()=>commit(()=>{const N=S.plan.notation;N.custom=(N.custom||[]).filter(x=>x.id!==N.active);N.active='club';}));break;
  case 'resetsess':commit(()=>{clearSess(ds.bid,+ds.i,ds.s);});break;
  case 'openweek':S.view='season';select({type:'week',i:+ds.i,bid:ds.bid});later(()=>scrollToWeek(+ds.i));break;
  case 'addaway':commit(()=>{S.plan.personal=S.plan.personal||{};const P=S.plan.personal[ds.id]=S.plan.personal[ds.id]||{};(P.away=P.away||[]).push({id:uid('a'),type:ds.t,from:toISO(today()),to:toISO(today()+6*DAY),note:''});});break;
  case 'delaway':commit(()=>{const P=(S.plan.personal||{})[ds.id];if(P&&P.away)P.away.splice(+ds.n,1);});break;
  case 'copyweeks':{const src=$('#cpSrc').value,a=+$('#cpA').value,z=+$('#cpB').value;commit(()=>{for(let i=Math.min(a,z);i<=Math.max(a,z);i++){const w=rw(src,i);if(w)setWeek(ds.bid,i,Object.assign(rawC(w),{p:w.p,load:w.load}));}});break;}
  case 'showplan':S.view='season';focusSwimmer(ds.id,true);break;
  case 'sheet':S.sheet=ds.id;renderSheet();break;
  case 'gosquad':S.view='squad';renderAll();window.scrollTo({top:0});break;
  case 'closesheet':S.sheet='';$('#sheetOverlay').hidden=true;break;
  case 'dl':download(ds.f);break;case 'copytext':copyText();break;
  case 'hidelane':if(!S.hidden.includes(ds.id))S.hidden.push(ds.id);S.sel=null;renderAll();break;
  case 'showall':S.hidden=[];renderAll();break;
  case 'nudge':{const isStart=!!(S.sel&&+ds.j===S.sel.start);let nj=null;commit(()=>{nj=moveBoundary(ds.bid,+ds.j,+ds.j+(+ds.d));});if(isStart&&nj!=null){S.sel={type:'run',bid:ds.bid,start:nj};renderAll();}break;}
  case 'ramp':{const a=(+$('#rampA').value||0)/100,bb=(+$('#rampB').value||0)/100;commit(()=>{const r=runAt(ds.bid,+ds.start);const n=r.end-r.start;for(let i=r.start;i<=r.end;i++)setLoad(ds.bid,i,n?a+(bb-a)*(i-r.start)/n:a);});break;}
  case 'taper':{const vals=$('#taperIn').value.split(/[,\s]+/).map(Number).filter(x=>isFinite(x)&&x>=0).map(x=>r2(x/100));commit(()=>{const r=runAt(ds.bid,+ds.start);const ph=S.plan.phases[TL(ds.bid)[r.start].p];if(vals.length)ph.taper=vals;else delete ph.taper;reshape(ds.bid,TL(ds.bid)[r.start].p);});break;}
  case 'split':{const at=+$('#splitAt').value;commit(()=>{const r=runAt(ds.bid,+ds.start);const old=S.plan.phases[r.k];const id=uid('p');S.plan.phases[id]=Object.assign(clone(old),{name:old.name+' (2)'});delete S.plan.phases[id].taper;const arr=TL(ds.bid);for(let i=at;i<=r.end;i++)setWeek(ds.bid,i,Object.assign(rawC(arr[i].raw),{p:id,load:arr[i].plan}));});break;}
  case 'merge':commit(()=>{const arr=TL(ds.bid);const rr=runs(arr,w=>w.p);const ri=rr.findIndex(x=>x.start===+ds.start);const r=rr[ri],o=rr[ri+(+ds.d)];for(let i=r.start;i<=r.end;i++)setWeek(ds.bid,i,Object.assign(rawC(arr[i].raw),{p:o.k,load:arr[i].plan}));S.sel={type:'run',bid:ds.bid,start:Math.min(r.start,o.start)};});break;
  case 'resetrange':commit(()=>{for(let i=+ds.a;i<=+ds.b;i++)clearWeek(ds.bid,i);});break;
  case 'forkphase':commit(()=>{const r=runAt(ds.bid,+ds.start);const id=uid('p');const b=BR(ds.bid);S.plan.phases[id]=Object.assign(clone(S.plan.phases[r.k]),{name:S.plan.phases[r.k].name+' · '+b.name});const arr=TL(ds.bid);for(let i=r.start;i<=r.end;i++)setWeek(ds.bid,i,Object.assign(rawC(arr[i].raw),{p:id,load:arr[i].plan}));});break;
  case 'addbranch':commit(()=>{const id=uid('b');const used=S.plan.branches.map(b=>b.color);S.plan.branches.push({id,name:'New group',parent:ds.id,color:PAL.find(p=>!used.includes(p))||PAL[0],note:'',weeks:{}});S.sel={type:'branch',bid:id};});break;
  case 'delbranch':arm(t,()=>commit(()=>{const b=BR(ds.id);Object.values(S.plan.personal||{}).forEach(P=>{['own','ownPrio','ownSess'].forEach(f=>{const o=P[f];if(!o||!o[b.id])return;o[b.parent]=Object.assign({},o[b.id],o[b.parent]||{});delete o[b.id];});});S.roster&&S.roster.swimmers.forEach(s=>{if(s.branch===b.id)s.branch=b.parent;(s.moves||[]).forEach(m=>{if(m.to===b.id)m.to=b.parent;});normMoves(s);});S.plan.calendar.forEach(c=>{if(c.prio)delete c.prio[b.id];});S.plan.branches=S.plan.branches.filter(x=>x.id!==b.id);S.sel=null;if(focusBranch()===b.id)S.focus='';},'both'));break;
  case 'addmeet':commit(()=>{const id=uid('c');const d=toISO(today());const prio={};lanes().forEach(b=>prio[b.id]='C');S.plan.calendar.push({id,start:d,end:d,name:'New meet',short:'New meet',venue:'',course:'25m',level:'',prio,note:''});});break;
  case 'delmeet':arm(t,()=>commit(()=>{S.plan.calendar=S.plan.calendar.filter(x=>x.id!==ds.id);}));break;
  case 'addev':commit(()=>{const d=toISO(today());S.plan.events.push({id:uid('e'),start:d,end:d,name:'New date',type:'Holiday'});});break;
  case 'delev':arm(t,()=>commit(()=>{S.plan.events=S.plan.events.filter(x=>x.id!==ds.id);}));break;
  case 'addtpl':commit(()=>{S.plan.templates.push({name:'New template '+(S.plan.templates.length+1),s:{},note:''});});break;
  case 'saveversion':saveVersion();break;
  case 'restore':arm(t,()=>restoreVersion(ds.id));break;
  case 'delversion':arm(t,async()=>{try{await verCol.doc(ds.id).delete();}catch(e){}renderVersions();});break;
  case 'blank':blankPlan();break;
  }
});
async function saveVersion(){if(!verCol||S.ro)return;const name=($('#verName').value||'').trim()||('Version '+new Date().toLocaleDateString());
  try{prune();await verCol.add({name,savedAt:new Date().toISOString(),plan:clone(S.plan),roster:clone(S.roster)});renderVersions();}catch(e){$('#verList').insertAdjacentHTML('afterbegin',`<li class="small" style="color:var(--bad)">${e&&e.code==='quota_exceeded'?'Storage is full: delete an old version first.':'Could not save the version. Try again.'}</li>`);}}
async function restoreVersion(id){try{const d=await verCol.doc(id).get();if(!d.exists)return;const v=d.data();pushUndo();S.plan=clone(v.plan);S.roster=clone(v.roster);S.sel=null;inval();dirty('both');renderAll();}catch(e){}}
function blankPlan(){if(S.ro)return;const st=new Date();st.setUTCDate(st.getUTCDate()-((st.getUTCDay()+6)%7));const weeks={};for(let i=0;i<50;i++)weeks[i]={p:'p1',load:.6};
  S.plan={schema:1,settings:{start:toISO(Date.UTC(st.getUTCFullYear(),st.getUTCMonth(),st.getUTCDate())),weeks:50,near:.015,squad:'Squad',season:'Season'},sessions:[{id:'s1',label:'Session 1',time:'',hours:1.5,pool:'25m',mph:2500,day:0,role:''}],templates:[{name:'General',s:{},note:''}],
    phases:{p1:{macro:'1',name:'Block 1',template:'General',course:'SC',objective:''}},calendar:[],events:[],branches:[{id:'core',name:'Core',parent:null,color:'#E8731A',note:'',weeks}],notes:{}};
  S.roster=S.roster||{schema:1,source:'',rules:{nats:'',er:''},qts:{nats:{},er:{}},swimmers:[]};dirty('both');renderAll();}
document.addEventListener('change',e=>{
  const t=e.target;if(t.id==='focusSel'){focusSwimmer(t.value,true);return;}
  if(t.id==='weekBranch'){S.sel.bid=t.value;renderDetail();return;}
  if(t.id==='wwLine'){S.wwLine=t.value;renderSessions();return;}
  if(t.id==='wwDiff'){S.wwDiff=t.checked;renderSessions();return;}
  if(t.id==='notSel'){if(S.ro){S.view='sessions';renderSessions();return;}return commit(()=>{S.plan.notation=S.plan.notation||{};S.plan.notation.active=t.value;});}
  const k=t.dataset.k;if(!k||S.ro)return;const ds=t.dataset;
  if(k==='ph')return commit(()=>{S.plan.phases[ds.p][ds.f]=t.value;});
  if(k==='wkload')return commit(()=>{setLoad(ds.bid,+ds.i,Math.max(0,Math.min(150,+t.value||0))/100);});
  if(k==='note')return commit(()=>{S.plan.notes=S.plan.notes||{};if(t.value.trim())S.plan.notes[ds.i]=t.value;else delete S.plan.notes[ds.i];});
  if(k==='br')return commit(()=>{BR(ds.id)[ds.f]=t.value;});
  if(k==='meet')return commit(()=>{const c=S.plan.calendar.find(x=>x.id===ds.id);c[ds.f]=t.value;if(ds.f==='start'&&c.end<c.start)c.end=c.start;if(ds.f==='end'&&c.end<c.start)c.start=c.end;});
  if(k==='prio')return commit(()=>{const c=S.plan.calendar.find(x=>x.id===ds.id);c.prio=c.prio||{};c.prio[ds.b]=t.value;});
  if(k==='ev')return commit(()=>{const x=S.plan.events.find(y=>y.id===ds.id);x[ds.f]=t.value;if(x.end<x.start)x.end=x.start;});
  if(k==='sess')return commit(()=>{const x=S.plan.sessions.find(y=>y.id===ds.id);x[ds.f]=(ds.f==='hours'||ds.f==='mph')?Math.max(0,+t.value||0):t.value;});
  if(k==='tpl')return commit(()=>{const x=S.plan.templates[+ds.n];if(ds.f==='name'){const old=x.name;x.name=t.value;Object.values(S.plan.phases).forEach(p=>{if(p.template===old)p.template=t.value;});}else if(ds.f==='note')x.note=t.value;else x.s[ds.f]=t.value;});
  if(k==='set')return commit(()=>{if(ds.f==='near')S.plan.settings.near=Math.max(0,+t.value||0)/100;else if(t.value){const d=iso(t.value);const dd=new Date(d);const mon=d-((dd.getUTCDay()+6)%7)*DAY;S.plan.settings.start=toISO(mon);}});
  if(k==='swbranch')return commit(()=>{const sw=S.roster.swimmers.find(s=>s.id===ds.id);if(!t.value){sw.branch='';sw.moves=[];}else if(!planned(sw)){sw.branch=t.value;sw.moves=[];}else{sw.branch=t.value;normMoves(sw);}},'roster');
  if(k==='swnow')return commit(()=>{moveNow(S.roster.swimmers.find(s=>s.id===ds.id),t.value);},'roster');
  if(k==='mvw'||k==='mvto')return commit(()=>{const sw=S.roster.swimmers.find(s=>s.id===ds.id);const m=sw.moves[+ds.n];if(k==='mvw')m.w=+t.value;else m.to=t.value;normMoves(sw);},'roster');
  if(k==='away')return commit(()=>{const a=awayFor(ds.id)[+ds.n];a[ds.f]=t.value;if(ds.f==='from'&&(!a.to||a.to<a.from))a.to=a.from;if(ds.f==='to'&&a.to<a.from)a.from=a.to;});
  if(k==='swf'){const v=t.value.trim();if(ds.f==='name'&&!v){renderAll();return;}return commit(()=>{S.roster.swimmers.find(x=>x.id===ds.id)[ds.f]=ds.f==='name'?v.replace(/\s+/g,' '):v;},'roster');}
  if(k==='goal')return commit(()=>{const sw=S.roster.swimmers.find(x=>x.id===ds.id);const g=sw.goals[+ds.n];g[ds.f]=t.value;
    if(ds.f==='meet'){const c=S.plan.calendar.find(x=>x.id===t.value);if(c&&c.course)g.course=c.course==='50m'?'LC':'SC';}},'roster');
  if(k==='goaltime'){const v=pt(t.value);if(Number.isNaN(v)){t.style.borderColor='var(--bad)';t.title='Use 26.31 or 1:02.45';return;}return commit(()=>{S.roster.swimmers.find(x=>x.id===ds.id).goals[+ds.n].target=v;},'roster');}
  if(k==='goaldone')return commit(()=>{S.roster.swimmers.find(x=>x.id===ds.id).goals[+ds.n].done=t.checked;},'roster');
  if(k==='tf')return commit(()=>{const x=S.plan.templates[+ds.n];x.f=x.f||{};const o=x.f[ds.s]=x.f[ds.s]||{};if(!t.value)delete o[ds.f];else o[ds.f]=rFromLevel(t.value,o[ds.f]);if(!Object.keys(o).length)delete x.f[ds.s];});
  if(k==='sf')return commit(()=>{const cur=sessT(ds.bid,+ds.i,ds.s);const patch={};if(ds.f==='n')patch.n=t.value;else patch[ds.f]=t.value?rFromLevel(t.value,cur[ds.f]):null;setSess(ds.bid,+ds.i,ds.s,patch);});
  if(k==='nname'||k==='ndesc')return commit(()=>{nsys()[k==='nname'?'name':'desc']=t.value.trim()||nsys()[k==='nname'?'name':'desc'];});
  if(k==='nlev')return commit(()=>{const l=nsys().levels[+ds.n];if(ds.f==='lo'||ds.f==='hi'){const v=Math.max(1,Math.min(21,Math.round(+t.value||1)));l[ds.f]=v;if(l.lo>l.hi){if(ds.f==='lo')l.hi=v;else l.lo=v;}}else l[ds.f]=t.value;});
  if(k==='awaymod')return commit(()=>{const a=awayFor(ds.id)[+ds.n];a.mods=Object.assign({},INJ,a.mods||{});a.mods[ds.f]=Math.max(0,Math.min(1.5,(+t.value||0)/100));});
  if(k==='swnote')return commit(()=>{S.roster.swimmers.find(s=>s.id===ds.id).note=t.value;},'roster');
  if(k==='wkcomp')return commit(()=>{setComp(ds.bid,+ds.i,ds.c,Math.max(0,+t.value||0)/100);});
  if(k==='tplw')return commit(()=>{const x=S.plan.templates[+ds.n];x.w=Object.assign({},wts(x.name),x.w||{});x.w[ds.f]=Math.max(0,+t.value||0);});
  if(k==='campatt')return commit(()=>{const e=S.plan.events.find(x=>x.id===ds.ev);e.camp=e.camp||{};const a=new Set(e.camp.attendees||[]);if(t.checked)a.add(ds.id);else a.delete(ds.id);e.camp.attendees=[...a];});
  if(k==='campf')return commit(()=>{const e=S.plan.events.find(x=>x.id===ds.ev);e.camp=e.camp||{};const v=t.value.trim();if(ds.f==='km'){if(v==='')delete e.camp.load;else e.camp.load=r2((+v*1000)/peakVol());}else{if(v==='')delete e.camp[ds.f];else e.camp[ds.f]=Math.max(0,+v)/100;}});
  if(k==='campsch')return commit(()=>{const e=S.plan.events.find(x=>x.id===ds.ev);e.camp.schedule[+ds.n][ds.f]=t.value;});
  if(k==='brmember')return commit(()=>{const sw=S.roster.swimmers.find(s=>s.id===ds.id);const b=BR(ds.bid);if(t.checked)moveNow(sw,b.id);else if(curGroup(sw)===b.id)moveNow(sw,b.parent||rootId());},'roster');
  if(k==='brparent')return commit(()=>{BR(ds.id).parent=t.value;});
  if(k==='pprio')return commit(()=>{S.plan.personal=S.plan.personal||{};const P=S.plan.personal[ds.id]=S.plan.personal[ds.id]||{};const sw=S.roster.swimmers.find(x=>x.id===ds.id);const c=S.plan.calendar.find(x=>x.id===ds.c);const g=groupAt(sw,meetWk(c));P.ownPrio=P.ownPrio||{};const o=P.ownPrio[g]=P.ownPrio[g]||{};if(t.value)o[ds.c]=t.value;else delete o[ds.c];});
  if(k==='swtime'){const v=pt(t.value);if(Number.isNaN(v)){t.style.borderColor='var(--bad)';t.title='Use 26.31 or 1:02.45';return;}return commit(()=>{const sw=S.roster.swimmers.find(s=>s.id===ds.id);sw.events[+ds.n][ds.f]=v;},'roster');}
});
// squad drag & drop
document.addEventListener('dragstart',e=>{const c=e.target.closest&&e.target.closest('[data-sw]');if(!c||S.ro)return;e.dataTransfer.setData('text/plain',c.dataset.sw);e.dataTransfer.effectAllowed='move';});
document.addEventListener('dragover',e=>{const z=e.target.closest&&e.target.closest('[data-drop]');if(!z)return;e.preventDefault();document.querySelectorAll('.scol.over').forEach(x=>x!==z&&x.classList.remove('over'));z.classList.add('over');});
document.addEventListener('dragleave',e=>{const z=e.target.closest&&e.target.closest('[data-drop]');if(z&&!z.contains(e.relatedTarget))z.classList.remove('over');});
document.addEventListener('drop',e=>{const z=e.target.closest&&e.target.closest('[data-drop]');if(!z)return;e.preventDefault();z.classList.remove('over');const id=e.dataTransfer.getData('text/plain');const sw=S.roster&&S.roster.swimmers.find(s=>s.id===id);if(sw&&(planned(sw)?curGroup(sw):'')!==z.dataset.drop)commit(()=>{moveNow(sw,z.dataset.drop);},'roster');});
document.addEventListener('keydown',e=>{const tag=(e.target.tagName||'').toLowerCase();if(['input','textarea','select'].includes(tag))return;
  if((e.key==='Enter'||e.key===' ')&&e.target.matches&&e.target.matches('[role="button"][data-cmd]')){e.preventDefault();e.target.click();return;}
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();}
  else if(e.key==='Escape'){if(S.sheet){S.sheet='';$('#sheetOverlay').hidden=true;}else{S.sel=null;renderAll();}}});
document.addEventListener('toggle',e=>{const d=e.target;if(d&&d.classList&&d.classList.contains('tplcard')){const n=d.dataset.tpl;S.tplOpen=d.open?[...new Set(S.tplOpen.concat(n))]:S.tplOpen.filter(x=>x!==n);}},true);
$('#sheetOverlay').addEventListener('click',e=>{if(e.target.id==='sheetOverlay'){S.sheet='';e.target.hidden=true;}});

/* ---------- boot ---------- */
function onPlan(snap){S.loaded.plan=true;if(snap.metadata&&snap.metadata.hasPendingWrites)return;if(pend.plan||saving||drag)return;
  if(!snap.exists){S.plan=null;renderAll();return;}const d=snap.data();const s=JSON.stringify(d);if(S.plan&&s===JSON.stringify(S.plan))return;
  const first=!S.plan;S.plan=JSON.parse(s);inval();if(!S.ro)setStatus('saved','Saved');renderAll();if(first)later(()=>scrollToWeek(weekOf(today())));}
function onRoster(snap){S.loaded.roster=true;if(snap.metadata&&snap.metadata.hasPendingWrites)return;if(pend.roster||saving)return;
  if(!snap.exists){if(S.roster){S.roster=null;renderAll();}return;}const d=snap.data();const s=JSON.stringify(d);if(S.roster&&s===JSON.stringify(S.roster))return;S.roster=JSON.parse(s);renderAll();}
function onErr(e){setStatus('error',e&&e.code==='revoked'?'Access changed: reload the page':'Lost connection to the saved plan');}
async function boot(hot){
  if(hot){if(hot.view)S.view=hot.view;if(hot.colW)S.colW=hot.colW;if(hot.focus)S.focus=hot.focus;if(hot.hidden)S.hidden=hot.hidden;if(hot.collapsed)S.collapsed=hot.collapsed;}
  renderAll();
  const C=window.claude;if(!C||!C.use){S.loaded.plan=true;setStatus('error','Not connected');renderAll();return;}
  C.use('downloads').then(d=>{downloads=d;if(S.sheet)renderSheet();}).catch(()=>{});
  try{db=await C.use('db');}catch(e){db=null;}
  if(!db){S.loaded.plan=true;setStatus('error','Saved plan unavailable');renderAll();return;}
  try{const u=await C.use('user');if(u&&u.can){const ok=await u.can('data.write');if(ok===false){S.ro=true;setStatus('idle','View only');}}}catch(e){}
  planRef=db.doc('plans/main');rosterRef=db.doc('squad/roster');verCol=db.collection('versions');
  planRef.onSnapshot(onPlan,onErr);rosterRef.onSnapshot(onRoster,onErr);
}
const H=window.claude&&window.claude.hot;
if(H&&H.snapshot)H.snapshot(()=>({view:S.view,colW:S.colW,focus:S.focus,hidden:S.hidden,collapsed:S.collapsed}));
if(H&&H.ready)H.ready(boot);else boot(H&&H.data||{});
  return {
    destroy(){
      try { if (typeof flush === 'function') flush() } catch (e) {}
      listeners.forEach(([t, type, h, o]) => t.removeEventListener(type, h, o))
      root.innerHTML = ''; root.classList.remove('sp')
    },
  }

}
