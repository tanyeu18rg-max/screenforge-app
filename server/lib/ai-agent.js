'use strict';

// Kardinal, the AI operator for Kardinal Screens: chat with OpenAI-style tool
// calling against the workspace's own data (server/lib/ai-tools.js).
//
// ⚠️ THE MODEL NEVER TOUCHES THE DATABASE DIRECTLY. It only gets the tool
// schemas; every tool_call runs through executeTool, which scopes rows to the
// caller's workspace and refuses mutations when canMutate is false. The Brain
// context is workspace-scoped facts injected by the caller (getBrainContext),
// never another tenant's.
const { db } = require('../db/database');
const { decrypt } = require('./secretbox');
const { toolList, executeTool } = require('./ai-tools');

// ⚠️ LAZY, because routes/ai requires this module at its top and this module
// needs routes/ai's endpointAllowed (the SSRF guard). Requiring it here at
// module load would hand back a half-initialised module; by call time the
// route module is fully loaded and the cache returns the real thing.
function endpointAllowed(url) {
  const guard = require('../routes/ai').endpointAllowed;
  if (typeof guard !== 'function') throw new Error('AI route module not ready');
  return guard(url);
}

const MAX_ITERATIONS = 6;
const TOTAL_TIMEOUT_MS = 90000;

function systemPrompt(canMutate) {
  return 'You are Kardinal, the AI operator for Kardinal Screens digital signage. '
    + 'You help operators run their display network: check which screens are online, browse media and playlists, '
    + 'and (for operators with editor access) build playlists and assign them to displays.\n'
    + 'Rules:\n'
    + '- Use the provided tools to look up real data. Never invent display names, media files, playlist ids, or statistics.\n'
    + '- Keep replies short and plain: no emojis, no marketing language, no filler.\n'
    + '- When you take an action, say exactly what changed and what it affects.\n'
    + '- If a request is ambiguous (for example which "lobby" screen), ask which one before acting.\n'
    + '- Adding media marks a playlist as a draft: tell the operator it needs publishing to reach screens.\n'
    + (canMutate
      ? '- You have editor access: you may create playlists, add media, and assign playlists to displays when asked.\n'
      : '- This session is read-only: you may look things up but not change anything. Say so if asked to change something.\n')
    + '- Refuse anything outside signage management, briefly and politely.';
}

/*
 * Ask the workspace's configured chat model, letting it call tools. OpenAI
 * chat-completions envelope, the same shape askModelForJson uses (BYO
 * endpoint: OpenAI cloud or a self-hosted OpenAI-compatible server).
 *
 * Errors come back as {error, status} rather than thrown — the chat route
 * reports them with the UPSTREAM_STATUS=400 convention, because a wrong model
 * name or dead endpoint is a configuration fault the operator can fix, and a
 * 502 body is replaced by Cloudflare's error page before it reaches anyone.
 */
