const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hidPicker', {
  onDevicesUpdate: (cb) => {
    const handler = (_event, devices) => cb(devices);
    ipcRenderer.on('hid-devices-updated', handler);
    return () => ipcRenderer.removeListener('hid-devices-updated', handler);
  },
  selectDevice: (deviceId) => ipcRenderer.send('hid-picker-select', deviceId),
  cancel: () => ipcRenderer.send('hid-picker-cancel'),
  ready: () => ipcRenderer.send('hid-picker-ready'),
});
