addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const CONFIG = { KV_TTL: 3600 }

async function handleRequest(request) {
  const url = new URL(request.url)
  const path = url.pathname

  if (path === '/api/notify' && request.method === 'POST') {
    return handleNotify(request, url);
  }

  if (path === '/api/get-location') {
    return handleGetLocation();
  }

  if (path === '/api/owner-confirm' && request.method === 'POST') {
    return handleOwnerConfirmAction(request);
  }

  if (path === '/api/check-status') {
    const status = await MOVE_CAR_STATUS.get('notify_status');
    const ownerLocation = await MOVE_CAR_STATUS.get('owner_location');
    const error = await MOVE_CAR_STATUS.get('notify_error');

    let parsedOwnerLocation = null;
    if (ownerLocation) {
      try {
        parsedOwnerLocation = JSON.parse(ownerLocation);
      } catch (e) {
        parsedOwnerLocation = null;
      }
    }

    return new Response(JSON.stringify({
      status: status || 'waiting',
      ownerLocation: parsedOwnerLocation,
      error: error || null
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      }
    });
  }

  if (path === '/owner-confirm') {
    return renderOwnerPage();
  }

  return renderMainPage(url.origin);
}

// WGS-84 转 GCJ-02 (中国国测局坐标系)
function wgs84ToGcj02(lat, lng) {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;

  if (outOfChina(lat, lng)) return { lat, lng };

  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

function generateMapUrls(lat, lng) {
  const gcj = wgs84ToGcj02(lat, lng);
  return {
    amapUrl: `https://uri.amap.com/marker?position=${gcj.lng},${gcj.lat}&name=位置`,
    appleUrl: `https://maps.apple.com/?ll=${gcj.lat},${gcj.lng}&q=位置`  // Apple Maps（中国大陆）使用 GCJ-02 坐标
  };
}

// 多渠道推送通知（支持逗号分隔配置多个渠道）
async function sendNotification(channelConfig, content, confirmUrl) {
  const channels = channelConfig.split(',').map(c => c.trim().toLowerCase()).filter(c => c);

  if (channels.length === 0) {
    channels.push('bark'); // 默认使用 bark
  }

  const results = await Promise.allSettled(
    channels.map(channel => {
      switch (channel) {
        case 'wxpusher':
          if (typeof WXPUSHER_TOKEN === 'undefined' || typeof WXPUSHER_UID === 'undefined') {
            return Promise.reject(new Error('WxPusher 未配置: 请设置 WXPUSHER_TOKEN 和 WXPUSHER_UID'));
          }
          return sendWxPusher(content, confirmUrl);
        case 'telegram':
          if (typeof TELEGRAM_BOT_TOKEN === 'undefined' || typeof TELEGRAM_CHAT_ID === 'undefined') {
            return Promise.reject(new Error('Telegram 未配置: 请设置 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID'));
          }
          return sendTelegram(content, confirmUrl);
        case 'bark':
          if (typeof BARK_URL === 'undefined') {
            return Promise.reject(new Error('Bark 未配置: 请设置 BARK_URL'));
          }
          return sendBark(content, confirmUrl);
        default:
          return Promise.reject(new Error(`未知渠道: ${channel}`));
      }
    })
  );

  // 检查是否至少有一个成功
  const hasSuccess = results.some(r => r.status === 'fulfilled');
  if (!hasSuccess) {
    const errors = results.map(r => r.reason?.message || 'Unknown error').join('; ');
    throw new Error(`所有渠道推送失败: ${errors}`);
  }

  return results;
}

// Bark 推送 (iOS)
async function sendBark(content, confirmUrl) {
  const barkApiUrl = `${BARK_URL}/挪车请求/${encodeURIComponent(content)}?group=MoveCar&level=critical&call=1&sound=minuet&icon=https://cdn-icons-png.flaticon.com/512/741/741407.png&url=${confirmUrl}`;
  const response = await fetch(barkApiUrl);
  if (!response.ok) throw new Error('Bark API Error');
  return response;
}

// WxPusher 推送 (微信)
async function sendWxPusher(content, confirmUrl) {
  const message = content.replace(/\\n/g, '\n');
  const jumpUrl = decodeURIComponent(confirmUrl);

  const response = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appToken: WXPUSHER_TOKEN,
      content: message,
      summary: '🚗 挪车请求',
      contentType: 1,  // 1=文本
      uids: [WXPUSHER_UID],
      url: jumpUrl  // 点击消息直接跳转确认页面
    })
  });

  const result = await response.json();
  if (result.code !== 1000) throw new Error('WxPusher API Error: ' + result.msg);
  return result;
}

