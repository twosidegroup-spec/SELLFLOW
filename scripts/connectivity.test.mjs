/**
 * Connectivity state tests.
 *
 * The behaviour worth protecting here is the EDGE, not the value. React
 * Native's network listener re-fires with the same boolean whenever an interface
 * renegotiates -- switching between Wi-Fi and mobile data, or a VPN cycling --
 * so a store that treats "set online to true" as a reconnect will announce
 * recovery repeatedly and fire a success haptic every few seconds. Only a real
 * offline -> online transition may acknowledge anything.
 *
 * This is also the contract behind the offline banner: a seller must never be
 * told they are online while they are not, and must never be left unsure
 * whether their queued orders went through.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { useConnectivity, RECONNECT_NOTICE_MS } from '../src/lib/connectivity.ts';

const state = () => useConnectivity.getState();

function reset() {
  useConnectivity.setState({ online: true, syncState: 'idle', justReconnected: false });
}

test('starts online and idle, so a good connection never flashes offline', () => {
  reset();
  assert.equal(state().online, true);
  assert.equal(state().syncState, 'idle');
  assert.equal(state().justReconnected, false, 'a cold start is not a recovery');
});

test('losing the connection downgrades the sync state to offline', () => {
  reset();
  state().setOnline(false);
  assert.equal(state().online, false);
  assert.equal(state().syncState, 'offline');
});

test('going offline never masks an in-progress sync', () => {
  reset();
  state().setSyncState('syncing');
  state().setOnline(false);
  assert.equal(
    state().syncState,
    'syncing',
    'clobbering an active sync with "offline" would stop the UI admitting it is still working',
  );
});

test('a genuine offline -> online transition is acknowledged', () => {
  reset();
  state().setOnline(false);
  state().setOnline(true);
  assert.equal(state().online, true);
  assert.equal(state().justReconnected, true, 'recovery must be visible, not silent');
  assert.equal(state().syncState, 'idle');
});

test('re-reporting the same online value is NOT a reconnect', () => {
  // The bug this guards: expo-network re-fires with the same value on an
  // interface change, which produced an endless "Back online" banner and a
  // success haptic every few seconds.
  reset();
  state().setOnline(true);
  state().setOnline(true);
  state().setOnline(true);
  assert.equal(state().justReconnected, false, 'repeating the same value must stay silent');
});

test('re-reporting the same offline value does not fabricate a recovery', () => {
  reset();
  state().setOnline(false);
  state().setOnline(false);
  assert.equal(state().online, false);
  assert.equal(state().justReconnected, false);
});

test('a flapping link does not celebrate recovery twice', () => {
  reset();
  state().setOnline(false);
  state().setOnline(true);
  assert.equal(state().justReconnected, true);

  // Drops again immediately, then returns. The second return is a real recovery
  // and may be acknowledged, but the flag must not have survived the drop --
  // otherwise a success haptic fires while the seller is actually offline.
  state().setOnline(false);
  assert.equal(
    state().justReconnected,
    false,
    'a stale recovery flag would fire a success haptic while still offline',
  );

  state().setOnline(true);
  assert.equal(state().justReconnected, true);
});

test('the recovery notice can be dismissed', () => {
  reset();
  state().setOnline(false);
  state().setOnline(true);
  assert.equal(state().justReconnected, true);
  state().acknowledgeReconnect();
  assert.equal(state().justReconnected, false, 'the banner must not sit there saying "Back online"');
});

test('the recovery notice window is short enough to be a moment', () => {
  assert.ok(
    RECONNECT_NOTICE_MS >= 2000 && RECONNECT_NOTICE_MS <= 6000,
    `expected a brief confirmation, got ${RECONNECT_NOTICE_MS}ms`,
  );
});

test('a full offline -> online cycle preserves queued work', () => {
  reset();
  useConnectivity.setState({
    pending: [
      { id: 'm1', kind: 'create_order', summary: 'Order with 1 item', payload: {}, attempts: 0 },
    ],
  });

  state().setOnline(false);
  // Still queued while offline: the seller has not lost the work.
  assert.equal(state().pending.length, 1);
  assert.equal(state().online, false);

  state().setOnline(true);
  assert.equal(state().pending.length, 1, 'reconnecting must not discard queued changes');
  assert.equal(state().justReconnected, true);

  useConnectivity.setState({ pending: [] });
});