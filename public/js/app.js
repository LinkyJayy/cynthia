import { api, streamMessage } from './api.js';
import { renderMarkdown, enhanceCode } from './markdown.js';

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const svg = (d, extra = '') => {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg viewBox="0 0 24 24" ${extra}>${d}</svg>`;
  return wrap.firstChild;
};
const ICONS = {
  check: '<path d="m5 12 5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/>',
  cube: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m3 7 9 5 9-5M12 12v10"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  dblcheck: '<path d="m2 12 4.5 4.5L15 7M10 15l1.5 1.5L20 7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  pencil: '<path d="M4 20h4l10.5-10.5a2.8 2.8 0 0 0-4-4L4 16v4Z"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6"/>',
};

const state = {
  user: null,
  config: {},
  conversations: [],
  currentId: null,
  current: null,
  messages: [],
  streaming: null, // { conversationId, assistant, controller }
  pendingFiles: [],
  pollTimer: null,
};

const els = {
  app: $('#app'), auth: $('#auth'), splash: $('#splash'), list: $('#conv-list'), messages: $('#messages'), empty: $('#empty'),
  input: $('#input'), send: $('#send'), status: $('#contact-status'), sheet: $('#sheet'), sheetBody: $('#sheet-body'),
  sheetTitle: $('#sheet-title'), backdrop: $('#sheet-backdrop'), menu: $('#menu'), toast: $('#toast'),
};

// ===================================================================== Utilities
function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (els.toast.hidden = true), ms);
}
const fileUrl = (path, download) => `/api/files/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function sameDay(a, b) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
function dayLabel(t, withTime) {
  const d = new Date(t);
  const today = new Date();
  const yest = new Date(Date.now() - 864e5);
  let day;
  if (sameDay(d, today)) day = 'Today';
  else if (sameDay(d, yest)) day = 'Yesterday';
  else if (Date.now() - t < 6 * 864e5) day = d.toLocaleDateString([], { weekday: 'long' });
  else day = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  return withTime ? [day, fmtTime(t)] : [day];
}
function listTime(t) {
  if (sameDay(t, Date.now())) return fmtTime(t);
  if (Date.now() - t < 6 * 864e5) return new Date(t).toLocaleDateString([], { weekday: 'short' });
  return new Date(t).toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
}
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const style = () => document.documentElement.dataset.chatStyle;

// ===================================================================== Preferences / theming
const media = matchMedia('(prefers-color-scheme: dark)');
function applyPrefs(prefs = state.user?.prefs || {}) {
  const root = document.documentElement;
  const chatStyle = ['imessage', 'whatsapp', 'cynthia'].includes(prefs.chatStyle) ? prefs.chatStyle : 'imessage';
  root.dataset.chatStyle = chatStyle;
  root.dataset.theme = prefs.theme || 'system';
  const dark = prefs.theme === 'dark' || ((prefs.theme || 'system') === 'system' && media.matches);
  root.dataset.mode = dark ? 'dark' : 'light';
  root.style.setProperty('--chat-font', `${prefs.fontSize || 16}px`);
  els.input.placeholder = chatStyle === 'imessage' ? 'iMessage' : chatStyle === 'whatsapp' ? 'Message' : 'Message Cynthia';
  const headColor = getComputedStyle(root).getPropertyValue(chatStyle === 'whatsapp' ? '--head-bg' : '--chat-bg').trim();
  $('meta[name="theme-color"]').setAttribute('content', headColor.startsWith('#') ? headColor : dark ? '#000000' : '#ffffff');
  try {
    localStorage.setItem('cynthia-prefs', JSON.stringify({ chatStyle, theme: prefs.theme, fontSize: prefs.fontSize }));
  } catch {}
}
media.addEventListener('change', () => applyPrefs());
try {
  applyPrefs(JSON.parse(localStorage.getItem('cynthia-prefs') || '{}'));
} catch {
  applyPrefs({});
}

async function savePrefs(patch) {
  state.user.prefs = { ...state.user.prefs, ...patch };
  applyPrefs();
  renderMessages();
  try {
    const { user } = await api.patch('/api/me', { prefs: patch });
    state.user = user;
  } catch (e) {
    toast(e.message);
  }
}

// ===================================================================== Boot & auth
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    state.config = await api.get('/api/config');
  } catch {}
  try {
    const { user } = await api.get('/api/auth/me');
    await enterApp(user);
  } catch {
    showAuth();
  }
  els.splash.hidden = true;
}

function showAuth() {
  els.app.hidden = true;
  els.auth.hidden = false;
  document.documentElement.dataset.mode = media.matches ? 'dark' : 'light';
}

let authMode = 'login';
for (const b of document.querySelectorAll('.seg-btn')) {
  b.onclick = () => {
    authMode = b.dataset.mode;
    document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    $('.signup-only').hidden = authMode !== 'signup';
    $('#auth-submit').textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
    $('#auth-form [name=password]').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
    $('#auth-error').hidden = true;
  };
}
$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = $('#auth-submit');
  btn.disabled = true;
  $('#auth-error').hidden = true;
  try {
    const { user } = await api.post(`/api/auth/${authMode}`, Object.fromEntries(f));
    await enterApp(user);
  } catch (err) {
    $('#auth-error').textContent = err.message;
    $('#auth-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
};

async function enterApp(user) {
  state.user = user;
  applyPrefs();
  els.auth.hidden = true;
  els.app.hidden = false;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz && user.prefs.timezone !== tz) api.patch('/api/me', { prefs: { timezone: tz } }).then((r) => (state.user = r.user)).catch(() => {});
  renderSuggestions();
  await loadConversations();
  const c = new URLSearchParams(location.search).get('c');
  if (c && state.conversations.some((x) => x.id === c)) openConversation(c);
  else startNewChat(false);
  setupMic();
}

