'use strict';

// Kardinal AI layer: tool executors, Brain retrieval, and the chat tool loop.
// Follows the ai-design.test.js pattern: an in-memory better-sqlite3 DB is
// injected as the db module before requiring the route (which pulls in
// lib/ai-agent -> lib/ai-tools -> services/activity).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const db = new Database(':memory:');
// Referenced by the ai_brain migration's REFERENCES clause (FKs are enforced here).
db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY)`);
db.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, status TEXT DEFAULT 'offline',
  last_heartbeat INTEGER, ip_address TEXT, app_version TEXT, playlist_id TEXT, playlist_source TEXT, updated_at INTEGER)`);
db.exec(`CREATE TABLE content (id TEXT PRIMARY KEY, workspace_id TEXT, filename TEXT, mime_type TEXT,
  duration_sec REAL, created_at INTEGER)`);
db.exec(`CREATE TABLE playlists (id TEXT PRIMARY KEY, workspace_id TEXT, user_id TEXT, name TEXT,
  status TEXT DEFAULT 'draft', description TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER)`);
db.exec(`CREATE TABLE playlist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id TEXT, content_id TEXT,
  sort_order INTEGER DEFAULT 0, duration_sec INTEGER DEFAULT 10)`);
db.exec(`CREATE TABLE activity_log (user_id TEXT, device_id TEXT, action TEXT, details TEXT,
  ip_address TEXT, workspace_id TEXT, status_code INTEGER)`);
db.exec(`CREATE TABLE ai_settings (workspace_id TEXT PRIMARY KEY, base_url TEXT, api_key_enc TEXT, model TEXT)`);

// The migration strings in db/database.js must be valid SQL. Run the ai_brain
// ones against this in-memory DB rather than re-typing them here (a copy would
// pass while the real migration stayed broken).
{
  const src = fs.readFileSync(require.resolve('../db/database.js'), 'utf8');
  const tableSql = src.match(/"CREATE TABLE IF NOT EXISTS ai_brain \([^"]*",/);
  const indexSql = src.match(/"CREATE INDEX IF NOT EXISTS idx_ai_brain_ws[^"]*"/);
  assert.ok(tableSql, 'ai_brain migration present in database.js');
  assert.ok(indexSql, 'ai_brain index migration present in database.js');
  db.exec(JSON.parse(tableSql[0].replace(/,$/, '')));
  db.exec(JSON.parse(indexSql[0].replace(/,$/, '')));
}

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db, pruneTelemetry() {}, pruneScreenshots() {} } };

require('../routes/ai'); // pulls in lib/ai-agent + lib/ai-tools via the route
const agent = require('../lib/ai-agent');
const tools = require('../lib/ai-tools');

const WS = 'ws1', WS2 = 'ws2', USER = 'u1';
const ctx = (over = {}) => ({ workspaceId: WS, userId: USER, ip: '127.0.0.1', canMutate: true, args: {}, ...over });

test('toolList hides mutating tools from read-only sessions', () => {
  const ro = tools.toolList(false).map((t) => t.function.name);
  assert.ok(ro.includes('overview_stats'));
  assert.ok(ro.includes('list_displays'));
  assert.ok(!ro.includes('create_playlist'));
  assert.ok(!ro.includes('assign_playlist_to_display'));
  const rw = tools.toolList(true).map((t) => t.function.name);
  assert.ok(rw.includes('create_playlist'));
});

test('overview_stats counts workspace rows only', async () => {
  db.prepare("INSERT INTO devices (id, workspace_id, name, status) VALUES ('d1', 'ws1', 'Lobby', 'online'), ('d2', 'ws1', 'Back', 'offline'), ('d9', 'ws2', 'Other', 'online')").run();
  db.prepare("INSERT INTO content (id, workspace_id, filename) VALUES ('m1', 'ws1', 'a.mp4'), ('m9', 'ws2', 'b.mp4')").run();
  const r = await tools.executeTool('overview_stats', ctx());
  assert.equal(r.data.displays.total, 2);
  assert.equal(r.data.displays.online, 1);
  assert.equal(r.data.displays.offline, 1);
  assert.equal(r.data.media, 1);
  assert.match(r.summary, /2 display\(s\), 1 online/);
});

test('list_displays filters by status and stays in-workspace', async () => {
  const r = await tools.executeTool('list_displays', ctx({ args: { status_filter: 'offline' } }));
  assert.equal(r.data.displays.length, 1);
  assert.equal(r.data.displays[0].name, 'Back');
});

test('display_detail resolves by name fragment', async () => {
  const r = await tools.executeTool('display_detail', ctx({ args: { display: 'lob' } }));
  assert.ok(!r.error);
  assert.equal(r.data.display.name, 'Lobby');
  const miss = await tools.executeTool('display_detail', ctx({ args: { display: 'nope' } }));
  assert.ok(miss.error);
});

