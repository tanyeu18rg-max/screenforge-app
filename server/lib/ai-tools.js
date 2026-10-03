'use strict';

// Kardinal AI operator — tool definitions (OpenAI function-calling format) and
// the local executors that run them against the workspace's own database.
//
// ⚠️ EXECUTORS READ REAL ROWS AND MUTATIONS WRITE REAL ROWS. The tool list the
// model sees is filtered by canMutate (see toolList): a viewer only ever gets
// the read-only half, and every mutating executor re-checks that the target
// playlist/display belongs to the caller's workspace before touching it, so a
// model that hallucinates an id from another tenant gets an error, not a write.
// Every mutation also calls logActivity — agent actions must be auditable.
const { db } = require('../db/database');
const { v4: uuidv4 } = require('uuid');
const { logActivity } = require('../services/activity');

const CAP = 20; // tool results are compact: ids + names, lists capped

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'overview_stats',
      description: 'Overall health of the signage network: display counts by status, media items, playlists.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_displays',
      description: 'List displays in this workspace, optionally filtered by status.',
      parameters: {
        type: 'object',
        properties: {
          status_filter: { type: 'string', enum: ['online', 'offline'], description: 'Only screens with this status' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'display_detail',
      description: 'Full detail for one display: status, last heartbeat, app version, current playlist.',
      parameters: {
        type: 'object',
        properties: {
          display: { type: 'string', description: 'Display id, or part of its name' },
        },
        required: ['display'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_media',
      description: 'Browse the content library: images, videos and other media in this workspace.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Match against the file name' },
          limit: { type: 'integer', description: 'How many to return (default 20, max 50)' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_playlists',
      description: 'List playlists in this workspace with item and display counts.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_playlist',
      description: 'Create a new empty playlist in this workspace.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Playlist name' },
          description: { type: 'string', description: 'Optional description' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_media_to_playlist',
      description:
        'Append a media item from the library to a playlist (marks the playlist as a draft until published).',
      parameters: {
        type: 'object',
        properties: {
          playlist: { type: 'string', description: 'Playlist id, or part of its name' },
          media: { type: 'string', description: 'Media id, or part of its file name' },
          duration_sec: { type: 'integer', description: 'Seconds on screen; defaults to the media duration or 10' },
        },
        required: ['playlist', 'media'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'assign_playlist_to_display',
      description: 'Assign a playlist to a display (device-level override). The display plays it immediately.',
      parameters: {
        type: 'object',
        properties: {
          playlist: { type: 'string', description: 'Playlist id, or part of its name' },
          display: { type: 'string', description: 'Display id, or part of its name' },
        },
        required: ['playlist', 'display'],
        additionalProperties: false,
      },
    },
  },
];

// Mutating tools: only offered to the model when canMutate is true, and each
// executor still scopes every row it touches to the caller's workspace.
const MUTATING = new Set(['create_playlist', 'add_media_to_playlist', 'assign_playlist_to_display']);

function toolList(canMutate) {
  return canMutate ? TOOLS : TOOLS.filter((t) => !MUTATING.has(t.function.name));
}

// Escape LIKE wildcards in a user/model-supplied fragment before wrapping in %.
const likeFrag = (s) => String(s || '').replace(/[\\%_]/g, (c) => '\\' + c);

function resolvePlaylist(workspaceId, ref) {
  if (!ref) return null;
  const byId = db.prepare('SELECT id, name FROM playlists WHERE id = ? AND workspace_id = ?').get(ref, workspaceId);
  if (byId) return byId;
  return (
    db
      .prepare(
        "SELECT id, name FROM playlists WHERE name LIKE ? ESCAPE '\\' AND workspace_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get('%' + likeFrag(ref) + '%', workspaceId) || null
  );
}

function resolveDisplay(workspaceId, ref) {
  if (!ref) return null;
  const byId = db.prepare('SELECT id, name FROM devices WHERE id = ? AND workspace_id = ?').get(ref, workspaceId);
  if (byId) return byId;
  return (
    db
      .prepare(
        "SELECT id, name FROM devices WHERE name LIKE ? ESCAPE '\\' AND workspace_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get('%' + likeFrag(ref) + '%', workspaceId) || null
  );
}

function resolveMedia(workspaceId, ref) {
  if (!ref) return null;
  const scope = '(workspace_id = ? OR workspace_id IS NULL)';
  const byId = db
    .prepare(`SELECT id, filename, duration_sec FROM content WHERE id = ? AND ${scope}`)
    .get(ref, workspaceId);
  if (byId) return byId;
  return (
    db
      .prepare(
        `SELECT id, filename, duration_sec FROM content WHERE filename LIKE ? ESCAPE '\\' AND ${scope} ORDER BY created_at DESC LIMIT 1`,
      )
      .get('%' + likeFrag(ref) + '%', workspaceId) || null
  );
}

const executors = {
  overview_stats: async ({ workspaceId }) => {
    const devices = db
      .prepare(
        'SELECT COUNT(*) AS total, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS online FROM devices WHERE workspace_id = ?',
      )
      .get('online', workspaceId) || { total: 0, online: 0 };
    const media = db
      .prepare('SELECT COUNT(*) AS n FROM content WHERE (workspace_id = ? OR workspace_id IS NULL)')
      .get(workspaceId);
    const playlists = db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE workspace_id = ?').get(workspaceId);
    const total = devices.total || 0,
      online = devices.online || 0;
    return {
      summary: `${total} display(s), ${online} online, ${total - online} offline; ${media.n} media item(s), ${playlists.n} playlist(s).`,
      data: { displays: { total, online, offline: total - online }, media: media.n, playlists: playlists.n },
    };
  },

  list_displays: async ({ workspaceId, args }) => {
    const f =
      args && args.status_filter === 'online'
        ? "AND d.status = 'online'"
        : args && args.status_filter === 'offline'
          ? "AND d.status != 'online'"
          : '';
    const rows = db
      .prepare(
        `
      SELECT d.id, d.name, d.status, d.last_heartbeat, p.name AS playlist_name
      FROM devices d LEFT JOIN playlists p ON p.id = d.playlist_id
      WHERE d.workspace_id = ? ${f}
      ORDER BY d.name ASC LIMIT ${CAP}
    `,
      )
      .all(workspaceId);
    const names = rows.map((r) => r.name).join(', ') || 'none';
    return {
      summary: `${rows.length} display(s)${args && args.status_filter ? ` (${args.status_filter})` : ''}: ${names}.`,
      data: { displays: rows },
    };
  },

  display_detail: async ({ workspaceId, args }) => {
    const ref = args && args.display;
    if (!ref) return { error: 'display is required' };
    const d = resolveDisplay(workspaceId, ref);
    if (!d) return { error: `No display found matching "${String(ref).slice(0, 60)}".` };
    const full = db
      .prepare(
        `
      SELECT d.id, d.name, d.status, d.last_heartbeat, d.ip_address, d.app_version,
             p.id AS playlist_id, p.name AS playlist_name
      FROM devices d LEFT JOIN playlists p ON p.id = d.playlist_id
      WHERE d.id = ? AND d.workspace_id = ?
    `,
      )
      .get(d.id, workspaceId);
    const last = full.last_heartbeat ? new Date(full.last_heartbeat * 1000).toISOString() : 'never';
    return {
      summary: `"${full.name}" is ${full.status} (last heartbeat ${last}), playing "${full.playlist_name || 'nothing'}".`,
      data: { display: full },
    };
  },

  list_media: async ({ workspaceId, args }) => {
    const limit = Math.min(Math.max(parseInt((args && args.limit) || CAP, 10) || CAP, 1), 50);
    const q = args && args.search ? "AND c.filename LIKE ? ESCAPE '\\'" : '';
    const params = q ? ['%' + likeFrag(args.search) + '%', workspaceId] : [workspaceId];
    const rows = db
      .prepare(
        `
      SELECT c.id, c.filename, c.mime_type, c.duration_sec
      FROM content c
      WHERE (c.workspace_id = ? OR c.workspace_id IS NULL) ${q}
      ORDER BY c.created_at DESC LIMIT ${limit}
    `,
      )
      .all(...params);
    return {
      summary: `${rows.length} media item(s)${args && args.search ? ` matching "${args.search}"` : ''}.`,
      data: { media: rows },
    };
  },

  list_playlists: async ({ workspaceId }) => {
    const rows = db
      .prepare(
        `
      SELECT p.id, p.name, p.status,
        (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count,
        (SELECT COUNT(*) FROM devices d WHERE d.playlist_id = p.id AND d.workspace_id = ?) AS display_count
      FROM playlists p WHERE p.workspace_id = ?
      ORDER BY p.updated_at DESC LIMIT ${CAP}
    `,
      )
      .all(workspaceId, workspaceId);
    return {
      summary:
        `${rows.length} playlist(s): ` +
        (rows.map((r) => `"${r.name}" (${r.item_count} items)`).join(', ') || 'none') +
        '.',
      data: { playlists: rows },
    };
  },

  create_playlist: async ({ workspaceId, userId, ip, args }) => {
    const name = String((args && args.name) || '')
      .trim()
      .slice(0, 120);
    if (!name) return { error: 'A playlist name is required.' };
    const description = String((args && args.description) || '')
      .trim()
      .slice(0, 500);
    const id = uuidv4();
    db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, description) VALUES (?, ?, ?, ?, ?)').run(
      id,
      userId,
      workspaceId,
      name,
      description,
    );
    logActivity(userId, 'ai_agent_create_playlist', `Created playlist "${name}"`, null, ip, workspaceId);
    return { summary: `Created playlist "${name}".`, data: { playlist: { id, name } } };
  },

  add_media_to_playlist: async ({ workspaceId, userId, ip, args }) => {
    const pl = resolvePlaylist(workspaceId, args && args.playlist);
    if (!pl) return { error: `No playlist found matching "${String(args && args.playlist).slice(0, 60)}".` };
    const m = resolveMedia(workspaceId, args && args.media);
    if (!m) return { error: `No media found matching "${String(args && args.media).slice(0, 60)}".` };
    const maxOrder = db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM playlist_items WHERE playlist_id = ?')
      .get(pl.id);
    const dur =
      Number.isFinite(Number(args && args.duration_sec)) && Number(args.duration_sec) > 0
        ? Math.floor(Number(args.duration_sec))
        : Math.floor(Number(m.duration_sec) || 10);
    db.prepare(
      'INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, ?, ?)',
    ).run(pl.id, m.id, (maxOrder.m || 0) + 1, dur);
    // Same semantics as the playlists routes: editing marks the draft so nothing
    // reaches a screen until the operator publishes.
    db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(pl.id);
    logActivity(userId, 'ai_agent_add_media', `Added "${m.filename}" to playlist "${pl.name}"`, null, ip, workspaceId);
    return {
      summary: `Added "${m.filename}" to playlist "${pl.name}" (${dur}s per loop; playlist is now a draft until published).`,
      data: { playlist: { id: pl.id, name: pl.name }, media: { id: m.id, filename: m.filename } },
    };
  },

  assign_playlist_to_display: async ({ workspaceId, userId, ip, args }) => {
    const pl = resolvePlaylist(workspaceId, args && args.playlist);
    if (!pl) return { error: `No playlist found matching "${String(args && args.playlist).slice(0, 60)}".` };
    const d = resolveDisplay(workspaceId, args && args.display);
    if (!d) return { error: `No display found matching "${String(args && args.display).slice(0, 60)}".` };
    // Same write the playlist assign route makes: a device-level override.
    db.prepare(
      "UPDATE devices SET playlist_id = ?, playlist_source = 'device', updated_at = strftime('%s','now') WHERE id = ? AND workspace_id = ?",
    ).run(pl.id, d.id, workspaceId);
    logActivity(
      userId,
      'ai_agent_assign_playlist',
      `Assigned playlist "${pl.name}" to display "${d.name}"`,
      d.id,
      ip,
      workspaceId,
    );
    return {
      summary: `Display "${d.name}" now plays playlist "${pl.name}".`,
      data: { display: { id: d.id, name: d.name }, playlist: { id: pl.id, name: pl.name } },
    };
  },
};

// Run one tool call. Mutations are refused when canMutate is false — the model
// never sees the mutating tools in that case, but this is the backstop in case
// it calls one anyway (or a crafted client does).
async function executeTool(name, ctx) {
  const fn = executors[name];
  if (!fn) return { error: `Unknown tool "${String(name).slice(0, 40)}".` };
  if (MUTATING.has(name) && !ctx.canMutate) {
    return { error: 'That action needs editor access, which this chat session does not have.' };
  }
  try {
    return await fn(ctx);
  } catch (e) {
    return { error: `Tool failed: ${String((e && e.message) || e).slice(0, 160)}` };
  }
}

module.exports = { TOOLS, MUTATING, toolList, executeTool };