// ===================================================================== Conversations
async function loadConversations() {
  const { conversations } = await api.get('/api/conversations');
  state.conversations = conversations;
  renderConvList();
}

function renderConvList() {
  const q = $('#search').value.trim().toLowerCase();
  els.list.replaceChildren();
  const items = state.conversations.filter((c) => !q || c.title.toLowerCase().includes(q) || (c.last_message || '').toLowerCase().includes(q));
  if (!items.length) {
    els.list.append(h('div', { class: 'empty-note' }, q ? 'No matching chats' : 'No chats yet — say hi to Cynthia!'));
    return;
  }
  for (const c of items) {
    const preview = (c.last_message || '').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').slice(0, 140);
    els.list.append(
      h('button', { class: `conv${c.id === state.currentId ? ' active' : ''}`, onclick: () => openConversation(c.id) },
        h('img', { src: '/icons/logo-128.png', alt: '' }),
        h('div', { class: 'conv-main' },
          h('div', { class: 'conv-top' }, h('span', { class: 'conv-title' }, c.title), h('span', { class: 'conv-time' }, listTime(c.updated_at))),
          h('div', { class: 'conv-prev' }, c.running || state.streaming?.conversationId === c.id ? h('span', { class: 'conv-running' }) : null, preview || 'No messages yet'),
        ),
      ),
    );
  }
}
$('#search').oninput = renderConvList;

function setUrl(id) {
  const url = id ? `/?c=${id}` : '/';
  if (location.pathname + location.search !== url) history.replaceState(null, '', url);
}

function startNewChat(show = true) {
  stopPolling();
  state.currentId = null;
  state.current = null;
  state.messages = [];
  setUrl(null);
  renderConvList();
  renderMessages();
  setStatus();
  if (show) {
    els.app.classList.add('show-chat');
    els.input.focus();
  }
}
$('#new-chat').onclick = () => startNewChat(true);
$('#back').onclick = () => {
  els.app.classList.remove('show-chat');
  setUrl(null);
};

async function openConversation(id) {
  stopPolling();
  state.currentId = id;
  els.app.classList.add('show-chat');
  setUrl(id);
  renderConvList();
  try {
    const { conversation, messages } = await api.get(`/api/conversations/${id}/messages`);
    if (state.currentId !== id) return;
    state.current = conversation;
    if (state.streaming?.conversationId !== id) state.messages = messages;
    renderMessages(true);
    setStatus();
    if (conversation.running && state.streaming?.conversationId !== id) startPolling(id);
  } catch (e) {
    toast(e.message);
  }
}

// When a reply is running server-side without our stream (e.g. after a reload), poll for it.
function startPolling(id) {
  setStatus('typing');
  showTyping(true);
  state.pollTimer = setInterval(async () => {
    try {
      const { conversation, messages } = await api.get(`/api/conversations/${id}/messages`);
      if (state.currentId !== id) return stopPolling();
      if (!conversation.running) {
        stopPolling();
        state.messages = messages;
        renderMessages(true);
        setStatus();
        loadConversations();
      }
    } catch {}
  }, 2500);
}
function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

// ===================================================================== Message rendering
function setStatus(kind) {
  const typing = kind === 'typing';
  els.status.textContent = typing ? 'typing…' : 'online';
}

function showTyping(on) {
  $('#typing-row')?.remove();
  if (!on) return;
  els.messages.append(h('div', { class: 'row assistant tail head new-group', id: 'typing-row' }, h('div', { class: 'bubble typing' }, h('i'), h('i'), h('i'))));
  scrollToBottom(true);
}

function isNearBottom() {
  const m = els.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
}
function scrollToBottom(force) {
  if (force || isNearBottom()) els.messages.scrollTop = els.messages.scrollHeight;
}

function renderSuggestions() {
  const list = [
    ['🌐', "What's the biggest tech news today?"],
    ['🧊', 'Build me a 3D model of a cute rocket ship'],
    ['🎨', 'Generate an image of a purple bunny astronaut'],
    ['⏰', 'Remind me in 10 minutes to stretch'],
    ['🐍', 'Plot sin(x)/x from -20 to 20 with Python'],
    ['🔎', 'Open wikipedia.org and tell me the featured article'],
  ];
  $('#suggestions').replaceChildren(
    ...list.map(([e, t]) => h('button', { class: 'suggestion', type: 'button', onclick: () => send(t) }, `${e} ${t}`)),
  );
}

function renderMessages(forceScroll = false) {
  const keepBottom = forceScroll || isNearBottom();
  els.messages.replaceChildren();
  if (!state.messages.length) {
    els.messages.append(els.empty);
    return;
  }
  const msgs = state.messages;
  const lastUserIdx = msgs.map((m) => (m.role === 'user' && !m.meta?.scheduled && m.meta?.via !== 'webhook' ? 'user' : '')).lastIndexOf('user');
  msgs.forEach((m, i) => {
    const prev = msgs[i - 1];
    const next = msgs[i + 1];
    const newDay = !prev || !sameDay(prev.created_at, m.created_at) || m.created_at - prev.created_at > 3600e3;
    if (newDay) {
      const [day, time] = dayLabel(m.created_at, style() !== 'whatsapp');
      els.messages.append(h('div', { class: 'day-sep' }, h('b', {}, day), time ? ` ${time}` : ''));
    }
    const kind = (x) => (x.role === 'user' && (x.meta?.scheduled || x.meta?.via === 'webhook') ? 'system' : x.role);
    const head = newDay || kind(prev) !== kind(m) || m.created_at - prev.created_at > 300e3;
    const tail = !next || kind(next) !== kind(m) || next.created_at - m.created_at > 300e3;
    els.messages.append(messageRow(m, { head, tail, isLastUser: i === lastUserIdx }));
  });
  if (state.streaming && state.streaming.conversationId === state.currentId && !state.streaming.assistant.content && !state.streaming.assistant.meta.tools.length) {
    showTyping(true);
  }
  if (keepBottom) scrollToBottom(true);
}