test('create_playlist writes a workspace-scoped row and audits', async () => {
  const r = await tools.executeTool('create_playlist', ctx({ args: { name: 'Morning Loop', description: 'd' } }));
  assert.ok(!r.error, r.error);
  const row = db.prepare('SELECT * FROM playlists WHERE id = ?').get(r.data.playlist.id);
  assert.equal(row.workspace_id, 'ws1');
  assert.equal(row.name, 'Morning Loop');
  const audit = db.prepare("SELECT * FROM activity_log WHERE action = 'ai_agent_create_playlist'").get();
  assert.ok(audit, 'mutation was audit-logged');
});

test('add_media_to_playlist appends and marks draft', async () => {
  const pl = db.prepare('SELECT id FROM playlists WHERE name = ?').get('Morning Loop');
  const r = await tools.executeTool('add_media_to_playlist', ctx({ args: { playlist: pl.id, media: 'a.mp4', duration_sec: 15 } }));
  assert.ok(!r.error, r.error);
  const item = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ?').get(pl.id);
  assert.equal(item.content_id, 'm1');
  assert.equal(item.duration_sec, 15);
  assert.equal(db.prepare('SELECT status FROM playlists WHERE id = ?').get(pl.id).status, 'draft');
});

test('assign_playlist_to_display sets device override in-workspace', async () => {
  const pl = db.prepare('SELECT id FROM playlists WHERE name = ?').get('Morning Loop');
  const r = await tools.executeTool('assign_playlist_to_display', ctx({ args: { playlist: pl.id, display: 'Lobby' } }));
  assert.ok(!r.error, r.error);
  const d = db.prepare('SELECT playlist_id, playlist_source FROM devices WHERE id = ?').get('d1');
  assert.equal(d.playlist_id, pl.id);
  assert.equal(d.playlist_source, 'device');
  // cross-workspace display must not resolve: d9 lives in ws2
  const bad = await tools.executeTool('assign_playlist_to_display', ctx({ args: { playlist: pl.id, display: 'd9' } }));
  assert.ok(bad.error, 'cross-workspace display id must not resolve');
});

test('mutations refused when canMutate is false', async () => {
  const r = await tools.executeTool('create_playlist', ctx({ canMutate: false, args: { name: 'X' } }));
  assert.ok(r.error);
  const ro = await tools.executeTool('overview_stats', ctx({ canMutate: false }));
  assert.ok(!ro.error);
});

test('unknown tool is an error, not a crash', async () => {
  const r = await tools.executeTool('launch_missiles', ctx());
  assert.ok(r.error);
});

test('getBrainContext scores keyword overlap, workspace-scoped', () => {
  db.prepare("INSERT OR IGNORE INTO workspaces (id) VALUES ('ws1'), ('ws2')").run();
  db.prepare("INSERT INTO ai_brain (id, workspace_id, title, content, tags) VALUES ('b1', 'ws1', 'Lobby screen', 'The lobby screen faces the entrance and shows the lunch menu from 11:00 to 15:00.', 'lobby,menu')").run();
  db.prepare("INSERT INTO ai_brain (id, workspace_id, title, content, tags) VALUES ('b2', 'ws1', 'WiFi password', 'The guest wifi password is hunter2.', 'network')").run();
  db.prepare("INSERT INTO ai_brain (id, workspace_id, title, content, tags) VALUES ('b3', 'ws2', 'Lobby screen', 'Other tenant secret.', '')").run();
  const c = agent.getBrainContext('ws1', 'what is on the lobby screen at lunch?');
  assert.match(c, /lobby screen faces the entrance/);
  assert.ok(!c.includes('hunter2'), 'unrelated entry not injected');
  assert.ok(!c.includes('Other tenant secret'), 'other workspace not injected');
  assert.equal(agent.getBrainContext('ws1', 'the and of'), '', 'stopword-only message injects nothing');
});

test('chatWithTools refuses without AI configured', async () => {
  const out = await agent.chatWithTools({ workspaceId: 'ws1', userId: 'u1', ip: '1.2.3.4', canMutate: false, messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(out.error);
  assert.equal(out.status, 400);
});

test('chatWithTools runs the tool loop with a stubbed endpoint', async () => {
  db.prepare("INSERT INTO ai_settings (workspace_id, base_url, model) VALUES ('ws1', 'https://ai.example.com/v1', 'test-model')").run();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const first = calls.length === 1;
    return {
      ok: true,
      json: async () => first
        ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
              { id: 'call1', type: 'function', function: { name: 'overview_stats', arguments: '{}' } },
            ] } }] }
        : { choices: [{ message: { role: 'assistant', content: 'You have 2 displays, 1 online.' } }] },
    };
  };
  try {
    const out = await agent.chatWithTools({
      workspaceId: 'ws1', userId: 'u1', ip: '1.2.3.4', canMutate: false,
      messages: [{ role: 'user', content: 'how is my network?' }],
    });
    assert.ok(!out.error, out.error);
    assert.equal(out.reply, 'You have 2 displays, 1 online.');
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0].tool, 'overview_stats');
    // read-only session: the model was never offered mutating tools
    const offered = calls[0].tools.map((t) => t.function.name);
    assert.ok(!offered.includes('create_playlist'));
  } finally {
    globalThis.fetch = realFetch;
    db.prepare('DELETE FROM ai_settings WHERE workspace_id = ?').run('ws1');
  }
});
