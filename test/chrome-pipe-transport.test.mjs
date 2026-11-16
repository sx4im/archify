import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { ChromeVisualBrowser, CHROME_STARTUP_TIMEOUT_MS } from '../archify/bin/visual-check.mjs';

function chromeChild() {
  const child = new EventEmitter();
  child.pid = 7321;
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = new PassThrough();
  child.stdio = [null, null, child.stderr, new PassThrough(), new PassThrough()];
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => {
      child.emit('exit', null, signal);
      child.emit('close', null, signal);
    });
    return true;
  };
  return child;
}

function browserFor(child) {
  return new ChromeVisualBrowser('/fake/chrome', {
    env: {},
    getuid: () => 1001,
    spawnImpl: () => child,
  });
}

test('Chrome first-command timeout reports the running process, pipe progress and stderr', async (t) => {
  const setTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) =>
    setTimeout(callback, delay === CHROME_STARTUP_TIMEOUT_MS ? 5 : delay, ...args));
  const child = chromeChild();
  const browser = browserFor(child);
  child.stderr.write('Browser initialization is waiting for a service\n');
  try {
    await assert.rejects(browser.sessionPromise, (error) => {
      assert.match(error.message, new RegExp(`Target\\.getTargets: timed out after ${CHROME_STARTUP_TIMEOUT_MS}ms`));
      assert.match(error.message, /Chrome process: still running/);
      assert.match(error.message, /pid=7321/);
      assert.match(error.message, /Node v\d+.*libuv/);
      assert.match(error.message, /completedWrites=1/);
      assert.match(error.message, /receivedBytes=0/);
      assert.match(error.message, /Browser initialization is waiting for a service/);
      return true;
    });
  } finally {
    await browser.close();
  }
});

test('Chrome pipe EOF fails the pending first command without waiting for process close', async () => {
  const child = chromeChild();
  const browser = browserFor(child);
  try {
    const result = assert.rejects(browser.sessionPromise, /Chrome DevTools read pipe failed:.*ended/);
    child.stdio[4].end();
    await Promise.race([
      result,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('pipe EOF did not reject the pending command')), 100);
        timer.unref();
      }),
    ]);
  } finally {
    await browser.close();
  }
});

test('Chrome close releases inherited process pipes after the main process exits', async () => {
  const child = chromeChild();
  const browser = browserFor(child);
  child.exitCode = 0;
  child.emit('exit', 0, null);
  const session = assert.rejects(browser.sessionPromise, /visual-check finished/);
  const first = browser.close();
  const second = browser.close();
  assert.strictEqual(second, first);
  await first;
  await session;
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.stdio[3].destroyed, true);
  assert.equal(child.stdio[4].destroyed, true);
});

test('Chrome visual browser denies downloads before the first inspection', async () => {
  const child = chromeChild();
  const sent = [];
  // Answer each CDP command as it is written, so attach() can run to completion.
  child.stdio[3].on('data', (chunk) => {
    for (const raw of String(chunk).split('\0')) {
      if (!raw) continue;
      const message = JSON.parse(raw);
      sent.push(message);
      let result = {};
      if (message.method === 'Target.getTargets') {
        result = { targetInfos: [{ type: 'page', targetId: 'target-1' }] };
      }
      if (message.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      child.stdio[4].write(`${JSON.stringify({ id: message.id, result })}\0`);
    }
  });
  const browser = browserFor(child);
  try {
    const sessionId = await browser.sessionPromise;
    assert.equal(sessionId, 'session-1');
    const denied = sent.find((message) => message.method === 'Browser.setDownloadBehavior');
    assert.ok(denied, 'expected Browser.setDownloadBehavior to be sent during attach');
    assert.deepEqual(denied.params, { behavior: 'deny' });
    assert.equal(denied.sessionId, undefined);
    // Downloads must be denied before any page work starts.
    const enabled = sent.findIndex((message) => message.method === 'Page.enable');
    assert.ok(sent.indexOf(denied) > enabled);
  } finally {
    await browser.close();
  }
});