function toolIcon(t) {
  if (t.status === 'done') return svg(ICONS.check);
  if (t.status === 'error') return svg(ICONS.x);
  return '';
}

function activityEl(tools, live) {
  const running = tools.find((t) => t.status === 'running');
  const summary = running ? running.label : `Used ${tools.length} tool${tools.length > 1 ? 's' : ''}`;
  const det = h('details', { class: 'activity', open: false },
    h('summary', {}, running ? h('span', { class: 'tool running' }, h('span', { class: 'dot' })) : '⚡️', summary),
    ...tools.map((t) =>
      h('div', { class: `tool ${t.status}` },
        h('span', { class: 'dot' }, toolIcon(t)),
        h('div', { style: 'min-width:0;flex:1' }, t.label,
          t.detail ? h('pre', {}, t.detail) : null,
          t.output ? h('pre', {}, t.output) : null),
      ),
    ),
  );
  if (live && openActivity.has(live)) det.open = true;
  det.addEventListener('toggle', () => (det.open ? openActivity.add(live) : openActivity.delete(live)));
  return det;
}
const openActivity = new Set();

function attachmentEl(a) {
  if (a.kind === 'image') {
    return h('img', { class: 'att-img', src: fileUrl(a.path), alt: a.caption || 'image', loading: 'lazy', onclick: () => openLightbox(fileUrl(a.path)) });
  }
  if (a.kind === 'model3d') {
    const thumb = h('div', { class: 'thumb' }, 'Rendering…');
    const card = h('button', { class: 'att-card att-model', type: 'button', onclick: () => openModel(a.path) },
      thumb,
      h('div', { class: 'cap' }, h('div', { style: 'min-width:0' }, h('div', { class: 't' }, a.caption || '3D model'), h('div', { class: 's' }, '3D model · tap to view')), h('span', { class: 'open' }, 'View')),
    );
    loadModel(a.path)
      .then(async (model) => {
        const { thumbnail } = await import('./viewer3d.js');
        thumb.textContent = '';
        thumb.style.backgroundImage = `url(${await thumbnail(model, a.path)})`;
      })
      .catch(() => (thumb.textContent = 'Preview unavailable'));
    return card;
  }
  const name = a.path.split('/').pop();
  return h('a', { class: 'att-card', href: fileUrl(a.path), target: '_blank', rel: 'noopener' },
    h('span', { class: 'ic' }, svg(ICONS.file)),
    h('div', { style: 'min-width:0' }, h('div', { class: 't' }, a.caption && a.caption !== a.path ? a.caption : name), h('div', { class: 's' }, a.path)),
  );
}

function messageRow(m, { head, tail, isLastUser }) {
  // Turns started by a schedule or another app are shown as a small system note, not as the user's bubble.
  if (m.role === 'user' && (m.meta?.scheduled || m.meta?.via === 'webhook')) {
    const label = m.meta.scheduled ? '⏰ Scheduled task' : '🔗 Via webhook';
    const text = m.meta.scheduled ? m.content.replace(/^⏰ Scheduled task /, '') : m.content;
    return h('div', { class: 'system-note', 'data-id': m.id }, h('b', {}, label), ` · ${fmtTime(m.created_at)}`, h('br'), text.length > 220 ? `${text.slice(0, 220)}…` : text);
  }
  const row = h('div', { class: `row ${m.role}${head ? ' head new-group' : ''}${tail ? ' tail' : ''}`, 'data-id': m.id });
  const meta = m.meta || {};
  const live = m.id === state.streaming?.assistant?.id;
  if (m.role === 'assistant' && meta.tools?.length) row.append(activityEl(meta.tools, m.id));

  const userAtts = m.role === 'user' ? meta.attachments || [] : [];
  if (userAtts.length) row.append(h('div', { class: 'attachments' }, userAtts.map(attachmentEl)));

  const waMeta = h('span', { class: 'wa-meta' }, fmtTime(m.created_at), m.role === 'user' ? svg(ICONS.dblcheck) : null);
  if (m.content) {
    const bubble = h('div', { class: 'bubble' });
    if (m.role === 'user') {
      bubble.append(h('span', { style: 'white-space:pre-wrap' }, meta.scheduled ? m.content.replace(/^⏰ /, '⏰ ') : m.content));
    } else {
      const md = h('div', { class: `md${live ? ' cursor' : ''}`, html: renderMarkdown(m.content) });
      enhanceCode(md);
      if (md.querySelector('pre, table')) bubble.classList.add('wide');
      bubble.append(md);
    }
    bubble.append(waMeta);
    row.append(bubble);
  }

  if (m.role === 'assistant' && meta.attachments?.length) row.append(h('div', { class: 'attachments' }, meta.attachments.map(attachmentEl)));
  if (m.role === 'assistant' && meta.sources?.length) {
    row.append(h('div', { class: 'sources' }, meta.sources.slice(0, 8).map((s) =>
      h('a', { class: 'source', href: s.uri, target: '_blank', rel: 'noopener noreferrer', title: s.title }, s.title))));
  }
  if (m.role === 'user' && isLastUser && tail) {
    row.append(h('div', { class: 'status-line' }, 'Delivered'));
  }
  if (tail) row.append(h('div', { class: 'cy-time' }, fmtTime(m.created_at)));
  return row;
}