// Telegram Bot 推送
async function sendTelegram(content, confirmUrl) {
  // 转义 MarkdownV2 特殊字符，避免用户留言导致解析错误
  const escapeMarkdownV2 = (text) => {
    return text.replace(/([_*\[\]()~`>#+=|{}.!\\-])/g, '\\$1');
  };

  const escapeMarkdownV2Url = (url) => {
    return url.replace(/([\\)])/g, '\\$1');
  };

  const escapedContent = escapeMarkdownV2(content.replace(/\\n/g, '\n'));
  const jumpUrl = escapeMarkdownV2Url(decodeURIComponent(confirmUrl));
  const message = `${escapedContent}\n\n👉 [点击确认挪车](${jumpUrl})`;

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: false
    })
  });

  const result = await response.json();
  if (!result.ok) throw new Error('Telegram API Error: ' + result.description);
  return response;
}

async function handleNotify(request, url) {
  try {
    const body = await request.json();
    const message = body.message || '车旁有人等待';
    const location = body.location || null;

    const confirmUrl = encodeURIComponent(url.origin + '/owner-confirm');

    let notifyBody = '🚗 挪车请求';
    if (message) notifyBody += `\\n💬 留言: ${message}`;

    if (location && location.lat && location.lng) {
      const urls = generateMapUrls(location.lat, location.lng);
      notifyBody += '\\n📍 已附带位置信息，点击查看';

      await MOVE_CAR_STATUS.put('requester_location', JSON.stringify({
        lat: location.lat,
        lng: location.lng,
        ...urls
      }), { expirationTtl: CONFIG.KV_TTL });
    } else {
      notifyBody += '\\n⚠️ 未提供位置信息';
    }

    await MOVE_CAR_STATUS.delete('notify_error').catch(() => {});
    await MOVE_CAR_STATUS.put('notify_status', 'waiting', { expirationTtl: CONFIG.KV_TTL });

    // 根据配置的渠道发送通知
    const channel = typeof NOTIFY_CHANNEL !== 'undefined' ? NOTIFY_CHANNEL : 'bark';
    await sendNotification(channel, notifyBody, confirmUrl);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    const errorMessage = (error && error.message) ? error.message : 'Unknown error';
    await MOVE_CAR_STATUS.put('notify_status', 'error', { expirationTtl: CONFIG.KV_TTL }).catch(() => {});
    await MOVE_CAR_STATUS.put('notify_error', errorMessage, { expirationTtl: CONFIG.KV_TTL }).catch(() => {});
    return new Response(JSON.stringify({ success: false, error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleGetLocation() {
  const data = await MOVE_CAR_STATUS.get('requester_location');
  if (data) {
    return new Response(data, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      }
    });
  }
  return new Response(JSON.stringify({ error: 'No location' }), {
    status: 404,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

async function handleOwnerConfirmAction(request) {
  try {
    const body = await request.json();
    const ownerLocation = body.location || null;

    if (ownerLocation && ownerLocation.lat && ownerLocation.lng) {
      const urls = generateMapUrls(ownerLocation.lat, ownerLocation.lng);
      await MOVE_CAR_STATUS.put('owner_location', JSON.stringify({
        lat: ownerLocation.lat,
        lng: ownerLocation.lng,
        ...urls,
        timestamp: Date.now()
      }), { expirationTtl: CONFIG.KV_TTL });
    }

    await MOVE_CAR_STATUS.delete('notify_error').catch(() => {});
    await MOVE_CAR_STATUS.put('notify_status', 'confirmed', { expirationTtl: CONFIG.KV_TTL });
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    const errorMessage = (error && error.message) ? error.message : 'Unknown error';
    await MOVE_CAR_STATUS.put('notify_status', 'error', { expirationTtl: CONFIG.KV_TTL }).catch(() => {});
    await MOVE_CAR_STATUS.put('notify_error', errorMessage, { expirationTtl: CONFIG.KV_TTL }).catch(() => {});
    return new Response(JSON.stringify({ success: false, error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

function renderMainPage(origin) {
  const phone = typeof PHONE_NUMBER !== 'undefined' ? PHONE_NUMBER : '';

  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#0093E9">
    <title>通知车主挪车</title>
    <style>
      :root {
        --sat: env(safe-area-inset-top, 0px);
        --sar: env(safe-area-inset-right, 0px);
        --sab: env(safe-area-inset-bottom, 0px);
        --sal: env(safe-area-inset-left, 0px);
      }
      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
      html {
        font-size: 16px;
        -webkit-text-size-adjust: 100%;
      }
      html, body { height: 100%; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
        background: linear-gradient(160deg, #0093E9 0%, #80D0C7 100%);
        min-height: 100vh;
        min-height: -webkit-fill-available;
        padding: clamp(16px, 4vw, 24px);
        padding-top: calc(clamp(16px, 4vw, 24px) + var(--sat));
        padding-bottom: calc(clamp(16px, 4vw, 24px) + var(--sab));
        padding-left: calc(clamp(16px, 4vw, 24px) + var(--sal));
        padding-right: calc(clamp(16px, 4vw, 24px) + var(--sar));
        display: flex;
        justify-content: center;
        align-items: flex-start;
      }
      body::before {
        content: ''; position: fixed; inset: 0;
        background: url("data:image/svg+xml,%3Csvg width='52' height='26' viewBox='0 0 52 26' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.1'%3E%3Cpath d='M10 10c0-2.21-1.79-4-4-4-3.314 0-6-2.686-6-6h2c0 2.21 1.79 4 4 4 3.314 0 6 2.686 6 6 0 2.21 1.79 4 4 4 3.314 0 6 2.686 6 6 0 2.21 1.79 4 4 4v2c-3.314 0-6-2.686-6-6 0-2.21-1.79-4-4-4-3.314 0-6-2.686-6-6zm25.464-1.95l8.486 8.486-1.414 1.414-8.486-8.486 1.414-1.414z' /%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
        z-index: -1;
      }

      .container {
        width: 100%;
        max-width: 500px;
        display: flex;
        flex-direction: column;
        gap: clamp(12px, 3vw, 20px);
      }

      .card {
        background: rgba(255, 255, 255, 0.95);
        border-radius: clamp(20px, 5vw, 28px);
        padding: clamp(18px, 4vw, 28px);
        box-shadow: 0 10px 40px rgba(0, 147, 233, 0.2);
        transition: transform 0.2s ease;
      }
      @media (hover: hover) {
        .card:hover { transform: translateY(-2px); }
      }
      .card:active { transform: scale(0.98); }

      .header {
        text-align: center;
        padding: clamp(20px, 5vw, 32px) clamp(16px, 4vw, 28px);
        background: white;
      }
      .icon-wrap {
        width: clamp(72px, 18vw, 100px);
        height: clamp(72px, 18vw, 100px);
        background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%);
        border-radius: clamp(22px, 5vw, 32px);
        display: flex; align-items: center; justify-content: center;
        margin: 0 auto clamp(14px, 3vw, 24px);
        box-shadow: 0 12px 32px rgba(0, 147, 233, 0.35);
      }
      .icon-wrap span { font-size: clamp(36px, 9vw, 52px); }
      .header h1 {
        font-size: clamp(22px, 5.5vw, 30px);
        font-weight: 700;
        color: #1a202c;
        margin-bottom: 6px;
      }
      .header p {
        font-size: clamp(13px, 3.5vw, 16px);
        color: #718096;
        font-weight: 500;
      }

      .input-card { padding: 0; overflow: hidden; }
      .input-card textarea {
        width: 100%;
        min-height: clamp(90px, 20vw, 120px);
        border: none;
        padding: clamp(16px, 4vw, 24px);
        font-size: clamp(15px, 4vw, 18px);
        font-family: inherit;
        resize: none;
        outline: none;
        color: #2d3748;
        background: transparent;
        line-height: 1.5;
      }
      .input-card textarea::placeholder { color: #a0aec0; }
      .tags {
        display: flex;
        gap: clamp(6px, 2vw, 10px);
        padding: 0 clamp(12px, 3vw, 20px) clamp(14px, 3vw, 20px);
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
      }
      .tags::-webkit-scrollbar { display: none; }
      .tag {
        background: linear-gradient(135deg, #e0f7fa 0%, #b2ebf2 100%);
        color: #00796b;
        padding: clamp(8px, 2vw, 12px) clamp(12px, 3vw, 18px);
        border-radius: 20px;
        font-size: clamp(13px, 3.5vw, 15px);
        font-weight: 600;
        white-space: nowrap;
        cursor: pointer;
        transition: all 0.2s;
        border: 1px solid #80cbc4;
        min-height: 44px;
        display: flex;
        align-items: center;
      }
      .tag:active { transform: scale(0.95); background: #80cbc4; }

      .loc-card {
        display: flex;
        align-items: center;
        gap: clamp(10px, 3vw, 16px);
        padding: clamp(14px, 3.5vw, 22px) clamp(16px, 4vw, 24px);
        cursor: pointer;
        min-height: 64px;
      }
      .loc-icon {
        width: clamp(44px, 11vw, 56px);
        height: clamp(44px, 11vw, 56px);
        border-radius: clamp(14px, 3.5vw, 18px);
        display: flex; align-items: center; justify-content: center;
        font-size: clamp(22px, 5.5vw, 28px);
        transition: all 0.3s;
        flex-shrink: 0;
      }
      .loc-icon.loading { background: #fff3cd; }
      .loc-icon.success { background: #d4edda; }
      .loc-icon.error { background: #f8d7da; }
      .loc-content { flex: 1; min-width: 0; }
      .loc-title {
        font-size: clamp(15px, 4vw, 18px);
        font-weight: 600;
        color: #2d3748;
      }
      .loc-status {
        font-size: clamp(12px, 3.2vw, 14px);
        color: #718096;
        margin-top: 3px;
      }
      .loc-status.success { color: #28a745; }
      .loc-status.error { color: #dc3545; }
      .loc-retry-btn {
        color: #0093E9;
        text-decoration: underline;
        cursor: pointer;
        margin-left: 8px;
        font-weight: 600;
      }
      .loc-refresh {
        font-size: clamp(20px, 5vw, 26px);
        color: #a0aec0;
        flex-shrink: 0;
      }

      .btn-main {
        background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%);
        color: white;
        border: none;
        padding: clamp(16px, 4vw, 22px);
        border-radius: clamp(16px, 4vw, 22px);
        font-size: clamp(16px, 4.2vw, 20px);
        font-weight: 700;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center; gap: 10px;
        box-shadow: 0 10px 30px rgba(0, 147, 233, 0.35);
        transition: all 0.2s;
        min-height: 56px;
      }
      .btn-main:active { transform: scale(0.98); }
      .btn-main:disabled {
        background: linear-gradient(135deg, #94a3b8 0%, #64748b 100%);
        box-shadow: none;
        cursor: not-allowed;
      }

      .toast {
        position: fixed;
        top: calc(20px + var(--sat));
        left: 50%;
        transform: translateX(-50%) translateY(-100px);
        background: white;
        padding: clamp(12px, 3vw, 16px) clamp(20px, 5vw, 32px);
        border-radius: 16px;
        font-size: clamp(14px, 3.5vw, 16px);
        font-weight: 600;
        color: #2d3748;
        box-shadow: 0 10px 40px rgba(0,0,0,0.15);
        opacity: 0;
        transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        z-index: 100;
        max-width: calc(100vw - 40px);
      }
      .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

      #successView { display: none; }
      .success-card {
        text-align: center;
        background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%);
        border: 2px solid #28a745;
      }
      .success-icon {
        font-size: clamp(56px, 14vw, 80px);
        margin-bottom: clamp(12px, 3vw, 20px);
        display: block;
      }
      .success-card h2 {
        color: #155724;
        margin-bottom: 8px;
        font-size: clamp(20px, 5vw, 28px);
      }
      .success-card p {
        color: #1e7e34;
        font-size: clamp(14px, 3.5vw, 16px);
      }

      .owner-card {
        background: white;
        border: 2px solid #80D0C7;
        text-align: center;
      }
      .owner-card.hidden { display: none; }
      .owner-card h3 {
        color: #0093E9;
        margin-bottom: 8px;
        font-size: clamp(18px, 4.5vw, 22px);
      }
      .owner-card p {
        color: #718096;
        margin-bottom: 16px;
        font-size: clamp(14px, 3.5vw, 16px);
      }
      .owner-card .map-links {
        display: flex;
        gap: clamp(8px, 2vw, 14px);
        flex-wrap: wrap;
      }
      .owner-card .map-btn {
        flex: 1;
        min-width: 120px;
        padding: clamp(12px, 3vw, 16px);
        border-radius: clamp(12px, 3vw, 16px);
        text-decoration: none;
        font-weight: 600;
        font-size: clamp(13px, 3.5vw, 15px);
        text-align: center;
        min-height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .map-btn.amap { background: #1890ff; color: white; }
      .map-btn.apple { background: #1d1d1f; color: white; }

      .action-card {
        display: flex;
        flex-direction: column;
        gap: clamp(10px, 2.5vw, 14px);
      }
      .action-hint {
        text-align: center;
        font-size: clamp(13px, 3.5vw, 15px);
        color: #718096;
        margin-bottom: 4px;
      }
      .btn-retry, .btn-phone {
        color: white;
        border: none;
        padding: clamp(14px, 3.5vw, 18px);
        border-radius: clamp(14px, 3.5vw, 18px);
        font-size: clamp(15px, 4vw, 17px);
        font-weight: 700;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        transition: all 0.2s;
        min-height: 52px;
        text-decoration: none;
      }
      .btn-retry {
        background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
        box-shadow: 0 8px 24px rgba(245, 158, 11, 0.3);
      }
      .btn-retry:active { transform: scale(0.98); }
      .btn-retry:disabled {
        background: linear-gradient(135deg, #9ca3af 0%, #6b7280 100%);
        box-shadow: none;
        cursor: not-allowed;
      }
      .btn-phone {
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        box-shadow: 0 8px 24px rgba(239, 68, 68, 0.3);
      }
      .btn-phone:active { transform: scale(0.98); }
      .btn-phone.disabled {
        background: linear-gradient(135deg, #9ca3af 0%, #6b7280 100%);
        box-shadow: none;
        pointer-events: none;
      }

      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      .loading-text { animation: pulse 1.5s ease-in-out infinite; }

      /* 弹窗样式 */
      .modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 200;
        padding: 20px;
        opacity: 0;
        visibility: hidden;
        transition: all 0.3s;
      }
      .modal-overlay.show {
        opacity: 1;
        visibility: visible;
      }
      .modal-box {
        background: white;
        border-radius: 20px;
        padding: clamp(24px, 6vw, 32px);
        max-width: 340px;
        width: 100%;
        text-align: center;
        transform: scale(0.9);
        transition: transform 0.3s;
      }
      .modal-overlay.show .modal-box {
        transform: scale(1);
      }
      .modal-icon {
        font-size: 48px;
        margin-bottom: 16px;
      }
      .modal-title {
        font-size: 18px;
        font-weight: 700;
        color: #1a202c;
        margin-bottom: 8px;
      }
      .modal-desc {
        font-size: 14px;
        color: #718096;
        margin-bottom: 24px;
        line-height: 1.5;
      }
      .modal-buttons {
        display: flex;
        gap: 12px;
      }
      .modal-btn {
        flex: 1;
        padding: 14px 16px;
        border-radius: 12px;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        transition: all 0.2s;
      }
      .modal-btn:active { transform: scale(0.96); }
      .modal-btn-primary {
        background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%);
        color: white;
      }
      .modal-btn-secondary {
        background: #f1f5f9;
        color: #64748b;
      }

      /* iPad / 平板适配 */
      @media (min-width: 768px) {
        body {
          align-items: center;
        }
        .container {
          max-width: 480px;
        }
      }

      /* 大屏幕 iPad Pro / 桌面 */
      @media (min-width: 1024px) {
        .container {
          max-width: 520px;
        }
        .card {
          padding: 32px;
        }
      }

      /* 折叠屏展开状态 */
      @media (min-width: 600px) and (max-width: 900px) {
        .container {
          max-width: 460px;
        }
      }

      /* 横屏适配 */
      @media (orientation: landscape) and (max-height: 500px) {
        body {
          align-items: flex-start;
          padding-top: calc(12px + var(--sat));
        }
        .header {
          padding: 16px;
        }
        .icon-wrap {
          width: 60px;
          height: 60px;
          margin-bottom: 12px;
        }
        .icon-wrap span { font-size: 32px; }
        .input-card textarea {
          min-height: 70px;
        }
        .success-icon {
          font-size: 48px;
          margin-bottom: 10px;
        }
      }

      /* 小屏手机适配 */
      @media (max-width: 350px) {
        .container {
          gap: 10px;
        }
        .card {
          padding: 14px;
          border-radius: 18px;
        }
        .tags {
          gap: 6px;
        }
        .tag {
          padding: 8px 10px;
          font-size: 12px;
        }
      }
    </style>
  </head>
  <body>
    <div id="toast" class="toast"></div>

    <!-- 页面加载时的位置提示弹窗 -->
    <div id="locationTipModal" class="modal-overlay">
      <div class="modal-box">
        <div class="modal-icon">📍</div>
        <div class="modal-title">位置信息说明</div>
        <div class="modal-desc">分享位置可让车主确认您在车旁<br>不分享将延迟30秒发送通知</div>
        <div class="modal-buttons">
          <button class="modal-btn modal-btn-primary" onclick="hideModal('locationTipModal');requestLocation()">我知道了</button>
        </div>
      </div>
    </div>

    <div class="container" id="mainView">
      <div class="card header">
        <div class="icon-wrap"><span>🚗</span></div>
        <h1>呼叫车主挪车</h1>
        <p>Notify Car Owner</p>
      </div>

      <div class="card input-card">
        <textarea id="msgInput" placeholder="输入留言给车主...（可选）"></textarea>
        <div class="tags">
          <div class="tag" onclick="addTag('您的车挡住我了')">🚧 挡路</div>
          <div class="tag" onclick="addTag('临时停靠一下')">⏱️ 临停</div>
          <div class="tag" onclick="addTag('电话打不通')">📞 没接</div>
          <div class="tag" onclick="addTag('麻烦尽快')">🙏 加急</div>
        </div>
      </div>

      <div class="card loc-card">
        <div id="locIcon" class="loc-icon loading">📍</div>
        <div class="loc-content">
          <div class="loc-title">我的位置</div>
          <div id="locStatus" class="loc-status">等待获取...</div>
        </div>
      </div>

      <button id="notifyBtn" class="card btn-main" onclick="sendNotify()">
        <span>🔔</span>
        <span>一键通知车主</span>
      </button>
    </div>

    <div class="container" id="successView">
      <div class="card success-card">
        <span class="success-icon">✅</span>
        <h2>通知已发送！</h2>
        <p id="waitingText" class="loading-text">正在等待车主回应...</p>
      </div>

      <div id="ownerFeedback" class="card owner-card hidden">
        <span style="font-size:56px; display:block; margin-bottom:16px">🎉</span>
        <h3>车主已收到通知</h3>
        <p>正在赶来，点击查看车主位置</p>
        <div id="ownerMapLinks" class="map-links" style="display:none">
          <a id="ownerAmapLink" href="#" class="map-btn amap">🗺️ 高德地图</a>
          <a id="ownerAppleLink" href="#" class="map-btn apple">🍎 Apple Maps</a>
        </div>
      </div>

      <div id="actionCard" class="card action-card">
        <p class="action-hint">车主没反应？试试其他方式</p>
        <button id="retryBtn" class="btn-retry" onclick="retryNotify()">
          <span>🔔</span>
          <span>再次通知</span>
        </button>
        <a id="phoneBtn" href="tel:${phone}" class="btn-phone disabled">
          <span>📞</span>
          <span id="phoneBtnText">2分59秒后可拨打</span>
        </a>
      </div>
    </div>

    <script>
      let userLocation = null;
      let checkTimer = null;
      let phoneTimer = null;
      let phoneCountdown = 180; // 3分钟倒计时
      let retryCountdown = 0; // 再次通知冷却倒计时
      let retryTimer = null;

      // 更新电话按钮倒计时显示
      function updatePhoneCountdown() {
        const phoneBtn = document.getElementById('phoneBtn');
        const phoneBtnText = document.getElementById('phoneBtnText');
        if (!phoneBtn || !phoneBtnText) return;

        if (phoneCountdown <= 0) {
          // 倒计时结束，激活按钮
          phoneBtn.classList.remove('disabled');
          phoneBtnText.innerText = '直接打电话';
          stopPhoneTimer();
        } else {
          // 显示倒计时
          const minutes = Math.floor(phoneCountdown / 60);
          const seconds = phoneCountdown % 60;
          const timeStr = minutes > 0 ? minutes + '分' + seconds + '秒' : seconds + '秒';
          phoneBtnText.innerText = timeStr + '后可拨打';
          phoneCountdown--;
        }
      }

      // 启动电话按钮倒计时
      function startPhoneTimer() {
        if (phoneTimer) clearInterval(phoneTimer);
        phoneCountdown = 180; // 重置为3分钟
        const phoneBtn = document.getElementById('phoneBtn');
        if (phoneBtn) {
          phoneBtn.classList.add('disabled');
          phoneBtn.style.display = ''; // 确保显示
        }
        updatePhoneCountdown();
        phoneTimer = setInterval(updatePhoneCountdown, 1000);
      }

      // 停止电话按钮倒计时
      function stopPhoneTimer() {
        if (phoneTimer) {
          clearInterval(phoneTimer);
          phoneTimer = null;
        }
      }

      // 隐藏操作卡片（车主确认后调用）
      function hideActionCard() {
        stopPhoneTimer();
        const actionCard = document.getElementById('actionCard');
        if (actionCard) {
          actionCard.style.display = 'none';
        }
      }

      // 页面加载时显示提示弹窗
      window.onload = () => {
        showModal('locationTipModal');
      };

      function showModal(id) {
        document.getElementById(id).classList.add('show');
      }

      function hideModal(id) {
        document.getElementById(id).classList.remove('show');
      }

      // 用户点击"我知道了"后请求位置
      function requestLocation() {
        const icon = document.getElementById('locIcon');
        const txt = document.getElementById('locStatus');

        icon.className = 'loc-icon loading';
        txt.className = 'loc-status';
        txt.innerText = '正在获取定位...';

        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
              icon.className = 'loc-icon success';
              txt.className = 'loc-status success';
              txt.innerText = '已获取位置 ✓';
            },
            (err) => {
              icon.className = 'loc-icon error';
              txt.className = 'loc-status error';
              txt.innerText = '位置获取失败，刷新页面可重试';
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
          );
        } else {
          icon.className = 'loc-icon error';
          txt.className = 'loc-status error';
          txt.innerText = '浏览器不支持定位';
        }
      }

      function addTag(text) {
        document.getElementById('msgInput').value = text;
      }

      // 发送通知
      async function sendNotify() {
        const btn = document.getElementById('notifyBtn');
        const msg = document.getElementById('msgInput').value;
        const delayed = !userLocation; // 无位置则延迟

        btn.disabled = true;

        // 如果无位置，前端延迟30秒再发送
        if (delayed) {
          btn.innerHTML = '<span>⏳</span><span>30秒后发送...</span>';
          showToast('⏳ 未获取位置，将延迟30秒发送');

          let countdown = 30;
          const countdownTimer = setInterval(() => {
            countdown--;
            if (countdown > 0) {
              btn.innerHTML = '<span>⏳</span><span>' + countdown + '秒后发送...</span>';
            }
          }, 1000);

          await new Promise(resolve => setTimeout(resolve, 30000));
          clearInterval(countdownTimer);
        }

        btn.innerHTML = '<span>🚀</span><span>发送中...</span>';

        try {
          const res = await fetch('/api/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, location: userLocation })
          });

          if (res.ok) {
            showToast('✅ 发送成功！');
            document.getElementById('mainView').style.display = 'none';
            document.getElementById('successView').style.display = 'flex';
            startPolling();
          } else {
            throw new Error('API Error');
          }
        } catch (e) {
          showToast('❌ 发送失败，请重试');
          btn.disabled = false;
          btn.innerHTML = '<span>🔔</span><span>一键通知车主</span>';
        }
      }

      function startPolling() {
        let pollCount = 0;
        const maxPolls = 180; // 最多轮询约10分钟

        // 启动电话按钮倒计时
        startPhoneTimer();

        function poll() {
          pollCount++;
          if (pollCount > maxPolls) return;

          fetch('/api/check-status')
            .then(res => res.json())
            .then(data => {
              if (data.status === 'confirmed') {
                const fb = document.getElementById('ownerFeedback');
                fb.classList.remove('hidden');

                // 标记已确认，隐藏操作卡片
                hideActionCard();
                const waitingText = document.getElementById('waitingText');
                waitingText.dataset.confirmed = 'true';
                waitingText.innerText = '车主已确认！';
                waitingText.classList.remove('loading-text');

                if (data.ownerLocation && data.ownerLocation.amapUrl) {
                  document.getElementById('ownerMapLinks').style.display = 'flex';
                  document.getElementById('ownerAmapLink').href = data.ownerLocation.amapUrl;
                  document.getElementById('ownerAppleLink').href = data.ownerLocation.appleUrl;
                }

                if(navigator.vibrate) navigator.vibrate([200, 100, 200]);
              } else if (data.status === 'error') {
                const waitingText = document.getElementById('waitingText');
                if (waitingText) {
                  waitingText.dataset.confirmed = 'true';
                  waitingText.innerText = data.error ? '车主确认失败：' + data.error : '车主确认失败，请重试。';
                  waitingText.classList.remove('loading-text');
                }
                showToast('❌ 车主确认失败');
              } else {
                // 渐进式间隔：前1分钟每2秒，之后每5秒
                const interval = pollCount <= 30 ? 2000 : 5000;
                checkTimer = setTimeout(poll, interval);
              }
            })
            .catch(() => {
              // 出错时继续轮询
              const interval = pollCount <= 30 ? 2000 : 5000;
              checkTimer = setTimeout(poll, interval);
            });
        }

        poll();
      }

      function showToast(text) {
        const t = document.getElementById('toast');
        t.innerText = text;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3000);
      }

      // 更新再次通知按钮冷却倒计时
      function updateRetryCountdown() {
        const retryBtn = document.getElementById('retryBtn');
        if (!retryBtn) return;

        if (retryCountdown <= 0) {
          retryBtn.disabled = false;
          retryBtn.innerHTML = '<span>🔔</span><span>再次通知</span>';
          stopRetryTimer();
        } else {
          retryBtn.disabled = true;
          retryBtn.innerHTML = '<span>⏳</span><span>' + retryCountdown + '秒后可再次通知</span>';
          retryCountdown--;
        }
      }

      function startRetryTimer() {
        if (retryTimer) clearInterval(retryTimer);
        retryCountdown = 30; // 30秒冷却
        updateRetryCountdown();
        retryTimer = setInterval(updateRetryCountdown, 1000);
      }

      function stopRetryTimer() {
        if (retryTimer) {
          clearInterval(retryTimer);
          retryTimer = null;
        }
      }

      async function retryNotify() {
        const btn = document.getElementById('retryBtn');
        btn.disabled = true;
        btn.innerHTML = '<span>🚀</span><span>发送中...</span>';

        try {
          const res = await fetch('/api/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '再次通知：请尽快挪车', location: userLocation })
          });

          if (res.ok) {
            // 重置电话按钮倒计时
            startPhoneTimer();
            // 启动再次通知冷却倒计时
            startRetryTimer();
            if (userLocation) {
              showToast('✅ 再次通知已发送（含位置）');
            } else {
              showToast('✅ 再次通知已发送');
            }
          } else {
            throw new Error('API Error');
          }
        } catch (e) {
          showToast('❌ 发送失败，请重试');
          btn.disabled = false;
          btn.innerHTML = '<span>🔔</span><span>再次通知</span>';
        }
      }
    </script>
  </body>
  </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function renderOwnerPage() {
  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#667eea">
    <title>确认挪车</title>
    <style>
      :root {
        --sat: env(safe-area-inset-top, 0px);
        --sar: env(safe-area-inset-right, 0px);
        --sab: env(safe-area-inset-bottom, 0px);
        --sal: env(safe-area-inset-left, 0px);
      }
      * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
      html {
        font-size: 16px;
        -webkit-text-size-adjust: 100%;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
        background: linear-gradient(160deg, #667eea 0%, #764ba2 100%);
        min-height: 100vh;
        min-height: -webkit-fill-available;
        padding: clamp(16px, 4vw, 24px);
        padding-top: calc(clamp(16px, 4vw, 24px) + var(--sat));
        padding-bottom: calc(clamp(16px, 4vw, 24px) + var(--sab));
        padding-left: calc(clamp(16px, 4vw, 24px) + var(--sal));
        padding-right: calc(clamp(16px, 4vw, 24px) + var(--sar));
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
      }
      .card {
        background: rgba(255,255,255,0.95);
        padding: clamp(24px, 6vw, 36px);
        border-radius: clamp(24px, 6vw, 32px);
        text-align: center;
        width: 100%;
        max-width: 420px;
        box-shadow: 0 20px 60px rgba(102, 126, 234, 0.3);
      }
      .emoji {
        font-size: clamp(52px, 13vw, 72px);
        margin-bottom: clamp(16px, 4vw, 24px);
        display: block;
      }
      h1 {
        font-size: clamp(22px, 5.5vw, 28px);
        color: #2d3748;
        margin-bottom: 8px;
      }
      .subtitle {
        color: #718096;
        font-size: clamp(14px, 3.5vw, 16px);
        margin-bottom: clamp(20px, 5vw, 28px);
      }

      .map-section {
        background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%);
        border-radius: clamp(14px, 3.5vw, 18px);
        padding: clamp(14px, 3.5vw, 20px);
        margin-bottom: clamp(16px, 4vw, 24px);
        display: none;
      }
      .map-section.show { display: block; }
      .map-section p {
        font-size: clamp(12px, 3.2vw, 14px);
        color: #6366f1;
        margin-bottom: 12px;
        font-weight: 600;
      }
      .map-links {
        display: flex;
        gap: clamp(8px, 2vw, 12px);
        flex-wrap: wrap;
      }
      .map-btn {
        flex: 1;
        min-width: 110px;
        padding: clamp(12px, 3vw, 16px);
        border-radius: clamp(10px, 2.5vw, 14px);
        text-decoration: none;
        font-weight: 600;
        font-size: clamp(13px, 3.5vw, 15px);
        text-align: center;
        transition: transform 0.2s;
        min-height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .map-btn:active { transform: scale(0.96); }
      .map-btn.amap { background: #1890ff; color: white; }
      .map-btn.apple { background: #1d1d1f; color: white; }

      .loc-status {
        background: #fef3c7;
        border-radius: clamp(10px, 2.5vw, 14px);
        padding: clamp(10px, 2.5vw, 14px) clamp(14px, 3.5vw, 18px);
        margin-bottom: clamp(16px, 4vw, 24px);
        font-size: clamp(13px, 3.5vw, 15px);
        color: #92400e;
        display: none;
      }
      .loc-status.show { display: block; }
      .loc-status.success { background: #d1fae5; color: #065f46; }
      .loc-status.error { background: #fee2e2; color: #991b1b; }

      .btn {
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
        color: white;
        border: none;
        width: 100%;
        padding: clamp(16px, 4vw, 20px);
        border-radius: clamp(14px, 3.5vw, 18px);
        font-size: clamp(16px, 4.2vw, 19px);
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(16, 185, 129, 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        transition: all 0.2s;
        min-height: 56px;
      }
      .btn:active { transform: scale(0.98); }
      .btn:disabled {
        background: linear-gradient(135deg, #9ca3af 0%, #6b7280 100%);
        box-shadow: none;
        cursor: not-allowed;
      }

      .done-msg {
        background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%);
        border-radius: clamp(14px, 3.5vw, 18px);
        padding: clamp(16px, 4vw, 24px);
        margin-top: clamp(16px, 4vw, 24px);
        display: none;
      }
      .done-msg.show { display: block; }
      .done-msg p {
        color: #065f46;
        font-weight: 600;
        font-size: clamp(15px, 4vw, 17px);
      }

      /* iPad / 平板适配 */
      @media (min-width: 768px) {
        .card {
          max-width: 440px;
          padding: 40px;
        }
      }

      /* 横屏适配 */
      @media (orientation: landscape) and (max-height: 500px) {
        body {
          justify-content: flex-start;
          padding-top: calc(12px + var(--sat));
        }
        .card {
          padding: 20px 28px;
        }
        .emoji {
          font-size: 44px;
          margin-bottom: 12px;
        }
        .subtitle {
          margin-bottom: 16px;
        }
      }

      /* 小屏手机适配 */
      @media (max-width: 350px) {
        .card {
          padding: 20px;
          border-radius: 20px;
        }
        .map-btn {
          min-width: 100px;
          padding: 10px;
        }
      }
    </style>
  </head>
  <body>
    <div class="card">
      <span class="emoji">👋</span>
      <h1>收到挪车请求</h1>
      <p class="subtitle">对方正在等待，请尽快确认</p>

      <div id="mapArea" class="map-section">
        <p>📍 对方位置</p>
        <div class="map-links">
          <a id="amapLink" href="#" class="map-btn amap">🗺️ 高德地图</a>
          <a id="appleLink" href="#" class="map-btn apple">🍎 Apple Maps</a>
        </div>
      </div>

      <button id="confirmBtn" class="btn" onclick="confirmMove()">
        <span>🚀</span>
        <span>我已知晓，正在前往</span>
      </button>

      <div id="statusMsg" class="loc-status"></div>

      <div id="doneMsg" class="done-msg">
        <p>✅ 已通知对方您正在赶来！</p>
      </div>
    </div>

    <script>
      let ownerLocation = null;

      window.onload = async () => {
        try {
          const res = await fetch('/api/get-location');
          if(res.ok) {
            const data = await res.json();
            if(data.amapUrl) {
              document.getElementById('mapArea').classList.add('show');
              document.getElementById('amapLink').href = data.amapUrl;
              document.getElementById('appleLink').href = data.appleUrl;
            }
          }
        } catch(e) {}
      }

      // 点击确认按钮时，触发浏览器授权
      async function confirmMove() {
        const btn = document.getElementById('confirmBtn');
        btn.disabled = true;
        btn.innerHTML = '<span>📍</span><span>获取位置中...</span>';

        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            async (pos) => {
              // 允许 → 发送确认 + 位置
              ownerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
              await doConfirm();
            },
            async (err) => {
              // 拒绝或失败 → 直接发送确认，不带位置
              ownerLocation = null;
              await doConfirm();
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
          );
        } else {
          // 浏览器不支持定位 → 直接发送确认
          ownerLocation = null;
          await doConfirm();
        }
      }

      // 发送确认
      function updateStatus(text, type) {
        const status = document.getElementById('statusMsg');
        if (!status) return;
        if (!text) {
          status.textContent = '';
          status.className = 'loc-status';
          return;
        }
        status.textContent = text;
        status.className = 'loc-status show' + (type ? ' ' + type : '');
      }

      async function doConfirm() {
        const btn = document.getElementById('confirmBtn');
        btn.innerHTML = '<span>⏳</span><span>确认中...</span>';
        updateStatus('');

        try {
          const res = await fetch('/api/owner-confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: ownerLocation })
          });

          let data = null;
          try {
            data = await res.json();
          } catch (_) {
            data = null;
          }

          if (!res.ok) {
            throw new Error((data && data.error) ? data.error : '服务器响应错误');
          }

          if (!data || !data.success) {
            throw new Error((data && data.error) ? data.error : '确认失败');
          }

          btn.innerHTML = '<span>✅</span><span>已确认</span>';
          btn.style.background = 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)';
          document.getElementById('doneMsg').classList.add('show');
        } catch(e) {
          btn.disabled = false;
          btn.innerHTML = '<span>🚀</span><span>我已知晓，正在前往</span>';
          updateStatus('确认失败，请重试：' + ((e && e.message) ? e.message : '未知错误'), 'error');
        }
      }
    </script>
  </body>
  </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
