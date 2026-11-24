(() => {
  'use strict';

  const KEY = 'ms.v2';
  const SEEN = 'ms.seen';
  const STEP = 5 * 60e3;            // size of the +/- adjust buttons
  const AWAY_MS = 15 * 60e3;        // a gap this long with a timer running prompts "were you away?"
  const KEEP_MS = 60 * 864e5;       // history kept for 60 days
  const HUES = [285, 200, 150, 60, 350, 110, 240, 25];
  const $ = (id) => document.getElementById(id);

  // A timer is { id, name, hue, sessions: [[startMs, endMs | null], ...] }.
  // Elapsed time is always derived from timestamps, so timers keep running while the page is closed.
  let state = load();
  let lastTick = Date.now();
  let lastSeenWrite = 0;
  let away = null;
  let undo = null;
  let toastTimer = 0;
  let iconKey = '';
  let selDay = null;                // day-start ms of the day picked in the week chart (not persisted)
  let weekKey = '', dayHtml = '';
  const lists = new Set([$('list')]);   // the main list plus the floating window's list

  // ---------- state ----------
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && Array.isArray(s.timers)) return s;
    } catch {}
    const s = { timers: [], solo: true, last: null };
    try {   // carry over custom names from the original app
      const old = JSON.parse(localStorage.getItem('stopwatches'));
      if (Array.isArray(old)) {
        for (const o of old) {
          if (o && typeof o.title === 'string' && o.title.trim() && !/^Stopwatch \d+$/.test(o.title)) {
            s.timers.push(make(o.title.trim(), s.timers));
          }
        }
      }
    } catch {}
    return s;
  }

  function save() {
    const cutoff = Date.now() - KEEP_MS;
    for (const t of state.timers) t.sessions = t.sessions.filter(([, e]) => e == null || e > cutoff);
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  function make(name, existing) {
    const used = new Set(existing.map((t) => t.hue));
    const hue = HUES.find((h) => !used.has(h)) ?? HUES[existing.length % HUES.length];
    return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, hue, sessions: [] };
  }

  const byId = (id) => state.timers.find((t) => t.id === id);
  const byName = (name) => state.timers.find((t) => t.name.toLowerCase() === name.toLowerCase());
  const running = (t) => { const l = t.sessions[t.sessions.length - 1]; return l && l[1] == null ? l : null; };
  const span = (t, a, b, now) => t.sessions.reduce((n, [s, e]) => n + Math.max(0, Math.min(e ?? now, b) - Math.max(s, a)), 0);
  const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

  // ---------- actions ----------
  function stop(t, at = Date.now()) {
    const r = running(t);
    if (!r) return;
    r[1] = at;
    if (r[1] - r[0] < 1000) t.sessions.pop();
  }
  // Solo mode: take the window [a, b) away from every other timer so time is never double counted.
  function clipOthers(t, a, b) {
    if (!state.solo || b <= a) return;
    for (const x of state.timers) {
      if (x === t) continue;
      x.sessions = x.sessions.flatMap(([s, e]) => {
        if ((e ?? Infinity) <= a || s >= b) return [[s, e]];
        return [...(s < a ? [[s, a]] : []), ...((e ?? Infinity) > b ? [[b, e]] : [])].filter(([p, q]) => q == null || q - p >= 1000);
      });
    }
  }
  function start(t, at = Date.now()) {   // `at` in the past backdates the start (forgotten timer)
    const now = Date.now(), r = running(t), prev = t.sessions[t.sessions.length - (r ? 2 : 1)];
    at = Math.max(at, prev?.[1] ?? 0);    // never overlap this timer's previous session
    if (r) { if (at >= r[0]) return; r[0] = at; }
    else t.sessions.push([at, null]);
    if (state.solo) {
      for (const x of state.timers) if (x !== t) stop(x, now);
      clipOthers(t, at, now);
    }
    state.last = t.id;
  }
  // Remove (d < 0) or add (d > 0) up to |d| ms of today's time on t; returns whether anything changed.
  function adjust(t, d, now = Date.now()) {
    const mid = dayStart(now), s = t.sessions;
    if (d > 0) {
      const last = s[s.length - 1];
      if (last && (last[1] ?? now) > mid) {   // grow the latest session backwards
        const prev = s[s.length - 2], ns = Math.max(mid, prev?.[1] ?? 0, last[0] - d);
        if (last[0] - ns < 1000) return false;
        clipOthers(t, ns, last[0]);
        last[0] = ns;
        return true;
      }
      const a = Math.max(mid, now - d);
      if (now - a < 1000) return false;
      clipOthers(t, a, now);
      s.push([a, now]);
      return true;
    }
    let left = -d, changed = false;
    for (let i = s.length - 1; i >= 0 && left > 0; i--) {
      const [a, e] = s[i], end = e ?? now, lo = Math.max(a, mid), take = Math.min(end - lo, left);
      if (take <= 0) continue;
      left -= take; changed = true;
      if (e == null) {   // open session: move its start later (a session spanning midnight is split there)
        if (a < mid) s.splice(i, 1, [a, mid], [mid + take, null]); else s[i][0] = a + take;
      } else if (a >= mid && e - take - a < 1000) s.splice(i, 1);
      else s[i][1] = e - take;
    }
    return changed;
  }
  function nudge(t, d) {
    if (!t) return;
    adjust(t, d);
    state.last = t.id;
    commit();
  }
  function toggle(t) {
    if (!t) return;
    running(t) ? stop(t) : start(t);
    commit();
  }
  // "Write report 1h 30m" -> name plus how long ago it really started (0 minutes = just strip it; capped at 12h)
  function parseDur(text) {
    text = text.trim();
    const m = /^(.*?\S)\s+(?:(\d+)\s*h(?:\s*(\d+)\s*m)?|(\d+)\s*m)$/i.exec(text);
    const min = m ? (m[4] != null ? +m[4] : m[2] * 60 + +(m[3] || 0)) : 0;
    return m ? { name: m[1], ms: Math.min(min, 720) * 60e3 } : { name: text, ms: 0 };
  }
  function begin(text) {   // start by name, creating the timer if needed
    const { name: raw, ms } = parseDur(text), name = raw.slice(0, 60).trim();
    if (!name) return;
    let t = byName(name);
    if (!t) { t = make(name, state.timers); state.timers.push(t); }
    start(t, Date.now() - ms);
    commit(true);
  }
  function stopAll() { state.timers.forEach((t) => stop(t)); commit(); }
  function commit(structural) {
    save();
    if (structural) build();
    paint();
  }

  // ---------- formatting ----------
  const pad = (n) => String(n).padStart(2, '0');
  function clock(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }
  function words(ms) {
    const m = Math.round(ms / 60e3);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  }
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // ---------- rendering ----------
  function build() {
    const html = state.timers.map((t, i) => `
      <li class="card" data-id="${t.id}" style="--h:${t.hue}">
        <button class="play" type="button" tabindex="0">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path class="i-play" d="M8 5v14l11-7z"/><path class="i-pause" d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
        </button>
        <span class="who"><span class="name">${esc(t.name)}</span><span class="sub"></span></span>
        <span class="time"></span>
        <span class="acts">
          <button type="button" data-act="minus" aria-label="Remove 5 minutes from ${esc(t.name)}">−5</button>
          <button type="button" data-act="plus" aria-label="Add 5 minutes to ${esc(t.name)}">+5</button>
          <button type="button" data-act="edit" aria-label="Rename ${esc(t.name)}">✎</button>
          <button type="button" data-act="del" aria-label="Delete ${esc(t.name)}">✕</button>
          ${i < 9 ? `<kbd class="key">${i + 1}</kbd>` : ''}
        </span>
      </li>`).join('');
    for (const el of lists) {
      el.innerHTML = html || (el === $('list') ? '' : '<li class="empty">No timers yet</li>');
    }
  }

  function paint() {
    const now = Date.now(), today = dayStart(now);
    let total = 0;
    const live = [];
    const per = new Map();
    for (const t of state.timers) {
      const ms = span(t, today, Infinity, now), r = running(t);
      per.set(t.id, { ms, r });
      total += ms;
      if (r) live.push(t);
    }

    for (const el of lists) {
      for (const card of el.querySelectorAll('.card')) {
        const t = byId(card.dataset.id), p = per.get(card.dataset.id);
        if (!p) continue;
        card.classList.toggle('on', !!p.r);
        card.querySelector('.time').textContent = clock(p.ms);
        card.querySelector('.sub').textContent = p.r ? `running ${clock(now - p.r[0])}` : '';
        card.querySelector('.play').setAttribute('aria-label', `${p.r ? 'Pause' : 'Start'} ${t.name}`);
      }
    }

    $('total').textContent = clock(total);
    $('date').textContent = new Date(now).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    document.title = live.length
      ? `${clock(per.get(live[0].id).ms)} · ${live[0].name}${live.length > 1 ? ` +${live.length - 1}` : ''}`
      : 'Stopwatch';

    paintTimeline(now, today);
    paintWeek(now, today);
    paintIcon(live);
  }

  function paintTimeline(now, today) {
    let first = now;
    for (const t of state.timers) for (const [s, e] of t.sessions) if ((e ?? now) > today) first = Math.min(first, Math.max(s, today));
    const from = Math.min(first, now - 36e5), range = now - from;
    let html = '';
    for (const t of state.timers) {
      for (const [s, e] of t.sessions) {
        const a = Math.max(s, from), b = Math.min(e ?? now, now);
        if (b > a) html += `<i class="seg" style="--h:${t.hue};left:${((a - from) / range) * 100}%;width:${((b - a) / range) * 100}%"></i>`;
      }
    }
    $('timeline').innerHTML = html;
    $('from').textContent = hhmm(from);
  }

  function paintWeek(now, today) {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const a = d.getTime(), e = new Date(a); e.setDate(e.getDate() + 1);
      const parts = state.timers.map((t) => ({ hue: t.hue, ms: span(t, a, e.getTime(), now) })).filter((p) => p.ms > 0);
      days.push({ a, parts, ms: parts.reduce((n, p) => n + p.ms, 0) });
    }
    const max = Math.max(...days.map((d) => d.ms), 1), wk = $('week');
    if (!days.some((d) => d.a === selDay)) selDay = null;
    const key = days.map((d) => d.a).join();
    if (key !== weekKey) {   // only rebuild the buttons when the days change, so keyboard focus survives the ticks
      weekKey = key;
      wk.innerHTML = days.map((d) => `
        <button type="button" class="day${d.a === today ? ' now' : ''}" data-day="${d.a}">
          <span class="col"><span class="stack"></span></span>${new Date(d.a).toLocaleDateString([], { weekday: 'narrow' })}
        </button>`).join('');
    }
    days.forEach((d, i) => {
      const b = wk.children[i], name = new Date(d.a).toLocaleDateString([], { weekday: 'long' }), stack = b.querySelector('.stack');
      b.classList.toggle('sel', d.a === selDay);
      b.setAttribute('aria-pressed', d.a === selDay);
      b.title = `${name}: ${words(d.ms)}`;
      b.setAttribute('aria-label', `${name}, ${words(d.ms)}`);
      stack.style.height = `${(d.ms / max) * 100}%`;
      stack.innerHTML = d.parts.map((p) => `<i class="seg" style="--h:${p.hue};flex:${p.ms}"></i>`).join('');
    });
    paintDay(now);
  }

  function paintDay(now) {   // breakdown of the day picked in the week chart
    const el = $('dayview');
    el.hidden = selDay == null;
    if (selDay == null) { dayHtml = ''; return; }
    const e = new Date(selDay); e.setDate(e.getDate() + 1);
    const rows = state.timers.map((t) => ({ t, ms: span(t, selDay, e.getTime(), now) })).filter((r) => r.ms > 0).sort((a, b) => b.ms - a.ms);
    const total = rows.reduce((n, r) => n + r.ms, 0), d = new Date(selDay), top = rows[0]?.ms || 1;
    const html = rows.length
      ? `<h2>${d.toLocaleDateString([], { weekday: 'long' })} ${d.getDate()} ${d.toLocaleDateString([], { month: 'short' })} · ${words(total)} total</h2><ul>${rows.map((r) => `
          <li style="--h:${r.t.hue}"><i class="dot"></i><span class="n">${esc(r.t.name)}</span><span class="d">${words(r.ms)}</span><span class="bar"><i style="width:${(r.ms / top) * 100}%"></i></span></li>`).join('')}</ul>`
      : `<h2>Nothing tracked on ${d.toLocaleDateString([], { weekday: 'long' })}</h2>`;
    if (html !== dayHtml) el.innerHTML = dayHtml = html;
  }

  function paintIcon(live) {   // the tab icon and dock badge show at a glance whether anything is running
    const key = live.map((t) => t.hue).join();
    if (key === iconKey) return;
    iconKey = key;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const color = live.length ? `oklch(0.8 0.14 ${live[0].hue})` : '#6b7080';
    g.fillStyle = '#0c0d10';
    g.beginPath(); g.roundRect(0, 0, 64, 64, 14); g.fill();
    g.strokeStyle = color; g.lineWidth = 7; g.lineCap = 'round';
    g.beginPath(); g.arc(32, 32, 19, -Math.PI / 2, live.length ? Math.PI * 1.1 : Math.PI * 1.5); g.stroke();
    if (live.length) { g.fillStyle = color; g.beginPath(); g.arc(32, 32, 7, 0, Math.PI * 2); g.fill(); }
    $('favicon').href = c.toDataURL();
    if (navigator.setAppBadge) (live.length ? navigator.setAppBadge(live.length) : navigator.clearAppBadge()).catch(() => {});
  }

  // ---------- CSV export ----------
  const csvCell = (v) => {
    v = String(v);
    if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;   // stop spreadsheets treating a name as a formula
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  function csvOf(timers, now) {   // one row per session per day, oldest first; null when there is nothing to export
    const rows = [];
    for (const t of timers) for (const [s, e] of t.sessions) {
      for (let a = s, end = e ?? now; a < end || a === s;) {   // split at local midnight so a row never ends before it starts
        const n = new Date(a); n.setHours(24, 0, 0, 0);
        const b = Math.min(end, n.getTime());
        rows.push([t.name, a, b, b === n.getTime()]);
        a = b;
        if (a >= end) break;
      }
    }
    if (!rows.length) return null;
    const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    const time = (ms, eod) => { const d = new Date(ms); return eod ? '24:00' : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    return ['timer,date,start,end,minutes', ...rows.sort((a, b) => a[1] - b[1]).map(([n, s, e, eod]) =>
      [n, day(s), time(s), time(e, eod), ((e - s) / 60e3).toFixed(1)].map(csvCell).join(','))].join('\r\n') + '\r\n';
  }
  function exportCsv() {
    const now = Date.now(), csv = csvOf(state.timers, now);
    if (!csv) return note('Nothing to export yet');
    const d = new Date(now), a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `stopwatch-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---------- list interactions (shared by the page and the floating window) ----------
  function wire(el) {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('input')) return;
      const card = ev.target.closest('.card');
      if (!card) return;
      const t = byId(card.dataset.id), act = ev.target.closest('[data-act]')?.dataset.act;
      if (act === 'edit') rename(card, t);
      else if (act === 'minus') nudge(t, -STEP);
      else if (act === 'plus') nudge(t, STEP);
      else if (act === 'del') remove(t);
      else toggle(t);
    });
  }

  function rename(card, t) {
    const label = card.querySelector('.name');
    const input = document.createElement('input');
    input.className = 'name'; input.value = t.name; input.maxLength = 60;
    label.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (keep && v) t.name = v;
      commit(true);
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
    });
  }

  function toast(text, canUndo, ms) {   // one shared toast timer, so an earlier toast can't hide a later one
    clearTimeout(toastTimer);
    $('toastText').textContent = text;
    $('undo').hidden = !canUndo;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; undo = null; }, ms);
  }
  function remove(t) {
    const index = state.timers.indexOf(t);
    stop(t);
    state.timers.splice(index, 1);
    commit(true);
    undo = { t, index };
    toast(`Deleted “${t.name}”`, true, 6000);
  }
  function note(text) { undo = null; toast(text, false, 5000); }   // a toast without the undo button
  $('undo').addEventListener('click', () => {
    if (!undo) return;
    clearTimeout(toastTimer);
    state.timers.splice(undo.index, 0, undo.t);
    undo = null;
    $('toast').hidden = true;
    commit(true);
  });

  // ---------- away detection ----------
  // If nothing ticked for a while (laptop asleep, app closed) while a timer ran, ask instead of guessing.
  function checkAway(from, to) {
    if (!from || to - from < AWAY_MS) return;
    const hit = state.timers.filter((t) => { const r = running(t); return r && r[0] < from; });
    if (!hit.length) return;
    away = { from: away ? Math.min(away.from, from) : from, to };
    $('awayText').textContent = `${hit.map((t) => t.name).join(', ')} kept running while this was closed or asleep (${words(away.to - away.from)}, since ${hhmm(away.from)}).`;
    $('away').hidden = false;
  }
  $('awayKeep').addEventListener('click', () => { away = null; $('away').hidden = true; });
  $('awayDrop').addEventListener('click', () => {
    for (const t of state.timers) {
      const r = running(t);
      if (r && r[0] < away.from) { r[1] = away.from; t.sessions.push([away.to, null]); }
    }
    away = null;
    $('away').hidden = true;
    commit();
  });

  function tick() {
    const now = Date.now();
    checkAway(lastTick, now);
    lastTick = now;
    if (now - lastSeenWrite > 15e3) { lastSeenWrite = now; localStorage.setItem(SEEN, now); }
    paint();
  }

  // ---------- floating always-on-top window ----------
  async function popOut() {
    if (!('documentPictureInPicture' in window)) return;
    if (documentPictureInPicture.window) return documentPictureInPicture.window.close();
    let w;
    try {
      w = await documentPictureInPicture.requestWindow({ width: 280, height: Math.min(60 + state.timers.length * 44, 360) });
    } catch {
      note('This browser blocked the floating window. Try Chrome or Edge.');
      return;
    }
    const css = w.document.createElement('link');
    css.rel = 'stylesheet'; css.href = new URL('style.css', location.href).href;
    w.document.head.append(css);
    w.document.body.className = 'pip';
    const ul = w.document.createElement('ul');
    ul.className = 'list';
    w.document.body.append(ul);
    lists.add(ul); wire(ul); build(); paint();
    w.addEventListener('pagehide', () => lists.delete(ul));
  }

  // ---------- wiring ----------
  wire($('list'));

  $('add').addEventListener('submit', (ev) => {
    ev.preventDefault();
    begin($('q').value);
    $('q').value = '';
    $('q').blur();
  });

  $('export').addEventListener('click', (ev) => {
    exportCsv();
    if (ev.detail) ev.currentTarget.blur();   // after a mouse click, let Space pause/resume again
  });
  $('week').addEventListener('click', (ev) => {
    const b = ev.target.closest('.day');
    if (!b) return;
    selDay = selDay === Number(b.dataset.day) ? null : Number(b.dataset.day);
    paint();
    if (ev.detail) b.blur();
  });

  $('solo').checked = state.solo;
  $('solo').addEventListener('change', (ev) => { state.solo = ev.target.checked; commit(); });

  if ('documentPictureInPicture' in window) {
    $('pop').hidden = false;
    $('pop').addEventListener('click', popOut);
  }

  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); installEvent = ev; $('install').hidden = false; });
  $('install').addEventListener('click', () => { installEvent?.prompt(); $('install').hidden = true; });

  document.addEventListener('keydown', (ev) => {
    if (ev.target.matches('input')) { if (ev.key === 'Escape') ev.target.blur(); return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === '/' || ev.key === 'n') { ev.preventDefault(); $('q').focus(); }
    else if (ev.key >= '1' && ev.key <= '9') toggle(state.timers[ev.key - 1]);
    else if (ev.key === ' ' && !ev.target.matches('button')) { ev.preventDefault(); toggle(byId(state.last) || state.timers[0]); }
    else if (ev.key === '+' || ev.key === '=') nudge(byId(state.last) || state.timers[0], STEP);
    else if (ev.key === '-') nudge(byId(state.last) || state.timers[0], -STEP);
    else if (ev.key === 'p') popOut();
    else if (ev.key === 'Escape' && selDay != null) { selDay = null; paint(); }
  });

  // another tab or the installed app changed something
  window.addEventListener('storage', (ev) => {
    if (ev.key !== KEY) return;
    state = load();
    $('solo').checked = state.solo;
    build(); paint();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  // Links that act: ?start=Name, ?toggle=Name, ?stop — for launchers, Shortcuts and bookmarks.
  const q = new URLSearchParams(location.search);
  checkAway(Number(localStorage.getItem(SEEN)), Date.now());
  if (q.has('start')) begin(q.get('start'));
  else if (q.has('toggle')) { const t = byName(q.get('toggle').trim()); t ? toggle(t) : begin(q.get('toggle')); }
  else if (q.has('stop')) stopAll();
  if (location.search) history.replaceState(null, '', location.pathname);

  build();
  tick();
  setInterval(tick, 1000);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