// Live re-render of the streaming assistant row (throttled to one per frame).
let rafPending = false;
function updateLive() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const s = state.streaming;
    if (!s || s.conversationId !== state.currentId) return;
    const msg = s.assistant;
    if (!state.messages.includes(msg)) return;
    if (!msg.content && !msg.meta.tools.length && !msg.meta.attachments.length) return;
    $('#typing-row')?.remove();
    const stick = isNearBottom();
    const old = els.messages.querySelector(`.row[data-id="${msg.id}"]`);
    const fresh = messageRow(msg, { head: true, tail: true });
    if (old) {
      // keep already-loaded media to avoid flicker
      const oldAtts = old.querySelector('.attachments');
      const newAtts = fresh.querySelector('.attachments');
      if (oldAtts && newAtts && oldAtts.children.length === newAtts.children.length) newAtts.replaceWith(oldAtts);
      old.replaceWith(fresh);
    } else els.messages.append(fresh);
    if (stick) scrollToBottom(true);
  });
}

// ===================================================================== Sending
function setSending(on) {
  els.send.classList.toggle('stop', on);
  els.send.setAttribute('aria-label', on ? 'Stop' : 'Send');
  updateSendState();
}
function updateSendState() {
  const busy = Boolean(state.streaming && state.streaming.conversationId === state.currentId);
  const hasContent = els.input.value.trim() || state.pendingFiles.length;
  els.send.disabled = !busy && !hasContent;
  const mic = $('#mic');
  if (mic && mic.dataset.supported) mic.hidden = Boolean(hasContent) && style() === 'imessage';
}

async function send(textArg) {
  if (state.streaming) {
    toast('Cynthia is still replying…');
    return;
  }
  const text = (textArg ?? els.input.value).trim();
  const files = state.pendingFiles.map(({ mimeType, data, name }) => ({ mimeType, data, name }));
  if (!text && !files.length) return;

  if (!state.currentId) {
    try {
      const { conversation } = await api.post('/api/conversations', {});
      state.conversations.unshift({ ...conversation, last_message: text });
      state.currentId = conversation.id;
      state.current = conversation;
      setUrl(conversation.id);
    } catch (e) {
      return toast(e.message);
    }
  }
  const conversationId = state.currentId;
  els.input.value = '';
  autosize();
  state.pendingFiles = [];
  renderPending();

  const tempUser = {
    id: `tmp-${Date.now()}`, role: 'user', content: text, created_at: Date.now(),
    meta: { attachments: [] }, localFiles: files,
  };
  const assistant = { id: `live-${Date.now()}`, role: 'assistant', content: '', created_at: Date.now() + 1, meta: { tools: [], attachments: [], sources: [] } };
  state.messages.push(tempUser);
  const controller = new AbortController();
  state.streaming = { conversationId, assistant, controller };
  setSending(true);
  setStatus('typing');
  renderMessages(true);
  showTyping(true);
  renderConvList();

  const onEvent = (e) => {
    const inView = state.currentId === conversationId;
    switch (e.type) {
      case 'user_message': {
        const idx = state.messages.indexOf(tempUser);
        if (idx !== -1) state.messages[idx] = e.message;
        state.messages.push(assistant);
        if (inView) renderMessages();
        break;
      }
      case 'text':
        assistant.content += e.delta;
        break;
      case 'tool': {
        const t = assistant.meta.tools.find((x) => x.id === e.tool.id);
        if (t) Object.assign(t, e.tool);
        else assistant.meta.tools.push(e.tool);
        break;
      }
      case 'attachment':
        assistant.meta.attachments.push(e.attachment);
        break;
      case 'source':
        assistant.meta.sources.push(e.source);
        break;
      case 'title': {
        const c = state.conversations.find((x) => x.id === conversationId);
        if (c) c.title = e.title;
        renderConvList();
        break;
      }
      case 'done': {
        const idx = state.messages.indexOf(assistant);
        if (idx !== -1) state.messages[idx] = e.message;
        break;
      }
      case 'error':
        toast(e.error);
        break;
    }
    if (inView && ['text', 'tool', 'attachment', 'source'].includes(e.type)) updateLive();
  };

  try {
    await streamMessage(conversationId, { text, files }, onEvent, controller.signal);
  } catch (e) {
    if (e.name !== 'AbortError') {
      toast(e.message);
      if (e.status === 409) startPolling(conversationId);
    }
    const idx = state.messages.indexOf(tempUser);
    if (idx !== -1 && e.name !== 'AbortError') {
      state.messages.splice(idx, 1);
      if (!els.input.value) els.input.value = text;
      autosize();
    }
  } finally {
    state.streaming = null;
    setSending(false);
    setStatus();
    showTyping(false);
    if (state.currentId === conversationId) renderMessages();
    loadConversations();
    if (document.hidden) notifyLocal('Cynthia', assistant.content);
  }
}

