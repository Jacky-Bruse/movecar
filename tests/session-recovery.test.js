const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeKV {
  constructor(options = {}) {
    this.store = new Map();
    this.minExpirationTtl = options.minExpirationTtl ?? 0;
  }

  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async put(key, value, options = {}) {
    if (
      options.expirationTtl != null &&
      this.minExpirationTtl > 0 &&
      options.expirationTtl < this.minExpirationTtl
    ) {
      throw new Error(
        `KV PUT failed: 400 Invalid expiration_ttl of ${options.expirationTtl}. Expiration TTL must be at least ${this.minExpirationTtl}.`
      );
    }
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
    crypto: globalThis.crypto,
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

  const ownerToken = await worker.MOVE_CAR_STATUS.get('owner_token');

  await worker.handleRequest(
    new Request('https://example.com/api/owner-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: { lat: 31.2, lng: 121.5 },
        token: ownerToken,
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

test('notify uses Cloudflare-compatible KV ttl for cooldown storage', async () => {
  const worker = loadWorker({
    BARK_URL: 'https://example.com/bark',
    MOVE_CAR_STATUS: new FakeKV({ minExpirationTtl: 60 }),
  });

  const response = await worker.handleRequest(
    new Request('https://example.com/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '第一次通知',
        sessionId: 'session-a',
      }),
    })
  );

  assert.equal(response.status, 200);
});

test('server cooldown expires after 30 seconds even if KV key still exists', async () => {
  let fakeNow = 1_700_000_000_000;
  const worker = loadWorker({
    BARK_URL: 'https://example.com/bark',
    Date: class extends Date {
      static now() {
        return fakeNow;
      }
    },
  });

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

  fakeNow += 31_000;

  const secondResponse = await worker.handleRequest(
    new Request('https://example.com/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '31秒后的通知',
        sessionId: 'session-a',
      }),
    })
  );

  assert.equal(secondResponse.status, 200);
});

test('owner endpoints reject requests without a valid token', async () => {
  const worker = loadWorker({ BARK_URL: 'https://example.com/bark' });

  await worker.handleRequest(
    new Request('https://example.com/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '麻烦挪车',
        sessionId: 'session-a',
        location: { lat: 31.2, lng: 121.5 },
      }),
    })
  );

  const pageResponse = await worker.handleRequest(
    new Request('https://example.com/owner-confirm')
  );
  assert.equal(pageResponse.status, 403);

  const locationResponse = await worker.handleRequest(
    new Request('https://example.com/api/get-location?t=wrong-token')
  );
  assert.equal(locationResponse.status, 403);

  const confirmResponse = await worker.handleRequest(
    new Request('https://example.com/api/owner-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: null, token: 'wrong-token' }),
    })
  );
  assert.equal(confirmResponse.status, 403);

  const ownerToken = await worker.MOVE_CAR_STATUS.get('owner_token');
  assert.ok(ownerToken);

  const validPageResponse = await worker.handleRequest(
    new Request(`https://example.com/owner-confirm?t=${ownerToken}`)
  );
  assert.equal(validPageResponse.status, 200);

  const validLocationResponse = await worker.handleRequest(
    new Request(`https://example.com/api/get-location?t=${ownerToken}`)
  );
  assert.equal(validLocationResponse.status, 200);
});

test('notify clears stale locations from the previous request', async () => {
  const worker = loadWorker({ BARK_URL: 'https://example.com/bark' });
  const kv = worker.MOVE_CAR_STATUS;

  await kv.put('requester_location', JSON.stringify({ lat: 1, lng: 1 }));
  await kv.put('owner_location', JSON.stringify({ lat: 2, lng: 2 }));

  const response = await worker.handleRequest(
    new Request('https://example.com/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '无位置通知',
        sessionId: 'session-a',
      }),
    })
  );
  assert.equal(response.status, 200);

  assert.equal(await kv.get('requester_location'), null);
  assert.equal(await kv.get('owner_location'), null);
});

test('owner eta response and distance surface in check-status', async () => {
  const worker = loadWorker({ BARK_URL: 'https://example.com/bark' });

  await worker.handleRequest(
    new Request('https://example.com/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '麻烦挪车',
        sessionId: 'session-a',
        location: { lat: 31.2, lng: 121.5 },
      }),
    })
  );

  const ownerToken = await worker.MOVE_CAR_STATUS.get('owner_token');

  await worker.handleRequest(
    new Request('https://example.com/api/owner-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: { lat: 31.21, lng: 121.5 },
        token: ownerToken,
        response: '5',
      }),
    })
  );

  const statusResponse = await worker.handleRequest(
    new Request('https://example.com/api/check-status?s=session-a')
  );
  const data = await statusResponse.json();

  assert.equal(data.status, 'confirmed');
  assert.equal(data.response, '5');
  // 纬度差 0.01° ≈ 1112 米
  assert.ok(data.distanceMeters > 1000 && data.distanceMeters < 1300);
});

test('invalid owner response values are stored as null', async () => {
  const worker = loadWorker({ BARK_URL: 'https://example.com/bark' });

  await worker.handleRequest(
    new Request('https://example.com/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '挪车', sessionId: 'session-a' }),
    })
  );

  const ownerToken = await worker.MOVE_CAR_STATUS.get('owner_token');

  await worker.handleRequest(
    new Request('https://example.com/api/owner-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: null, token: ownerToken, response: '<script>' }),
    })
  );

  const statusResponse = await worker.handleRequest(
    new Request('https://example.com/api/check-status?s=session-a')
  );
  const data = await statusResponse.json();

  assert.equal(data.status, 'confirmed');
  assert.equal(data.response, null);
  assert.equal(data.distanceMeters, null);
});

test('telegram push sends rich message with inline buttons and location pin', async () => {
  const calls = [];
  const worker = loadWorker({
    NOTIFY_CHANNEL: 'telegram',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHAT_ID: '123456',
    AMAP_KEY: 'test-amap-key',
    fetch: async (url, options) => {
      calls.push({
        url: String(url),
        body: options && options.body ? JSON.parse(options.body) : null,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  const response = await worker.handleRequest(
    new Request('https://example.com/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '挡住出口了',
        sessionId: 'session-a',
        location: { lat: 31.2, lng: 121.5 },
      }),
    })
  );
  assert.equal(response.status, 200);

  const photoCall = calls.find(c => c.url.includes('/sendPhoto'));
  assert.ok(photoCall, 'should send an amap static map preview');
  assert.match(photoCall.body.photo, /restapi\.amap\.com\/v3\/staticmap/);
  assert.match(photoCall.body.photo, /key=test-amap-key/);
  // 预览用 GCJ-02 坐标（已偏移），不等于原始 WGS-84 经度
  assert.doesNotMatch(photoCall.body.photo, /location=121\.5,/);

  const messageCall = calls.find(c => c.url.includes('/sendMessage'));
  assert.ok(messageCall, 'should send the main message');
  assert.equal(messageCall.body.parse_mode, 'MarkdownV2');
  assert.equal(messageCall.body.disable_web_page_preview, true);
  assert.match(messageCall.body.text, />挡住出口了/);

  const keyboard = messageCall.body.reply_markup.inline_keyboard;
  assert.equal(keyboard.length, 2);
  assert.match(keyboard[0][0].url, /uri\.amap\.com/);
  assert.match(keyboard[1][0].url, /owner-confirm\?t=/);
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
