const { app, BrowserWindow, Menu, ipcMain, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const HUB_URL = 'https://scyrox.net';
const WINDOW_STATE_VERSION = 2;
const ICON_PATH = path.join(__dirname, 'icon.ico');
const WINDOW_ICON = fs.existsSync(ICON_PATH) ? ICON_PATH : undefined;
const ALLOWED_HOSTS = new Set([
  'scyrox.net',
  'www.scyrox.net',
  'scyrox.com',
  'www.scyrox.com',
]);

let mainWindow = null;
let pickerWindow = null;

function getStorePath(filename) {
  return path.join(app.getPath('userData'), filename);
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`Failed to write ${filePath}:`, err);
  }
}

function isAllowedOrigin(rawUrl) {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function scoreHidDevice(dev) {
  const collections = Array.isArray(dev.collections) ? dev.collections : [];
  let bestScore = 0;

  for (const col of collections) {
    const inCount = Array.isArray(col.inputReports) ? col.inputReports.length : 0;
    const outReports = Array.isArray(col.outputReports) ? col.outputReports : [];
    const featCount = Array.isArray(col.featureReports) ? col.featureReports.length : 0;
    const usagePage = Number(col.usagePage || 0);
    const usage = Number(col.usage || 0);

    let score = 0;

    if (inCount === 1 && outReports.length === 1) {
      score += 45;
      if (outReports[0] && outReports[0].reportId === 8) {
        score += 100;
      }
    }

    if (featCount === 1) {
      score += 30;
    }

    if (usagePage >= 0xff00) {
      score += 50;
    } else if (usagePage === 1 && (usage === 2 || usage === 6)) {
      score -= 40;
    }

    if (score > bestScore || bestScore === 0) {
      bestScore = score;
    }
  }

  return bestScore;
}

function dedupeAndRankDevices(deviceList) {
  const byPhysicalDevice = new Map();

  for (const dev of deviceList || []) {
    const key = `${dev.vendorId}:${dev.productId}:${dev.serialNumber || dev.name || ''}`;
    const score = scoreHidDevice(dev);
    const existing = byPhysicalDevice.get(key);

    if (!existing || score > existing.score) {
      byPhysicalDevice.set(key, {
        deviceId: dev.deviceId,
        name: dev.name || 'Scyrox Device',
        vendorId: dev.vendorId,
        productId: dev.productId,
        serialNumber: dev.serialNumber || '',
        score,
        isConfigInterface: score > 0,
      });
    }
  }

  return Array.from(byPhysicalDevice.values()).sort((a, b) => b.score - a.score);
}

function getPermittedDevices() {
  return loadJson(getStorePath('permitted-devices.json'), []);
}

function rememberPermittedDevice(dev) {
  if (!dev || !dev.vendorId || !dev.productId) return;
  const current = getPermittedDevices();
  const exists = current.some(
    (entry) => entry.vendorId === dev.vendorId && entry.productId === dev.productId
  );
  if (!exists) {
    current.push({
      vendorId: dev.vendorId,
      productId: dev.productId,
      name: dev.name || '',
    });
    saveJson(getStorePath('permitted-devices.json'), current);
  }
}

function isDevicePermitted(dev) {
  if (!dev) return false;
  return getPermittedDevices().some(
    (entry) => entry.vendorId === dev.vendorId && entry.productId === dev.productId
  );
}

function openPickerModal(parentWin, rawDeviceList, onComplete) {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.close();
  }

  let currentList = [...(rawDeviceList || [])];
  let settled = false;

  const ses = parentWin.webContents.session;

  const cleanup = () => {
    ses.off('hid-device-added', handleAdded);
    ses.off('hid-device-removed', handleRemoved);
    ipcMain.removeListener('hid-picker-select', handleSelect);
    ipcMain.removeListener('hid-picker-cancel', handleCancel);
    ipcMain.removeListener('hid-picker-ready', handleReady);
  };

  const settle = (deviceId) => {
    if (settled) return;
    settled = true;
    cleanup();

    if (deviceId) {
      const chosen = currentList.find((d) => d.deviceId === deviceId);
      if (chosen) rememberPermittedDevice(chosen);
    }

    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.close();
    }
    pickerWindow = null;
    onComplete(deviceId || '');
  };

  const pushUpdate = () => {
    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.webContents.send('hid-devices-updated', dedupeAndRankDevices(currentList));
    }
  };

  const handleAdded = (_event, details) => {
    if (details && details.device) {
      const idx = currentList.findIndex((d) => d.deviceId === details.device.deviceId);
      if (idx === -1) {
        currentList.push(details.device);
      } else {
        currentList[idx] = details.device;
      }
      pushUpdate();
    }
  };

  const handleRemoved = (_event, details) => {
    if (details && details.device) {
      currentList = currentList.filter((d) => d.deviceId !== details.device.deviceId);
      pushUpdate();
    }
  };

  const handleSelect = (_event, deviceId) => settle(deviceId);
  const handleCancel = () => settle('');
  const handleReady = () => pushUpdate();

  ses.on('hid-device-added', handleAdded);
  ses.on('hid-device-removed', handleRemoved);
  ipcMain.on('hid-picker-select', handleSelect);
  ipcMain.on('hid-picker-cancel', handleCancel);
  ipcMain.on('hid-picker-ready', handleReady);

  pickerWindow = new BrowserWindow({
    width: 460,
    height: 360,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: parentWin,
    modal: true,
    show: false,
    backgroundColor: '#111216',
    autoHideMenuBar: true,
    icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'picker-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  pickerWindow.on('closed', () => {
    pickerWindow = null;
    settle('');
  });

  pickerWindow.once('ready-to-show', () => {
    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.show();
    }
  });

  pickerWindow.loadFile(path.join(__dirname, 'picker.html'));
}

