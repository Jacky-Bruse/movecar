const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeKV {
  constructor() {
    this.store = new Map();
  }

  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async put(key, value) {
    this.store.set(key, value);
  }

  async delete(key) {
    this.store.delete(key);
  }
}

function loadWorker(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'movecar.js'), 'utf8');
  const context = {
    console,
    URL,
    Request,
    Response,
    fetch: async () => new Response('{}', { status: 200 }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Math,
    Date,
    JSON,
    Promise,
    TextEncoder,
    TextDecoder,
    MOVE_CAR_STATUS: new FakeKV(),
    addEventListener: () => {},
    ...overrides,
  };

  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

test('check-status only returns waiting state for the same browser session', async () => {
  const worker = loadWorker({ BARK_URL: 'https://example.com/bark' });

  const notifyRequest = new Request('https://example.com/api/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: '挡住出口了',
      sessionId: 'session-a',
    }),
  });

  const notifyResponse = await worker.handleRequest(notifyRequest);
  assert.equal(notifyResponse.status, 200);

  const sameSessionResponse = await worker.handleRequest(
    new Request('https://example.com/api/check-status?s=session-a')
  );
  const sameSessionData = await sameSessionResponse.json();
  assert.equal(sameSessionData.status, 'waiting');

  const otherSessionResponse = await worker.handleRequest(
    new Request('https://example.com/api/check-status?s=session-b')
  );
  const otherSessionData = await otherSessionResponse.json();
  assert.equal(otherSessionData.status, 'none');
});

test('owner confirmation remains recoverable for the originating browser session', async () => {
  const worker = loadWorker({ BARK_URL: 'https://example.com/bark' });

  await worker.handleRequest(
    new Request('https://example.com/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '麻烦挪车',
        sessionId: 'session-a',
      }),
    })
  );

  await worker.handleRequest(
    new Request('https://example.com/api/owner-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: { lat: 31.2, lng: 121.5 },
      }),
    })
  );

  const sameSessionResponse = await worker.handleRequest(
    new Request('https://example.com/api/check-status?s=session-a')
  );
  const sameSessionData = await sameSessionResponse.json();
  assert.equal(sameSessionData.status, 'confirmed');
  assert.ok(sameSessionData.ownerLocation);

  const otherSessionResponse = await worker.handleRequest(
    new Request('https://example.com/api/check-status?s=session-b')
  );
  const otherSessionData = await otherSessionResponse.json();
  assert.equal(otherSessionData.status, 'none');
});

test('notify rejects repeated requests during the server cooldown window', async () => {
  const worker = loadWorker({ BARK_URL: 'https://example.com/bark' });

  const firstResponse = await worker.handleRequest(
    new Request('https://example.com/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '第一次通知',
        sessionId: 'session-a',
      }),
    })
  );
  assert.equal(firstResponse.status, 200);

  const secondResponse = await worker.handleRequest(
    new Request('https://example.com/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '再次通知',
        sessionId: 'session-a',
      }),
    })
  );

  assert.equal(secondResponse.status, 429);
  const secondData = await secondResponse.json();
  assert.equal(secondData.success, false);
  assert.match(secondData.error, /30秒/);
});

test('main page bootstraps browser-local session recovery', () => {
  const worker = loadWorker();

  const response = worker.renderMainPage('https://example.com');
  assert.equal(response.status, 200);

  return response.text().then((html) => {
    assert.match(html, /const SESSION_STORAGE_KEY = 'movecar_session'/);
    assert.match(html, /localStorage\.getItem\(SESSION_STORAGE_KEY\)/);
    assert.match(html, /fetch\('\/api\/check-status\?s=' \+ encodeURIComponent\(sessionId\)\)/);
  });
});

test('main page clears stale browser session when status is gone', () => {
  const worker = loadWorker();

  const response = worker.renderMainPage('https://example.com');
  assert.equal(response.status, 200);

  return response.text().then((html) => {
    assert.match(html, /if \(!data\.status \|\| data\.status === 'none'\)/);
    assert.match(html, /localStorage\.removeItem\(SESSION_STORAGE_KEY\)/);
  });
});
