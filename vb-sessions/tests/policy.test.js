'use strict';

// Verifies that the policy overlay HTML contains the required legal terms.
// Reads vb-sessions/index.html directly and checks for key phrases.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const html  = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'),    'utf8');

function check(source, phrase, description) {
  assert(source.toLowerCase().includes(phrase.toLowerCase()),
    `Policy missing required term: ${description} ("${phrase}")`);
  console.log(`PASS  ${description}`);
}

check(html,  'cancellation',   'cancellation policy (in index.html)');
check(html,  '24 hour',        '24-hour no-refund rule (in index.html)');
check(html,  'refund',         'refund policy (in index.html)');
check(html,  'waiting list',   'waiting list rules (in index.html)');
check(html,  'gdpr',           'GDPR / data usage (in index.html)');
check(html,  'personal data',  'personal data mention (in index.html)');
check(html,  'organiser',      'session cancellation by organiser (in index.html)');
check(html,  'policy-overlay', 'policy overlay element exists (in index.html)');
check(appJs, 'openPolicy',     'openPolicy function defined (in app.js)');

console.log('\nAll policy tests passed.');