async function chatWithTools({ workspaceId, userId, ip, canMutate, messages, brainContext }) {
  const row = db.prepare('SELECT base_url, api_key_enc, model FROM ai_settings WHERE workspace_id = ?').get(workspaceId);
  if (!row || !row.base_url || !row.model) {
    return { error: 'AI is not configured. Set an endpoint and model in AI settings first.', status: 400 };
  }
  let allowed;
  try { allowed = endpointAllowed(row.base_url); } catch (e) {
    return { error: 'AI endpoint check unavailable: ' + String(e.message || e).slice(0, 100), status: 400 };
  }
  if (!allowed) return { error: 'Configured endpoint is not allowed.', status: 400 };

  const key = decrypt(row.api_key_enc) || 'none';
  const url = row.base_url.replace(/\/+$/, '') + '/chat/completions';
  const tools = toolList(!!canMutate);
  const convo = [
    { role: 'system', content: systemPrompt(!!canMutate) + (brainContext ? '\n\n' + brainContext : '') },
    ...(Array.isArray(messages) ? messages.slice(-20) : []),
  ];
  const actions = [];
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const remaining = deadline - Date.now();
    if (remaining <= 2000) return { error: 'The AI took too long to answer. Try a shorter request.', status: 400 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(60000, remaining));
    let aiRes;
    try {
      aiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: row.model, temperature: 0.2, stream: false,
          messages: convo, tools, tool_choice: 'auto',
        }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return { error: 'Could not reach the AI endpoint: ' + (e.name === 'AbortError' ? 'timed out' : String(e.message || e).slice(0, 120)), status: 400 };
    }
    clearTimeout(timer);
    if (!aiRes.ok) {
      const t = await aiRes.text().catch(() => '');
      return { error: `AI endpoint error ${aiRes.status}: ${t.slice(0, 150)}`, status: 400 };
    }
    let json;
    try { json = await aiRes.json(); } catch { return { error: 'AI returned non-JSON.', status: 400 }; }
    const msg = (json && json.choices && json.choices[0] && json.choices[0].message) || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (!calls.length) {
      const reply = String(msg.content || '').trim() || 'Done.';
      return { reply, actions };
    }

    // Record the assistant turn (with its tool calls) so the model sees its
    // own calls when the results come back.
    convo.push({ role: 'assistant', content: msg.content || null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: c.function })) });
    for (const call of calls) {
      const name = call && call.function && call.function.name;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* model sent garbage; executor gets {} */ }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {};
      const result = await executeTool(name, { workspaceId, userId, ip, canMutate: !!canMutate, args });
      const summary = result && (result.summary || result.error) ? String(result.summary || result.error) : 'done';
      actions.push({ tool: String(name || 'unknown').slice(0, 60), summary: summary.slice(0, 300) });
      convo.push({
        role: 'tool',
        tool_call_id: call.id,
        // Compact JSON: the model gets what it needs to answer, not full rows.
        content: JSON.stringify(result).slice(0, 8000),
      });
    }
  }
  return { error: 'The AI kept calling tools without answering. Try a simpler request.', status: 400 };
}

/*
 * The Brain: workspace-scoped knowledge entries, retrieved by keyword overlap
 * with the user's message. Dependency-free on purpose: no vector DB, no
 * embeddings endpoint, nothing to configure — an operator types facts ("the
 * lobby screen faces the entrance", "lunch menu runs 11:00-15:00") and the
 * ones whose words overlap the question ride along as context.
 */
const STOPWORDS = new Set(('a,an,the,and,or,but,of,to,in,on,at,for,with,by,from,as,is,are,was,were,be,been,being,'
  + 'it,its,this,that,these,those,i,you,he,she,we,they,them,my,your,our,their,his,her,me,us,do,does,did,'
  + 'what,which,who,whom,whose,when,where,why,how,can,could,should,would,will,have,has,had,not,no,yes,'
  + 'if,then,than,so,such,only,just,very,also,any,all,each,every,more,most,some,there,here,now,then')
  .split(','));

function messageWords(message) {
  const words = String(message || '').toLowerCase().match(/[a-z0-9][a-z0-9']*/g) || [];
  return new Set(words.filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

function getBrainContext(workspaceId, message) {
  if (!workspaceId || !message) return '';
  const words = messageWords(message);
  if (!words.size) return '';
  let entries;
  try {
    entries = db.prepare('SELECT title, content, tags FROM ai_brain WHERE workspace_id = ?').all(workspaceId);
  } catch {
    return ''; // table missing on a very old DB: chat still works, just without Brain
  }
  const scored = [];
  for (const e of entries) {
    const hay = String(e.title + ' ' + e.content + ' ' + (e.tags || '')).toLowerCase();
    let score = 0;
    for (const w of words) {
      // Word-boundary match on the haystack: "menu" matches "menu" but not "menus" spam.
      if (hay.indexOf(w) >= 0) score += 1;
      if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay)) score += 1;
    }
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  if (!top.length) return '';
  const lines = top.map(({ e }) => `- ${String(e.title).slice(0, 120)}: ${String(e.content).slice(0, 400)}`);
  return 'Knowledge base (facts about this workspace — prefer these over guessing):\n' + lines.join('\n');
}

module.exports = { chatWithTools, getBrainContext, systemPrompt };
