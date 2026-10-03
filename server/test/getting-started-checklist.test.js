'use strict';

// A user reported not knowing how to get content onto a screen. There WAS onboarding — a modal
// wizard — but it is gated on a localStorage flag: skip it once and it never returns, and it
// never knew whether you actually succeeded at anything. Someone who closed it was left with no
// thread to pull.
//
// The replacement reads the account's real state instead of a flag. That is the property worth
// pinning: it must not congratulate someone who has not finished, must not nag someone who has,
// and must point at the FIRST thing that is actually possible rather than the first thing missing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The component and the i18n module it imports both read localStorage — that is not incidental,
// it is how the dismissal persists. Give them a real one rather than stubbing the behaviour out,
// so the dismissal tests below exercise the actual mechanism.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
// Node 22 added a built-in `navigator` global, defined as a getter with NO setter — so the plain
// assignment this used to do throws ("only a getter") under 'use strict' there, while being fine on
// Node 20 where the global does not exist at all. It is configurable, so define it rather than
// assign. Doing that unconditionally is also the more honest fixture: Node 22's own navigator
// reports the HOST locale (en-US here, something else on another machine or in CI), and a test that
// reads its language should not depend on where it runs.
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en' }, configurable: true, writable: true,
});

const MOD = pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'js', 'components', 'getting-started.js')).href;
let GS;
test('load', async () => {
  GS = await import(MOD);
  assert.ok(typeof GS.computeSteps === 'function');
});

const withDevice = [{ id: 'd1' }];
const assignedDevice = [{ id: 'd1', playlist_id: 'p1' }];
/*
 * What a playlist has to look like to satisfy the later steps: filled (item_count) AND published
 * (published_snapshot). Players build their payload from the snapshot with no fallback to the live
 * items, so an unpublished playlist on a screen is a dark screen.
 */
const livePlaylist = [{ id: 'p1', item_count: 1, published_snapshot: '[{}]' }];

test('an empty account is at step one, and step one is the screen', async () => {
  const s = GS.computeSteps({ devices: [], content: [], playlists: [] });
  assert.equal(s.doneCount, 0);
  assert.equal(s.complete, false);
  assert.equal(s.steps[s.nextIndex].key, 'device', 'nothing else is possible until a screen exists');
});

test('progress reflects what is really there, not what was clicked through', async () => {
  const s = GS.computeSteps({ devices: withDevice, content: [{ id: 'c1' }], playlists: [] });
  assert.equal(s.doneCount, 2);
  assert.equal(s.steps[s.nextIndex].key, 'playlist');
});

test('THE POINT: it is only finished when something is actually ON a screen', async () => {
  // Creating a playlist and walking away is the exact failure the report described — plenty of
  // objects, nothing playing. That must NOT read as complete.
  const almost = GS.computeSteps({ devices: withDevice, content: [{ id: 'c1' }], playlists: [{ id: 'p1', item_count: 1 }] });
  assert.equal(almost.complete, false, 'objects exist but no screen is showing anything');
  assert.equal(almost.steps[almost.nextIndex].key, 'assign');

  const done = GS.computeSteps({ devices: assignedDevice, content: [{ id: 'c1' }], playlists: livePlaylist });
  assert.equal(done.complete, true);
  assert.equal(done.nextIndex, -1);
});

test('the screen is only "live" once its playlist is published', async () => {
  /*
   * ⚠️ THIS TEST USED TO SAY "assigning a playlist OR A LAYOUT counts", and both halves were a
   * lie of the same kind default_content_id is below.
   *
   * A player builds its payload from published_snapshot with no fallback to the live items, so a
   * screen pointed at an unpublished playlist shows nothing — while the checklist reported 4 of 4
   * and the banner explaining why ("Devices will show nothing until you publish") sits on the
   * screen's own page. And a layout is a zone arrangement: with no playlist there is nothing to
   * put in the zones, so a layout alone was never "live" either.
   */
  const published = [{ id: 'p', item_count: 1, published_snapshot: '[{}]' }];

  const live = GS.computeSteps({ devices: [{ id: 'x', playlist_id: 'p' }], content: [{ id: 'c' }], playlists: published });
  assert.equal(live.complete, true, 'a published playlist on a screen is the finish line');

  const unpublished = GS.computeSteps({
    devices: [{ id: 'x', playlist_id: 'p' }], content: [{ id: 'c' }],
    playlists: [{ id: 'p', item_count: 1, published_snapshot: null }],
  });
  assert.equal(unpublished.complete, false, 'assigned but never published is a dark screen, not a finished setup');
  assert.equal(unpublished.steps[unpublished.nextIndex].key, 'assign', 'and the step must stay open so the user is still being pointed at it');

  const layoutOnly = GS.computeSteps({ devices: [{ id: 'x', layout_id: 'l' }], content: [{ id: 'c' }], playlists: published });
  assert.equal(layoutOnly.complete, false, 'a layout with no playlist has nothing to play');
});