function notifyLocal(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !body) return;
  navigator.serviceWorker?.ready.then((reg) =>
    reg.showNotification(title, { body: body.replace(/[#*_`>]/g, '').slice(0, 200), icon: '/icons/icon-192.png', badge: '/icons/icon-96.png', tag: 'reply' }),
  );
}

$('#composer').onsubmit = (e) => {
  e.preventDefault();
  if (state.streaming && state.streaming.conversationId === state.currentId) {
    api.post(`/api/conversations/${state.currentId}/stop`).catch(() => {});
    return;
  }
  send();
};

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`;
  updateSendState();
}
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => {
  const enterToSend = state.user?.prefs?.enterToSend !== false && !matchMedia('(pointer: coarse)').matches;
  if (e.key === 'Enter' && !e.shiftKey && enterToSend && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
els.input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

// ===================================================================== Attachments
$('#attach').onclick = () => $('#file-input').click();
$('#file-input').onchange = (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
};
els.messages.addEventListener('dragover', (e) => e.preventDefault());
els.messages.addEventListener('drop', (e) => {
  e.preventDefault();
  addFiles([...(e.dataTransfer?.files || [])]);
});

async function addFiles(files) {
  for (const f of files) {
    if (f.size > 15 * 1024 * 1024) {
      toast(`${f.name} is larger than 15 MB`);
      continue;
    }
    const data = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    state.pendingFiles.push({ name: f.name, mimeType: f.type || 'application/octet-stream', data, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null });
  }
  renderPending();
}
function renderPending() {
  const box = $('#attach-preview');
  box.hidden = !state.pendingFiles.length;
  box.replaceChildren(
    ...state.pendingFiles.map((f, i) =>
      h('div', { class: 'chip' }, f.preview ? h('img', { src: f.preview, alt: '' }) : f.name,
        h('button', { type: 'button', 'aria-label': 'Remove', onclick: () => { state.pendingFiles.splice(i, 1); renderPending(); } }, '✕'))),
  );
  updateSendState();
}

// ===================================================================== Voice dictation
function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $('#mic');
  if (!SR) return;
  mic.dataset.supported = '1';
  mic.hidden = false;
  let rec = null;
  mic.onclick = () => {
    if (rec) return rec.stop();
    rec = new SR();
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    const base = els.input.value ? `${els.input.value} ` : '';
    rec.onresult = (e) => {
      els.input.value = base + [...e.results].map((r) => r[0].transcript).join('');
      autosize();
    };
    rec.onend = () => {
      mic.classList.remove('recording');
      rec = null;
    };
    rec.onerror = () => toast('Dictation unavailable');
    mic.classList.add('recording');
    rec.start();
  };
}

// ===================================================================== Media viewers
function openLightbox(src) {
  const lb = $('#lightbox');
  lb.querySelector('img').src = src;
  lb.hidden = false;
}
$('#lightbox').onclick = () => ($('#lightbox').hidden = true);

const modelCache = new Map();
async function loadModel(path) {
  if (!modelCache.has(path)) {
    modelCache.set(path, fetch(fileUrl(path)).then((r) => {
      if (!r.ok) throw new Error('Model not found');
      return r.json();
    }));
  }
  return modelCache.get(path);
}
async function openModel(path) {
  try {
    const model = await loadModel(path);
    const v = await import('./viewer3d.js');
    $('#viewer').hidden = false;
    $('#viewer-title').textContent = model.name || '3D model';
    v.openViewer($('#viewer-canvas'), model);
  } catch (e) {
    toast(e.message);
  }
}
$('#viewer-close').onclick = async () => {
  (await import('./viewer3d.js')).closeViewer();
  $('#viewer').hidden = true;
};
for (const b of document.querySelectorAll('[data-export]')) {
  b.onclick = async () => (await import('./viewer3d.js')).exportCurrent(b.dataset.export);
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#lightbox').hidden) $('#lightbox').hidden = true;
  else if (!$('#viewer').hidden) $('#viewer-close').click();
  else if (!els.menu.hidden) els.menu.hidden = true;
  else if (!els.sheet.hidden) closeSheet();
});

// ===================================================================== Popup menu
function showMenu(anchor, items) {
  const r = anchor.getBoundingClientRect();
  els.menu.replaceChildren(...items.map(([label, fn, cls]) => h('button', { class: cls || '', onclick: () => { els.menu.hidden = true; fn(); } }, label)));
  els.menu.hidden = false;
  const w = els.menu.offsetWidth;
  els.menu.style.top = `${r.bottom + 6}px`;
  els.menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
}
document.addEventListener('pointerdown', (e) => {
  if (!els.menu.hidden && !els.menu.contains(e.target)) els.menu.hidden = true;
});
$('#chat-menu').onclick = (e) => {
  const id = state.currentId;
  const items = [
    ['New chat', () => startNewChat(true)],
    ['Chat style…', () => openPanel('settings', 'appearance')],
  ];
  if (id) {
    items.push(
      ['Rename', async () => {
        const c = state.conversations.find((x) => x.id === id);
        const title = prompt('Rename chat', c?.title || '');
        if (!title) return;
        await api.patch(`/api/conversations/${id}`, { title });
        loadConversations();
      }],
      ['Export as Markdown', () => exportChat()],
      ['Delete chat', async () => {
        if (!confirm('Delete this chat? This cannot be undone.')) return;
        await api.del(`/api/conversations/${id}`);
        startNewChat(false);
        els.app.classList.remove('show-chat');
        loadConversations();
      }, 'danger'],
    );
  }
  showMenu(e.currentTarget, items);
};
function exportChat() {
  const c = state.conversations.find((x) => x.id === state.currentId);
  const md = `# ${c?.title || 'Chat'}\n\n` + state.messages.map((m) => `**${m.role === 'user' ? state.user.name : 'Cynthia'}** — ${new Date(m.created_at).toLocaleString()}\n\n${m.content}\n`).join('\n---\n\n');
  const a = h('a', { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: `${(c?.title || 'chat').replace(/[^\w-]+/g, '_')}.md` });
  a.click();
}

// ===================================================================== Panels (sheets)
function openSheet(title) {
  els.sheetTitle.textContent = title;
  els.sheet.hidden = false;
  els.backdrop.hidden = false;
  els.sheetBody.scrollTop = 0;
}
function closeSheet() {
  els.sheet.hidden = true;
  els.backdrop.hidden = true;
}
$('#sheet-close').onclick = closeSheet;
els.backdrop.onclick = closeSheet;
$('#open-settings').onclick = () => openPanel('settings');
for (const b of document.querySelectorAll('[data-panel]')) b.onclick = () => openPanel(b.dataset.panel);

const group = (title, items, note) => [
  title ? h('div', { class: 'group-title' }, title) : null,
  h('div', { class: 'group' }, items),
  note ? h('div', { class: 'group-note' }, note) : null,
].filter(Boolean);
const item = (main, right, opts = {}) =>
  h('div', { class: `item${opts.onclick ? ' clickable' : ''}`, onclick: opts.onclick }, opts.icon || null, h('div', { class: 'grow' }, main), right || null);
const switchEl = (checked, onchange) => {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.onchange = () => onchange(input.checked);
  return h('label', { class: 'switch' }, input, h('span'));
};

async function openPanel(name, tab) {
  if (name === 'settings') return settingsPanel(tab || 'appearance');
  if (name === 'computer') return computerPanel();
  if (name === 'tasks') return tasksPanel();
  if (name === 'connections') return connectionsPanel();
}

// ---------------- Settings
function settingsPanel(tab) {
  openSheet('Settings');
  const tabs = [['appearance', 'Appearance'], ['account', 'Account'], ['notifications', 'Notifications'], ['memory', 'Memory'], ['about', 'About']];
  const body = h('div');
  const tabBar = h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: `tab${k === tab ? ' active' : ''}`, onclick: () => settingsPanel(k) }, l)));
  els.sheetBody.replaceChildren(tabBar, body);
  ({ appearance: appearanceTab, account: accountTab, notifications: notificationsTab, memory: memoryTab, about: aboutTab })[tab](body);
}

