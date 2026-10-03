import { api } from '../api.js';
import { esc } from '../utils.js';
import { showToast } from '../components/toast.js';

/*
 * Brain — the workspace knowledge base behind Kardinal AI. Editors write facts
 * ("lobby screen faces the entrance", "lunch menu runs 11:00-15:00") and the
 * chat retrieves the relevant ones by keyword overlap (server/lib/ai-agent.js).
 * No vector DB, no embeddings — plain text, searchable by people too.
 */

function canEditBrain() {
  let me = null;
  try {
    me = JSON.parse(localStorage.getItem('user') || 'null');
  } catch (_) {
    /* no user */
  }
  if (!me) return false;
  if (me.role === 'platform_admin' || me.is_platform_admin) return true;
  return ['workspace_admin', 'workspace_editor'].includes(me.current_workspace_role);
}

function fmtDate(ts) {
  if (!ts) return '';
  try {
    return new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export async function render(container) {
  document.title = 'Brain — knowledge base';
  const editable = canEditBrain();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Brain <span style="font-weight:400;color:var(--text-muted)">— knowledge base</span></h1>
        <div class="subtitle">Facts Kardinal AI knows about your network. Anything here is offered to the chat as context when it is relevant.</div>
      </div>
    </div>
    ${
      editable
        ? `
    <div class="card" style="margin-bottom:20px">
      <h3 style="margin:0 0 12px;font-size:14px" id="brainFormTitle">Add knowledge</h3>
      <div style="display:grid;gap:10px;max-width:720px">
        <div class="form-group" style="margin:0"><label>Title</label>
          <input id="brainTitle" class="input" maxlength="200" placeholder="e.g. Lobby screen"></div>
        <div class="form-group" style="margin:0"><label>Tags <span style="color:var(--text-muted);font-weight:400">(comma-separated, optional)</span></label>
          <input id="brainTags" class="input" maxlength="500" placeholder="e.g. lobby, hours"></div>
        <div class="form-group" style="margin:0"><label>Content</label>
          <textarea id="brainContent" class="input" rows="4" maxlength="20000" placeholder="The fact the AI should know..."></textarea></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" id="brainSave">Add entry</button>
          <button class="btn btn-secondary btn-sm" id="brainCancel" style="display:none">Cancel</button>
        </div>
      </div>
    </div>`
        : `
    <div class="card" style="margin-bottom:20px"><p style="margin:0;font-size:13px;color:var(--text-muted)">
      Editor access is required to add or change entries. What is listed here is still used as context by Kardinal AI when you chat.</p></div>`
    }
    <div id="brainList" style="display:grid;gap:12px;max-width:900px"><p style="color:var(--text-muted)">Loading...</p></div>`;

  const listEl = container.querySelector('#brainList');
  let editingId = null;

  async function load() {
    let entries = [];
    try {
      const r = await api.aiBrainList();
      entries = (r && r.entries) || [];
    } catch (e) {
      listEl.innerHTML = `<p style="color:var(--text-muted)">${esc((e && e.message) || 'Could not load the knowledge base.')}</p>`;
      return;
    }
    if (!entries.length) {
      listEl.innerHTML =
        '<p style="color:var(--text-muted)">Nothing here yet. Add the first fact above — screen locations, opening hours, menu schedules, anything the AI should know.</p>';
      return;
    }
    listEl.innerHTML = '';
    for (const e of entries) {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.margin = '0';
      const tags = String(e.tags || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
          <div style="min-width:0">
            <h4 style="margin:0 0 4px;font-size:14px">${esc(e.title || '(untitled)')}</h4>
            ${tags.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">${tags.map((t) => `<span class="pill" style="font-size:11px">${esc(t)}</span>`).join('')}</div>` : ''}
            <p style="margin:0;font-size:13px;color:var(--text-muted);white-space:pre-wrap">${esc(e.preview || '')}${(e.preview || '').length >= 200 ? '…' : ''}</p>
            <div style="font-size:11px;color:var(--text-muted);margin-top:6px">${esc(fmtDate(e.created_at))}</div>
          </div>
          ${
            editable
              ? `<div style="display:flex;gap:6px;flex:none">
            <button class="btn btn-secondary btn-sm" data-edit="${esc(e.id)}">Edit</button>
            <button class="btn btn-secondary btn-sm" data-del="${esc(e.id)}">Delete</button>
          </div>`
              : ''
          }
        </div>`;
      listEl.appendChild(card);
    }
    if (editable) {
      listEl.querySelectorAll('[data-del]').forEach((b) =>
        b.addEventListener('click', async () => {
          if (!window.confirm('Delete this knowledge entry?')) return;
          try {
            await api.aiBrainDelete(b.dataset.del);
            showToast('Entry deleted', 'success');
            load();
          } catch (e) {
            showToast((e && e.message) || 'Delete failed', 'error');
          }
        }),
      );
      listEl
        .querySelectorAll('[data-edit]')
        .forEach((b) => b.addEventListener('click', () => startEdit(b.dataset.edit)));
    }
  }

  async function startEdit(id) {
    let e = null;
    try {
      e = (await api.aiBrainGet(id)).entry;
    } catch {
      return;
    }
    if (!e) return;
    container.querySelector('#brainTitle').value = e.title || '';
    container.querySelector('#brainTags').value = e.tags || '';
    container.querySelector('#brainContent').value = e.content || '';
    editingId = id;
    container.querySelector('#brainFormTitle').textContent = 'Edit knowledge';
    container.querySelector('#brainSave').textContent = 'Save changes';
    container.querySelector('#brainCancel').style.display = '';
    container.querySelector('#brainTitle').focus();
    container.querySelector('#brainTitle').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  if (editable) {
    const titleEl = container.querySelector('#brainTitle');
    const tagsEl = container.querySelector('#brainTags');
    const contentEl = container.querySelector('#brainContent');
    const saveBtn = container.querySelector('#brainSave');
    const cancelBtn = container.querySelector('#brainCancel');
    const resetForm = () => {
      titleEl.value = '';
      tagsEl.value = '';
      contentEl.value = '';
      editingId = null;
      container.querySelector('#brainFormTitle').textContent = 'Add knowledge';
      saveBtn.textContent = 'Add entry';
      cancelBtn.style.display = 'none';
    };
    cancelBtn.addEventListener('click', resetForm);
    saveBtn.addEventListener('click', async () => {
      const data = { title: titleEl.value.trim(), tags: tagsEl.value.trim(), content: contentEl.value.trim() };
      if (!data.title || !data.content) {
        showToast('Title and content are required', 'error');
        return;
      }
      try {
        if (editingId) await api.aiBrainUpdate(editingId, data);
        else await api.aiBrainAdd(data);
        showToast(editingId ? 'Entry updated' : 'Entry added', 'success');
        resetForm();
        load();
      } catch (e) {
        showToast((e && e.message) || 'Save failed', 'error');
      }
    });
  }

  load();
}