test('default_content_id does NOT count, because no player reads it', async () => {
  // This test previously asserted the opposite, and it was wrong. Grep the whole tree and
  // default_content appears only in this checklist, the device form, the settings snapshot, the
  // schema and the devices route — never in a socket payload, in assemblePayload, or in any of the
  // four players. Setting it changes nothing on the screen, so counting it told the operator
  // "content assigned" while their display went on showing "waiting for content". A checklist that
  // lies about the one thing it exists to confirm is worse than no checklist.
  const s = GS.computeSteps({ devices: [{ id: 'x', default_content_id: 'c' }], content: [{ id: 'c' }], playlists: [{ id: 'p', item_count: 1, published_snapshot: '[{}]' }] });
  assert.equal(s.complete, false, 'a screen with only default_content is not actually showing anything');
});

test('steps stay in dependency order — never sent somewhere unusable', async () => {
  // Content before a screen exists is not wrong, but it cannot be PUT anywhere, so the next
  // action must remain the screen.
  const s = GS.computeSteps({ devices: [], content: [{ id: 'c1' }], playlists: [{ id: 'p1', item_count: 1 }] });
  assert.equal(s.steps[s.nextIndex].key, 'device');
});

test('it shows while there is work left and hides once finished', async () => {
  GS.undismiss();
  assert.equal(GS.shouldShow(GS.computeSteps({ devices: [], content: [], playlists: [] })), true);
  assert.equal(GS.shouldShow(GS.computeSteps({ devices: assignedDevice, content: [{ id: 'c' }], playlists: livePlaylist })), false,
    'a finished account is never nagged');
});

test('dismissing sticks — it is guidance, not a demand', async () => {
  GS.undismiss();
  const empty = GS.computeSteps({ devices: [], content: [], playlists: [] });
  assert.equal(GS.shouldShow(empty), true);
  GS.dismiss();
  assert.equal(GS.shouldShow(empty), false, 'stays hidden even with everything still to do');
  GS.undismiss();
  assert.equal(GS.shouldShow(empty), true, 'and can be brought back');
});

test('every step offers a way to act on it', async () => {
  const s = GS.computeSteps({ devices: [], content: [], playlists: [] });
  for (const step of s.steps) {
    assert.ok(step.title && step.desc && step.cta, `${step.key} is explained`);
    assert.ok(step.href, `${step.key} goes somewhere`);
  }
});

/*
 * ⚠️ THE CHECKLIST MUST BE ON EVERY PAGE ITS OWN STEPS SEND YOU TO.
 *
 * It used to live only on the dashboard, which made following it a dead end: click "Add some
 * content", land on the Content Library, and the thing that sent you there is gone — no step, no
 * progress, nothing naming what you were in the middle of. Reported as "you kinda get lost".
 *
 * So the steps' hrefs and the set of views that mount it are the same set, and this test is what
 * keeps them that way: adding a step that points somewhere new fails here until that view mounts
 * the checklist too.
 */
test('the checklist lives on the Overview view', async () => {
  // The rebrand consolidated the checklist: it used to repeat on Displays, Playlists and Content.
  // Now it lives once on Overview (#/) with a single global dismissal.
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'overview.js'), 'utf8');
  assert.match(src, /id="ovGettingStarted"/, 'overview needs the checklist host element');
  assert.match(src, /gettingStarted\.mount\(/, 'and it has to mount the checklist into it');
});

test('the views mount it through the shared helper, not their own copy', async () => {
  const fs = require('node:fs');
  for (const view of ['dashboard.js', 'content-library.js', 'playlists.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', view), 'utf8');
    // computeSteps/render/dismiss belong to the component. A view calling them directly is a
    // third copy of "fetch three lists, decide, hide when finished" waiting to drift.
    assert.ok(!/gettingStarted\.(computeSteps|render|dismiss)\(/.test(src),
      `${view} drives the checklist internals itself — use gettingStarted.mount() so there is one copy`);
  }
});

/*
 * ⚠️ NO STEP MAY HAVE A DEAD BUTTON ON ITS OWN PAGE.
 *
 * The CTA falls back to `location.hash = step.href`, and setting the hash to the page you are
 * already on does nothing at all. Only step 1 ever carried an `action`, so on Playlists step 3's
 * "New playlist" button did precisely nothing while the page's own New Playlist button opened the
 * dialog — reported as "it just sits there doing nothing".
 *
 * The invariant: every step declares an action, and the view its href points at handles that
 * action. Add a step without one, or point a step at a view that does not serve it, and this fails.
 */
