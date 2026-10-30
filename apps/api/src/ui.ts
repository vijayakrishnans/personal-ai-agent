// The agent's page, served at GET /. Its footer credits Orunbase, the
// platform it was created with — the owner's to keep (NOTICE asks only that
// the attribution travel with the source, not that the page show it).
// One self-contained document — no
// script, style or font from anywhere else — so the Worker is the whole of
// what the owner's browser talks to. The conversation and the access key
// stay in the browser (localStorage); models and memories are read from and
// written to /api with the key as a bearer token. The sidebar lists what the
// agent remembers by space; ☰ opens the settings — the knowledge graph of
// those spaces, the owner's notes and to-dos, their library (every image the
// agent drew, every answer they saved), the models — chat and image — and
// access: the kill switch, what the agent did, and locking this browser.
// Every message can be copied, added to the knowledge, or saved to the
// library. Images are shown in the chat, fetched with the key.

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

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
main{flex:1;display:flex;min-height:0}
#chat{flex:1;display:flex;flex-direction:column;min-width:0}
#log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:46rem;padding:10px 14px;border-radius:12px;background:var(--panel);border:1px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere}
.msg.user{align-self:flex-end;background:var(--me)}
.msg .meta{display:block;margin-top:6px;font-size:12px;color:var(--muted)}
.msg img{display:block;max-width:min(100%,512px);border-radius:10px;margin-top:8px;background:var(--line);aspect-ratio:1}
.actions{display:flex;gap:4px;margin-top:6px;opacity:.55;transition:opacity .15s}
.msg:hover .actions,.msg:focus-within .actions{opacity:1}
.actions button{border:0;background:none;padding:2px 6px;font-size:12px;color:var(--muted);border-radius:6px}
.actions button:hover{background:var(--bg);color:var(--ink)}
dialog#to-knowledge{border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--ink);width:min(480px,94vw);padding:20px}
dialog#to-knowledge::backdrop{background:rgb(0 0 0 / .45)}
dialog#to-knowledge textarea{width:100%;min-height:120px;resize:vertical}
#library-images{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
#library-images figure{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--bg);display:flex;flex-direction:column}
#library-images img{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:var(--line)}
#library-images figcaption{padding:8px;font-size:12px;display:grid;gap:6px}
#library-images figcaption p{margin:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
#library-images .row button,#library-images .row a{font-size:12px;padding:2px 8px}
#library-saved li{display:block;border-bottom:1px solid var(--line);padding:8px 0}
#library-saved li p{margin:0 0 6px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:9em;overflow:hidden}
#library-saved li.open p{max-height:none}
#library-saved .row button{font-size:12px;padding:2px 8px}
a.button{border:1px solid var(--line);border-radius:8px;color:inherit;text-decoration:none}
#notes-lists{display:grid;gap:20px}
#notes-lists li{align-items:center}
#notes-lists li label{display:flex;gap:8px;align-items:flex-start;flex:1;cursor:pointer}
#notes-lists li.done span{text-decoration:line-through;color:var(--muted)}
.msg.error{border-color:var(--warn);color:var(--warn)}
#paused{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--warn);color:var(--warn);background:var(--panel);font-size:14px}
#paused span{flex:1}
#paused button{padding:4px 10px;font-size:13px}
form#ask{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--line);background:var(--panel)}
form#ask textarea{flex:1;resize:none;height:44px}
aside{width:300px;border-left:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;min-height:0}
#side-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:16px}
#side-foot{border-top:1px solid var(--line);padding:8px;display:flex;justify-content:flex-end}
#side-foot button{padding:4px 10px;font-size:13px}
aside.collapsed{width:48px}
aside.collapsed #side-body{display:none}
aside.collapsed #side-foot{flex:1;align-items:flex-end;justify-content:center;border-top:0}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 8px}
h3{font-size:13px;margin:0 0 6px;display:flex;align-items:center;gap:6px}
h3 .dot{width:9px;height:9px;border-radius:50%;flex:none}
h3 .count{color:var(--muted);font-weight:400}
form.stack{display:grid;gap:8px}
ul.items{list-style:none;margin:0;padding:0;display:grid;gap:6px}
ul.items li{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;font-size:14px}
ul.items li button{padding:2px 8px;font-size:12px;flex:none}
.hint{font-size:13px;color:var(--muted);margin:0}
.credit{margin:0;padding:6px 16px 10px;font-size:12px;color:var(--muted);text-align:center;background:var(--panel)}
.credit a{color:inherit}
#lock{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:16px;z-index:2}
#lock form{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px;display:grid;gap:12px;width:100%;max-width:380px}
#lock h1{margin:0;font-size:18px}
dialog#settings{border:1px solid var(--line);border-radius:14px;padding:0;background:var(--panel);color:var(--ink);width:min(1040px,96vw);height:min(720px,92dvh)}
dialog#settings::backdrop{background:rgb(0 0 0 / .45)}
#settings-shell{display:flex;flex-direction:column;height:100%}
#settings-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line)}
#settings-head h2{margin:0;flex:1;font-size:15px;text-transform:none;letter-spacing:0;color:var(--ink)}
#tabs{display:flex;gap:4px}
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
#memories{display:grid;gap:16px}
#knowledge-side{width:280px;flex:none;display:flex;flex-direction:column;gap:20px;overflow-y:auto;overflow-x:hidden}
#detail{border:1px solid var(--line);border-radius:10px;padding:12px;display:grid;gap:8px}
#detail p{margin:0;overflow-wrap:anywhere}
#activity li{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:13px;border-bottom:1px solid var(--line);padding:6px 0}
#activity .when{color:var(--muted);white-space:nowrap}
#activity .what{overflow-wrap:anywhere}
#activity .blocked .what{color:var(--warn)}
.row{display:flex;gap:8px}.row input{flex:1;width:0}
.models{max-width:560px;display:grid;gap:24px}
[hidden]{display:none!important}
@media (max-width:760px){main{flex-direction:column}aside{width:auto;border-left:0;border-top:1px solid var(--line);max-height:40dvh}aside.collapsed{width:auto;max-height:none}aside.collapsed #side-foot{justify-content:flex-end}#tab-knowledge{flex-direction:column}#graph-wrap{min-height:360px}#knowledge-side{width:auto}#settings-title{display:none}#tabs{flex:1}dialog#settings{width:100vw;height:100dvh;max-width:none;max-height:none;border-radius:0}}
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
  <button id="menu" type="button" title="Settings: knowledge, models, access" aria-label="Settings">☰</button>
</header>
<main>
  <section id="chat">
    <div id="paused" role="status" hidden><span>Paused: the kill switch is on, so the agent calls no model.</span><button type="button" id="resume-banner">Resume</button></div>
    <div id="log" aria-live="polite"></div>
    <form id="ask">
      <textarea id="input" placeholder="Ask your agent…" required></textarea>
      <button class="primary" id="send">Send</button>
    </form>
    <p class="credit">Built with <a href="https://orunbase.com" target="_blank" rel="noopener">Orunbase</a> · open source, Apache-2.0</p>
  </section>
  <aside id="side">
    <div id="side-body">
      <div>
        <h2>What it remembers</h2>
        <button type="button" class="link" id="open-graph">Open the knowledge graph</button>
      </div>
      <div id="memories"></div>
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
        <button type="button" role="tab" data-tab="library">Library</button>
        <button type="button" role="tab" data-tab="models">Models</button>
        <button type="button" role="tab" data-tab="access">Access</button>
      </div>
      <button type="button" id="close-settings" aria-label="Close">✕</button>
    </div>
    <section class="tab" id="tab-knowledge" role="tabpanel">
      <div id="graph-wrap">
        <svg id="graph" viewBox="-520 -360 1040 720" role="img" aria-label="What the agent remembers, by space"></svg>
        <p class="hint" id="graph-empty" hidden>Nothing remembered yet. Tell your agent something about you, or add a memory here.</p>
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
          <form class="stack" id="note-form">
            <input id="note-text" placeholder="e.g. Buy cardamom" maxlength="1000" required>
            <input id="note-list" placeholder="List — e.g. Groceries (default: Notes)" maxlength="40" list="list-names">
            <button>Add</button>
            <p class="hint" id="note-note"></p>
          </form>
          <datalist id="list-names"></datalist>
        </section>
        <div id="notes-lists"></div>
      </div>
    </section>
    <section class="tab" id="tab-library" role="tabpanel" hidden>
      <div style="display:grid;gap:24px">
        <section>
          <h2>Images</h2>
          <div id="library-images"></div>
        </section>
        <section style="max-width:760px">
          <h2>Saved</h2>
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
          <p class="hint">The access key and this conversation are kept in this browser only. Locking forgets the key here; the agent and what it remembers are untouched.</p>
          <p><button type="button" id="lock-now">Lock this browser</button></p>
        </section>
      </div>
    </section>
  </div>
</dialog>
<dialog id="to-knowledge" aria-labelledby="to-knowledge-title">
  <form class="stack" id="knowledge-form" method="dialog">
    <h2 id="to-knowledge-title">Add to knowledge</h2>
    <p class="hint">One fact the agent keeps and is told in every conversation. Trim it to what matters.</p>
    <textarea id="knowledge-text" maxlength="500" required></textarea>
    <input id="knowledge-space" placeholder="Space — e.g. Work (default: General)" maxlength="40" list="space-names">
    <p class="hint" id="knowledge-note"></p>
    <div class="row"><button type="button" id="knowledge-cancel">Cancel</button><button class="primary" id="knowledge-save" value="save">Add</button></div>
  </form>
</dialog>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  let key = store.get('agent.key', '');
  let messages = store.get('agent.messages', []);
  let models = [];
  let memories = [];
  let selected = null; // { kind: 'space', name } | { kind: 'memory', id }
  let paused = false;
  let imageModels = [];
  let chosenImageModel = '';
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

  function bubble(m) {
    const div = document.createElement('div');
    div.className = 'msg ' + m.role + (m.error ? ' error' : '');
    div.textContent = m.content;
    for (const im of m.images || []) div.appendChild(picture(im));
    if (m.meta) { const s = document.createElement('span'); s.className = 'meta'; s.textContent = m.meta; div.appendChild(s); }
    if (!m.error && m.content && m.content !== '…') div.appendChild(actions(m));
    $('log').appendChild(div);
    $('log').scrollTop = $('log').scrollHeight;
    return div;
  }
  // EVERY MESSAGE'S ACTIONS: copy it, add it to the knowledge (as a memory
  // the owner trims first), or save an answer whole to the library.
  function actions(m) {
    const bar = el('div', { className: 'actions' });
    const flash = (b, text) => { const was = b.textContent; b.textContent = text; setTimeout(() => { b.textContent = was; }, 1400); };
    const copy = el('button', { type: 'button', textContent: 'Copy', title: 'Copy to the clipboard' });
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(m.content); flash(copy, 'Copied'); }
      catch { flash(copy, 'Copy failed'); }
    };
    const know = el('button', { type: 'button', textContent: 'Add to knowledge', title: 'Keep this as something the agent knows' });
    know.onclick = () => toKnowledge(m.content);
    bar.append(copy, know);
    if (m.role === 'assistant') {
      const save = el('button', { type: 'button', textContent: 'Save', title: 'Save this answer to your library' });
      save.onclick = async () => {
        try { await api('/api/saved', { method: 'POST', body: JSON.stringify({ text: m.content, source: (m.meta || '').split(' · used')[0] }) }); flash(save, 'Saved to library'); }
        catch (err) { flash(save, err.message.slice(0, 40)); }
      };
      bar.append(save);
    }
    return bar;
  }
  function toKnowledge(text) {
    $('knowledge-text').value = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    $('knowledge-space').value = '';
    $('knowledge-note').textContent = text.length > 500 ? 'Shortened to 500 characters: keep the part worth knowing.' : '';
    $('to-knowledge').showModal();
    $('knowledge-text').focus();
  }

  // THE LIBRARY: every image the agent drew, and every answer saved.
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
      const know = el('button', { type: 'button', textContent: 'Add to knowledge', onclick: () => toKnowledge(it.text) });
      const remove = el('button', { type: 'button', textContent: 'Delete', onclick: async () => { await api('/api/saved/' + it.id, { method: 'DELETE' }); loadLibrary(); } });
      item.append(el('p', { textContent: it.text }), el('div', { className: 'row' },
        el('span', { className: 'hint', style: 'flex:1', textContent: new Date(it.createdAt).toLocaleString() + (it.source ? ' · ' + it.source : '') }), copy, more, know, remove));
      return item;
    }) : [li('Nothing saved yet. Use “Save” under an answer.')]));
  }

  // An image the agent drew: fetched with the key (an <img> cannot send it),
  // shown from a blob URL kept for the page's life.
  const pictures = new Map();
  function picture(im) {
    const img = document.createElement('img');
    img.alt = im.prompt; img.title = im.prompt;
    const shown = pictures.get(im.id);
    if (shown) img.src = shown;
    else fetch('/api/images/' + im.id, { headers: { authorization: 'Bearer ' + key } })
      .then((res) => (res.ok ? res.blob() : Promise.reject()))
      .then((blob) => { const url = URL.createObjectURL(blob); pictures.set(im.id, url); img.src = url; })
      .catch(() => { img.replaceWith(el('span', { className: 'meta', textContent: '(image no longer kept: ' + im.prompt + ')' })); });
    return img;
  }
  function render() { $('log').replaceChildren(); messages.forEach(bubble); }

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

  // SPACES: memories grouped by the space they are filed under, the biggest
  // first. Each has a colour the sidebar and the graph share, handed out in
  // the order the spaces were first used, so a space keeps its colour as
  // memories come and go.
  const HUES = [220, 0, 140, 35, 275, 180, 330, 95, 55, 250, 15, 160];
  function spaces() {
    const by = new Map();
    for (const m of memories) { if (!by.has(m.space)) by.set(m.space, []); by.get(m.space).push(m); }
    const first = [...by.entries()].map(([name, items]) => [name, Math.min(...items.map((m) => m.id))]).sort((a, b) => a[1] - b[1]).map(([name]) => name);
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([name, items]) => ({ name, items, colour: 'hsl(' + HUES[first.indexOf(name) % HUES.length] + ' 62% 56%)' }));
  }

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
    renderSide(); renderGraph(); renderDetail();
  }

  const forget = async (m) => { await api('/api/memories/' + m.id, { method: 'DELETE' }); await loadMemories(); };
  const move = async (m, space) => { await api('/api/memories/' + m.id, { method: 'PATCH', body: JSON.stringify({ space }) }); };

  function renderSide() {
    const groups = spaces();
    $('space-names').replaceChildren(...groups.map((g) => new Option(g.name)));
    $('memories').replaceChildren(...(groups.length ? groups.map((g) => el('section', {},
      el('h3', {}, el('span', { className: 'dot', style: 'background:' + g.colour }), g.name, el('span', { className: 'count', textContent: '· ' + g.items.length })),
      el('ul', { className: 'items' }, ...g.items.map((m) => li(m.text, () => forget(m)))),
    )) : [el('p', { className: 'hint', textContent: 'Nothing yet. Tell your agent something about you.' })]));
  }

  // THE KNOWLEDGE GRAPH: the owner at the centre, each space a hub around
  // them, each memory a leaf around its hub — fanned outwards, away from
  // the centre, in one ring or two.
  function svg(tag, attrs = {}, text) {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

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
          node.appendChild(svg('title', {}, m.text));
          node.appendChild(svg('circle', { cx: x, cy: y, r: 7, fill: grp.colour }));
          const right = Math.cos(b) >= 0;
          node.appendChild(svg('text', { x: x + (right ? 12 : -12), y: y + 4, 'text-anchor': right ? 'start' : 'end', class: 'label' }, short(m.text, ringNo ? 18 : 26)));
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
  // or removed; a space can be renamed, which moves every memory in it.
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
        el('h2', { textContent: 'Memory · ' + m.space }),
        el('p', { textContent: m.text }),
        el('p', { className: 'hint', textContent: 'Remembered ' + new Date(m.createdAt).toLocaleString() }),
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
        el('ul', { className: 'items' }, ...items.map((m) => li(m.text, () => forget(m).catch(fail)))),
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

  // NOTES: each list with its open to-dos first; tick one off, or remove it.
  async function loadNotes() {
    const { notes } = await api('/api/notes');
    const lists = new Map();
    for (const n of notes) { if (!lists.has(n.list)) lists.set(n.list, []); lists.get(n.list).push(n); }
    $('list-names').replaceChildren(...[...lists.keys()].map((n) => new Option(n)));
    $('notes-lists').replaceChildren(...(lists.size ? [...lists.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, items]) => el('section', {},
      el('h2', { textContent: name + ' · ' + items.filter((n) => !n.done).length + ' open' }),
      el('ul', { className: 'items' }, ...items.map((n) => {
        const box = el('input', { type: 'checkbox', checked: n.done, onchange: async () => { await api('/api/notes/' + n.id, { method: 'PATCH', body: JSON.stringify({ done: box.checked }) }); loadNotes(); } });
        return el('li', { className: n.done ? 'done' : '' },
          el('label', {}, box, el('span', { textContent: n.text })),
          el('button', { type: 'button', textContent: 'Remove', onclick: async () => { await api('/api/notes/' + n.id, { method: 'DELETE' }); loadNotes(); } }));
      })),
    )) : [el('p', { className: 'hint', textContent: 'No notes yet. Add one here, or ask your agent: “add milk to my groceries”.' })]));
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
    for (const t of ['knowledge', 'notes', 'library', 'models', 'access']) $('tab-' + t).hidden = t !== name;
    store.set('agent.tab', name);
    if (name === 'access') loadActivity().catch(() => {});
    if (name === 'notes') loadNotes().catch(() => {});
    if (name === 'library') loadLibrary().catch(() => {});
  }
  function openSettings(name) { tab(name || store.get('agent.tab', 'knowledge')); if (!$('settings').open) $('settings').showModal(); }

  function collapse(on) {
    $('side').classList.toggle('collapsed', on);
    $('collapse').textContent = on ? '›' : '‹ Collapse';
    $('collapse').title = on ? 'Show what it remembers' : 'Collapse the sidebar';
    store.set('agent.sidebar.collapsed', on);
  }

  async function start() {
    $('lock').hidden = true;
    const st = await api('/api/state');
    showPaused(st.paused); chosenImageModel = st.imageModel;
    await loadModels(); await loadMemories(); render();
  }

  $('unlock').onsubmit = (e) => { e.preventDefault(); key = $('key').value.trim(); store.set('agent.key', key); start().catch(() => {}); };
  $('model').onchange = () => store.set('agent.model', $('model').value);
  $('clear').onclick = () => { messages = []; store.set('agent.messages', messages); render(); };
  $('menu').onclick = () => openSettings();
  $('open-graph').onclick = () => openSettings('knowledge');
  $('close-settings').onclick = () => $('settings').close();
  $('settings').onclick = (e) => { if (e.target === $('settings')) $('settings').close(); };
  for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => tab(b.dataset.tab);
  $('collapse').onclick = () => collapse(!$('side').classList.contains('collapsed'));
  $('switch').onclick = () => setPaused(!paused);
  $('resume-banner').onclick = () => setPaused(false);
  $('lock-now').onclick = () => lock('Locked. Enter the access key to use this agent here again.');
  $('note-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = { text: $('note-text').value.trim() };
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
  $('knowledge-cancel').onclick = () => $('to-knowledge').close();
  $('knowledge-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = { text: $('knowledge-text').value.trim() };
    if ($('knowledge-space').value.trim()) body.space = $('knowledge-space').value.trim();
    try { await api('/api/memories', { method: 'POST', body: JSON.stringify(body) }); $('to-knowledge').close(); await loadMemories(); }
    catch (err) { $('knowledge-note').textContent = err.message; }
  };
  $('add').onsubmit = async (e) => {
    e.preventDefault();
    const provider = $('add-provider').value;
    const body = { provider, id: $('add-id').value.trim() };
    if ($('add-label').value.trim()) body.label = $('add-label').value.trim();
    if (provider === 'space') { if ($('add-api').value.trim()) body.apiName = $('add-api').value.trim().replace(/^\\//, ''); }
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
    messages.push({ role: 'user', content: text }); bubble(messages[messages.length - 1]);
    const pending = bubble({ role: 'assistant', content: '…' });
    $('send').disabled = true;
    try {
      // What a model is sent: the words only (an image is shown, not resent).
      const history = messages.filter((m) => !m.error && m.content).slice(-40).map(({ role, content }) => ({ role, content }));
      const reply = await api('/api/chat', { method: 'POST', body: JSON.stringify({ model: $('model').value, messages: history }) });
      const label = (models.find((m) => m.key === reply.model) || {}).label || reply.model;
      // A secret in what was typed never reached the model; keep the redacted
      // words here too, so this browser does not hold it either.
      if (reply.said) { messages[messages.length - 1].content = reply.said; render(); }
      const kept = reply.redacted ? ' · kept ' + reply.redacted + (reply.redacted === 1 ? ' secret' : ' secrets') + ' out' : '';
      messages.push({ role: 'assistant', content: reply.text || (reply.images ? '' : '(no answer)'), images: reply.images, meta: label + (reply.tools.length ? ' · used ' + reply.tools.join(', ') : '') + kept });
      if (reply.tools.some((t) => t === 'remember' || t === 'forget')) loadMemories();
      if (reply.tools.some((t) => /Note/.test(t)) && !$('tab-notes').hidden) loadNotes();
    } catch (err) {
      messages.push({ role: 'assistant', content: err.message, error: true });
    } finally {
      pending.remove(); bubble(messages[messages.length - 1]);
      store.set('agent.messages', messages.slice(-100)); $('send').disabled = paused; $('input').focus();
    }
  };

  collapse(store.get('agent.sidebar.collapsed', false));
  if (key) start().catch(() => {}); else lock();
})();
</script>
</body>
</html>`
}
