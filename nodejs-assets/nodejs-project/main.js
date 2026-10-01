// Termix Mobile — standalone SSH engine (FORK).
// Runs inside the embedded Node.js runtime (nodejs-mobile) and serves a
// WebSocket terminal bridge on loopback. It speaks the same terminal
// protocol as a Termix server, so the React Native side can use the
// existing NativeWebSocketManager without changes. All SSH traffic goes
// directly from this device; no remote server is involved.
"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { Client } = require("ssh2");
const { WebSocketServer } = require("ws");
const rn_bridge = require("rn-bridge");

const READY_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// State dir (known hosts persistence). The nodejs-project folder is bundled
// as a read-only asset, so find a writable directory at runtime.
// ---------------------------------------------------------------------------
function findStateDir() {
  const candidates = [
    process.env.TMPDIR ? path.join(process.env.TMPDIR, "termix-mobile") : null,
    path.join(os.tmpdir(), "termix-mobile"),
    "/data/local/tmp/termix-mobile",
    path.join(__dirname, ".state"),
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, ".write-probe");
      fs.writeFileSync(probe, "1");
      fs.unlinkSync(probe);
      return dir;
    } catch (_) {
      /* try next */
    }
  }
  return null;
}

const STATE_DIR = findStateDir();
const KNOWN_HOSTS_FILE = STATE_DIR ? path.join(STATE_DIR, "known_hosts.json") : null;

