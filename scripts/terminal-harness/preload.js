const { ipcRenderer } = require("electron");
window.ReactNativeWebView = { postMessage: (s) => ipcRenderer.send("rn", s, Math.round(performance.now())) };