function appearanceTab(body) {
  const p = state.user.prefs;
  const styles = [['imessage', 'iMessage'], ['whatsapp', 'WhatsApp'], ['cynthia', 'Cynthia']];
  const picker = h('div', { class: 'style-picker' }, styles.map(([k, l]) =>
    h('button', { class: `style-opt${p.chatStyle === k ? ' active' : ''}`, onclick: () => { savePrefs({ chatStyle: k }); settingsPanel('appearance'); } },
      h('div', { class: `prev prev-${k}` }, h('div', { class: 'head' }), h('div', { class: 'b i' }), h('div', { class: 'b o' }), h('div', { class: 'b i', style: 'width:50%' }), h('div', { class: 'b o', style: 'width:40%' })),
      h('span', { class: 'lbl' }, l))));
  const theme = h('select', { onchange: (e) => savePrefs({ theme: e.target.value }) },
    [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: p.theme === v }, l)));
  const font = h('select', { onchange: (e) => savePrefs({ fontSize: Number(e.target.value) }) },
    [[14, 'Small'], [16, 'Default'], [18, 'Large'], [20, 'Extra large']].map(([v, l]) => h('option', { value: v, selected: (p.fontSize || 16) === v }, l)));
  body.append(
    h('div', { class: 'group-title' }, 'Chat style'), picker,
    h('div', { class: 'group-note' }, 'Choose how your conversations look. Your choice syncs across your devices.'),
    ...group('Display', [
      item('Appearance', theme),
      item('Text size', font),
      item('Enter to send', switchEl(p.enterToSend !== false, (v) => savePrefs({ enterToSend: v }))),
    ], 'On phones the return key always adds a new line; tap the send button to send.'),
  );
}

function accountTab(body) {
  const name = h('input', { type: 'text', value: state.user.name });
  const cur = h('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
  const nw = h('input', { type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password' });
  body.append(
    ...group('Profile', [
      item(h('div', {}, h('div', { class: 'sub' }, 'Name'), name)),
      item(h('div', {}, h('div', { class: 'sub' }, 'Email'), h('div', { class: 't' }, state.user.email))),
    ]),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn small primary', onclick: async () => {
      try {
        state.user = (await api.patch('/api/me', { name: name.value })).user;
        toast('Saved');
      } catch (e) { toast(e.message); }
    } }, 'Save name')),
    ...group('Change password', [item(cur), item(nw)]),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn small primary', onclick: async () => {
      try {
        await api.post('/api/me/password', { currentPassword: cur.value, newPassword: nw.value });
        cur.value = nw.value = '';
        toast('Password changed');
      } catch (e) { toast(e.message); }
    } }, 'Update password')),
    ...group('', [
      item(h('span', { class: 't', style: 'color:var(--accent)' }, 'Sign out'), null, { onclick: async () => {
        await api.post('/api/auth/logout');
        location.href = '/';
      } }),
      item(h('span', { class: 't danger-text' }, 'Delete account…'), null, { onclick: async () => {
        const pw = prompt('This permanently deletes your account, chats, files and tasks.\n\nEnter your password to confirm:');
        if (!pw) return;
        try {
          await api.del('/api/me', { password: pw });
          location.href = '/';
        } catch (e) { toast(e.message); }
      } }),
    ]),
  );
}

