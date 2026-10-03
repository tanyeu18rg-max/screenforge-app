'use strict';

/*
 * The Enterprise (quote-only) plan on the marketing page.
 *
 * The rebranded landing page carries three static plan cards. The Enterprise card must say
 * "Custom" — never "$0" or "Free", which is what a naive rendering of a zero-price plan produces
 * and what the old dynamic grid had to explicitly guard against.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LANDING = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'landing.html'), 'utf8'
);

test('the Enterprise card asks for contact, not a $0 price', () => {
  const cards = LANDING.split('<div class="price-card').slice(1);
  const enterprise = cards.find((c) => c.includes('<h3>Enterprise</h3>'));
  assert.ok(enterprise, 'Enterprise card exists');
  const price = (enterprise.match(/class="price">(.*?)<\/div>/) || [])[1] || '';
  assert.ok(price.includes('Custom'), `Enterprise price must be Custom, got: ${price}`);
  assert.ok(!price.includes('$0'), 'Enterprise must not render as $0');
  assert.ok(!/>\s*Free\s*</.test(enterprise), 'Enterprise must not render as Free');
  assert.ok(enterprise.includes('Contact sales'), 'Enterprise card has the sales CTA');
});