function loadKnownHosts() {
  try {
    return JSON.parse(fs.readFileSync(KNOWN_HOSTS_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}

let knownHosts = loadKnownHosts(); // "ip:port" -> { fingerprint, keyType, algorithm }

function saveKnownHosts() {
  if (!KNOWN_HOSTS_FILE) return;
  try {
    fs.writeFileSync(KNOWN_HOSTS_FILE, JSON.stringify(knownHosts, null, 2));
  } catch (_) {
    /* non-fatal */
  }
}

function hostKeyTypeName(blob) {
  try {
    const len = blob.readUInt32BE(0);
    if (len > 0 && len < 64) return blob.toString("utf8", 4, 4 + len);
  } catch (_) {
    /* not a wire-format key */
  }
  return null;
}

function hostKeyFingerprint(buffer) {
  const b64 = crypto
    .createHash("sha256")
    .update(buffer)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return "SHA256:" + b64;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function send(ws, obj) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch (_) {
    /* socket gone */
  }
}

function log(s, level, message) {
  try {
    send(s.ws, { type: "connection_log", data: { level, message } });
  } catch (_) {
    /* socket gone */
  }
}

function isAuthError(message) {
  const m = (message || "").toLowerCase();
  return (
    m.includes("authentication") ||
    m.includes("permission denied") ||
    m.includes("all configured authentication methods failed") ||
    m.includes("invalid user") ||
    m.includes("handshake failed")
  );
}

// ---------------------------------------------------------------------------
// Per-connection session
// ---------------------------------------------------------------------------
function makeSession(ws, hostConfig, cols, rows) {
  return {
    ws,
    conn: null,
    shell: null,
    cols: cols || 80,
    rows: rows || 24,
    host: {
      ip: hostConfig.ip,
      port: Number(hostConfig.port) || 22,
      username: hostConfig.username || "root",
      password: hostConfig.password || null,
      privateKey: hostConfig.key || hostConfig.privateKey || null,
      keyPassword: hostConfig.keyPassword || null,
    },
    phase: "handshake", // handshake | awaiting-hostkey | awaiting-password | connected | closing
    pendingKeyAlgorithm: null,
    pendingKeyInfo: null,
    hostKeyVerifierCb: null, // ssh2 hostVerifier callback (pending answer)
    kiState: null,
    authPrompted: false,
    userTried: false,
    done: false,
  };
}

function failSession(s, message) {
  if (s.done) return;
  log(s, "error", message);
  send(s.ws, { type: "error", message });
  s.done = true;
  try {
    if (s.conn) s.conn.end();
  } catch (_) {
    /* noop */
  }
  try {
    s.ws.close();
  } catch (_) {
    /* noop */
  }
}

function promptPassword(s) {
  if (s.done || s.phase === "connected") return;
  s.phase = "awaiting-password";
  send(s.ws, { type: "password_required", prompt: "Password: " });
}

function openSSH(s) {
  const h = s.host;
  const conn = new Client();
  s.conn = conn;
  s.phase = "handshake";
  s.userTried = false;

  log(s, "info", `Connecting to ${h.ip}:${h.port} as ${h.username}…`);

  conn.on("ready", () => {
    startShell(s);
  });

  conn.on("error", (err) => {
    if (s.done || s.phase === "closing") return;
    if (s.conn !== conn) return; // FORK: stale connection (already reconnected)
    if (s.phase === "awaiting-hostkey") return;

    if (isAuthError(err && err.message)) {
      // The stored/supplied credential was rejected. Ask the user for a
      // fresh password (or TOTP) instead of killing the connection.
      if (!s.authPrompted) {
        s.authPrompted = true;
        promptPassword(s);
        return;
      }
      if (s.userTried) {
        // A user-typed attempt also failed — prompt again (they can retry
        // or close the dialog).
        s.userTried = false;
        promptPassword(s);
        return;
      }
      failSession(s, "Authentication failed: " + (err.message || "unknown"));
      return;
    }

    failSession(s, (err && err.message) || "SSH connection failed");
  });

  conn.on("close", () => {
    if (s.done) return;
    if (s.conn !== conn) return; // FORK: stale connection (already reconnected)
    // FORK: the server dropped the connection while a credential / host-key
    // dialog is still open (e.g. OpenSSH closing right after a rejected
    // "none" auth). Keep the WS + session alive so the dialog can still be
    // answered; answering triggers a fresh connection.
    if (s.phase === "awaiting-password" || s.phase === "awaiting-hostkey") {
      s.conn = null;
      s.shell = null;
      if (s.phase === "awaiting-password") {
        try {
          send(s.ws, { type: "password_required", prompt: "Password: " });
        } catch (_) {
          /* socket gone */
        }
      }
      return;
    }
    s.phase = "closing";
    try {
      send(s.ws, { type: "data", data: "\r\n[connection closed]\r\n" });
    } catch (_) {
      /* socket gone */
    }
    send(s.ws, { type: "disconnected" });
    s.done = true;
    try {
      s.ws.close();
    } catch (_) {
      /* noop */
    }
  });

  conn.on(
    "keyboard-interactive",
    (methods, instructions, prompts, onPrompt) => {
      if (s.phase === "closing" || s.done) return;
      // Server-driven keyboard-interactive (e.g. TOTP). Show the first prompt.
      const label =
        prompts && prompts.length ? prompts[0].prompt || "Code: " : "Code: ";
      s.phase = "awaiting-password";
      s.kiState = { onPrompt, prompts };
      send(s.ws, { type: "totp_required", prompt: label });
    },
  );

  conn.connect({
    host: h.ip,
    port: h.port,
    username: h.username,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
    readyTimeout: READY_TIMEOUT_MS,
    // FORK: ssh2 1.x has no "serverhostkey" event — host key verification
    // is done through hostVerifier (without it ssh2 accepts any host key).
    // Known fingerprints are accepted silently (TOFU): unknown or changed
    // keys prompt the RN host-key dialog and wait for the user's answer.
    hostVerifier: (key, verify) => {
      if (s.done) {
        try {
          verify(false);
        } catch (_) {
          /* noop */
        }
        return;
      }
      const fp = hostKeyFingerprint(key);
      const keyId = h.ip + ":" + h.port;
      const known = knownHosts[keyId];
      if (known && known.fingerprint === fp) {
        verify(true);
        return;
      }
      s.phase = "awaiting-hostkey";
      s.hostKeyVerifierCb = verify;
      const keyType = hostKeyTypeName(key);
      s.pendingKeyInfo = {
        ip: h.ip,
        port: h.port,
        fingerprint: fp,
        keyType: keyType || "unknown",
        algorithm: keyType || "unknown",
        oldFingerprint: known ? known.fingerprint : undefined,
        oldKeyType: known ? known.keyType : undefined,
      };
      try {
        send(s.ws, {
          type: known
            ? "host_key_changed"
            : "host_key_verification_required",
          data: s.pendingKeyInfo,
        });
      } catch (_) {
        /* socket gone */
      }
    },
    // Providing both lets ssh2 try each method the server advertises.
    ...(h.password ? { password: h.password } : {}),
    ...(h.privateKey
      ? {
          privateKey: h.privateKey,
          passphrase: h.keyPassword || undefined,
        }
      : {}),
  });
}

function startShell(s) {
  const conn = s.conn;
  s.phase = "connected";
  log(s, "success", "Authenticated. Opening shell…");
  // ssh2 1.x API: shell(ptyWndOpts, shellOpts, cb) — the PTY request is the
  // first argument (there is no public conn.reqPty in ssh2 1.x).
  conn.shell(
    {
      cols: s.cols,
      rows: s.rows,
      term: "xterm-256color",
      mode: { echo: true, input: 1, output: 1, opost: 1, obaud: 38400 },
    },
    { env: ["TERM=xterm-256color"] },
    (err, stream) => {
      if (err) return failSession(s, "Shell request failed: " + err.message);
      s.shell = stream;
      stream.on("data", (d) => send(s.ws, { type: "data", data: d.toString("utf8") }));
      stream.stderr.on("data", (d) =>
        send(s.ws, { type: "data", data: d.toString("utf8") }),
      );
      log(s, "success", "Shell ready");
      send(s.ws, { type: "connected" });
    },
  );
}

function tryAuthWithCredential(s, code) {
  const conn = s.conn;
  if (s.done) return;
  s.phase = "awaiting-password";
  s.userTried = true;

  // FORK: the connection dropped while the credential dialog was open
  // (common when the server closes right after a rejected "none" auth).
  // Start a fresh connection: plain-password hosts retry with the typed
  // code; keyboard-interactive (TOTP) hosts get re-prompted by the server.
  if (!conn) {
    const wasKeyboardInteractive = Boolean(s.kiState);
    s.kiState = null;
    if (!wasKeyboardInteractive && code) s.host.password = code;
    openSSH(s);
    return;
  }

  if (s.kiState) {
    // Respond to the keyboard-interactive prompt the server opened.
    const onPrompt = s.kiState.onPrompt;
    s.kiState = null;
    try {
      onPrompt([code]);
    } catch (e) {
      failSession(s, "Interactive auth failed: " + e.message);
    }
    return;
  }
  try {
    conn.auth(s.host.username, code);
    // Success is signalled via 'ready'; failure via 'error'.
  } catch (e) {
    // FORK: the socket is already gone (e.g. the server closed right after
    // the rejected "none" auth) — reconnect with the typed password instead
    // of re-prompting against a dead socket (would loop forever).
    if (code) s.host.password = code;
    s.conn = null;
    openSSH(s);
    // openSSH() resets userTried — re-flag it: this attempt carries a
    // user-typed code, so a rejection must re-prompt (retry), not fail.
    s.userTried = true;
  }
}

function handleHostKeyResponse(s, action) {
  if (s.phase !== "awaiting-hostkey") return;
  const verifyCb = s.hostKeyVerifierCb;
  s.hostKeyVerifierCb = null;
  if (action === "accept") {
    const keyId = s.host.ip + ":" + s.host.port;
    knownHosts[keyId] = {
      fingerprint: s.pendingKeyInfo.fingerprint,
      keyType: s.pendingKeyInfo.keyType,
      algorithm: s.pendingKeyInfo.algorithm,
    };
    saveKnownHosts();
    s.phase = "handshake";
    if (s.conn) {
      if (typeof verifyCb === "function") verifyCb(true);
      return;
    }
    // FORK: the connection died while the dialog was open (e.g. ready
    // timeout) — reconnect; the just-stored fingerprint is auto-accepted
    // on the new handshake.
    openSSH(s);
    return;
  }
  if (typeof verifyCb === "function") {
    try {
      verifyCb(false);
    } catch (_) {
      /* conn already gone */
    }
  }
  failSession(s, "Host key rejected by user");
}

// ---------------------------------------------------------------------------
// WebSocket server (loopback only)
// ---------------------------------------------------------------------------
const sessions = new Map(); // ws -> session

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_) {
    return;
  }
  const s = sessions.get(ws);

  switch (msg.type) {
    case "connectToHost": {
      if (s && s.conn) {
        try {
          s.conn.end();
        } catch (_) {
          /* noop */
        }
      }
      const session = makeSession(
        ws,
        msg.data && msg.data.hostConfig ? msg.data.hostConfig : {},
        (msg.data && msg.data.cols) || 80,
        (msg.data && msg.data.rows) || 24,
      );
      sessions.set(ws, session);
      openSSH(session);
      break;
    }

    case "attachSession": {
      // No persistent sessions in standalone mode — the RN side falls back
      // to a fresh connectToHost when it sees sessionExpired.
      send(ws, { type: "sessionExpired" });
      break;
    }

    case "input": {
      if (s && s.shell && s.phase === "connected") {
        try {
          s.shell.write(msg.data);
        } catch (_) {
          /* noop */
        }
      }
      break;
    }

    case "resize": {
      if (s && s.shell && s.phase === "connected") {
        s.cols = (msg.data && msg.data.cols) || s.cols;
        s.rows = (msg.data && msg.data.rows) || s.rows;
        try {
          // NOTE: must be the CHANNEL's setWindow (sends
          // SSH_MSG_CHANNEL_WINDOW_CHANGE -> sshd -> TIOCSWINSZ -> SIGWINCH).
          // Client has no setWindow in ssh2 1.x — the old s.conn.setWindow
          // call threw inside try/catch and the pty never resized, so TUIs
          // (opencode) never redrew on keyboard show/hide.
          s.shell.setWindow(s.rows, s.cols, 0, 0);
        } catch (_) {
          /* noop */
        }
        send(ws, { type: "resized" });
      }
      break;
    }

    case "ping":
      break; // keep-alive; nothing to echo

    case "disconnect": {
      if (s) {
        s.done = true;
        try {
          if (s.conn) s.conn.end();
        } catch (_) {
          /* noop */
        }
        sessions.delete(ws);
      }
      try {
        ws.close();
      } catch (_) {
        /* noop */
      }
      break;
    }

    case "password_response":
    case "totp_response": {
      if (s && s.phase === "awaiting-password") {
        tryAuthWithCredential(s, (msg.data && msg.data.code) || "");
      }
      break;
    }

    case "reconnect_with_credentials": {
      // RN sends { data: { password, sshKey, keyPassword, hostConfig, cols, rows } }.
      if (!s || s.done) break;
      const d = (msg && msg.data) || {};
      if (d.password) s.host.password = d.password;
      if (d.sshKey) s.host.privateKey = d.sshKey;
      if (d.keyPassword) s.host.keyPassword = d.keyPassword;
      if (d.hostConfig) {
        if (d.hostConfig.ip) s.host.ip = d.hostConfig.ip;
        if (d.hostConfig.port) s.host.port = Number(d.hostConfig.port) || s.host.port;
        if (d.hostConfig.username) s.host.username = d.hostConfig.username;
        if (d.hostConfig.password) s.host.password = d.hostConfig.password;
        if (d.hostConfig.key) s.host.privateKey = d.hostConfig.key;
        if (d.hostConfig.keyPassword) s.host.keyPassword = d.hostConfig.keyPassword;
      }
      if (d.cols) s.cols = d.cols;
      if (d.rows) s.rows = d.rows;
      s.authPrompted = false;
      s.userTried = false;
      try {
        if (s.conn) s.conn.end();
      } catch (_) {
        /* noop */
      }
      if (s.phase === "connected") break;
      openSSH(s);
      break;
    }

    case "host_key_verification_response": {
      if (s && s.phase === "awaiting-hostkey") {
        handleHostKeyResponse(s, msg.data && msg.data.action);
      }
      break;
    }

    case "warpgate_auth_continue":
      break; // not supported in standalone mode

    default:
      break;
  }
}

let wss = null;

function listen(port) {
  wss = new WebSocketServer({ host: "127.0.0.1", port, path: "/terminal" });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => handleMessage(ws, raw));
    ws.on("close", () => {
      const s = sessions.get(ws);
      if (s) {
        s.done = true;
        try {
          if (s.conn) s.conn.end();
        } catch (_) {
          /* noop */
        }
        sessions.delete(ws);
      }
    });
    ws.on("error", () => {
      /* handled by close */
    });
  });
  wss.on("error", (err) => {
    rn_bridge.channel.send("local-terminal-error:" + ((err && err.message) || "unknown"));
  });
  wss.on("listening", () => {
    const actual = wss.address() && wss.address().port;
    rn_bridge.channel.send("local-terminal-ready:" + actual);
  });
}

// port 0 -> OS picks a free port; the real one is reported to the RN side.
listen(0);