function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function notificationsTab(body) {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let sub = null;
  if (supported) sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription().catch(() => null);
  const enabled = Boolean(sub) && Notification.permission === 'granted';
  const toggle = switchEl(enabled, async (on) => {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (on) {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') throw new Error('Notifications were blocked in your browser settings.');
        const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(state.config.pushPublicKey) });
        await api.post('/api/push/subscribe', { subscription: s.toJSON() });
        toast('Notifications on');
      } else {
        const s = await reg.pushManager.getSubscription();
        if (s) {
          await api.post('/api/push/unsubscribe', { endpoint: s.endpoint });
          await s.unsubscribe();
        }
        toast('Notifications off');
      }
    } catch (e) {
      toast(e.message);
    }
    settingsPanel('notifications');
  });
  body.append(
    ...group('Push notifications', [
      item(h('div', {}, h('div', { class: 't' }, 'Notifications on this device'), h('div', { class: 'sub' }, supported ? 'Get scheduled task results and messages from Cynthia even when the app is closed.' : 'Not supported in this browser. On iPhone, add Cynthia to your Home Screen first.')), supported ? toggle : null),
      enabled ? item(h('span', { class: 't', style: 'color:var(--accent)' }, 'Send a test notification'), null, { onclick: async () => {
        const { sent } = await api.post('/api/push/test');
        toast(sent ? 'Sent!' : 'No devices subscribed');
      } }) : null,
    ].filter(Boolean)),
  );
}

async function memoryTab(body) {
  const { memories } = await api.get('/api/memories');
  const input = h('input', { type: 'text', placeholder: 'Add something Cynthia should remember…' });
  body.append(
    ...group('Add a memory', [item(input, h('button', { class: 'btn small primary', onclick: async () => {
      if (!input.value.trim()) return;
      await api.post('/api/memories', { content: input.value });
      settingsPanel('memory');
    } }, 'Add'))]),
    ...group('What Cynthia remembers', memories.length ? memories.map((m) => item(
      h('div', {}, h('div', { class: 't' }, m.content), h('div', { class: 'sub' }, new Date(m.created_at).toLocaleDateString())),
      h('button', { class: 'icon-btn', 'aria-label': 'Delete', onclick: async () => { await api.del(`/api/memories/${m.id}`); settingsPanel('memory'); } }, svg(ICONS.trash)),
    )) : [h('div', { class: 'empty-note' }, 'Nothing yet. Ask Cynthia to remember things, or add them here.')],
    'Memories are included in every conversation so Cynthia knows you better.'),
  );
}

function aboutTab(body) {
  const c = state.config;
  body.append(
    h('div', { style: 'text-align:center;padding:16px 0 4px' }, h('img', { src: '/icons/logo.png', alt: '', style: 'width:96px;height:96px' }), h('h3', { style: 'margin:6px 0 2px' }, 'Cynthia'), h('div', { class: 'muted' }, 'Your always-on AI assistant')),
    ...group('Status', [
      item('AI model', h('span', { class: 'muted' }, c.model || '—')),
      item('Gemini API', h('span', { class: 'muted' }, c.geminiConfigured ? 'Connected' : 'Not configured')),
      item('Web browser', h('span', { class: 'muted' }, c.browser ? 'Available' : 'Unavailable')),
      item('Install app', h('span', { class: 'muted' }, matchMedia('(display-mode: standalone)').matches ? 'Installed' : 'Use “Add to Home Screen”')),
    ]),
  );
}

// ---------------- Computer (files)
async function computerPanel() {
  openSheet('Computer');
  els.sheetBody.replaceChildren(h('div', { class: 'empty-note' }, 'Loading…'));
  const { files } = await api.get('/api/files');
  const groups = {};
  for (const f of files) (groups[f.path.includes('/') ? f.path.split('/')[0] : 'Files'] ||= []).push(f);
  const iconFor = (f) =>
    f.mime.startsWith('image/') ? h('span', { class: 'ficon' }, h('img', { src: fileUrl(f.path), alt: '', loading: 'lazy' }))
    : f.path.endsWith('.model3d.json') ? h('span', { class: 'ficon' }, svg(ICONS.cube))
    : h('span', { class: 'ficon' }, svg(ICONS.file));
  const upload = h('input', { type: 'file', multiple: true, hidden: true, onchange: async (e) => {
    for (const f of e.target.files) {
      const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(f); });
      await api.post('/api/files', { path: `uploads/${f.name}`, data, mimeType: f.type });
    }
    computerPanel();
  } });
  els.sheetBody.replaceChildren(
    h('div', { class: 'group-note', style: 'margin:0 4px 6px' }, "Cynthia's persistent workspace. Everything she creates — files, images, 3D models, screenshots — lives here."),
    h('div', { class: 'form-actions' }, upload, h('button', { class: 'btn small', onclick: () => upload.click() }, 'Upload files')),
    ...(files.length ? [] : [h('div', { class: 'empty-note' }, 'No files yet.')]),
    ...Object.entries(groups).flatMap(([g, list]) => group(g, list.map((f) => {
      const open = () => (f.path.endsWith('.model3d.json') ? (closeSheet(), openModel(f.path)) : f.mime.startsWith('image/') ? openLightbox(fileUrl(f.path)) : window.open(fileUrl(f.path), '_blank'));
      return h('div', { class: 'item' }, iconFor(f),
        h('div', { class: 'grow', style: 'cursor:pointer', onclick: open }, h('div', { class: 't' }, f.path.split('/').pop()), h('div', { class: 'sub' }, `${fmtSize(f.size)} · ${new Date(f.updated_at).toLocaleString()}`)),
        h('a', { class: 'icon-btn', href: fileUrl(f.path, true), 'aria-label': 'Download' }, svg(ICONS.download)),
        h('button', { class: 'icon-btn', 'aria-label': 'Delete', onclick: async () => {
          if (!confirm(`Delete ${f.path}?`)) return;
          await api.del(`/api/files?path=${encodeURIComponent(f.path)}`);
          computerPanel();
        } }, svg(ICONS.trash)));
    }))),
  );
}

