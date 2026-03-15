const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

// youtube_monitor の認証情報パス
const YT_MONITOR_DIR = path.join(__dirname, '..', 'youtube_monitor');
const TOKEN_FILE = path.join(YT_MONITOR_DIR, 'token.json');
const CLIENT_SECRET_FILE = path.join(YT_MONITOR_DIR, 'client_secret.json');

// 監視中の動画を管理
const activeMonitors = new Map();
const POLL_INTERVAL = 30000; // 30秒

// ===== YouTube API ヘルパー =====

function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
}

function loadClientSecret() {
  if (!fs.existsSync(CLIENT_SECRET_FILE)) return null;
  const data = JSON.parse(fs.readFileSync(CLIENT_SECRET_FILE, 'utf8'));
  return data.installed || data.web || null;
}

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function refreshAccessToken(token) {
  const client = loadClientSecret();
  if (!client || !token.refresh_token) return null;

  const params = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token'
  });

  const res = await httpsRequest('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (res.status === 200 && res.data.access_token) {
    token.token = res.data.access_token;
    if (res.data.expiry) token.expiry = res.data.expiry;
    saveToken(token);
    return token;
  }
  return null;
}

async function getAccessToken() {
  let token = loadToken();
  if (!token) {
    throw new Error('YouTube認証情報が見つかりません。先にmonitor.pyで認証を行ってください。');
  }

  // トークンの期限チェック（expiryフィールドがある場合）
  if (token.expiry) {
    const expiry = new Date(token.expiry);
    if (expiry <= new Date()) {
      token = await refreshAccessToken(token);
      if (!token) throw new Error('トークンの更新に失敗しました。monitor.pyで再認証してください。');
    }
  }

  return token.token;
}

async function ytApiGet(endpoint, params = {}) {
  const accessToken = await getAccessToken();
  const qs = new URLSearchParams(params).toString();
  const url = `https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`;

  const res = await httpsRequest(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  if (res.status === 401) {
    // トークン期限切れ → リフレッシュして再試行
    let token = loadToken();
    token = await refreshAccessToken(token);
    if (!token) throw new Error('トークンの更新に失敗しました。');

    const retryRes = await httpsRequest(url.replace(/access_token=[^&]+/, ''), {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token.token}` }
    });
    return retryRes.data;
  }

  if (res.status !== 200) {
    throw new Error(`YouTube API エラー (${res.status}): ${JSON.stringify(res.data)}`);
  }

  return res.data;
}

async function checkVideoStatus(videoId) {
  const data = await ytApiGet('videos', {
    part: 'processingDetails,status,snippet',
    id: videoId
  });

  if (!data.items || data.items.length === 0) {
    return { error: '動画が見つかりません', videoId };
  }

  const item = data.items[0];
  const processing = item.processingDetails || {};
  const status = item.status || {};
  const snippet = item.snippet || {};

  return {
    videoId,
    title: snippet.title || '',
    processingStatus: processing.processingStatus || 'unknown',
    uploadStatus: status.uploadStatus || 'unknown',
    isReady: processing.processingStatus === 'succeeded' && status.uploadStatus === 'processed',
    isFailed: processing.processingStatus === 'failed' || status.uploadStatus === 'failed'
  };
}

// ===== 監視機能 =====

function startMonitor(videoId, win) {
  if (activeMonitors.has(videoId)) return;

  const poll = async () => {
    try {
      const status = await checkVideoStatus(videoId);
      win.webContents.send('yt-monitor-update', status);

      if (status.isReady || status.isFailed || status.error) {
        stopMonitor(videoId);
      }
    } catch (err) {
      win.webContents.send('yt-monitor-update', {
        videoId,
        error: err.message
      });
      stopMonitor(videoId);
    }
  };

  // 初回即時チェック
  poll();
  const interval = setInterval(poll, POLL_INTERVAL);
  activeMonitors.set(videoId, interval);
}

function stopMonitor(videoId) {
  const interval = activeMonitors.get(videoId);
  if (interval) {
    clearInterval(interval);
    activeMonitors.delete(videoId);
  }
}

// ===== Electron =====

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 800,
    minWidth: 600,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0a0e1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('index.html');

  // IPC ハンドラー
  ipcMain.handle('yt-check-status', async (event, videoId) => {
    try {
      return await checkVideoStatus(videoId);
    } catch (err) {
      return { error: err.message, videoId };
    }
  });

  ipcMain.handle('yt-start-monitor', async (event, videoId) => {
    startMonitor(videoId, win);
    return { started: true, videoId };
  });

  ipcMain.handle('yt-stop-monitor', async (event, videoId) => {
    stopMonitor(videoId);
    return { stopped: true, videoId };
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // 全監視を停止
  for (const [videoId] of activeMonitors) {
    stopMonitor(videoId);
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
