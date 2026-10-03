import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

/*
 * Kardinal chat: a floating assistant button + slide-in drawer on every
 * authenticated page. Talks to POST /api/ai/chat, which runs the workspace's
 * own configured model with tool-calling (server/lib/ai-agent.js). Mutations
 * are only offered to editors+ by the server; viewers get read-only answers.
 *
 * ⚠️ SINGLETON. initAiChat is called from app.js on every route change after
 * auth; the guard below makes the second and later calls no-ops so there is
 * exactly one button and one drawer in the DOM.
 */

const CHAT_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const CLOSE_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const SEND_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

const SUGGESTIONS = ['Which screens are offline?', 'Create a playlist for the lobby', 'Summarize my network'];

const styles = `
#kchatFab{position:fixed;right:22px;bottom:22px;width:56px;height:56px;border-radius:50%;
  background:var(--accent,#d92038);color:#fff;border:none;cursor:pointer;z-index:9000;
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 6px 20px rgba(0,0,0,.35);transition:transform .15s ease,background .15s ease}
#kchatFab:hover{transform:scale(1.06);background:var(--accent-hover,#b3122e)}
#kchatDrawer{position:fixed;top:0;right:0;bottom:0;width:380px;max-width:94vw;z-index:9001;
  background:var(--bg-panel,#14171c);border-left:1px solid var(--border,#2a2f36);
  display:flex;flex-direction:column;transform:translateX(105%);transition:transform .25s ease;
  box-shadow:-12px 0 32px rgba(0,0,0,.4)}
#kchatDrawer.open{transform:translateX(0)}
.kchat-head{display:flex;align-items:center;justify-content:space-between;
  padding:14px 16px;border-bottom:1px solid var(--border,#2a2f36)}
.kchat-head h3{margin:0;font-size:15px}
.kchat-head p{margin:2px 0 0;font-size:11px;color:var(--text-muted,#8a94a3)}
.kchat-close{background:none;border:none;color:var(--text-muted,#8a94a3);cursor:pointer;padding:4px}
.kchat-close:hover{color:var(--text,#e8ebf0)}
#kchatMsgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.kchat-msg{max-width:88%;padding:9px 12px;border-radius:12px;font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.kchat-msg.user{align-self:flex-end;background:var(--accent,#d92038);color:#fff;border-bottom-right-radius:4px}
.kchat-msg.ai{align-self:flex-start;background:var(--bg-input,#1d2127);color:var(--text,#e8ebf0);border:1px solid var(--border,#2a2f36);border-bottom-left-radius:4px}
.kchat-msg.sys{align-self:center;font-size:12px;color:var(--text-muted,#8a94a3);background:none;text-align:center}
.kchat-actions{margin-top:6px;display:flex;flex-direction:column;gap:4px}
.kchat-action{font-size:11.5px;color:var(--text-muted,#8a94a3);border-left:2px solid var(--accent,#d92038);padding-left:8px}
.kchat-typing{align-self:flex-start;display:flex;gap:5px;padding:12px 14px;background:var(--bg-input,#1d2127);border:1px solid var(--border,#2a2f36);border-radius:12px}
.kchat-typing span{width:7px;height:7px;border-radius:50%;background:var(--text-muted,#8a94a3);animation:kchatBlink 1.2s infinite}
.kchat-typing span:nth-child(2){animation-delay:.2s}.kchat-typing span:nth-child(3){animation-delay:.4s}
@keyframes kchatBlink{0%,80%,100%{opacity:.25}40%{opacity:1}}
.kchat-chips{display:flex;gap:8px;flex-wrap:wrap;padding:0 16px 10px}
.kchat-chip{font-size:12px;padding:7px 12px;border-radius:20px;border:1px solid var(--border,#2a2f36);
  background:var(--bg-input,#1d2127);color:var(--text,#e8ebf0);cursor:pointer}
.kchat-chip:hover{border-color:var(--accent,#d92038)}
.kchat-foot{padding:12px 16px;border-top:1px solid var(--border,#2a2f36);display:flex;gap:8px}
#kchatInput{flex:1;background:var(--bg-input,#1d2127);border:1px solid var(--border,#2a2f36);
  border-radius:10px;color:var(--text,#e8ebf0);padding:10px 12px;font-size:13.5px;resize:none;height:42px;font-family:inherit}
#kchatInput:focus{outline:none;border-color:var(--accent,#d92038)}
#kchatSend{width:42px;height:42px;border-radius:10px;border:none;background:var(--accent,#d92038);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none}
#kchatSend:hover{background:var(--accent-hover,#b3122e)}
#kchatSend:disabled{opacity:.5;cursor:default}
.kchat-noconfig{margin:auto;text-align:center;padding:24px;max-width:280px}
.kchat-noconfig h4{margin:0 0 8px;font-size:15px}
.kchat-noconfig p{font-size:13px;color:var(--text-muted,#8a94a3);margin:0 0 16px;line-height:1.5}`;