test('every step points at a real route', async () => {
  // The checklist lives only on Overview now. Steps navigate to the page where the action happens;
  // there are no in-page action handlers to keep in sync across views.
  const fs = require('node:fs');
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'app.js'), 'utf8');

  const s = GS.computeSteps({ devices: [], content: [], playlists: [] });
  for (const step of s.steps) {
    assert.ok(step.href, `step "${step.key}" has no href`);
    assert.ok(step.action, `step "${step.key}" has no action`);
    // The href must be a route the app actually serves.
    assert.ok(app.includes(`'${step.href}'`) || app.includes(`"${step.href}"`),
      `step "${step.key}" points at ${step.href}, which the router does not serve`);
  }
});

test('actions are distinct, so one handler cannot silently answer for another', async () => {
  const s = GS.computeSteps({ devices: [], content: [], playlists: [] });
  const actions = s.steps.map((st) => st.action);
  assert.equal(new Set(actions).size, actions.length, `duplicate step actions: ${actions.join(', ')}`);
});

/*
 * ⚠️ AN EMPTY PLAYLIST IS NOT "CONTENT IN A PLAYLIST".
 *
 * Step 3's own button creates a playlist and lands you on an empty one. Counting that as done
 * marked the step complete and moved the user on to "Send it to the screen" — which puts an empty
 * playlist on a display and shows nothing. The same blank-screen-behind-a-success-message shape as
 * the onboarding publish bug, reached a different way.
 */
test('creating an empty playlist does not tick "put content in a playlist"', async () => {
  const withDevice = [{ id: 'd1' }];
  const empty = GS.computeSteps({ devices: withDevice, content: [{ id: 'c1' }], playlists: [{ id: 'p1', item_count: 0 }] });
  const step3 = empty.steps.find((s) => s.key === 'playlist');
  assert.equal(step3.done, false, 'an empty playlist must not satisfy the step about putting content in one');
  assert.equal(empty.steps[empty.nextIndex].key, 'playlist', 'and it must still be the step being pointed at');
  assert.equal(empty.complete, false);

  // One item is the whole difference.
  const filled = GS.computeSteps({ devices: withDevice, content: [{ id: 'c1' }], playlists: [{ id: 'p1', item_count: 1 }] });
  assert.equal(filled.steps.find((s) => s.key === 'playlist').done, true);
});

test('a playlist shape with no item_count counts as empty, so the checklist nags rather than lies', async () => {
  // The failure direction matters: an unexpected shape must leave a step OPEN (annoying, visible,
  // fixable) rather than mark it done (silent, wrong, and it moves the user past a real gap).
  const s = GS.computeSteps({ devices: [{ id: 'd' }], content: [{ id: 'c' }], playlists: [{ id: 'p' }] });
  assert.equal(s.steps.find((st) => st.key === 'playlist').done, false);
});

test('the checklist is consolidated on Overview, not repeated per view', async () => {
  // The rebrand deliberately removed the per-view checklist mounts (Displays, Playlists, Content,
  // device detail). Repeating it meant four copies of "fetch three lists, decide, hide when
  // finished" drifting apart. One mount on Overview with a global dismissal is the design.
  const fs = require('node:fs');
  for (const view of ['dashboard.js', 'content-library.js', 'playlists.js', 'device-detail.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', view), 'utf8');
    assert.ok(!/gettingStarted\.mount\(/.test(src),
      `${view} mounts the checklist — it should live only on Overview now`);
  }
});

/*
 * The checklist re-reads the account when Overview renders.
 *
 * The checklist lives only on Overview now, so there is no cross-page refresh hook: navigating
 * back to Overview re-mounts it with fresh data. The component keeps a refresh() entry point for
 * in-place updates, and it must re-resolve the host by id (a cached node belongs to a view that
 * has re-rendered).
 */
test('the checklist re-reads the account when Overview renders', async () => {
  const fs = require('node:fs');
  const gs = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'components', 'getting-started.js'), 'utf8');
  assert.match(gs, /export async function refresh\(\)/, 'the component needs a refresh entry point');
  assert.match(gs, /getElementById\('gettingStarted'\)/,
    'refresh must re-resolve the host by id — a cached node belongs to a view that has re-rendered');
  // Overview mounts it on every render, so returning to #/ always shows current progress.
  const overview = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'overview.js'), 'utf8');
  assert.match(overview, /gettingStarted\.mount\(/,
    'Overview must mount the checklist on render, or progress goes stale');
});
