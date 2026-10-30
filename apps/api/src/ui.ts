// The agent's page, served at GET /. Its footer credits Orunbase, the
// platform it was created with — the owner's to keep (NOTICE asks only that
// the attribution travel with the source, not that the page show it).
// One self-contained document — no
// script, style or font from anywhere else — so the Worker is the whole of
// what the owner's browser talks to. The conversation and the access key
// stay in the browser (localStorage); models and memories are read from and
// written to /api with the key as a bearer token.

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
button:disabled{opacity:.5;cursor:default}
main{flex:1;display:flex;min-height:0}
#chat{flex:1;display:flex;flex-direction:column;min-width:0}
#log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:46rem;padding:10px 14px;border-radius:12px;background:var(--panel);border:1px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere}
.msg.user{align-self:flex-end;background:var(--me)}
.msg .meta{display:block;margin-top:6px;font-size:12px;color:var(--muted)}
.msg.error{border-color:var(--warn);color:var(--warn)}
form#ask{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--line);background:var(--panel)}
form#ask textarea{flex:1;resize:none;height:44px}
aside{width:320px;border-left:1px solid var(--line);background:var(--panel);overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:20px}
aside h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 8px}
aside form{display:grid;gap:8px}
aside ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
aside li{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;font-size:14px}
aside li button{padding:2px 8px;font-size:12px}
.hint{font-size:13px;color:var(--muted);margin:0}
.credit{margin:0;padding:6px 16px 10px;font-size:12px;color:var(--muted);text-align:center;background:var(--panel)}
.credit a{color:inherit}
#lock{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:16px}
#lock form{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px;display:grid;gap:12px;width:100%;max-width:380px}
#lock h1{margin:0;font-size:18px}
[hidden]{display:none!important}
@media (max-width:760px){main{flex-direction:column}aside{width:auto;border-left:0;border-top:1px solid var(--line);max-height:40dvh}}
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
  <button id="toggle" type="button" title="Models and memories">☰</button>
</header>
<main>
  <section id="chat">
    <div id="log" aria-live="polite"></div>
    <form id="ask">
      <textarea id="input" placeholder="Ask your agent…" required></textarea>
      <button class="primary" id="send">Send</button>
    </form>
    <p class="credit">Built with <a href="https://orunbase.com" target="_blank" rel="noopener">Orunbase</a> · open source, Apache-2.0</p>
  </section>
  <aside id="side">
    <section>
      <h2>Add a Hugging Face model</h2>
      <form id="add">
        <select id="add-provider">
          <option value="huggingface">Inference Providers model (as HuggingChat uses)</option>
          <option value="space">Gradio Space</option>
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
      <ul id="added"></ul>
    </section>
    <section>
      <h2>What it remembers</h2>
      <ul id="memories"></ul>
    </section>
  </aside>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  let key = store.get('agent.key', '');
  let messages = store.get('agent.messages', []);
  let models = [];

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key, ...(opts.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { lock('That key was not accepted.'); throw new Error('unauthorized'); }
    if (res.status === 503) { lock(body.message); throw new Error(body.error); }
    if (!res.ok) throw new Error(body.message || ('HTTP ' + res.status));
    return body;
  }

  function lock(hint) {
    key = ''; store.del('agent.key');
    if (hint) $('lock-hint').textContent = hint;
    $('lock').hidden = false; $('key').focus();
  }

  function bubble(m) {
    const div = document.createElement('div');
    div.className = 'msg ' + m.role + (m.error ? ' error' : '');
    div.textContent = m.content;
    if (m.meta) { const s = document.createElement('span'); s.className = 'meta'; s.textContent = m.meta; div.appendChild(s); }
    $('log').appendChild(div);
    $('log').scrollTop = $('log').scrollHeight;
    return div;
  }
  function render() { $('log').replaceChildren(); messages.forEach(bubble); }

  function li(text, onRemove) {
    const item = document.createElement('li');
    const span = document.createElement('span'); span.textContent = text; item.appendChild(span);
    if (onRemove) { const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Remove'; b.onclick = onRemove; item.appendChild(b); }
    return item;
  }

  async function loadModels() {
    const body = await api('/api/models');
    models = body.models;
    const chosen = store.get('agent.model', body.default);
    $('model').replaceChildren(...models.map((m) => { const o = new Option(m.label, m.key); o.selected = m.key === chosen; return o; }));
    const added = models.filter((m) => m.source === 'added');
    $('added').replaceChildren(...(added.length ? added.map((m) => li(m.label, async () => {
      await api('/api/models/' + [m.provider, ...m.id.split('/')].map(encodeURIComponent).join('/'), { method: 'DELETE' }); loadModels();
    })) : [li('None yet — add one above, or list them in HF_MODELS.')]));
    $('add-note').textContent = body.huggingface ? '' : 'HF_TOKEN is not stored: public Spaces work, Inference Providers models need it.';
  }

  async function loadMemories() {
    const { memories } = await api('/api/memories');
    $('memories').replaceChildren(...(memories.length ? memories.map((m) => li(m.text, async () => {
      await api('/api/memories/' + m.id, { method: 'DELETE' }); loadMemories();
    })) : [li('Nothing yet. Tell your agent something about you.')]));
  }

  async function start() {
    $('lock').hidden = true;
    await loadModels(); await loadMemories(); render();
  }

  $('unlock').onsubmit = (e) => { e.preventDefault(); key = $('key').value.trim(); store.set('agent.key', key); start().catch(() => {}); };
  $('model').onchange = () => store.set('agent.model', $('model').value);
  $('clear').onclick = () => { messages = []; store.set('agent.messages', messages); render(); };
  $('toggle').onclick = () => { $('side').hidden = !$('side').hidden; };
  $('add-provider').onchange = () => {
    const space = $('add-provider').value === 'space';
    $('add-api').hidden = !space; $('add-tools-row').hidden = space;
    $('add-id').placeholder = space ? 'owner/space — e.g. your-name/your-chat-space' : 'owner/name — e.g. openai/gpt-oss-120b';
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
    const text = $('input').value.trim(); if (!text) return;
    $('input').value = '';
    messages.push({ role: 'user', content: text }); bubble(messages[messages.length - 1]);
    const pending = bubble({ role: 'assistant', content: '…' });
    $('send').disabled = true;
    try {
      const history = messages.filter((m) => !m.error).slice(-40).map(({ role, content }) => ({ role, content }));
      const reply = await api('/api/chat', { method: 'POST', body: JSON.stringify({ model: $('model').value, messages: history }) });
      const label = (models.find((m) => m.key === reply.model) || {}).label || reply.model;
      messages.push({ role: 'assistant', content: reply.text || '(no answer)', meta: label + (reply.tools.length ? ' · used ' + reply.tools.join(', ') : '') });
      if (reply.tools.some((t) => t === 'remember' || t === 'forget')) loadMemories();
    } catch (err) {
      messages.push({ role: 'assistant', content: err.message, error: true });
    } finally {
      pending.remove(); bubble(messages[messages.length - 1]);
      store.set('agent.messages', messages.slice(-100)); $('send').disabled = false; $('input').focus();
    }
  };

  if (key) start().catch(() => {}); else lock();
})();
</script>
</body>
</html>`
}