function setupWebHidHandlers(win) {
  const ses = win.webContents.session;

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (!isAllowedOrigin(requestingOrigin)) return false;
    return permission === 'hid' || permission === 'usb';
  });

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const origin = details && details.requestingUrl ? details.requestingUrl : '';
    callback(isAllowedOrigin(origin) && (permission === 'hid' || permission === 'usb'));
  });

  ses.setDevicePermissionHandler((details) => {
    if (!details || details.deviceType !== 'hid') return false;
    if (!isAllowedOrigin(details.origin)) return false;
    return isDevicePermitted(details.device);
  });

  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const frameUrl = details && details.frame ? details.frame.url : win.webContents.getURL();
    if (!isAllowedOrigin(frameUrl)) {
      callback('');
      return;
    }
    const list = (details && details.deviceList) || [];
    const ranked = dedupeAndRankDevices(list);

    if (ranked.length === 1 && ranked[0].isConfigInterface) {
      rememberPermittedDevice(ranked[0]);
      callback(ranked[0].deviceId);
      return;
    }

    openPickerModal(win, list, (selectedId) => {
      callback(selectedId || '');
    });
  });
}

function buildMenu(win) {
  const adjustZoom = (delta) => {
    const current = win.webContents.getZoomFactor();
    const next = Math.min(2.0, Math.max(0.75, Math.round((current + delta) * 20) / 20));
    win.webContents.setZoomFactor(next);
  };

  const template = [
    {
      label: 'Scyrox Hub',
      submenu: [
        {
          label: 'Увеличить масштаб',
          accelerator: 'CmdOrCtrl+=',
          click: () => adjustZoom(0.1),
        },
        {
          label: 'Уменьшить масштаб',
          accelerator: 'CmdOrCtrl+-',
          click: () => adjustZoom(-0.1),
        },
        {
          label: 'Сбросить масштаб',
          accelerator: 'CmdOrCtrl+0',
          click: () => win.webContents.setZoomFactor(1.0),
        },
        {
          label: 'На весь экран',
          accelerator: 'F11',
          click: () => win.setFullScreen(!win.isFullScreen()),
        },
        { type: 'separator' },
        {
          label: 'Перезагрузить',
          accelerator: 'CmdOrCtrl+R',
          click: () => win.webContents.reload(),
        },
        {
          label: 'Перезагрузить (без кэша)',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => win.webContents.reloadIgnoringCache(),
        },
        {
          label: 'Сбросить сохранённые HID-устройства',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => {
            saveJson(getStorePath('permitted-devices.json'), []);
            win.webContents.reloadIgnoringCache();
          },
        },
        { type: 'separator' },
        {
          label: 'Инструменты разработчика',
          accelerator: 'F12',
          click: () => win.webContents.toggleDevTools(),
        },
        { type: 'separator' },
        {
          label: 'Выход',
          role: 'quit',
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getDefaultWindowBounds() {
  const { width: workW, height: workH } = screen.getPrimaryDisplay().workAreaSize;
  return {
    version: WINDOW_STATE_VERSION,
    width: Math.min(1720, Math.max(960, workW - 40)),
    height: Math.min(980, Math.max(640, workH - 40)),
    isMaximized: false,
    zoomFactor: 1.0,
  };
}

function createMainWindow() {
  const statePath = getStorePath('window-state.json');
  const rawState = loadJson(statePath, null);
  const defaults = getDefaultWindowBounds();
  const savedState =
    rawState && rawState.version === WINDOW_STATE_VERSION
      ? { ...defaults, ...rawState }
      : defaults;

  mainWindow = new BrowserWindow({
    width: savedState.width,
    height: savedState.height,
    x: savedState.x,
    y: savedState.y,
    minWidth: 960,
    minHeight: 640,
    title: 'Scyrox Hub',
    backgroundColor: '#0e0e11',
    autoHideMenuBar: true,
    show: false,
    icon: WINDOW_ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      zoomFactor: savedState.zoomFactor || 1.0,
    },
  });

  if (savedState.isMaximized) {
    mainWindow.maximize();
  }

  buildMenu(mainWindow);
  setupWebHidHandlers(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedOrigin(url)) {
      mainWindow.loadURL(url);
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('close', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const isMaximized = mainWindow.isMaximized();
    const bounds = mainWindow.getNormalBounds();
    saveJson(statePath, {
      version: WINDOW_STATE_VERSION,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized,
      zoomFactor: mainWindow.webContents.getZoomFactor(),
    });
  });

  const escapeHtml = (str) =>
    String(str || '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><style>
      body{margin:0;background:#0e0e11;color:#f3f4f6;font-family:'Segoe UI',system-ui,sans-serif;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center}
      .box{max-width:420px;padding:28px;border:1px solid #2a2d3a;border-radius:14px;background:#16181f}
      h2{margin:0 0 8px;font-size:18px}p{margin:0 0 18px;color:#8b90a0;font-size:13px;line-height:1.5}
      button{background:#e5ff00;color:#0e0e11;border:none;border-radius:8px;padding:10px 20px;font-weight:600;cursor:pointer;font-size:13px}
    </style></head><body><div class="box"><h2>Не удалось загрузить Scyrox Hub</h2><p>${escapeHtml(errorDescription)} (${errorCode})<br>${escapeHtml(validatedURL)}</p><button onclick="location.href='${HUB_URL}'">Повторить</button></div></body></html>`;
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  mainWindow.loadURL(HUB_URL);
}

app.setAppUserModelId('net.scyrox.hub');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createMainWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
