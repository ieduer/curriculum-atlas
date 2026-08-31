import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const security = await readFile(new URL('../src/security.ts', import.meta.url), 'utf8');
const client = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('anonymous comments keep fresh Turnstile and bind exact production context', () => {
  assert.match(security, /TURNSTILE_EXPECTED_HOSTNAME = 'curriculum\.bdfz\.net'/);
  assert.match(security, /TURNSTILE_COMMENT_ACTION = 'curriculum_comment'/);
  assert.match(security, /result\.hostname !== TURNSTILE_EXPECTED_HOSTNAME/);
  assert.match(security, /result\.action !== TURNSTILE_COMMENT_ACTION/);
  assert.match(security, /TURNSTILE_TIMEOUT_MS = 8_000/);
  assert.match(client, /action: 'curriculum_comment'/);
  assert.match(client, /appearance: 'interaction-only'/);
  assert.doesNotMatch(security, /Set-Cookie|Max-Age/);
});
