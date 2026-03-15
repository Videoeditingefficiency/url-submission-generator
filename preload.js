const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('youtubeMonitor', {
  checkVideoStatus: (videoId) => ipcRenderer.invoke('yt-check-status', videoId),
  startMonitor: (videoId) => ipcRenderer.invoke('yt-start-monitor', videoId),
  stopMonitor: (videoId) => ipcRenderer.invoke('yt-stop-monitor', videoId),
  onMonitorUpdate: (callback) => {
    ipcRenderer.on('yt-monitor-update', (event, data) => callback(data));
  }
});
