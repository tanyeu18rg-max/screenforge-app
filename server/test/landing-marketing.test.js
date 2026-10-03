'use strict';

/*
 * The marketing landing page (rewritten for the Kardinal Screens rebrand).
 *
 * The page that converts, so the tests here are about what must NOT change:
 * the page must not contradict itself on price, the "Most Popular" flag must
 * sit on a NAMED plan (not a positional index), and the product name must be
 * Kardinal Screens throughout.
 *
 * Unlike the pre-rebrand page (which rendered pricing from
 * /api/subscription/plans at runtime), the rebranded page carries three
 * static plan cards. The tests read the committed HTML directly.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LANDING = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'landing.html'), 'utf8'
);

const cardsOf = (html) => html.split('<div class="price-card').slice(1);
const textOf = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');

test('the page names Kardinal Screens and never the old product name', () => {
  assert.ok(LANDING.includes('Kardinal Screens'), 'product name present');
  assert.ok(!LANDING.includes('ScreenTinker'), 'old product name gone');
  assert.ok(!LANDING.includes('ScreenForge'), 'intermediate product name gone');
});

test('three plan cards with the published prices', () => {
  const cards = cardsOf(LANDING);
  assert.equal(cards.length, 3, 'Starter, Professional, Enterprise');
  const text = cards.map(textOf).join('\n');
  assert.ok(text.includes('Starter'), 'Starter card');
  assert.ok(text.includes('Professional'), 'Professional card');
  assert.ok(text.includes('Enterprise'), 'Enterprise card');
  assert.ok(text.includes('$29'), 'Starter price');
  assert.ok(text.includes('$79'), 'Professional price');
  assert.ok(text.includes('Custom'), 'Enterprise price');
});

test('"Most Popular" is on the named Professional plan, not a positional index', () => {
  const cards = cardsOf(LANDING);
  const flagged = cards.filter((c) => c.includes('Most popular'));
  assert.equal(flagged.length, 1, 'exactly one card carries the flag');
  assert.ok(textOf(flagged[0]).includes('Professional'),
    'the flag is on Professional by name, not by position');
});

test('headline prices are monthly figures', () => {
  const cards = cardsOf(LANDING);
  for (const card of cards) {
    const price = (card.match(/class="price">(.*?)<\/div>/) || [])[1] || '';
    if (price.includes('Custom')) continue; // Enterprise has no figure
    assert.ok(price.includes('/mo'), `price is monthly: ${textOf(price)}`);
  }
  assert.ok(LANDING.includes('billed monthly'), 'billing period stated');
});

test('per-screen counts are consistent between cards and copy', () => {
  const text = textOf(LANDING);
  assert.ok(text.includes('3 screens'), 'Starter screen count');
  assert.ok(text.includes('15 screens'), 'Professional screen count');
  assert.ok(text.includes('Unlimited screens'), 'Enterprise screen count');
});

test('the things that convert are all still on the page', () => {
  assert.ok(LANDING.includes('#/register'), 'signup link present');
  assert.ok(LANDING.includes('Start free trial'), 'trial CTA present');
  assert.ok(LANDING.includes('Contact sales'), 'enterprise CTA present');
  assert.ok(LANDING.includes('#pricing'), 'pricing anchor reachable from nav/hero');
  assert.ok(LANDING.includes('14-day free trial') || LANDING.includes('14 days'),
    'trial terms stated');
});

test('the hero keeps its headline', () => {
  assert.ok(LANDING.includes('Digital signage for every screen.'),
    'hero headline present');
});
