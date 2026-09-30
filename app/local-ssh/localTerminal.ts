// FORK: launches the embedded Node.js SSH engine (nodejs-mobile) exactly
// once per app lifecycle and resolves with the loopback port it listens on.
// The engine (nodejs-project/main.js) announces readiness over the
// rn-bridge channel: "local-terminal-ready:<port>".
import nodejs from "nodejs-mobile-react-native";

type ReadyHandler = (msg: string) => void;

let resolvedPort: number | null = null;
let starting: Promise<number> | null = null;
let channelListener: ReadyHandler | null = null;

function armChannelListener(): void {
  if (channelListener) return;
  channelListener = (msg: string) => {
    if (typeof msg !== "string") return;
    if (msg.startsWith("local-terminal-ready:")) {
      const port = parseInt(msg.slice("local-terminal-ready:".length), 10);
      if (Number.isFinite(port) && port > 0) {
        resolvedPort = port;
      }
    }
    // "local-terminal-error:..." is intentionally ignored here: the WS layer
    // surfaces connection problems to the terminal UI.
  };
  try {
    nodejs.channel.addListener("message", channelListener);
  } catch (_) {
    /* listener already attached */
  }
}

/**
 * Starts the local SSH engine if needed and resolves with its WS port.
 * Callers should treat rejections as "standalone mode currently broken".
 */
export function ensureLocalSshServer(): Promise<number> {
  if (resolvedPort !== null) {
    return Promise.resolve(resolvedPort);
  }
  if (!starting) {
    starting = startEngine().catch((err) => {
      starting = null; // allow a later retry after an engine failure
      throw err;
    });
  }
  return starting;
}

function startEngine(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    armChannelListener();

    const timer = setTimeout(() => {
      reject(
        new Error(
          "Local SSH engine did not start within 30s (nodejs-mobile runtime missing?)",
        ),
      );
    }, 30000);

    const poll = setInterval(() => {
      if (resolvedPort !== null) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(resolvedPort);
      }
    }, 200);

    try {
      // start() returns void; readiness (and the port) arrive over the
      // rn-bridge channel, which the poll loop above watches.
      nodejs.start("main.js");
    } catch (err) {
      clearTimeout(timer);
      clearInterval(poll);
      reject(
        new Error(
          "Failed to start local SSH engine: " +
            (err instanceof Error ? err.message : String(err)),
        ),
      );
    }
  });
}
