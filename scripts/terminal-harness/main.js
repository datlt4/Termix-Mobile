// Runs the mobile terminal WebView HTML against a real opencode pty and
// drives it with CDP touch events, recording when the screen content changes.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
// node-pty built for this Electron (the desktop repo has one).
const pty = require(process.env.NODE_PTY || "node-pty");

const HTML = process.env.HTML;
const OUT = process.env.OUT;
const LAT = Number(process.env.LAT || 35); // one-way latency, ms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const step = (name) => console.error("STEP", name, Date.now() - t0);

app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 480,
    height: 987,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  step("window");
  const dbg = win.webContents.debugger;
  dbg.attach("1.3");

  const log = { inputs: [], touches: [], errors: [], writes: [] };
  let term = null;
  let batch = [];
  let flushTimer = null;
  const js = (code) => win.webContents.executeJavaScript(code);
  const toPage = (data) => {
    batch.push(data);
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const s = batch.join("");
      batch = [];
      js(`window.writeToTerminal(${JSON.stringify(s)}); true;`).catch(() => {});
    }, 16);
  };

  ipcMain.on("rn", (_e, s, pt) => {
    let m;
    try { m = JSON.parse(s); } catch { return; }
    if (m.type === "input") {
      log.inputs.push([pt, m.data]);
      setTimeout(() => term && term.write(m.data), LAT);
    } else if (m.type === "resize") {
      log.resize = m.data;
      if (term) try { term.resize(m.data.cols, m.data.rows); } catch {}
    } else if (m.type === "termixDbg") {
      log.errors.push(m.data);
    }
  });
  win.webContents.on("console-message", (...a) => {
    const m = typeof a[1] === "object" ? a[1] : { level: a[1], message: a[2] };
    if (m.level === 3 || m.level === "error") log.errors.push(String(m.message).slice(0, 300));
  });

  await win.loadFile(HTML);
  step("loaded");
  await dbg.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  step("touch-emulation");
  await sleep(1500);
  log.size = await js(`({cols: terminal.cols, rows: terminal.rows, canvas: document.querySelectorAll('canvas').length, rowsDom: document.querySelectorAll('.xterm-rows').length})`);
  step("size " + JSON.stringify(log.size));

  const shell = process.env.MODE === "shell";
  term = pty.spawn(shell ? "bash" : "opencode", shell ? ["--norc", "-i"] : (process.env.OPENCODE_SESSION ? ["-s", process.env.OPENCODE_SESSION] : []), {
    name: "xterm-256color", cols: log.size.cols, rows: log.size.rows, cwd: process.env.HOME,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  term.onData((d) => setTimeout(() => toPage(d), LAT));
  await js(`window.notifyConnected(false,false); true;`);
  if (shell) { await sleep(800); term.write("seq 1 3000\r"); await sleep(2500); } else await sleep(9000);
  step("connected");

  // Content-change observer: hash a band of viewport rows on every render.
  await js(`(()=>{window.__chg=[];let last='';
    terminal.onRender(()=>{const b=terminal.buffer.active;let s='';
      for(let i=2;i<14;i++){const l=b.getLine(b.viewportY+i);s+=l?l.translateToString(true):'';}
      if(s!==last){last=s;window.__chg.push(Math.round(performance.now()));}});
    window.__vy=[];(function f(){window.__vy.push([Math.round(performance.now()),terminal.buffer.active.viewportY]);requestAnimationFrame(f);})();
    return true;})()`);
  if (process.env.DEBUGLOG) await js("TERMIX_DEBUG = true; true;");
  log.lineH = await js("terminal._core._renderService.dimensions.css.cell.height");
  await js(`window.__sl=[];const _sl=terminal.scrollLines.bind(terminal);terminal.scrollLines=(n)=>{const b=terminal.buffer.active.viewportY;_sl(n);window.__sl.push([Math.round(performance.now()),n,b,terminal.buffer.active.viewportY]);}; true;`);
  await js(`window.__raw={};['touchstart','touchmove','touchend','touchcancel'].forEach(n=>document.addEventListener(n,e=>{const k=n+(e.cancelable?'':'(nc)')+(e.defaultPrevented?'(prevented)':'');window.__raw[k]=(window.__raw[k]||0)+1;},{capture:true,passive:true})); true;`);
  const pageNow = () => js("Math.round(performance.now())");
  const touch = async (type, y) => {
    log.touches.push([type, await pageNow(), y]);
    await dbg.sendCommand("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: 240, y }] });
  };

  log.scen = [];
  // 1) slow drag: 300px over ~2s with the finger held (scrolls back).
  log.scen.push(["slow", await pageNow()]);
  step("slow");
  await touch("touchStart", 300);
  for (let i = 1; i <= 125; i++) {
    await touch("touchMove", 300 + i * 2.4);
    await sleep(16);
  }
  await touch("touchEnd", 600);
  await sleep(2500);
  // 2) fast flick: 300px in ~100ms, then release.
  log.scen.push(["flick", await pageNow()]);
  step("flick");
  await touch("touchStart", 300);
  for (let i = 1; i <= 6; i++) {
    await touch("touchMove", 300 + i * 50);
    await sleep(16);
  }
  await touch("touchEnd", 600);
  await sleep(3000);
  log.changes = await js("window.__chg");
  log.raw = await js("window.__raw");
  log.vy = await js("window.__vy");
  log.sl = await js("window.__sl");
  step("done");
  fs.writeFileSync(OUT, JSON.stringify(log));
  term.kill();
  app.quit();
});