// ---------------- Tasks
async function tasksPanel() {
  openSheet('Scheduled tasks');
  const { tasks } = await api.get('/api/tasks');
  els.sheetBody.replaceChildren(
    h('div', { class: 'group-note', style: 'margin:0 4px 6px' }, 'Cynthia is always on. Ask her things like “every morning at 8 send me a news briefing” or “check this page every hour and tell me if the price drops”.'),
    ...group('Tasks', tasks.length ? tasks.map((t) => h('div', { class: 'item' },
      h('div', { class: 'grow' },
        h('div', { class: 't' }, t.title),
        h('div', { class: 'sub' }, t.every_minutes ? `Every ${t.every_minutes >= 1440 && t.every_minutes % 1440 === 0 ? `${t.every_minutes / 1440} day(s)` : t.every_minutes >= 60 && t.every_minutes % 60 === 0 ? `${t.every_minutes / 60} hour(s)` : `${t.every_minutes} min`}` : 'Once',
          t.enabled ? ` · next ${new Date(t.next_run_at).toLocaleString()}` : t.last_run_at ? ' · done' : ' · paused'),
        t.last_result ? h('div', { class: 'sub' }, `Last: ${t.last_result.replace(/[#*_`>]/g, '').slice(0, 140)}`) : null),
      h('button', { class: 'icon-btn', title: 'Run now', 'aria-label': 'Run now', onclick: async () => { await api.post(`/api/tasks/${t.id}/run`); toast('Running…'); setTimeout(tasksPanel, 800); } }, svg(ICONS.play)),
      switchEl(Boolean(t.enabled), async (v) => { await api.patch(`/api/tasks/${t.id}`, { enabled: v }); tasksPanel(); }),
      h('button', { class: 'icon-btn', 'aria-label': 'Delete', onclick: async () => { await api.del(`/api/tasks/${t.id}`); tasksPanel(); } }, svg(ICONS.trash)),
    )) : [h('div', { class: 'empty-note' }, 'No scheduled tasks yet. Just ask Cynthia in a chat.')]),
  );
}

// ---------------- Connections
async function connectionsPanel() {
  openSheet('Connections');
  const [{ integrations }, hook] = await Promise.all([api.get('/api/integrations'), api.get('/api/me/hook')]);
  const name = h('input', { type: 'text', placeholder: 'Name (e.g. Family Discord)' });
  const kind = h('select', {}, [['discord', 'Discord webhook'], ['slack', 'Slack incoming webhook'], ['webhook', 'Generic webhook (Zapier, Make, IFTTT, n8n, Home Assistant…)']].map(([v, l]) => h('option', { value: v }, l)));
  const url = h('input', { type: 'url', placeholder: 'https://…' });
  const desc = h('input', { type: 'text', placeholder: 'What is it for? (helps Cynthia)' });
  const headers = h('input', { type: 'text', placeholder: 'Optional headers JSON, e.g. {"Authorization":"Bearer …"}' });
  const hookUrl = h('div', { class: 'code-box' }, hook.url);
  els.sheetBody.replaceChildren(
    h('div', { class: 'group-note', style: 'margin:0 4px 6px' }, 'Connect Cynthia to your other services. She can send messages and data to them, and they can talk to her.'),
    ...group('Your connections', integrations.length ? integrations.map((i) => item(
      h('div', {}, h('div', { class: 't' }, i.name), h('div', { class: 'sub' }, `${i.kind} · ${i.url}${i.description ? ` · ${i.description}` : ''}`)),
      h('button', { class: 'icon-btn', 'aria-label': 'Delete', onclick: async () => { await api.del(`/api/integrations/${i.id}`); connectionsPanel(); } }, svg(ICONS.trash)),
    )) : [h('div', { class: 'empty-note' }, 'No connections yet.')]),
    ...group('Add a connection', [item(name), item(kind), item(url), item(desc), item(headers)]),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn small primary', onclick: async () => {
      try {
        await api.post('/api/integrations', { name: name.value, kind: kind.value, url: url.value, description: desc.value, headers: headers.value || undefined });
        toast('Connected');
        connectionsPanel();
      } catch (e) { toast(e.message); }
    } }, 'Add connection')),
    ...group('Incoming webhook', [item(h('div', {}, h('div', { class: 'sub', style: 'margin-bottom:6px' }, 'POST JSON {"message": "…"} here from any app (Apple Shortcuts, Zapier, IFTTT, cron jobs…) and Cynthia replies with {"reply": "…"}. Add "conversation_id" to continue a chat, or "notify": true to push the reply to your devices.'), hookUrl))],
    'Keep this URL secret — anyone with it can message Cynthia as you.'),
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn small', onclick: () => { navigator.clipboard.writeText(hookUrl.textContent); toast('Copied'); } }, 'Copy URL'),
      h('button', { class: 'btn small danger', onclick: async () => {
        if (!confirm('Generate a new URL? The old one will stop working.')) return;
        hookUrl.textContent = (await api.post('/api/me/hook/rotate')).url;
      } }, 'Regenerate')),
  );
}

// ===================================================================== Misc
addEventListener('popstate', () => {
  const c = new URLSearchParams(location.search).get('c');
  if (c) openConversation(c);
  else els.app.classList.remove('show-chat');
});
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open' && e.data.url) {
    const c = new URL(e.data.url, location.origin).searchParams.get('c');
    loadConversations().then(() => c && openConversation(c));
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.user && !state.streaming) {
    loadConversations();
    if (state.currentId) openConversation(state.currentId);
  }
});

boot();