function injectStyles() {
  if (document.getElementById('kchatStyles')) return;
  const s = document.createElement('style');
  s.id = 'kchatStyles';
  s.textContent = styles;
  document.head.appendChild(s);
}

export function initAiChat() {
  if (window.__kardinalAiChat) return;
  if (!localStorage.getItem('token')) return; // not authenticated
  window.__kardinalAiChat = true;
  injectStyles();

  const fab = document.createElement('button');
  fab.id = 'kchatFab';
  fab.setAttribute('aria-label', 'Chat with Kardinal AI');
  fab.innerHTML = CHAT_SVG;
  document.body.appendChild(fab);

  const drawer = document.createElement('div');
  drawer.id = 'kchatDrawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', 'Kardinal AI chat');
  drawer.innerHTML = `
    <div class="kchat-head">
      <div><h3>Kardinal AI</h3><p>Your signage operator</p></div>
      <button class="kchat-close" aria-label="${t('ai.chat.close')}">${CLOSE_SVG}</button>
    </div>
    <div id="kchatMsgs"></div>
    <div class="kchat-chips" id="kchatChips"></div>
    <div class="kchat-foot">
      <textarea id="kchatInput" placeholder="Ask about your screens..." aria-label="${t('ai.chat.message_label')}"></textarea>
      <button id="kchatSend" aria-label="${t('ai.chat.send')}">${SEND_SVG}</button>
    </div>`;
  document.body.appendChild(drawer);

  const msgs = drawer.querySelector('#kchatMsgs');
  const input = drawer.querySelector('#kchatInput');
  const sendBtn = drawer.querySelector('#kchatSend');
  const chipsBox = drawer.querySelector('#kchatChips');
  const history = []; // {role, content}, last 20 — sent to the server each turn
  let configured = null;
  let busy = false;

  const scrollDown = () => {
    msgs.scrollTop = msgs.scrollHeight;
  };
  const addMsg = (role, text) => {
    const d = document.createElement('div');
    d.className = 'kchat-msg ' + role;
    d.textContent = text;
    msgs.appendChild(d);
    scrollDown();
    return d;
  };
  const addActions = (actions) => {
    if (!actions || !actions.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'kchat-actions';
    for (const a of actions) {
      const d = document.createElement('div');
      d.className = 'kchat-action';
      d.textContent = a.summary || a.tool;
      wrap.appendChild(d);
    }
    const last = msgs.lastElementChild;
    if (last && last.classList.contains('ai')) last.appendChild(wrap);
    else msgs.appendChild(wrap);
    scrollDown();
  };

  for (const s of SUGGESTIONS) {
    const b = document.createElement('button');
    b.className = 'kchat-chip';
    b.type = 'button';
    b.textContent = s;
    b.addEventListener('click', () => {
      openDrawer();
      send(s);
    });
    chipsBox.appendChild(b);
  }

  async function checkConfigured() {
    if (configured !== null) return configured;
    try {
      const s = await api.aiGetSettings();
      configured = !!(s && s.configured);
    } catch {
      configured = false;
    }
    if (!configured) showNotConfigured();
    return configured;
  }

  function showNotConfigured() {
    msgs.innerHTML = '';
    chipsBox.style.display = 'none';
    input.disabled = true;
    sendBtn.disabled = true;
    const d = document.createElement('div');
    d.className = 'kchat-noconfig';
    const h = document.createElement('h4');
    h.textContent = "AI isn't connected yet";
    const p = document.createElement('p');
    p.textContent = 'Connect an AI endpoint in Settings to let Kardinal manage your screens by chat.';
    const b = document.createElement('button');
    b.className = 'btn btn-primary btn-sm';
    b.type = 'button';
    b.textContent = 'Open AI settings';
    b.addEventListener('click', () => {
      closeDrawer();
      window.location.hash = '#/settings';
    });
    d.append(h, p, b);
    msgs.appendChild(d);
  }

  async function send(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    if (!(await checkConfigured())) return;
    busy = true;
    sendBtn.disabled = true;
    addMsg('user', text);
    input.value = '';
    const typing = document.createElement('div');
    typing.className = 'kchat-typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    msgs.appendChild(typing);
    scrollDown();
    try {
      const r = await api.aiChat(text, history.slice(-20));
      typing.remove();
      const reply = (r && r.reply) || 'Done.';
      addMsg('ai', reply);
      addActions(r && r.actions);
      history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (history.length > 20) history.splice(0, history.length - 20);
    } catch (e) {
      typing.remove();
      addMsg('sys', (e && e.message) || 'The chat failed. Try again.');
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  function openDrawer() {
    drawer.classList.add('open');
    checkConfigured();
    setTimeout(() => input.focus(), 260);
  }
  function closeDrawer() {
    drawer.classList.remove('open');
  }

  fab.addEventListener('click', () => (drawer.classList.contains('open') ? closeDrawer() : openDrawer()));
  drawer.querySelector('.kchat-close').addEventListener('click', closeDrawer);
  sendBtn.addEventListener('click', () => send(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input.value);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
  });
}
