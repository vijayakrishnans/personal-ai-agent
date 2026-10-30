// The agent's page, served at GET /. Its footer credits Orunbase, the
// platform it was created with — the owner's to keep (NOTICE asks only that
// the attribution travel with the source, not that the page show it).
// One self-contained document — no script, style or font from anywhere else;
// the only outside requests are OpenStreetMap's map tiles, when a map is
// shown — so the Worker is the whole of what the owner's browser talks to.
// The access key stays in the browser (localStorage); everything else is read
// from and written to /api with the key as a bearer token.
//
// The sidebar lists the owner's conversations — the latest few, or those a
// search finds. ☰ opens the settings: the knowledge graph, notes (which
// expire unless kept), the skills it follows, their library (every image the
// agent drew, every answer kept whole), the models — chat and image — and
// access: the kill switch, what the agent did, and locking this browser.
// Every message can be copied, added to the knowledge (an answer as the
// question and what it said), saved (a note for 2 or 7 days, knowledge, or
// the library) and an answer taken as a screenshot. The Tools menu beside
// the input asks the agent to use one for a message. Images and maps are
// shown in the chat.

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

// The page's script, raw: its regular expressions keep their backslashes
// (in a plain template string `\s` would arrive as `s`). It holds no
// backtick and no `${`.
const SCRIPT = String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
  let key = store.get('agent.key', '');
  let convId = store.get('agent.conversation', '') || newId();
  let messages = store.get('agent.messages', []);
  let models = [];
  let memories = [];
  let selected = null; // { kind: 'space', name } | { kind: 'memory', id }
  let paused = false;
  let imageModels = [];
  let chosenImageModel = '';
  let mode = null;
  function renderImageModels() {
    $('image-model').replaceChildren(...imageModels.map((m) => { const o = new Option(m.label, m.id); o.selected = m.id === chosenImageModel; return o; }));
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key, ...(opts.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { lock('That key was not accepted.'); throw new Error('unauthorized'); }
    if (res.status === 503 && body.error === 'agent_paused') { showPaused(true); throw new Error(body.message); }
    if (res.status === 503) { lock(body.message); throw new Error(body.error); }
    if (!res.ok) throw new Error(body.message || ('HTTP ' + res.status));
    return body;
  }

  function lock(hint) {
    key = ''; store.del('agent.key');
    if ($('settings').open) $('settings').close();
    if (hint) $('lock-hint').textContent = hint;
    $('lock').hidden = false; $('key').focus();
  }

  function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    e.append(...children);
    return e;
  }
  function li(text, onRemove) {
    const item = el('li', {}, el('span', { textContent: text }));
    if (onRemove) item.appendChild(el('button', { type: 'button', textContent: 'Remove', onclick: onRemove }));
    return item;
  }
  function svg(tag, attrs = {}, text) {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // MARKDOWN, as models write it: headings, lists, tables, code, bold,
  // italics and links — built as elements, never as HTML, so an answer can
  // never put markup on the page.
  function link(href, text) { return el('a', { href, textContent: text, target: '_blank', rel: 'noopener noreferrer' }); }
  function inline(text) {
    const out = document.createDocumentFragment();
    const re = /(\*\*[^*]+\*\*|__[^_]+__|\x60[^\x60]+\x60|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|\*[^*\s][^*]*\*)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.append(text.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('**') || t.startsWith('__')) out.append(el('strong', { textContent: t.slice(2, -2) }));
      else if (t[0] === '\x60') out.append(el('code', { textContent: t.slice(1, -1) }));
      else if (t[0] === '[') { const k = t.indexOf(']('); out.append(link(t.slice(k + 2, -1), t.slice(1, k))); }
      else if (t.startsWith('http')) out.append(link(t, t));
      else out.append(el('em', { textContent: t.slice(1, -1) }));
      last = m.index + t.length;
    }
    if (last < text.length) out.append(text.slice(last));
    return out;
  }
  const isRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  function table(rows) {
    const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const body = rows.filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r) || !/-/.test(r));
    const t = el('table');
    body.forEach((r, i) => t.append(el('tr', {}, ...cells(r).map((c) => el(i ? 'td' : 'th', {}, inline(c))))));
    return el('div', { className: 'table' }, t);
  }
  function md(text) {
    const root = document.createDocumentFragment();
    const lines = String(text || '').split('\n');
    let list = null, para = [];
    const flush = () => {
      if (!para.length) return;
      const p = el('p');
      para.forEach((line, i) => { if (i) p.append(el('br')); p.append(inline(line)); });
      root.append(p); para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*\x60\x60\x60/.test(line)) {
        flush(); list = null;
        const code = []; i++;
        while (i < lines.length && !/^\s*\x60\x60\x60/.test(lines[i])) code.push(lines[i++]);
        root.append(el('pre', {}, el('code', { textContent: code.join('\n') })));
        continue;
      }
      if (isRow(line)) {
        flush(); list = null;
        const rows = [];
        while (i < lines.length && isRow(lines[i])) rows.push(lines[i++]);
        i--; root.append(table(rows));
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flush(); list = null; root.append(el(h[1].length <= 2 ? 'h4' : 'h5', {}, inline(h[2].replace(/\s*#+\s*$/, '')))); continue; }
      const b = /^\s*[-*•+]\s+(.*)$/.exec(line), n = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      if (b || n) {
        flush();
        const tag = b ? 'UL' : 'OL';
        if (!list || list.tagName !== tag) { list = el(tag.toLowerCase()); if (n) list.start = Number(n[1]); root.append(list); }
        list.append(el('li', {}, inline(b ? b[1] : n[2])));
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); list = null; root.append(el('hr')); continue; }
      if (!line.trim()) { flush(); list = null; continue; }
      if (list && /^\s{2,}\S/.test(line)) { list.lastChild.append(' ', inline(line.trim())); continue; }
      list = null; para.push(line.trim());
    }
    flush();
    return root;
  }
  /** Markdown as plain words: what a screenshot and a note keep. */
  const plain = (s) => String(s || '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/\x60([^\x60]+)\x60/g, '$1').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)');

  // THE CHAT: each message a bubble — the owner's words as typed, an answer
  // as markdown, with the images and maps shown with it.
  function bubble(m, i) {
    const div = el('div', { className: 'msg ' + m.role + (m.error ? ' error' : '') });
    if (m.role === 'assistant' && !m.error && m.content !== '…') div.append(el('div', { className: 'md' }, md(m.content)));
    else div.append(el('div', { className: 'said', textContent: m.content }));
    for (const im of m.images || []) div.appendChild(picture(im));
    for (const v of m.maps || []) div.appendChild(mapView(v));
    if (m.meta) div.append(el('span', { className: 'meta', textContent: m.meta }));
    if (!m.error && (m.content || (m.images || []).length) && m.content !== '…') div.appendChild(actions(m, i));
    $('log').appendChild(div);
    $('log').scrollTop = $('log').scrollHeight;
    return div;
  }
  function render() { $('log').replaceChildren(); messages.forEach(bubble); }
  /** The question an answer answered: the owner's message before it. */
  function questionFor(i) {
    for (let j = i - 1; j >= 0; j--) if (messages[j].role === 'user') return messages[j].content;
    return '';
  }

  // EVERY MESSAGE'S ACTIONS: copy it; add it to the knowledge (an answer as
  // what was asked and what it said); save it — a note for 2 or 7 days, the
  // knowledge, or the library; and take an answer as a picture.
  function flash(b, text) { const was = b.textContent; b.textContent = text; setTimeout(() => { b.textContent = was; }, 1600); }
  function actions(m, i) {
    const bar = el('div', { className: 'actions' });
    const copy = el('button', { type: 'button', textContent: 'Copy', title: 'Copy to the clipboard' });
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(m.content); flash(copy, 'Copied'); }
      catch { flash(copy, 'Copy failed'); }
    };
    const answer = m.role === 'assistant';
    const know = el('button', { type: 'button', textContent: 'Add to knowledge', title: 'Keep this as something the agent knows' });
    know.onclick = () => toKnowledge(answer ? { question: questionFor(i), text: m.content } : { text: m.content });
    const save = el('button', { type: 'button', textContent: 'Save', title: 'Save as a note, to the knowledge, or to your library' });
    save.onclick = () => openSave(m, answer ? questionFor(i) : '');
    bar.append(copy, know, save);
    if (answer) {
      const shot = el('button', { type: 'button', textContent: 'Screenshot', title: 'Save the question and this answer as a picture' });
      shot.onclick = () => screenshot(m, questionFor(i)).then(() => flash(shot, 'Saved'), (err) => flash(shot, String(err.message || err).slice(0, 40)));
      bar.append(shot);
    }
    return bar;
  }

  // ADD TO KNOWLEDGE: a fact, or a question with the answer kept. From a
  // note, the note goes once it is in the knowledge.
  let fromNote = null;
  function toKnowledge(item) {
    const qa = !!item.question;
    fromNote = item.noteId || null;
    $('knowledge-q-row').hidden = !qa;
    $('knowledge-question').value = qa ? oneLine(item.question).slice(0, 1000) : '';
    $('knowledge-a-label').textContent = qa ? 'What it answered' : 'The fact';
    const max = qa ? 4000 : 500;
    $('knowledge-text').maxLength = max;
    const text = qa ? String(item.text).trim() : oneLine(item.text);
    $('knowledge-text').value = text.slice(0, max);
    $('knowledge-text').rows = qa ? 8 : 4;
    $('knowledge-space').value = '';
    $('knowledge-hint').textContent = qa
      ? 'Kept as a conversation: what you asked, and what it answered. The agent sees the question and the start of the answer in every chat, and can look up the rest.'
      : 'One fact the agent keeps and is told in every conversation. Trim it to what matters.';
    $('knowledge-note').textContent = text.length > max ? 'Shortened to ' + max + ' characters: keep the part worth knowing.' : '';
    $('to-knowledge').showModal();
    $('knowledge-text').focus();
  }

  // SAVE: a note that expires in 2 or 7 days, the knowledge, or the library.
  let saving = null;
  function openSave(m, question) {
    saving = { text: m.content, question, meta: m.meta || '' };
    $('save-preview').textContent = short(oneLine(plain(m.content).replace(/^\s*(#+|[-*•]|\|)\s*/gm, '').replace(/\|/g, ' ')), 160);
    $('save-note').textContent = '';
    $('save-list').value = '';
    $('keep-2').checked = true; $('save-list-row').hidden = false;
    $('save-dialog').showModal();
  }
  for (const r of document.querySelectorAll('input[name="keep"]')) r.onchange = () => { $('save-list-row').hidden = !/^keep-\d/.test(document.querySelector('input[name="keep"]:checked').id); };
  $('save-cancel').onclick = () => $('save-dialog').close();
  $('save-form').onsubmit = async (e) => {
    e.preventDefault();
    const how = document.querySelector('input[name="keep"]:checked').value;
    const it = saving;
    try {
      if (how === 'knowledge') { $('save-dialog').close(); toKnowledge(it.question ? { question: it.question, text: it.text } : { text: it.text }); return; }
      if (how === 'library') await api('/api/saved', { method: 'POST', body: JSON.stringify({ text: it.text, source: it.meta.split(' · used')[0] }) });
      else {
        const text = (it.question ? 'You asked: ' + oneLine(it.question) + '\n\n' : '') + plain(it.text);
        const body = { text: text.slice(0, 20000), keepDays: Number(how) };
        if ($('save-list').value.trim()) body.list = $('save-list').value.trim();
        await api('/api/notes', { method: 'POST', body: JSON.stringify(body) });
      }
      $('save-dialog').close();
      toast(how === 'library' ? 'Saved to your library' : 'Saved to notes for ' + how + ' days');
    } catch (err) { $('save-note').textContent = err.message; }
  };
  function toast(text) {
    const t = $('toast'); t.textContent = text; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 2400);
  }

  // A SCREENSHOT of an answer: the question, the answer and its pictures,
  // drawn on a canvas — downloaded as a PNG, and copied when the browser lets it.
  async function screenshot(m, question) {
    const W = 900, PAD = 48, MAXW = W - PAD * 2, scale = 2, MAX_H = 14000;
    const face = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const c = document.createElement('canvas'), g = c.getContext('2d');
    const fontOf = (b) => (b.weight || 400) + ' ' + b.size + 'px ' + face;
    const wrap = (text, width, font) => {
      g.font = font;
      const lines = []; let line = '';
      for (const word of String(text).split(' ')) {
        let w = word;
        while (g.measureText(w).width > width) { let k = w.length - 1; while (k > 1 && g.measureText(w.slice(0, k)).width > width) k--; if (line) { lines.push(line); line = ''; } lines.push(w.slice(0, k)); w = w.slice(k); }
        const next = line ? line + ' ' + w : w;
        if (g.measureText(next).width > width && line) { lines.push(line); line = w; } else line = next;
      }
      lines.push(line);
      return lines;
    };
    const blocks = [];
    blocks.push({ text: document.title + ' · ' + new Date().toLocaleDateString(), size: 13, weight: 600, color: '#6b6b66' });
    if (question) {
      blocks.push({ text: 'YOU ASKED', size: 12, weight: 700, color: '#3b5bdb', gap: 22 });
      blocks.push({ text: oneLine(question), size: 19, weight: 600, color: '#1d1d1b', gap: 6 });
    }
    blocks.push({ text: 'ANSWER', size: 12, weight: 700, color: '#3b5bdb', gap: 26 });
    let first = true;
    for (const raw of plain(m.content).split('\n')) {
      const line = raw.trim();
      if (!line || /^\|?[\s:|-]+\|?$/.test(line) && /-/.test(line)) { first = false; continue; }
      const h = /^#{1,6}\s+(.*)$/.exec(line), b = /^[-*•+]\s+(.*)$/.exec(line);
      if (h) blocks.push({ text: h[1], size: 18, weight: 700, color: '#1d1d1b', gap: 14 });
      else if (b) blocks.push({ text: b[1], size: 16, color: '#1d1d1b', gap: 4, bullet: true });
      else if (/^\d+[.)]\s/.test(line) || /^\|/.test(line)) blocks.push({ text: line.replace(/^\||\|$/g, '').replace(/\|/g, ' · '), size: 16, color: '#1d1d1b', gap: 4 });
      else blocks.push({ text: line.replace(/^\||\|$/g, '').replace(/\|/g, ' · '), size: 16, color: '#1d1d1b', gap: first ? 6 : 10 });
      first = false;
    }
    for (const v of m.maps || []) blocks.push({ text: 'Map: ' + v.title + (v.route ? ' — ' + v.route.km + ' km, ' + duration(v.route.minutes) + ' by ' + v.route.mode : ''), size: 14, color: '#6b6b66', gap: 12 });
    const pics = [];
    for (const im of m.images || []) {
      const url = pictures.get(im.id); if (!url) continue;
      const img = new Image(); img.src = url;
      try { await img.decode(); pics.push(img); } catch {}
    }
    const footer = { text: (m.meta || '').split(' · used')[0] + ' · Built with Orunbase', size: 12, color: '#9b9b94', gap: 26 };
    // Lay out, then draw.
    let y = PAD;
    const laid = [];
    for (const blk of [...blocks]) {
      const indent = blk.bullet ? 22 : 0;
      const lh = Math.round(blk.size * 1.5);
      y += blk.gap || 0;
      for (const [k, line] of wrap(blk.text, MAXW - indent, fontOf(blk)).entries()) {
        if (y > MAX_H) break;
        laid.push({ blk, line, x: PAD + indent, y, dot: blk.bullet && k === 0 }); y += lh;
      }
    }
    const picH = pics.map((p) => Math.round(Math.min(420, p.naturalWidth) * p.naturalHeight / p.naturalWidth));
    const picsAt = y + 12; y += 12 + picH.reduce((a, h) => a + h + 12, 0);
    laid.push({ blk: footer, line: wrap(footer.text, MAXW, fontOf(footer))[0], x: PAD, y: y + footer.gap });
    y += footer.gap + 20 + PAD;
    c.width = W * scale; c.height = y * scale; g.scale(scale, scale);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, y);
    g.fillStyle = '#3b5bdb'; g.fillRect(0, 0, W, 6);
    g.textBaseline = 'top';
    for (const t of laid) {
      g.font = fontOf(t.blk); g.fillStyle = t.blk.color;
      if (t.dot) g.fillText('•', t.x - 16, t.y);
      g.fillText(t.line, t.x, t.y);
    }
    let py = picsAt;
    pics.forEach((p, k) => { const w = Math.min(420, p.naturalWidth); g.drawImage(p, PAD, py, w, picH[k]); py += picH[k] + 12; });
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    if (!blob) throw new Error('could not draw it');
    const url = URL.createObjectURL(blob);
    el('a', { href: url, download: 'answer-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.png' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Screenshot downloaded and copied'); } catch { toast('Screenshot downloaded'); }
  }

  // MAPS, drawn here from OpenStreetMap's tiles: the places numbered, a
  // route as a line, zoom buttons, the credit OpenStreetMap asks for, and
  // the places listed with links.
  const TILE = 256;
  function project(lat, lon, z) {
    const n = TILE * Math.pow(2, z), s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  }
  function duration(min) { return min < 60 ? min + ' min' : Math.floor(min / 60) + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : ''); }
  function mapView(view) {
    const W = 600, H = 320;
    const pts = (view.places || []).map((p) => [p.lat, p.lon]).concat(view.route ? view.route.line : []);
    if (!pts.length) return el('span');
    let z = 15;
    if (pts.length > 1) {
      for (z = 16; z > 1; z--) {
        const px = pts.map((p) => project(p[0], p[1], z));
        const xs = px.map((p) => p[0]), ys = px.map((p) => p[1]);
        if (Math.max(...xs) - Math.min(...xs) <= W - 70 && Math.max(...ys) - Math.min(...ys) <= H - 70) break;
      }
    }
    const stage = el('div', { className: 'map-stage' });
    const draw = () => {
      const px = pts.map((p) => project(p[0], p[1], z));
      const xs = px.map((p) => p[0]), ys = px.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const n = Math.pow(2, z), at = (e, x, y) => { e.style.left = 'calc(50% + ' + Math.round(x) + 'px)'; e.style.top = 'calc(50% + ' + Math.round(y) + 'px)'; return e; };
      const parts = [];
      for (let tx = Math.floor((cx - W / 2) / TILE); tx <= Math.floor((cx + W / 2) / TILE); tx++) {
        for (let ty = Math.floor((cy - H / 2) / TILE); ty <= Math.floor((cy + H / 2) / TILE); ty++) {
          if (ty < 0 || ty >= n) continue;
          parts.push(at(el('img', { className: 'tile', alt: '', draggable: false, src: 'https://tile.openstreetmap.org/' + z + '/' + (((tx % n) + n) % n) + '/' + ty + '.png' }), tx * TILE - cx, ty * TILE - cy));
        }
      }
      if (view.route) {
        const line = svg('svg', { class: 'map-route', width: 1, height: 1 });
        line.append(svg('polyline', { points: view.route.line.map((p) => project(p[0], p[1], z)).map((p) => (p[0] - cx).toFixed(1) + ',' + (p[1] - cy).toFixed(1)).join(' ') }));
        parts.push(line);
      }
      view.places.forEach((p, k) => {
        const q = project(p.lat, p.lon, z);
        parts.push(at(el('a', { className: 'pin', href: p.url, target: '_blank', rel: 'noopener noreferrer', title: p.name, textContent: String(k + 1) }), q[0] - cx, q[1] - cy));
      });
      stage.replaceChildren(...parts);
    };
    draw();
    const zoom = (d) => { z = Math.max(2, Math.min(18, z + d)); draw(); };
    const box = el('div', { className: 'map' }, stage,
      el('div', { className: 'map-zoom' }, el('button', { type: 'button', textContent: '+', title: 'Zoom in', onclick: () => zoom(1) }), el('button', { type: 'button', textContent: '−', title: 'Zoom out', onclick: () => zoom(-1) })),
      el('div', { className: 'map-credit' }, '© ', link('https://www.openstreetmap.org/copyright', 'OpenStreetMap'), ' contributors'));
    const about = el('div', { className: 'map-about' }, el('strong', { textContent: view.title }));
    if (view.route) about.append(el('p', {}, view.route.km + ' km · ' + duration(view.route.minutes) + ' by ' + view.route.mode + ' · ', link(view.route.directions, 'Turn-by-turn directions')));
    about.append(el('ol', {}, ...view.places.map((p) => el('li', {}, link(p.url, p.name), [p.kind, p.address, p.hours].filter(Boolean).length ? ' — ' + [p.kind, p.address, p.hours].filter(Boolean).join(' · ') : '', ...(p.website && /^https?:/.test(p.website) ? [' · ', link(p.website, 'website')] : [])))));
    return el('figure', { className: 'map-wrap' }, box, about);
  }

  // An image the agent drew: fetched with the key (an <img> cannot send it),
  // shown from a blob URL kept for the page's life.
  const pictures = new Map();
  function picture(im) {
    const img = el('img', { className: 'drawn', alt: im.prompt, title: im.prompt });
    const shown = pictures.get(im.id);
    if (shown) img.src = shown;
    else fetch('/api/images/' + im.id, { headers: { authorization: 'Bearer ' + key } })
      .then((res) => (res.ok ? res.blob() : Promise.reject()))
      .then((blob) => { const url = URL.createObjectURL(blob); pictures.set(im.id, url); img.src = url; })
      .catch(() => { img.replaceWith(el('span', { className: 'meta', textContent: '(image no longer kept: ' + im.prompt + ')' })); });
    return img;
  }

  // CONVERSATIONS: the sidebar shows the latest few, or what a search finds.
  // The one open is saved after every answer.
  let chatsOpen = false;
  let searchTimer = 0;
  function ago(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 7 * 86400) return Math.floor(s / 86400) + (s < 2 * 86400 ? ' day ago' : ' days ago');
    return new Date(iso).toLocaleDateString();
  }
  async function loadChats() {
    const q = $('chat-search').value.trim();
    const { conversations } = await api('/api/conversations?limit=' + (q || chatsOpen ? 30 : 5) + (q ? '&q=' + encodeURIComponent(q) : ''));
    $('chats-title').textContent = q ? (conversations.length ? 'Found' : 'Nothing found') : 'Recent';
    const shown = q || chatsOpen ? conversations : conversations.slice(0, 4);
    $('chats-more').hidden = !!q || (!chatsOpen && conversations.length <= 4);
    $('chats-more').textContent = chatsOpen ? 'Show fewer' : 'Show more';
    $('chats').replaceChildren(...(shown.length ? shown.map((cv) => {
      const open = el('button', { type: 'button', className: 'chat-open', onclick: () => openChat(cv.id) },
        el('span', { className: 'chat-title', textContent: cv.title }),
        el('small', { textContent: cv.snippet ? cv.snippet : ago(cv.updatedAt) }));
      if (cv.id === convId) open.setAttribute('aria-current', 'true');
      const del = el('button', { type: 'button', className: 'chat-del', textContent: '✕', title: 'Delete this conversation', onclick: async () => {
        if (!confirm('Delete "' + cv.title + '"?')) return;
        await api('/api/conversations/' + encodeURIComponent(cv.id), { method: 'DELETE' });
        if (cv.id === convId) newChat();
        loadChats().catch(() => {});
      } });
      return el('li', {}, open, del);
    }) : q ? [] : [el('li', { className: 'hint', textContent: 'Your conversations will be listed here.' })]));
  }
  async function openChat(id) {
    try {
      const { conversation } = await api('/api/conversations/' + encodeURIComponent(id));
      convId = id; messages = conversation.messages;
      store.set('agent.conversation', convId); store.set('agent.messages', messages.slice(-100));
      render(); loadChats().catch(() => {});
    } catch (err) { toast(err.message); }
  }
  function newChat() {
    convId = newId(); messages = [];
    store.set('agent.conversation', convId); store.set('agent.messages', messages);
    render(); loadChats().catch(() => {}); $('input').focus();
  }
  async function saveChat() {
    if (!messages.length) return;
    const kept = messages.slice(-400).map((m) => ({
      role: m.role, content: String(m.content || '').slice(0, 20000),
      ...(m.meta ? { meta: m.meta.slice(0, 400) } : {}), ...(m.error ? { error: true } : {}),
      ...(m.images ? { images: m.images.map((im) => ({ id: im.id, prompt: im.prompt })) } : {}),
      ...(m.maps ? { maps: m.maps } : {}),
    }));
    await api('/api/conversations/' + encodeURIComponent(convId), { method: 'PUT', body: JSON.stringify({ messages: kept }) });
    loadChats().catch(() => {});
  }

  // THE TOOLS MENU: pick one for the next message; the agent is told to use it.
  const MODES = [
    ['web', 'Web search', 'Search the web and read the results'],
    ['research', 'Research papers', 'Find and cite scholarly papers'],
    ['news', 'News', 'The latest headlines'],
    ['wikipedia', 'Wikipedia', 'Look it up in the encyclopedia'],
    ['weather', 'Weather', 'The forecast for a place'],
    ['map', 'Map', 'Places, routes and what is nearby'],
    ['travel', 'Plan a trip', 'Route, sights, stays, weather, budget'],
    ['image', 'Draw an image', 'Make a picture from a description'],
    ['calculate', 'Calculate', 'Work out the numbers exactly'],
  ];
  function setMode(m) {
    mode = m;
    const found = MODES.find((x) => x[0] === m);
    $('mode-chip').hidden = !found;
    $('mode-label').textContent = found ? 'Using: ' + found[1] : '';
    $('tools').classList.toggle('on', !!found);
  }
  function toolsMenu(open) {
    $('tools-menu').hidden = !open;
    $('tools').setAttribute('aria-expanded', String(open));
    if (open) $('tools-menu').querySelector('button').focus();
  }
  $('tools-menu').replaceChildren(...MODES.map(([id, label, hint]) => el('button', { type: 'button', role: 'menuitem', onclick: () => { setMode(id); toolsMenu(false); $('input').focus(); } },
    el('strong', { textContent: label }), el('small', { textContent: hint }))));
  $('tools').onclick = () => toolsMenu($('tools-menu').hidden);
  $('mode-clear').onclick = () => { setMode(null); $('input').focus(); };
  document.addEventListener('click', (e) => { if (!$('tools-menu').hidden && !$('tools-menu').contains(e.target) && e.target !== $('tools')) toolsMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('tools-menu').hidden) { toolsMenu(false); $('tools').focus(); } });

  // SKILLS: the list on the left, the one being written on the right. A
  // built-in can be customised (saved under its name) and reset (deleted).
  let skills = [];
  let editing = null;
  async function loadSkills() {
    skills = (await api('/api/skills')).skills;
    $('skills-list').replaceChildren(...skills.map((sk) => {
      const b = el('button', { type: 'button' },
        el('strong', { textContent: sk.name }, ...(sk.source === 'owner' ? [] : [el('span', { className: 'badge', textContent: sk.source })])),
        el('small', { textContent: sk.description }));
      b.setAttribute('aria-current', String(editing === sk.name));
      b.onclick = () => editSkill(sk);
      return b;
    }));
  }
  function editSkill(sk) {
    editing = sk ? sk.name : null;
    $('skill-title').textContent = sk ? sk.name : 'New skill';
    $('skill-name').value = sk ? sk.name : ''; $('skill-name').readOnly = !!sk;
    $('skill-description').value = sk ? sk.description : '';
    $('skill-instructions').value = sk ? sk.instructions : '';
    $('skill-delete').hidden = !sk || sk.source === 'built-in';
    $('skill-delete').textContent = sk && sk.source === 'customised' ? 'Reset to built-in' : 'Delete';
    $('skill-note').textContent = sk && sk.source === 'built-in' ? 'Built in. Edit and save to make it yours.' : '';
    for (const b of document.querySelectorAll('#skills-list button')) b.setAttribute('aria-current', String(b.querySelector('strong').firstChild.textContent === editing));
  }

  // THE LIBRARY: every image the agent drew, and every answer kept whole.
  async function loadLibrary() {
    const [{ images }, { saved }] = await Promise.all([api('/api/images'), api('/api/saved')]);
    $('library-images').replaceChildren(...(images.length ? images.map((im) => {
      const img = picture(im);
      const download = el('a', { className: 'button', textContent: 'Download', href: '#' });
      download.onclick = (e) => { e.preventDefault(); const url = pictures.get(im.id); if (url) { const a = el('a', { href: url, download: 'image-' + im.id }); a.click(); } };
      const remove = el('button', { type: 'button', textContent: 'Delete', onclick: async () => { if (confirm('Delete this image?')) { await api('/api/images/' + im.id, { method: 'DELETE' }); loadLibrary(); } } });
      return el('figure', {}, img, el('figcaption', {},
        el('p', { textContent: im.prompt, title: im.prompt }),
        el('span', { className: 'hint', textContent: new Date(im.createdAt).toLocaleDateString() + ' · ' + (im.model || '').split('/').pop() }),
        el('div', { className: 'row' }, download, remove)));
    }) : [el('p', { className: 'hint', textContent: 'No images yet. Ask your agent to draw something.' })]));
    $('library-saved').replaceChildren(...(saved.length ? saved.map((it) => {
      const item = el('li', {});
      const copy = el('button', { type: 'button', textContent: 'Copy', onclick: () => navigator.clipboard.writeText(it.text).catch(() => {}) });
      const more = el('button', { type: 'button', textContent: 'Show all', onclick: () => { item.classList.toggle('open'); more.textContent = item.classList.contains('open') ? 'Show less' : 'Show all'; } });
      const know = el('button', { type: 'button', textContent: 'Add to knowledge', onclick: () => toKnowledge({ text: it.text }) });
      const remove = el('button', { type: 'button', textContent: 'Delete', onclick: async () => { await api('/api/saved/' + it.id, { method: 'DELETE' }); loadLibrary(); } });
      item.append(el('div', { className: 'md clip' }, md(it.text)), el('div', { className: 'row' },
        el('span', { className: 'hint', style: 'flex:1', textContent: new Date(it.createdAt).toLocaleString() + (it.source ? ' · ' + it.source : '') }), copy, more, know, remove));
      return item;
    }) : [li('Nothing here yet. Use Save → Library under an answer to keep it whole.')]));
  }

  // SPACES: memories grouped by the space they are filed under, the biggest
  // first. Each has a colour the graph uses, handed out in the order the
  // spaces were first used, so a space keeps its colour as memories come and go.
  const HUES = [220, 0, 140, 35, 275, 180, 330, 95, 55, 250, 15, 160];
  function spaces() {
    const by = new Map();
    for (const m of memories) { if (!by.has(m.space)) by.set(m.space, []); by.get(m.space).push(m); }
    const first = [...by.entries()].map(([name, items]) => [name, Math.min(...items.map((m) => m.id))]).sort((a, b) => a[1] - b[1]).map(([name]) => name);
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([name, items]) => ({ name, items, colour: 'hsl(' + HUES[first.indexOf(name) % HUES.length] + ' 62% 56%)' }));
  }
  const memoryLabel = (m) => m.question ? 'Q: ' + oneLine(m.question) : m.text;

  async function loadModels() {
    const body = await api('/api/models');
    models = body.models;
    const chosen = store.get('agent.model', body.default);
    const groups = [['workers-ai', 'Workers AI'], ['huggingface', 'Hugging Face'], ['space', 'Spaces']];
    $('model').replaceChildren(...groups.map(([provider, label]) => {
      const g = el('optgroup', { label });
      g.append(...models.filter((m) => m.provider === provider).map((m) => { const o = new Option(m.label.replace(/ · (Workers AI|Hugging Face|Space)$/, ''), m.key); o.selected = m.key === chosen; return o; }));
      return g;
    }).filter((g) => g.children.length));
    imageModels = body.images.models;
    const added = models.filter((m) => m.source === 'added');
    $('added').replaceChildren(...(added.length ? added.map((m) => li(m.label, async () => {
      await api('/api/models/' + [m.provider, ...m.id.split('/')].map(encodeURIComponent).join('/'), { method: 'DELETE' }); loadModels();
    })) : [li('None yet — add one above, or list them in HF_MODELS.')]));
    renderImageModels();
    $('add-note').textContent = body.huggingface ? '' : 'HF_TOKEN is not stored: public Spaces work, Inference Providers models need it.';
  }

  async function loadMemories() {
    memories = (await api('/api/memories')).memories;
    if (selected && selected.kind === 'memory' && !memories.some((m) => m.id === selected.id)) selected = null;
    if (selected && selected.kind === 'space' && !memories.some((m) => m.space === selected.name)) selected = null;
    $('space-names').replaceChildren(...spaces().map((g) => new Option(g.name)));
    $('memory-count').textContent = memories.length ? String(memories.length) : '';
    renderGraph(); renderDetail();
  }

  const forget = async (m) => { await api('/api/memories/' + m.id, { method: 'DELETE' }); await loadMemories(); };
  const move = async (m, space) => { await api('/api/memories/' + m.id, { method: 'PATCH', body: JSON.stringify({ space }) }); };

  // THE KNOWLEDGE GRAPH: the owner at the centre, each space a hub around
  // them, each memory a leaf around its hub — fanned outwards, away from
  // the centre, in one ring or two.
  function renderGraph() {
    const g = $('graph');
    const groups = spaces();
    $('graph-empty').hidden = groups.length > 0;
    const edges = svg('g'), nodes = svg('g');
    const focus = selected && (selected.kind === 'space' ? selected.name : (memories.find((m) => m.id === selected.id) || {}).space);
    const n = groups.length;
    const R = n <= 1 ? 0 : n === 2 ? 150 : 175;
    groups.forEach((grp, i) => {
      const a = n <= 1 ? -Math.PI / 2 : -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const hx = R * Math.cos(a), hy = R * Math.sin(a);
      const faded = focus && focus !== grp.name ? ' faded' : '';
      if (n > 1) edges.appendChild(svg('line', { x1: 0, y1: 0, x2: hx, y2: hy, class: 'edge' + faded }));
      const span = n <= 1 ? 2 * Math.PI : Math.min(Math.PI * 1.25, (2 * Math.PI / n) * 1.6);
      const inner = grp.items.slice(0, 12), outer = grp.items.slice(12, 40);
      [[inner, 95], [outer, 150]].forEach(([ring, r], ringNo) => {
        ring.forEach((m, j) => {
          const t = ring.length === 1 ? 0 : (n <= 1 ? j / ring.length : j / (ring.length - 1) - 0.5);
          const b = n <= 1 ? -Math.PI / 2 + t * 2 * Math.PI + ringNo * 0.2 : a + t * span;
          const x = hx + r * Math.cos(b), y = hy + r * Math.sin(b);
          const on = selected && selected.kind === 'memory' && selected.id === m.id ? ' on' : '';
          edges.appendChild(svg('line', { x1: hx, y1: hy, x2: x, y2: y, class: 'edge' + faded }));
          const node = svg('g', { class: 'node' + faded + on, tabindex: 0 });
          node.appendChild(svg('title', {}, memoryLabel(m)));
          node.appendChild(svg('circle', { cx: x, cy: y, r: 7, fill: grp.colour }));
          const right = Math.cos(b) >= 0;
          node.appendChild(svg('text', { x: x + (right ? 12 : -12), y: y + 4, 'text-anchor': right ? 'start' : 'end', class: 'label' }, short(memoryLabel(m), ringNo ? 18 : 26)));
          node.onclick = () => { selected = { kind: 'memory', id: m.id }; renderGraph(); renderDetail(); };
          node.onkeydown = (e) => { if (e.key === 'Enter') node.onclick(); };
          nodes.appendChild(node);
        });
      });
      if (grp.items.length > 40) nodes.appendChild(svg('text', { x: hx, y: hy + 44, 'text-anchor': 'middle', class: 'label' + faded }, '+' + (grp.items.length - 40) + ' more'));
      const hub = svg('g', { class: 'node' + faded + (selected && selected.kind === 'space' && selected.name === grp.name ? ' on' : ''), tabindex: 0 });
      hub.appendChild(svg('title', {}, grp.name + ' · ' + grp.items.length));
      hub.appendChild(svg('circle', { cx: hx, cy: hy, r: 22, fill: grp.colour }));
      hub.appendChild(svg('text', { x: hx, y: hy + 40, 'text-anchor': 'middle', class: 'hub-label' }, short(grp.name, 22)));
      hub.onclick = () => { selected = selected && selected.kind === 'space' && selected.name === grp.name ? null : { kind: 'space', name: grp.name }; renderGraph(); renderDetail(); };
      hub.onkeydown = (e) => { if (e.key === 'Enter') hub.onclick(); };
      nodes.appendChild(hub);
    });
    if (n > 1) {
      nodes.appendChild(svg('circle', { cx: 0, cy: 0, r: 14, fill: 'var(--ink)' }));
      nodes.appendChild(svg('text', { x: 0, y: 32, 'text-anchor': 'middle', class: 'hub-label' }, 'You'));
    }
    g.replaceChildren(edges, nodes);
  }

  // THE DETAIL CARD beside the graph: a memory can be moved to another space
  // or removed; a space can be renamed, which moves every memory in it. A
  // kept answer reads as the conversation it was.
  function memoryBody(m) {
    if (!m.question) return [el('p', { textContent: m.text })];
    return [el('p', { className: 'asked' }, el('strong', { textContent: 'You asked: ' }), m.question), el('div', { className: 'md clip' }, md(m.text))];
  }
  function renderDetail() {
    const d = $('detail');
    const note = el('p', { className: 'hint' });
    const fail = (err) => { note.textContent = err.message; };
    if (selected && selected.kind === 'memory') {
      const m = memories.find((x) => x.id === selected.id);
      if (!m) return;
      const to = el('input', { value: m.space, maxLength: 40, required: true });
      to.setAttribute('list', 'space-names');
      d.replaceChildren(
        el('h2', { textContent: (m.question ? 'Conversation · ' : 'Memory · ') + m.space }),
        ...memoryBody(m),
        el('p', { className: 'hint', textContent: 'Kept ' + new Date(m.createdAt).toLocaleString() }),
        el('form', { className: 'row', onsubmit: async (e) => { e.preventDefault(); try { await move(m, to.value.trim()); await loadMemories(); } catch (err) { fail(err); } } },
          to, el('button', { textContent: 'Move' })),
        el('p', {}, el('button', { type: 'button', textContent: 'Remove this memory', onclick: () => forget(m).catch(fail) })),
        note,
      );
    } else if (selected && selected.kind === 'space') {
      const items = memories.filter((m) => m.space === selected.name);
      const to = el('input', { value: selected.name, maxLength: 40, required: true });
      d.replaceChildren(
        el('h2', { textContent: 'Space' }),
        el('p', { textContent: selected.name + ' · ' + items.length + (items.length === 1 ? ' memory' : ' memories') }),
        el('form', { className: 'row', onsubmit: async (e) => {
          e.preventDefault();
          const name = to.value.trim();
          try { for (const m of items) await move(m, name); selected = { kind: 'space', name }; await loadMemories(); } catch (err) { fail(err); }
        } }, to, el('button', { textContent: 'Rename' })),
        el('ul', { className: 'items' }, ...items.map((m) => li(short(memoryLabel(m), 140), () => forget(m).catch(fail)))),
        note,
      );
    } else {
      d.replaceChildren(el('p', { className: 'hint', textContent: 'Click a space or a memory to see it here.' }));
    }
  }

  // THE KILL SWITCH: paused, the banner says so and Send is off.
  function showPaused(on) {
    paused = on;
    $('paused').hidden = !on;
    $('send').disabled = on;
    $('input').placeholder = on ? 'Paused — resume to chat' : 'Ask your agent…';
    $('switch').textContent = on ? 'Resume the agent' : 'Pause the agent';
    $('switch').className = on ? 'primary' : 'danger';
  }
  async function setPaused(on) {
    try { showPaused((await api('/api/state', { method: 'PUT', body: JSON.stringify({ paused: on }) })).paused); }
    catch (err) { $('switch-note').textContent = err.message; }
  }

  // NOTES: short-lived. Each shows when it goes; keep it 2 or 7 more days,
  // for good, or move it to the knowledge. Tick a to-do off, or remove it.
  function expires(n) {
    if (!n.expiresAt) return 'Kept for good';
    const s = (new Date(n.expiresAt).getTime() - Date.now()) / 1000;
    if (s < 3600) return 'Goes in ' + Math.max(1, Math.round(s / 60)) + ' min';
    const hours = Math.round(s / 3600), d = Math.floor(hours / 24), h = hours % 24;
    return 'Goes in ' + (d ? d + (d === 1 ? ' day' : ' days') + (h ? ' ' + h + ' h' : '') : h + ' h');
  }
  async function loadNotes() {
    const { notes } = await api('/api/notes');
    const lists = new Map();
    for (const n of notes) { if (!lists.has(n.list)) lists.set(n.list, []); lists.get(n.list).push(n); }
    $('list-names').replaceChildren(...[...lists.keys()].map((n) => new Option(n)));
    $('notes-lists').replaceChildren(...(lists.size ? [...lists.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, items]) => el('section', {},
      el('h2', { textContent: name + ' · ' + items.filter((n) => !n.done).length + ' open' }),
      el('ul', { className: 'items notes' }, ...items.map((n) => {
        const patch = async (body) => { await api('/api/notes/' + n.id, { method: 'PATCH', body: JSON.stringify(body) }); loadNotes(); };
        const box = el('input', { type: 'checkbox', checked: n.done, title: 'Done', onchange: () => patch({ done: box.checked }) });
        const keep = el('select', { title: 'How long to keep it', onchange: () => { if (keep.value) patch({ keepDays: keep.value === 'good' ? null : Number(keep.value) }); } },
          new Option(expires(n), ''), new Option('Keep 2 more days', '2'), new Option('Keep 7 more days', '7'), new Option('Keep for good', 'good'));
        const long = n.text.length > 280;
        const text = el('div', { className: 'note-text md' + (long ? ' clip' : '') }, md(n.text));
        const item = el('li', { className: n.done ? 'done' : '' },
          el('div', { className: 'note-main' }, box, text),
          el('div', { className: 'row note-tools' },
            keep,
            ...(long ? [el('button', { type: 'button', textContent: 'Show all', onclick: (e) => { text.classList.toggle('clip'); e.target.textContent = text.classList.contains('clip') ? 'Show all' : 'Show less'; } })] : []),
            el('button', { type: 'button', textContent: 'To knowledge', title: 'Keep it for good as something the agent knows; the note goes', onclick: () => {
              const qa = /^You asked: (.*)\n\n([\s\S]*)$/.exec(n.text);
              toKnowledge(qa ? { question: qa[1], text: qa[2], noteId: n.id } : { text: n.text, noteId: n.id });
            } }),
            el('button', { type: 'button', textContent: 'Remove', onclick: async () => { await api('/api/notes/' + n.id, { method: 'DELETE' }); loadNotes(); } })));
        return item;
      })),
    )) : [el('p', { className: 'hint', textContent: 'No notes. Save an answer as a note, add one here, or ask your agent: “add milk to my groceries”. Notes go after 2 days unless you keep them.' })]));
  }

  async function loadActivity() {
    const { activity } = await api('/api/activity');
    $('activity').replaceChildren(...(activity.length ? activity.map((a) => el('li', { className: a.outcome },
      el('span', { className: 'when', textContent: new Date(a.at).toLocaleString() }),
      el('span', { className: 'what', textContent: a.tool + (a.outcome === 'ok' ? '' : ' · ' + a.outcome) + (a.detail ? ' — ' + a.detail : '') }),
    )) : [li('Nothing yet.')]));
  }

  function tab(name) {
    for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const t of ['knowledge', 'notes', 'skills', 'library', 'models', 'access']) $('tab-' + t).hidden = t !== name;
    store.set('agent.tab', name);
    if (name === 'access') loadActivity().catch(() => {});
    if (name === 'notes') loadNotes().catch(() => {});
    if (name === 'library') loadLibrary().catch(() => {});
    if (name === 'skills') loadSkills().catch(() => {});
  }
  function openSettings(name) { tab(name || store.get('agent.tab', 'knowledge')); if (!$('settings').open) $('settings').showModal(); }

  function collapse(on) {
    $('side').classList.toggle('collapsed', on);
    $('collapse').textContent = on ? '›' : '‹ Collapse';
    $('collapse').title = on ? 'Show your conversations' : 'Collapse the sidebar';
    store.set('agent.sidebar.collapsed', on);
  }

  async function start() {
    $('lock').hidden = true;
    const st = await api('/api/state');
    showPaused(st.paused); chosenImageModel = st.imageModel;
    await loadModels(); await loadMemories();
    // The open conversation, as last saved; one kept only in this browser
    // (from before conversations were saved) is saved now.
    try { const { conversation } = await api('/api/conversations/' + encodeURIComponent(convId)); messages = conversation.messages; }
    catch { if (messages.length) saveChat().catch(() => {}); }
    store.set('agent.conversation', convId);
    render(); loadChats().catch(() => {});
  }

  $('unlock').onsubmit = (e) => { e.preventDefault(); key = $('key').value.trim(); store.set('agent.key', key); start().catch(() => {}); };
  $('model').onchange = () => store.set('agent.model', $('model').value);
  $('clear').onclick = () => newChat();
  $('menu').onclick = () => openSettings();
  $('open-graph').onclick = () => openSettings('knowledge');
  $('open-notes').onclick = () => openSettings('notes');
  $('open-library').onclick = () => openSettings('library');
  $('chat-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadChats().catch(() => {}), 250); };
  $('chats-more').onclick = () => { chatsOpen = !chatsOpen; loadChats().catch(() => {}); };
  $('close-settings').onclick = () => $('settings').close();
  $('settings').onclick = (e) => { if (e.target === $('settings')) $('settings').close(); };
  for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => tab(b.dataset.tab);
  $('collapse').onclick = () => collapse(!$('side').classList.contains('collapsed'));
  $('switch').onclick = () => setPaused(!paused);
  $('resume-banner').onclick = () => setPaused(false);
  $('lock-now').onclick = () => lock('Locked. Enter the access key to use this agent here again.');
  $('note-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = { text: $('note-text').value.trim(), keepDays: $('note-keep').value === 'good' ? null : Number($('note-keep').value) };
    if ($('note-list').value.trim()) body.list = $('note-list').value.trim();
    try { await api('/api/notes', { method: 'POST', body: JSON.stringify(body) }); $('note-form').reset(); $('note-note').textContent = ''; loadNotes(); }
    catch (err) { $('note-note').textContent = err.message; }
  };
  $('add-memory').onsubmit = async (e) => {
    e.preventDefault();
    const body = { text: $('memory-text').value.trim() };
    if ($('memory-space').value.trim()) body.space = $('memory-space').value.trim();
    try {
      const { memory } = await api('/api/memories', { method: 'POST', body: JSON.stringify(body) });
      $('add-memory').reset(); $('memory-note').textContent = '';
      selected = { kind: 'memory', id: memory.id }; await loadMemories();
    } catch (err) { $('memory-note').textContent = err.message; }
  };
  $('add-provider').onchange = () => {
    const provider = $('add-provider').value, space = provider === 'space';
    $('add-api').hidden = !space; $('add-tools-row').hidden = space;
    $('add-id').placeholder = space ? 'owner/space — e.g. your-name/your-chat-space'
      : provider === 'workers-ai' ? '@cf/owner/name — e.g. @cf/qwen/qwen3-30b-a3b-fp8' : 'owner/name — e.g. openai/gpt-oss-120b';
  };
  $('image-model').onchange = async () => {
    try { chosenImageModel = (await api('/api/state', { method: 'PUT', body: JSON.stringify({ imageModel: $('image-model').value }) })).imageModel; $('image-note').textContent = 'Saved: new pictures use it.'; }
    catch (err) { $('image-note').textContent = err.message; }
  };
  $('skill-new').onclick = () => { editSkill(null); $('skill-name').focus(); };
  $('skill-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('skill-name').value.trim();
    try {
      await api('/api/skills/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify({ description: $('skill-description').value, instructions: $('skill-instructions').value }) });
      editing = name; await loadSkills(); editSkill(skills.find((sk) => sk.name === name)); $('skill-note').textContent = 'Saved. The agent uses it from the next message.';
    } catch (err) { $('skill-note').textContent = err.message; }
  };
  $('skill-delete').onclick = async () => {
    if (!editing || !confirm('Delete the skill "' + editing + '"?')) return;
    try { await api('/api/skills/' + encodeURIComponent(editing), { method: 'DELETE' }); const was = editing; await loadSkills(); editSkill(skills.find((sk) => sk.name === was) || null); }
    catch (err) { $('skill-note').textContent = err.message; }
  };
  $('knowledge-cancel').onclick = () => $('to-knowledge').close();
  $('knowledge-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = { text: $('knowledge-text').value.trim() };
    if (!$('knowledge-q-row').hidden && $('knowledge-question').value.trim()) body.question = $('knowledge-question').value.trim();
    if ($('knowledge-space').value.trim()) body.space = $('knowledge-space').value.trim();
    try {
      await api('/api/memories', { method: 'POST', body: JSON.stringify(body) });
      if (fromNote) { await api('/api/notes/' + fromNote, { method: 'DELETE' }).catch(() => {}); fromNote = null; if (!$('tab-notes').hidden) loadNotes(); }
      $('to-knowledge').close(); toast('Added to the knowledge'); await loadMemories();
    }
    catch (err) { $('knowledge-note').textContent = err.message; }
  };
  $('add').onsubmit = async (e) => {
    e.preventDefault();
    const provider = $('add-provider').value;
    const body = { provider, id: $('add-id').value.trim() };
    if ($('add-label').value.trim()) body.label = $('add-label').value.trim();
    if (provider === 'space') { if ($('add-api').value.trim()) body.apiName = $('add-api').value.trim().replace(/^\//, ''); }
    else body.tools = $('add-tools').checked;
    try {
      const { model } = await api('/api/models', { method: 'POST', body: JSON.stringify(body) });
      $('add').reset(); $('add-provider').onchange();
      store.set('agent.model', model.key); await loadModels();
    } catch (err) { $('add-note').textContent = err.message; }
  };
  $('input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('ask').requestSubmit(); } };
  $('ask').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('input').value.trim(); if (!text || paused) return;
    $('input').value = '';
    const using = mode; setMode(null);
    messages.push({ role: 'user', content: text }); bubble(messages[messages.length - 1], messages.length - 1);
    const pending = bubble({ role: 'assistant', content: '…' }, -1);
    $('send').disabled = true;
    try {
      // What a model is sent: the words only (an image or a map is shown, not resent).
      const history = messages.filter((m) => !m.error && m.content).slice(-40).map(({ role, content }) => ({ role, content: content.slice(0, 8000) }));
      const reply = await api('/api/chat', { method: 'POST', body: JSON.stringify({ model: $('model').value, messages: history, ...(using ? { mode: using } : {}) }) });
      const label = (models.find((m) => m.key === reply.model) || {}).label || reply.model;
      // A secret in what was typed never reached the model; keep the redacted
      // words here too, so neither this browser nor the saved conversation holds it.
      if (reply.said) { messages[messages.length - 1].content = reply.said; render(); }
      const kept = reply.redacted ? ' · kept ' + reply.redacted + (reply.redacted === 1 ? ' secret' : ' secrets') + ' out' : '';
      messages.push({ role: 'assistant', content: reply.text || (reply.images || reply.maps ? '' : '(no answer)'), images: reply.images, maps: reply.maps, meta: label + (reply.tools.length ? ' · used ' + reply.tools.join(', ') : '') + kept });
      if (reply.tools.some((t) => t === 'remember' || t === 'forget')) loadMemories();
      if (reply.tools.some((t) => /Note/.test(t)) && !$('tab-notes').hidden) loadNotes();
    } catch (err) {
      messages.push({ role: 'assistant', content: err.message, error: true });
    } finally {
      pending.remove(); bubble(messages[messages.length - 1], messages.length - 1);
      store.set('agent.messages', messages.slice(-100)); $('send').disabled = paused; $('input').focus();
      saveChat().catch(() => {});
    }
  };

  collapse(store.get('agent.sidebar.collapsed', false));
  if (key) start().catch(() => {}); else lock();
})();
`

export function page(name: string): string {
  const title = escapeHtml(name)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--accent:#3b5bdb;--accent-ink:#fff;--me:#eef1fd;--warn:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--ink:#ededea;--muted:#9b9b94;--line:#30302d;--accent:#7c93f5;--accent-ink:#0d0d0c;--me:#252a3d;--warn:#f97066}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;height:100dvh;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:16px;margin:0;flex:1}
select,input,textarea,button{font:inherit;color:inherit}
select,input,textarea{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-width:0}
button{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:8px 12px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button.danger{border-color:var(--warn);color:var(--warn)}
button.link{border:0;background:none;padding:0;color:var(--accent);font-size:13px}
button:disabled{opacity:.5;cursor:default}
a{color:var(--accent)}
main{flex:1;display:flex;min-height:0}
#chat{flex:1;display:flex;flex-direction:column;min-width:0}
#log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:46rem;padding:10px 14px;border-radius:12px;background:var(--panel);border:1px solid var(--line);overflow-wrap:anywhere}
.msg .said{white-space:pre-wrap}
.msg.user{align-self:flex-end;background:var(--me)}
.msg .meta{display:block;margin-top:6px;font-size:12px;color:var(--muted)}
.msg img.drawn{display:block;max-width:min(100%,512px);border-radius:10px;margin-top:8px;background:var(--line);aspect-ratio:1}
.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md p{margin:0 0 10px}.md ul,.md ol{margin:0 0 10px;padding-left:22px}.md li{margin:2px 0}
.md h4{font-size:16px;margin:14px 0 6px}.md h5{font-size:15px;margin:12px 0 4px}
.md code{font:13px ui-monospace,Menlo,Consolas,monospace;background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:0 4px}
.md pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto}.md pre code{border:0;padding:0}
.md hr{border:0;border-top:1px solid var(--line);margin:12px 0}
.md .table{overflow-x:auto;margin:0 0 10px}.md table{border-collapse:collapse;font-size:14px}.md th,.md td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}.md th{background:var(--bg)}
.clip{max-height:9em;overflow:hidden;-webkit-mask-image:linear-gradient(#000 70%,transparent)}
.actions{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;opacity:.55;transition:opacity .15s}
.msg:hover .actions,.msg:focus-within .actions{opacity:1}
.actions button{border:0;background:none;padding:2px 6px;font-size:12px;color:var(--muted);border-radius:6px}
.actions button:hover{background:var(--bg);color:var(--ink)}
.map-wrap{margin:8px 0 0;display:grid;gap:8px}
.map{position:relative;width:600px;max-width:100%;height:320px;overflow:hidden;border-radius:10px;border:1px solid var(--line);background:#e8e6df}
.map-stage{position:absolute;inset:0}
.map img.tile{position:absolute;width:256px;height:256px;max-width:none;margin:0;user-select:none}
.map-route{position:absolute;left:50%;top:50%;overflow:visible;pointer-events:none}
.map-route polyline{fill:none;stroke:#3b5bdb;stroke-width:5;stroke-linejoin:round;stroke-linecap:round;opacity:.85}
.pin{position:absolute;transform:translate(-50%,-50%);width:24px;height:24px;border-radius:50%;background:#b42318;color:#fff;border:2px solid #fff;font:700 12px/20px system-ui,sans-serif;text-align:center;text-decoration:none;box-shadow:0 1px 4px rgb(0 0 0 / .4)}
.map-zoom{position:absolute;right:8px;top:8px;display:grid;gap:4px}
.map-zoom button{width:30px;height:30px;padding:0;background:#fff;color:#1d1d1b;border-color:#ccc;font-size:16px}
.map-credit{position:absolute;right:0;bottom:0;background:rgb(255 255 255 / .85);color:#333;font-size:11px;padding:1px 6px}
.map-credit a{color:#333}
.map-about{font-size:13px}.map-about p{margin:2px 0}.map-about ol{margin:4px 0 0;padding-left:20px}
dialog.small{border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--ink);width:min(520px,94vw);padding:20px}
dialog.small::backdrop{background:rgb(0 0 0 / .45)}
dialog.small textarea{width:100%;resize:vertical}
dialog.small label{display:grid;gap:4px;font-size:13px;color:var(--muted)}
fieldset{border:0;padding:0;margin:0;display:grid;gap:6px}
fieldset label{display:flex!important;gap:10px;align-items:flex-start;border:1px solid var(--line);border-radius:10px;padding:8px 10px;cursor:pointer;color:var(--ink)!important;font-size:14px!important}
fieldset label:has(input:checked){border-color:var(--accent);background:var(--me)}
fieldset small{display:block;color:var(--muted);font-size:12px}
#toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:8px 14px;border-radius:10px;font-size:14px;z-index:3}
#library-images{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
#library-images figure{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--bg);display:flex;flex-direction:column}
#library-images img{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:var(--line)}
#library-images figcaption{padding:8px;font-size:12px;display:grid;gap:6px}
#library-images figcaption p{margin:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
#library-images .row button,#library-images .row a{font-size:12px;padding:2px 8px}
#library-saved li{display:block;border-bottom:1px solid var(--line);padding:8px 0}
#library-saved li .md{margin:0 0 6px;overflow-wrap:anywhere}
#library-saved li.open .clip{max-height:none;-webkit-mask-image:none}
#library-saved .row button{font-size:12px;padding:2px 8px}
a.button{border:1px solid var(--line);border-radius:8px;color:inherit;text-decoration:none}
#skills-wrap{display:flex;gap:20px;min-height:100%}
#skills-list{width:300px;flex:none;display:grid;gap:6px;align-content:start}
#skills-list button{text-align:left;display:grid;gap:2px;padding:8px 10px}
#skills-list button[aria-current="true"]{background:var(--me)}
#skills-list small{color:var(--muted);font-size:12px}
#skill-form{flex:1;min-width:0;align-content:start}
#skill-form .row{align-items:center}
#skill-form textarea{min-height:300px;resize:vertical;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace}
.badge{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:0 5px;margin-left:6px}
@media (max-width:760px){#skills-wrap{flex-direction:column}#skills-list{width:auto}}
#notes-lists{display:grid;gap:20px}
ul.items.notes li{display:grid;justify-content:stretch;gap:6px;border-bottom:1px solid var(--line);padding:8px 0}
.note-main{display:flex;gap:10px;align-items:flex-start}
.note-main input{margin-top:4px;flex:none}
.note-text{flex:1;min-width:0;overflow-wrap:anywhere}
ul.items.notes li.done .note-text{text-decoration:line-through;color:var(--muted)}
.note-tools{flex-wrap:wrap;align-items:center;padding-left:26px}
.note-tools select{font-size:12px;padding:2px 6px}
.note-tools button{font-size:12px;padding:2px 8px}
.msg.error{border-color:var(--warn);color:var(--warn)}
#paused{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--warn);color:var(--warn);background:var(--panel);font-size:14px}
#paused span{flex:1}
#paused button{padding:4px 10px;font-size:13px}
form#ask{position:relative;display:grid;gap:6px;padding:12px 16px;border-top:1px solid var(--line);background:var(--panel)}
#composer{display:flex;gap:8px}
#composer textarea{flex:1;resize:none;height:44px}
#tools{white-space:nowrap}
#tools.on{border-color:var(--accent);color:var(--accent)}
#mode-chip{display:flex;align-items:center;gap:6px;align-self:start;font-size:13px;background:var(--me);border:1px solid var(--accent);color:var(--accent);border-radius:999px;padding:2px 4px 2px 12px}
#mode-chip button{border:0;background:none;padding:0 6px;color:inherit}
#tools-menu{position:absolute;left:16px;bottom:calc(100% - 4px);z-index:2;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 28px rgb(0 0 0 / .18);padding:6px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:2px;width:min(460px,calc(100vw - 32px))}
#tools-menu button{border:0;background:none;text-align:left;display:grid;gap:0;padding:8px 10px}
#tools-menu button:hover,#tools-menu button:focus{background:var(--bg)}
#tools-menu small{color:var(--muted);font-size:12px}
aside{width:300px;border-left:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;min-height:0}
#side-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:16px}
#side-body input[type=search]{width:100%}
#chats{list-style:none;margin:0;padding:0;display:grid;gap:2px}
#chats li{display:flex;align-items:stretch;border-radius:8px}
#chats li:hover{background:var(--bg)}
.chat-open{flex:1;min-width:0;border:0;background:none;text-align:left;display:grid;gap:1px;padding:7px 8px;border-radius:8px}
.chat-open[aria-current="true"]{background:var(--me)}
.chat-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px}
.chat-open small{color:var(--muted);font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.chat-del{border:0;background:none;color:var(--muted);padding:0 8px;opacity:0}
#chats li:hover .chat-del,.chat-del:focus{opacity:1}
#shortcuts{display:grid;gap:6px;justify-items:start}
#memory-count{color:var(--muted);font-size:12px;margin-left:4px}
#side-foot{border-top:1px solid var(--line);padding:8px;display:flex;justify-content:flex-end}
#side-foot button{padding:4px 10px;font-size:13px}
aside.collapsed{width:48px}
aside.collapsed #side-body{display:none}
aside.collapsed #side-foot{flex:1;align-items:flex-end;justify-content:center;border-top:0}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 8px}
form.stack{display:grid;gap:8px}
ul.items{list-style:none;margin:0;padding:0;display:grid;gap:6px}
ul.items li{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;font-size:14px}
ul.items li button{padding:2px 8px;font-size:12px;flex:none}
.hint{font-size:13px;color:var(--muted);margin:0}
.credit{margin:0;padding:6px 16px 10px;font-size:12px;color:var(--muted);text-align:center;background:var(--panel)}
.credit a{color:inherit}
#lock{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:16px;z-index:4}
#lock form{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px;display:grid;gap:12px;width:100%;max-width:380px}
#lock h1{margin:0;font-size:18px}
dialog#settings{border:1px solid var(--line);border-radius:14px;padding:0;background:var(--panel);color:var(--ink);width:min(1040px,96vw);height:min(720px,92dvh)}
dialog#settings::backdrop{background:rgb(0 0 0 / .45)}
#settings-shell{display:flex;flex-direction:column;height:100%}
#settings-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line)}
#settings-head h2{margin:0;flex:1;font-size:15px;text-transform:none;letter-spacing:0;color:var(--ink)}
#tabs{display:flex;gap:4px;flex-wrap:wrap}
#tabs button{border-color:transparent;background:none;padding:6px 12px}
#tabs button[aria-selected="true"]{background:var(--me);border-color:var(--line)}
.tab{flex:1;min-height:0;overflow:auto;padding:16px}
#tab-knowledge{display:flex;gap:16px}
#graph-wrap{flex:1;min-width:0;border:1px solid var(--line);border-radius:12px;background:var(--bg);position:relative}
#graph{width:100%;height:100%;display:block;user-select:none}
#graph .edge{stroke:var(--line);stroke-width:1.5}
#graph .label{fill:var(--ink);font-size:13px}
#graph .hub-label{fill:var(--ink);font-size:14px;font-weight:600}
#graph .node{cursor:pointer}
#graph .node:hover circle,#graph .node.on circle{stroke:var(--ink);stroke-width:2.5}
#graph .faded{opacity:.25}
#graph-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}
#knowledge-side{width:300px;flex:none;display:flex;flex-direction:column;gap:20px;overflow-y:auto;overflow-x:hidden}
#detail{border:1px solid var(--line);border-radius:10px;padding:12px;display:grid;gap:8px}
#detail p{margin:0;overflow-wrap:anywhere}
#detail .clip{max-height:16em}
#activity li{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:13px;border-bottom:1px solid var(--line);padding:6px 0}
#activity .when{color:var(--muted);white-space:nowrap}
#activity .what{overflow-wrap:anywhere}
#activity .blocked .what{color:var(--warn)}
.row{display:flex;gap:8px}.row input{flex:1;width:0}
.models{max-width:620px;display:grid;gap:24px}
[hidden]{display:none!important}
@media (max-width:760px){main{flex-direction:column}aside{width:auto;border-left:0;border-top:1px solid var(--line);max-height:40dvh}aside.collapsed{width:auto;max-height:none}aside.collapsed #side-foot{justify-content:flex-end}#tab-knowledge{flex-direction:column}#graph-wrap{min-height:360px}#knowledge-side{width:auto}#settings-title{display:none}#tabs{flex:1}dialog#settings{width:100vw;height:100dvh;max-width:none;max-height:none;border-radius:0}#tools{padding:8px}}
</style>
</head>
<body>
<div id="lock" hidden>
  <form id="unlock">
    <h1>${title}</h1>
    <p class="hint" id="lock-hint">Enter this agent’s access key (AGENT_ACCESS_KEY).</p>
    <input id="key" type="password" autocomplete="current-password" placeholder="Access key" required>
    <button class="primary">Unlock</button>
  </form>
</div>
<header>
  <h1>${title}</h1>
  <select id="model" aria-label="Model"></select>
  <button id="clear" type="button" title="Start a new conversation">New chat</button>
  <button id="menu" type="button" title="Settings: knowledge, notes, library, models, access" aria-label="Settings">☰</button>
</header>
<main>
  <section id="chat">
    <div id="paused" role="status" hidden><span>Paused: the kill switch is on, so the agent calls no model.</span><button type="button" id="resume-banner">Resume</button></div>
    <div id="log" aria-live="polite"></div>
    <form id="ask">
      <div id="mode-chip" hidden><span id="mode-label"></span><button type="button" id="mode-clear" aria-label="Stop using this tool" title="Stop using this tool">✕</button></div>
      <div id="composer">
        <button type="button" id="tools" aria-haspopup="menu" aria-expanded="false" aria-controls="tools-menu" title="Ask the agent to use a tool">+ Tools</button>
        <textarea id="input" placeholder="Ask your agent…" required></textarea>
        <button class="primary" id="send">Send</button>
      </div>
      <div id="tools-menu" role="menu" aria-label="Tools" hidden></div>
    </form>
    <p class="credit">Built with <a href="https://orunbase.com" target="_blank" rel="noopener">Orunbase</a> · open source, Apache-2.0</p>
  </section>
  <aside id="side">
    <div id="side-body">
      <input id="chat-search" type="search" placeholder="Search conversations" aria-label="Search conversations">
      <section>
        <h2 id="chats-title">Recent</h2>
        <ul id="chats"></ul>
        <button type="button" class="link" id="chats-more" hidden>Show more</button>
      </section>
      <section id="shortcuts">
        <h2>Yours</h2>
        <button type="button" class="link" id="open-graph">Knowledge graph<span id="memory-count"></span></button>
        <button type="button" class="link" id="open-notes">Notes</button>
        <button type="button" class="link" id="open-library">Library</button>
      </section>
    </div>
    <div id="side-foot"><button type="button" id="collapse" title="Collapse the sidebar">‹ Collapse</button></div>
  </aside>
</main>
<dialog id="settings" aria-labelledby="settings-title">
  <div id="settings-shell">
    <div id="settings-head">
      <h2 id="settings-title">Settings</h2>
      <div id="tabs" role="tablist">
        <button type="button" role="tab" data-tab="knowledge">Knowledge</button>
        <button type="button" role="tab" data-tab="notes">Notes</button>
        <button type="button" role="tab" data-tab="skills">Skills</button>
        <button type="button" role="tab" data-tab="library">Library</button>
        <button type="button" role="tab" data-tab="models">Models</button>
        <button type="button" role="tab" data-tab="access">Access</button>
      </div>
      <button type="button" id="close-settings" aria-label="Close">✕</button>
    </div>
    <section class="tab" id="tab-knowledge" role="tabpanel">
      <div id="graph-wrap">
        <svg id="graph" viewBox="-520 -360 1040 720" role="img" aria-label="What the agent remembers, by space"></svg>
        <p class="hint" id="graph-empty" hidden>Nothing remembered yet. Tell your agent something about you, add an answer with “Add to knowledge”, or add a memory here.</p>
      </div>
      <div id="knowledge-side">
        <div id="detail"><p class="hint">Click a space or a memory to see it here.</p></div>
        <section>
          <h2>Add a memory</h2>
          <form class="stack" id="add-memory">
            <input id="memory-text" placeholder="One fact — e.g. Prefers tea to coffee." maxlength="500" required>
            <input id="memory-space" placeholder="Space — e.g. Food (default: General)" maxlength="40" list="space-names">
            <button>Add memory</button>
            <p class="hint" id="memory-note"></p>
          </form>
          <datalist id="space-names"></datalist>
        </section>
      </div>
    </section>
    <section class="tab" id="tab-notes" role="tabpanel" hidden>
      <div class="models">
        <section>
          <h2>Add a note or a to-do</h2>
          <p class="hint">Notes are short-lived: each goes when its time is up, unless you keep it longer, for good, or move it to the knowledge.</p>
          <form class="stack" id="note-form">
            <textarea id="note-text" placeholder="e.g. Buy cardamom" maxlength="20000" rows="2" required></textarea>
            <div class="row">
              <input id="note-list" placeholder="List — e.g. Groceries (default: Notes)" maxlength="40" list="list-names">
              <select id="note-keep" aria-label="How long to keep it"><option value="2">Keep 2 days</option><option value="7">Keep 7 days</option><option value="good">Keep for good</option></select>
            </div>
            <button>Add</button>
            <p class="hint" id="note-note"></p>
          </form>
          <datalist id="list-names"></datalist>
        </section>
        <div id="notes-lists"></div>
      </div>
    </section>
    <section class="tab" id="tab-skills" role="tabpanel" hidden>
      <div id="skills-wrap">
        <div id="skills-list"></div>
        <form class="stack" id="skill-form">
          <h2 id="skill-title">New skill</h2>
          <p class="hint">A skill tells the agent how to do one kind of task. It sees each skill's name and description, and loads the instructions only when a request matches.</p>
          <input id="skill-name" placeholder="name — e.g. weekly-review (lowercase, dashes)" pattern="[a-z0-9][a-z0-9-]{1,39}" required>
          <input id="skill-description" placeholder="When to use it — e.g. Review my week: notes done, notes open, what to plan" maxlength="200" required>
          <textarea id="skill-instructions" placeholder="Steps the agent follows, and the tools it should use." maxlength="8000" required></textarea>
          <div class="row"><button class="primary" id="skill-save">Save skill</button><button type="button" id="skill-new">New skill</button><button type="button" id="skill-delete" class="danger" hidden>Delete</button></div>
          <p class="hint" id="skill-note"></p>
        </form>
      </div>
    </section>
    <section class="tab" id="tab-library" role="tabpanel" hidden>
      <div style="display:grid;gap:24px">
        <section>
          <h2>Images</h2>
          <div id="library-images"></div>
        </section>
        <section style="max-width:760px">
          <h2>Kept whole</h2>
          <ul class="items" id="library-saved"></ul>
        </section>
      </div>
    </section>
    <section class="tab" id="tab-models" role="tabpanel" hidden>
      <div class="models">
        <section>
          <h2>Image model</h2>
          <select id="image-model" aria-label="Image model"></select>
          <p class="hint" id="image-note">Draws the pictures you ask for, on Workers AI.</p>
        </section>
        <section>
          <h2>Add a model</h2>
          <form class="stack" id="add">
            <select id="add-provider">
              <option value="huggingface">Hugging Face: Inference Providers model (as HuggingChat uses)</option>
              <option value="space">Hugging Face: Gradio Space</option>
              <option value="workers-ai">Workers AI: any other @cf/… model</option>
            </select>
            <input id="add-id" placeholder="owner/name — e.g. openai/gpt-oss-120b" required>
            <input id="add-label" placeholder="Label (optional)">
            <label class="hint" id="add-tools-row"><input type="checkbox" id="add-tools" checked> Let it use the agent’s tools</label>
            <input id="add-api" placeholder="Space endpoint (default: chat)" hidden>
            <button>Add model</button>
            <p class="hint" id="add-note"></p>
          </form>
        </section>
        <section>
          <h2>Added models</h2>
          <ul class="items" id="added"></ul>
        </section>
      </div>
    </section>
    <section class="tab" id="tab-access" role="tabpanel" hidden>
      <div class="models">
        <section>
          <h2>Kill switch</h2>
          <p class="hint" id="switch-note">Pausing stops the agent at once: no chat reaches any model, so nothing is spent, until you resume. What it remembers and its models stay as they are.</p>
          <p><button type="button" class="danger" id="switch">Pause the agent</button></p>
          <p class="hint">If the access key itself may have leaked, use the hard switch instead: store the secret <code>AGENT_KILL_SWITCH</code> = <code>on</code> for this environment and redeploy. Every /api route then refuses everyone, you included, until you remove it and redeploy.</p>
        </section>
        <section>
          <h2>What it did</h2>
          <p class="hint">Every tool the agent called, newest first. Blocked means a guard refused it: a secret kept out, a link nobody gave it, or a memory change after reading the web.</p>
          <ul class="items" id="activity"></ul>
        </section>
        <section>
          <h2>This browser</h2>
          <p class="hint">The access key is kept in this browser only; your conversations are saved with the agent, with any secret taken out. Locking forgets the key here; the agent, its conversations and what it remembers are untouched.</p>
          <p><button type="button" id="lock-now">Lock this browser</button></p>
        </section>
      </div>
    </section>
  </div>
</dialog>
<dialog id="to-knowledge" class="small" aria-labelledby="to-knowledge-title">
  <form class="stack" id="knowledge-form" method="dialog">
    <h2 id="to-knowledge-title">Add to knowledge</h2>
    <p class="hint" id="knowledge-hint"></p>
    <label id="knowledge-q-row" hidden>You asked<textarea id="knowledge-question" maxlength="1000" rows="2"></textarea></label>
    <label><span id="knowledge-a-label">The fact</span><textarea id="knowledge-text" maxlength="500" rows="4" required></textarea></label>
    <input id="knowledge-space" placeholder="Space — e.g. Food (default: General)" maxlength="40" list="space-names">
    <p class="hint" id="knowledge-note"></p>
    <div class="row"><button type="button" id="knowledge-cancel">Cancel</button><button class="primary" id="knowledge-save" value="save">Add</button></div>
  </form>
</dialog>
<dialog id="save-dialog" class="small" aria-labelledby="save-title">
  <form class="stack" id="save-form" method="dialog">
    <h2 id="save-title">Save</h2>
    <p class="hint" id="save-preview"></p>
    <fieldset>
      <legend class="hint">Keep it as</legend>
      <label><input type="radio" name="keep" id="keep-2" value="2" checked><span>A note for 2 days<small>In ☰ → Notes; it goes after 2 days unless you keep it.</small></span></label>
      <label><input type="radio" name="keep" id="keep-7" value="7"><span>A note for 7 days<small>The same, for a week.</small></span></label>
      <label><input type="radio" name="keep" id="keep-knowledge" value="knowledge"><span>Knowledge<small>Kept for good as what you asked and what it answered; the agent knows it in every chat.</small></span></label>
      <label><input type="radio" name="keep" id="keep-library" value="library"><span>Library<small>Kept whole, for you to read; the agent does not see it.</small></span></label>
    </fieldset>
    <div id="save-list-row"><input id="save-list" placeholder="Note list (default: Notes)" maxlength="40" list="list-names" style="width:100%"></div>
    <p class="hint" id="save-note"></p>
    <div class="row"><button type="button" id="save-cancel">Cancel</button><button class="primary" id="save-go" value="save">Save</button></div>
  </form>
</dialog>
<div id="toast" role="status" hidden></div>
<script>${SCRIPT}</script>
</body>
</html>`
}
