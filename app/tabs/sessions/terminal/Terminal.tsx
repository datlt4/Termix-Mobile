import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import {
  View,
  Text,
  ActivityIndicator,
  Dimensions,
  AccessibilityInfo,
  TouchableOpacity,
  type LayoutChangeEvent,
} from "react-native";
import { WebView } from "react-native-webview";
import { ChevronDown } from "lucide-react-native";
import {
  logActivity,
  getSnippets,
  saveCommandToHistory,
  rememberLocalHostPassword,
} from "../../../main-axios";
import { showToast } from "../../../utils/toast";
import { useTerminalCustomization } from "../../../contexts/TerminalCustomizationContext";
import {
  BACKGROUNDS,
  ACCENT,
  TEXT_COLORS,
} from "../../../constants/designTokens";
import {
  TOTPDialog,
  SSHAuthDialog,
  HostKeyVerificationDialog,
  PassphraseDialog,
  WarpgateDialog,
} from "@/app/tabs/dialogs";
import { TERMINAL_THEMES, TERMINAL_FONTS } from "@/constants/terminal-themes";
import { MOBILE_DEFAULT_TERMINAL_CONFIG } from "@/constants/terminal-config";
import type { TerminalConfig } from "@/types";
import {
  NativeWebSocketManager,
  type TerminalHostConfig,
  type HostKeyData,
} from "./NativeWebSocketManager";
import { loadXtermAssets } from "./loadXtermAssets";
import { useConnectionLog, ConnectionLog } from "../_shared/useConnectionLog";

interface TerminalProps {
  hostConfig: {
    id: number;
    name: string;
    ip: string;
    port: number;
    username: string;
    authType: "password" | "key" | "credential" | "none";
    password?: string;
    key?: string;
    keyPassword?: string;
    keyType?: string;
    credentialId?: number;
    jumpHosts?: { hostId: number }[];
    forceKeyboardInteractive?: boolean;
    overrideCredentialUsername?: boolean;
    terminalConfig?: Partial<TerminalConfig>;
  };
  isVisible: boolean;
  title?: string;
  onClose?: () => void;
  onBackgroundColorChange?: (color: string) => void;
  /** Stable tab instance id (cross-device session tracking). */
  tabInstanceId?: string;
  /** Backend session id to attach to on first connect (reviving a tab). */
  initialSessionId?: string | null;
  /** Fired when the backend session id is created/attached/cleared. */
  onSessionIdChange?: (sessionId: string | null) => void;
}

export type TerminalHandle = {
  sendInput: (data: string) => void;
  fit: () => void;
  isDialogOpen: () => boolean;
  notifyBackgrounded: () => void;
  notifyForegrounded: () => void;
  scrollToBottom: () => void;
  isSelecting: () => boolean;
};

const TerminalComponent = forwardRef<TerminalHandle, TerminalProps>(
  (
    {
      hostConfig,
      isVisible,
      title = "Terminal",
      onClose,
      onBackgroundColorChange,
      tabInstanceId,
      initialSessionId,
      onSessionIdChange,
    },
    ref,
  ) => {
    const webViewRef = useRef<WebView>(null);
    const wsManagerRef = useRef<NativeWebSocketManager | null>(null);
    // FORK: standalone mode — a password typed into the auth dialog, kept
    // until the session actually connects, then stored on the local host.
    const lastTypedPasswordRef = useRef<{
      hostId: number;
      code: string;
    } | null>(null);
    const terminalColsRef = useRef(80);
    const terminalRowsRef = useRef(24);
    // Pixel height of the visible terminal area as measured by RN layout.
    // The WebView is shrunk by the TabBar/KeyboardBar/system-keyboard via the
    // parent's marginBottom, but inside the WebView `100vh`/`window.innerHeight`
    // is unreliable (WKWebView reports stale values after a frame resize). Pushing
    // the exact laid-out height lets xterm compute the correct row count, so TUI
    // apps (Claude Code, Codex, …) draw their bottom input row inside the visible
    // area instead of behind the chrome.
    const viewportHeightRef = useRef<number | null>(null);
    // Debounces onLayout pushes during LayoutAnimation / keyboard slide so the
    // pty isn't spammed with resize storms (each resize → SIGWINCH → TUI redraw).
    const viewportDebounceTimerRef = useRef<ReturnType<
      typeof setTimeout
    > | null>(null);
    const pendingDataRef = useRef<string[]>([]);
    // Buffers typed characters so a command can be saved to history on Enter.
    const commandBufferRef = useRef("");

    const recordCommandInput = useCallback(
      (data: string) => {
        for (const ch of data) {
          if (ch === "\r" || ch === "\n") {
            const command = commandBufferRef.current.trim();
            commandBufferRef.current = "";
            if (command.length > 1 && hostConfig.id > 0) {
              saveCommandToHistory(hostConfig.id, command);
            }
          } else if (ch === "\x7f" || ch === "\b") {
            commandBufferRef.current = commandBufferRef.current.slice(0, -1);
          } else if (ch === "\x03" || ch === "\x15") {
            commandBufferRef.current = "";
          } else if (ch >= " ") {
            commandBufferRef.current += ch;
          }
        }
      },
      [hostConfig.id],
    );
    const dataFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );

    const { config } = useTerminalCustomization();
    const log = useConnectionLog();
    const [webViewKey, setWebViewKey] = useState(0);
    const [screenDimensions, setScreenDimensions] = useState(
      Dimensions.get("window"),
    );
    type ConnectionState =
      | "connecting"
      | "connected"
      | "reconnecting"
      | "disconnected"
      | "failed";
    const [connectionState, setConnectionState] =
      useState<ConnectionState>("connecting");
    const [retryCount, setRetryCount] = useState(0);
    const [hasReceivedData, setHasReceivedData] = useState(false);
    const [htmlContent, setHtmlContent] = useState("");
    const [terminalBackgroundColor, setTerminalBackgroundColor] =
      useState<string>(BACKGROUNDS.DARKEST);

    const [totpRequired, setTotpRequired] = useState(false);
    const [totpPrompt, setTotpPrompt] = useState("");
    const [isPasswordPrompt, setIsPasswordPrompt] = useState(false);
    const [showAuthDialog, setShowAuthDialog] = useState(false);
    const [authDialogReason, setAuthDialogReason] = useState<
      "no_keyboard" | "auth_failed" | "timeout"
    >("auth_failed");
    const [passphraseRequired, setPassphraseRequired] = useState(false);
    const [warpgateAuth, setWarpgateAuth] = useState<{
      url: string;
      securityKey: string;
    } | null>(null);
    const [isSelecting, setIsSelecting] = useState(false);
    const [showScrollToBottomButton, setShowScrollToBottomButton] =
      useState(false);
    const [hostKeyVerification, setHostKeyVerification] = useState<{
      scenario: "new" | "changed";
      data: HostKeyData;
    } | null>(null);

    const xtermAssetsRef = useRef<{
      xtermJs: string;
      xtermCss: string;
      fitAddonJs: string;
      canvasAddonJs: string;
      nerdFontBase64?: string;
    } | null>(null);

    const [isScreenReaderEnabled, setIsScreenReaderEnabled] = useState(false);
    const isScreenReaderEnabledRef = useRef(false);
    const [accessibilityText, setAccessibilityText] = useState("");
    const accessibilityBufferRef = useRef<string[]>([]);
    const accessibilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );

    useEffect(() => {
      AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
        setIsScreenReaderEnabled(enabled);
        isScreenReaderEnabledRef.current = enabled;
      });
      const subscription = AccessibilityInfo.addEventListener(
        "screenReaderChanged",
        (enabled) => {
          setIsScreenReaderEnabled(enabled);
          isScreenReaderEnabledRef.current = enabled;
        },
      );
      return () => subscription.remove();
    }, []);

    const writeToAccessibility = useCallback((rawData: string) => {
      const cleaned = rawData
        .replace(/\x1b\[[0-9;]*[mGKHJABCDsu]/g, "")
        .replace(/\x1b\][^\x07]*\x07/g, "")
        .replace(/\x1b[()][AB012]/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
        .trim();

      if (!cleaned) return;

      const lines = cleaned.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length === 0) return;

      accessibilityBufferRef.current.push(...lines);
      if (accessibilityBufferRef.current.length > 5) {
        accessibilityBufferRef.current =
          accessibilityBufferRef.current.slice(-5);
      }

      if (accessibilityTimerRef.current) {
        clearTimeout(accessibilityTimerRef.current);
      }
      accessibilityTimerRef.current = setTimeout(() => {
        accessibilityTimerRef.current = null;
        const text = accessibilityBufferRef.current.join("\n");
        accessibilityBufferRef.current = [];
        setAccessibilityText(text);
        AccessibilityInfo.announceForAccessibility(text);
      }, 500);
    }, []);

    useEffect(() => {
      const subscription = Dimensions.addEventListener(
        "change",
        ({ window }) => {
          setScreenDimensions(window);
        },
      );

      return () => subscription?.remove();
    }, []);

    const handleConnectionFailure = useCallback(
      (errorMessage: string) => {
        showToast.error(errorMessage);
        setConnectionState("failed");
        if (onClose) {
          onClose();
        }
      },
      [onClose],
    );

    const generateHTML = useCallback(
      (assets: {
        xtermJs: string;
        xtermCss: string;
        fitAddonJs: string;
        canvasAddonJs: string;
        nerdFontBase64?: string;
      }) => {
        const { width, height } = screenDimensions;

        const terminalConfig: Partial<TerminalConfig> = {
          ...MOBILE_DEFAULT_TERMINAL_CONFIG,
          ...config,
          ...hostConfig.terminalConfig,
        };

        const baseFontSize = config.fontSize || 16;
        const charWidth = baseFontSize * 0.6;
        const lineHeight = baseFontSize * 1.2;
        const terminalWidth = Math.floor(width / charWidth);
        const terminalHeight = Math.floor(height / lineHeight);

        void terminalWidth;
        void terminalHeight;

        const themeName = terminalConfig.theme || "termix";
        const themeColors =
          TERMINAL_THEMES[themeName]?.colors || TERMINAL_THEMES.termix.colors;

        const bgColor = themeColors.background;
        setTerminalBackgroundColor(bgColor);
        if (onBackgroundColorChange) {
          onBackgroundColorChange(bgColor);
        }

        const fontConfig = TERMINAL_FONTS.find(
          (f) => f.value === terminalConfig.fontFamily,
        );
        const fontFamily = fontConfig?.fallback || TERMINAL_FONTS[0].fallback;
        const nerdFontFace = assets.nerdFontBase64
          ? `@font-face {
      font-family: "Caskaydia Cove Nerd Font Mono";
      src: url("data:font/ttf;base64,${assets.nerdFontBase64}") format("truetype");
      font-style: normal;
      font-weight: 400;
      font-display: block;
    }`
          : "";

        return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terminal</title>
  <style>${assets.xtermCss}</style>
  <script>${assets.xtermJs}</script>
  <script>${assets.fitAddonJs}</script>
  <script>${assets.canvasAddonJs}</script>
  <style>
    ${nerdFontFace}

    body {
      margin: 0;
      padding: 4px 4px 0 4px;
      background-color: ${themeColors.background};
      font-family: ${fontFamily};
      overflow: hidden;
      width: 100vw;
      height: 100vh;
      box-sizing: border-box;
    }

    /* Padding lives on body, not #terminal: the fit addon derives the row
       count from #terminal's height but subtracts .xterm's padding (which is
       0), so any padding here would not be accounted for and the bottom row
       would be clipped. No bottom padding: the row count is floored, so up to
       a cell of slack already sits below the last row. */
    #terminal {
      width: 100%;
      height: 100%;
      margin: 0;
      box-sizing: border-box;
    }

    .xterm {
      width: 100% !important;
      height: 100% !important;
    }

    .xterm-viewport {
      width: 100% !important;
      height: 100% !important;
      overflow: hidden !important;
      -webkit-overflow-scrolling: auto;
    }

    /* Disable native touch-scrolling of the embedded terminal at the source.
       The terminal is scroll-driven exclusively by JS (synthetic WheelEvent →
       viewport.scrollTop). Without this, iOS WKWebView / Android WebView's
       native touch scroll of .xterm-viewport bubbles to the page when the
       (alternate) buffer is at its top, scrolling the whole WebView instead of
       the terminal. */
    html, body, #terminal, .xterm, .xterm-viewport, .xterm-screen {
      touch-action: none;
      -webkit-touch-action: none;
      -ms-touch-action: none;
    }

    .xterm {
      font-feature-settings: "liga" 1, "calt" 1;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .xterm .xterm-screen {
      font-family: ${fontFamily} !important;
      font-variant-ligatures: contextual;
    }

    .xterm .xterm-screen .xterm-char {
      font-feature-settings: "liga" 1, "calt" 1;
    }

    .xterm .xterm-viewport::-webkit-scrollbar {
      width: 8px;
      background: transparent;
    }
    .xterm .xterm-viewport::-webkit-scrollbar-thumb {
      background: rgba(180,180,180,0.7);
      border-radius: 4px;
    }
    .xterm .xterm-viewport::-webkit-scrollbar-thumb:hover {
      background: rgba(120,120,120,0.9);
    }
    .xterm .xterm-viewport {
      scrollbar-width: thin;
      scrollbar-color: rgba(180,180,180,0.7) transparent;
    }
    * {
      -webkit-tap-highlight-color: transparent;
      -webkit-touch-callout: none;
    }
    html, body, #terminal, .xterm {
      user-select: text;
      -webkit-user-select: text;
      -ms-user-select: text;
      -moz-user-select: text;
    }

    input, textarea, [contenteditable], .xterm-helper-textarea {
      position: absolute !important;
      left: -9999px !important;
      top: -9999px !important;
      width: 1px !important;
      height: 1px !important;
      opacity: 0 !important;
      pointer-events: none !important;
      color: transparent !important;
      background: transparent !important;
      border: none !important;
      outline: none !important;
      caret-color: transparent !important;
      -webkit-text-fill-color: transparent !important;
    }

  </style>
</head>
<body>
  <div id="terminal"></div>

  <script>
    // [termix-dbg] WebView console.log does not reach Android logcat, so
    // mirror [termix] lines to React Native (shows up as ReactNativeJS).
    (function () {
      var origLog = console.log;
      console.log = function () {
        var msg = Array.prototype.join.call(arguments, " ");
        if (msg.indexOf("[termix]") === 0) {
          try {
            if (window.ReactNativeWebView) {
              window.ReactNativeWebView.postMessage(
                JSON.stringify({ type: "termixDbg", data: msg }),
              );
            }
          } catch (e) {}
        }
        origLog.apply(console, arguments);
      };
    })();

    const screenWidth = ${width};
    const screenHeight = ${height};

    const baseFontSize = ${baseFontSize};

    const terminal = new Terminal({
      cursorBlink: ${terminalConfig.cursorBlink || false},
      cursorStyle: '${terminalConfig.cursorStyle || "bar"}',
      scrollback: ${terminalConfig.scrollback || 10000},
      fontSize: baseFontSize,
      fontFamily: ${JSON.stringify(fontFamily)},
      letterSpacing: ${terminalConfig.letterSpacing || 0},
      lineHeight: ${terminalConfig.lineHeight || 1.2},
      theme: {
        background: '${themeColors.background}',
        foreground: '${themeColors.foreground}',
        cursor: '${themeColors.cursor || themeColors.foreground}',
        cursorAccent: '${themeColors.cursorAccent || themeColors.background}',
        selectionBackground: '${themeColors.selectionBackground || "rgba(255, 255, 255, 0.3)"}',
        selectionForeground: '${themeColors.selectionForeground || ""}',
        black: '${themeColors.black}',
        red: '${themeColors.red}',
        green: '${themeColors.green}',
        yellow: '${themeColors.yellow}',
        blue: '${themeColors.blue}',
        magenta: '${themeColors.magenta}',
        cyan: '${themeColors.cyan}',
        white: '${themeColors.white}',
        brightBlack: '${themeColors.brightBlack}',
        brightRed: '${themeColors.brightRed}',
        brightGreen: '${themeColors.brightGreen}',
        brightYellow: '${themeColors.brightYellow}',
        brightBlue: '${themeColors.brightBlue}',
        brightMagenta: '${themeColors.brightMagenta}',
        brightCyan: '${themeColors.brightCyan}',
        brightWhite: '${themeColors.brightWhite}'
      },
      allowTransparency: true,
      convertEol: true,
      // The a11y DOM mirror is very expensive on mobile; only enable it
      // when the OS screen reader is actually active.
      screenReaderMode: ${isScreenReaderEnabled},
      windowsMode: false,
      macOptionIsMeta: false,
      macOptionClickForcesSelection: false,
      rightClickSelectsWord: false,
      fastScrollModifier: 'alt',
      fastScrollSensitivity: 5,
      allowProposedApi: true,
      disableStdin: true,
      cursorInactiveStyle: '${terminalConfig.cursorStyle || "bar"}'
    });

    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);

    // Prefer the canvas renderer on mobile: the DOM renderer is much slower
    // for scrolling and high-volume output. Fall back to DOM rendering if the
    // canvas addon is unavailable or fails against this xterm build.
    try {
      if (window.CanvasAddon) {
        terminal.loadAddon(new window.CanvasAddon.CanvasAddon());
      }
    } catch (e) {
      console.warn('canvas renderer unavailable, using DOM renderer', e);
    }

    terminal.open(document.getElementById('terminal'));

    // Bridge xterm-originated wheel input back to the pty. Stdin remains
    // disabled outside the synchronous wheel dispatch below, so keyboard text
    // continues to use only the React Native input path.
    terminal.onData(function(data) {
      try {
        termixLog('onData', data.length + 'b ' + JSON.stringify(String(data).slice(0, 16)));
      } catch (e) {}
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'input', data: data }));
      }
    });

    fitAddon.fit();
    terminal.write('\x1b[?25h');

    setTimeout(() => {
      const inputs = document.querySelectorAll('input, textarea, .xterm-helper-textarea');
      inputs.forEach(input => {
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('autocorrect', 'off');
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('spellcheck', 'false');
        input.style.color = 'transparent';
        input.style.caretColor = 'transparent';
        input.style.webkitTextFillColor = 'transparent';
      });
    }, 100);

    let isScrolledToBottom = true;
    let scrollStateFrame = null;

    function getIsScrolledToBottom() {
      try {
        return terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
      } catch(e) {
        return true;
      }
    }

    function postScrollState() {
      const nextIsAtBottom = getIsScrolledToBottom();
      if (nextIsAtBottom === isScrolledToBottom) {
        return;
      }

      isScrolledToBottom = nextIsAtBottom;
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'scrollState',
          data: { isAtBottom: isScrolledToBottom }
        }));
      }
    }

    function scheduleScrollStateUpdate() {
      if (scrollStateFrame !== null) {
        return;
      }

      scrollStateFrame = requestAnimationFrame(function() {
        scrollStateFrame = null;
        postScrollState();
      });
    }

    terminal.onScroll(scheduleScrollStateUpdate);

    // connectionEpoch is incremented each time notifyConnected fires.
    // The write callback captures its epoch at call time; if it no longer
    // matches the current epoch the connection already moved on, so we skip
    // the dataReceived notification to avoid spurious state changes.
    let connectionEpoch = 0;
    let notifiedEpoch = -1;
    window.writeToTerminal = function(data) {
      const shouldStickToBottom = getIsScrolledToBottom();
      const capturedEpoch = connectionEpoch;
      try {
        terminal.write(data, function() {
          if (notifiedEpoch !== capturedEpoch) {
            notifiedEpoch = capturedEpoch;
            if (window.ReactNativeWebView) {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'dataReceived' }));
            }
          }
          if (shouldStickToBottom) {
            terminal.scrollToBottom();
          }
          scheduleScrollStateUpdate();
        });
      } catch(e) {}
    };

    window.notifyConnected = function(fromBackground, isReattach) {
      connectionEpoch += 1;
      terminal.clear();
      if (isReattach) {
        terminal.write('\\x1b[2J\\x1b[H\\x1b[?25h');
      } else {
        terminal.reset();
        terminal.write('\\x1b[2J\\x1b[H\\x1b[?25h');
      }
    };

    const terminalElement = document.getElementById('terminal');

    window.resetScroll = function() {
      terminal.scrollToBottom();
      scheduleScrollStateUpdate();
    }

    document.addEventListener('focusin', function(e) {
      if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (e.target && e.target.blur) {
          e.target.blur();
        }
        return false;
      }
    }, true);

    document.addEventListener('focus', function(e) {
      if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (e.target && e.target.blur) {
          e.target.blur();
        }
        return false;
      }
    }, true);

    terminalElement.addEventListener('contextmenu', function(e){
      e.preventDefault();
      e.stopPropagation();
      return false;
    }, { passive: false });

    // [termix-dbg] Light tracing to logcat (chromium console) to diagnose
    // scroll / input / resize issues on device.
    function termixLog(tag, extra) {
      try { console.log('[termix] ' + tag + (extra ? ' ' + extra : '')); } catch (e) {}
    }
    // True while a TUI (opencode & friends) has mouse tracking enabled and
    // therefore owns every pointer gesture on the terminal surface.
    function termixMouseActive() {
      try {
        var svc = terminal._core.coreMouseService || terminal._core._coreMouseService;
        return !!svc && !!svc.areMouseEventsActive;
      } catch (err) { return false; }
    }

    let selectionEndTimeout = null;
    let isCurrentlySelecting = false;
    let lastInteractionTime = Date.now();
    let touchStartTime = 0;
    let touchStartX = 0;
    let touchStartY = 0;
    let hasMoved = false;
    let longPressTimeout = null;

    terminalElement.addEventListener('touchstart', (e) => {
      lastInteractionTime = Date.now();
      touchStartTime = Date.now();
      hasMoved = false;

      if (e.touches && e.touches.length > 0) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }

      if (longPressTimeout) {
        clearTimeout(longPressTimeout);
      }

      longPressTimeout = setTimeout(() => {
        if (!hasMoved && !termixMouseActive()) {
          if (!isCurrentlySelecting) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'selectionStart', data: {} }));
            isCurrentlySelecting = true;
          }
        }
      }, 350);
    }, { passive: true });

    terminalElement.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches.length > 0) {
        const deltaX = Math.abs(e.touches[0].clientX - touchStartX);
        const deltaY = Math.abs(e.touches[0].clientY - touchStartY);

        if (deltaX > 10 || deltaY > 10) {
          hasMoved = true;
          if (longPressTimeout) {
            clearTimeout(longPressTimeout);
            longPressTimeout = null;
          }
        }
      }
    }, { passive: true });

    terminalElement.addEventListener('touchend', () => {
      if (longPressTimeout) {
        clearTimeout(longPressTimeout);
        longPressTimeout = null;
      }

      const touchDuration = Date.now() - touchStartTime;

      setTimeout(() => {
        const selection = terminal.getSelection();
        const hasSelection = selection && selection.length > 0;

        if (hasSelection) {
          lastInteractionTime = Date.now();
          if (!isCurrentlySelecting) {
            isCurrentlySelecting = true;
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'selectionStart', data: {} }));
          }
        } else if (!isCurrentlySelecting && (touchDuration < 350 || hasMoved)) {
          lastInteractionTime = Date.now();
          checkIfDoneSelecting();
        }
      }, 100);
    });

    terminalElement.addEventListener('mousedown', (e) => {
      lastInteractionTime = Date.now();
    });

    terminalElement.addEventListener('mouseup', () => {
      lastInteractionTime = Date.now();
      checkIfDoneSelecting();
    });

    function checkIfDoneSelecting() {
      if (selectionEndTimeout) {
        clearTimeout(selectionEndTimeout);
      }

      selectionEndTimeout = setTimeout(() => {
        const selection = terminal.getSelection();
        const hasSelection = selection && selection.length > 0;

        if (hasSelection) {
          if (!isCurrentlySelecting) {
            isCurrentlySelecting = true;
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'selectionStart', data: {} }));
          }
        } else if (isCurrentlySelecting) {
          const timeSinceLastInteraction = Date.now() - lastInteractionTime;
          if (timeSinceLastInteraction >= 150) {
            isCurrentlySelecting = false;
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'selectionEnd', data: {} }));
          } else {
            checkIfDoneSelecting();
          }
        }
      }, 100);
    }

    terminal.onSelectionChange(() => {
      const selection = terminal.getSelection();
      const hasSelection = selection && selection.length > 0;

      if (hasSelection) {
        lastInteractionTime = Date.now();
        if (!isCurrentlySelecting) {
          isCurrentlySelecting = true;
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'selectionStart', data: {} }));
        }
      } else if (isCurrentlySelecting) {
        lastInteractionTime = Date.now();
        checkIfDoneSelecting();
      }
    });

    function handleResize() {
      fitAddon.fit();
      termixLog('fit', 'cols=' + terminal.cols + ' rows=' + terminal.rows);
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'resize',
          data: { cols: terminal.cols, rows: terminal.rows }
        }));
      }
    }

    var lastViewportHeight = null;
    function applyViewportHeight(px, force) {
      var el = document.getElementById('terminal');
      if (!el || !px || px <= 0) return;
      if (!force && Math.abs(px - (lastViewportHeight || 0)) < 1) return;
      lastViewportHeight = px;

      // px is the RN-measured height of the whole WebView; body's vertical
      // padding has to come off before sizing #terminal, or the fit addon
      // rounds up a row that then gets clipped.
      var bodyStyle = window.getComputedStyle(document.body);
      var vPad = (parseFloat(bodyStyle.paddingTop) || 0) +
                 (parseFloat(bodyStyle.paddingBottom) || 0);
      el.style.height = Math.max(0, px - vPad) + 'px';
      el.style.minHeight = '0px';

      try {
        fitAddon.fit();
        termixLog('viewport', 'px=' + px + ' cols=' + terminal.cols + ' rows=' + terminal.rows);
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'resize',
            data: { cols: terminal.cols, rows: terminal.rows }
          }));
        }
        // If the user was scrolled near the bottom, keep them pinned there so
        // the prompt/TUI input row stays visible after the resize.
        try {
          if (terminal.buffer.active.viewportY >= terminal.buffer.active.baseY - 1) {
            terminal.scrollToBottom();
          }
        } catch(e2) {}
      } catch(e) {}
    }
    window.setTerminalViewportHeight = function(px) {
      applyViewportHeight(px, false);
    }

    // Re-fit using the last RN-measured viewport height (if known) instead of
    // the possibly-stale 100vh, so RN-driven resizes (keyboard, orientation,
    // chrome show/hide) keep the row count in sync with the visible area.
    window.nativeFit = function() {
      if (lastViewportHeight) {
        applyViewportHeight(lastViewportHeight, true);
      } else {
        try { handleResize(); } catch(e) {}
      }
    }

    window.addEventListener('resize', function() {
      // Prefer the RN-measured height; fall back to the WebView's own viewport
      // when RN hasn't measured yet (e.g. initial load before onLayout).
      if (lastViewportHeight) {
        applyViewportHeight(lastViewportHeight, true);
      } else {
        try { handleResize(); } catch(e) {}
      }
    });

    window.addEventListener('orientationchange', function() {
      setTimeout(handleResize, 100);
    });

    // Wheel normalizer: mouse / trackpad wheels (USB / Bluetooth on Android,
    // some desktop browsers) report LINE-mode deltas — 1 notch = exactly 1
    // line, which is what made scrolling feel stuck at a single line.
    // Termius scrolls ~3 lines per notch, so re-emit LINE-mode events as
    // PIXEL-mode events multiplied 3x before xterm's own handler runs.
    // xterm then does the rest natively: viewport scroll on the normal
    // buffer, arrow-key sequences on a TUI (alt buffer).
    var WHEEL_LINES_PER_NOTCH = 3;
    terminalElement.addEventListener('wheel', function(e) {
      if (e.__termixWheel) return; // our own synthesized event
      if (e.deltaMode !== WheelEvent.DOM_DELTA_LINE || !e.cancelable) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      var rowH = 0;
      try { rowH = terminal._core._renderService.dimensions.css.cell.height; } catch (err) {}
      if (!rowH) rowH = ${baseFontSize * 1.2};
      try {
        terminal.element.dispatchEvent(new WheelEvent('wheel', {
          deltaY: e.deltaY * WHEEL_LINES_PER_NOTCH * rowH,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          cancelable: true,
          shiftKey: e.shiftKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey
        }));
      } catch (err) {}
    }, { passive: false, capture: true });

    // Touch handling, per terminal state:
    //
    // 1. TUI with SGR mouse tracking active (opencode, vim-with-mouse, ...):
    //    the app drives the whole pointer protocol. The WebView's own
    //    compatibility mouse events are invisible to the app (xterm gates
    //    every SGR mouse report behind disableStdin, which stays on so the
    //    RN input path remains the only keyboard source), so the TUI only
    //    ever sees what we forward here. A quick tap is forwarded as a
    //    synthesized click (mousedown+mouseup at the tap position), a real
    //    swipe as synthesized SGR wheel reports. Once the gesture is
    //    claimed as a swipe, preventDefault cancels the remaining
    //    compatibility mouse events so the TUI never sees a half-drag.
    //
    // 2. Regular shell: xterm already tracks the finger 1:1 with its own
    //    touchstart/touchmove handlers (viewport.scrollTop += fingerDelta),
    //    which is the smooth Termius-style swipe — we must NOT dispatch
    //    extra wheel events on the normal buffer (it would double the
    //    scroll). We only claim the gesture (preventDefault) so the
    //    WebView/page cannot hijack it.
    //
    // 3. Alt buffer without mouse tracking (classic TUIs): the viewport
    //    cannot scroll, so swipes are synthesized as wheel events; xterm
    //    converts them to arrow-key sequences the TUI understands.
    (function() {
      var SWIPE_THRESHOLD_PX = 10;
      var scrollTouchY = null;
      var gestureStartX = 0;
      var gestureStartY = 0;
      var lastX = 0;
      var lastY = 0;
      var swiping = false;
      var pendingLines = 0;
      var lineH = terminal._core._renderService.dimensions.css.cell.height || ${baseFontSize * 1.2};

      function mouseActive() {
        try {
          var svc = terminal._core.coreMouseService || terminal._core._coreMouseService;
          return !!svc && !!svc.areMouseEventsActive;
        } catch (err) { return false; }
      }
      function inAltBuffer() {
        try { return terminal.buffer.active === terminal.buffer.alternate; } catch (err) { return false; }
      }
      // The SGR report emitters respect disableStdin, so forward
      // synthesized pointer input only inside a brief stdin window.
      function dispatchWithStdin(fn) {
        terminal.options.disableStdin = false;
        try {
          fn();
        } finally {
          terminal.options.disableStdin = true;
        }
      }
      function dispatchSyntheticWheel(whole) {
        dispatchWithStdin(function() {
          var ev = new WheelEvent('wheel', {
            deltaY: whole * WHEEL_LINES_PER_NOTCH,
            deltaMode: WheelEvent.DOM_DELTA_LINE,
            cancelable: true,
            clientX: lastX,
            clientY: lastY
          });
          ev.__termixWheel = true;
          terminal.element.dispatchEvent(ev);
        });
      }

      // SGR wheel reports arrive at the TUI as discrete ticks. TUIs
      // (opencode) coalesce ticks that land in the same frame, so a burst of
      // N reports from one fast swipe scrolled as if it were one tick.
      // The queue is fed on EVERY touchmove (so it follows the finger in
      // real time — finger moves, ticks flow; finger stops, ticks stop) and
      // drained as fast as frames allow (~8ms ≈ 120 ticks/s): the TUI then
      // scrolls continuously while the finger is in motion, and any leftover
      // from a fling drains as a short momentum tail (Termius-like feel).
      var wheelQueue = 0;
      var wheelTimer = null;
      function queueWheel(lines) {
        wheelQueue += lines;
        if (wheelTimer) return;
        wheelTimer = setInterval(function() {
          if (wheelQueue === 0) {
            clearInterval(wheelTimer);
            wheelTimer = null;
            return;
          }
          var step = wheelQueue > 0 ? 1 : -1;
          // Drain up to 3 lines per tick. A burst of separate SGR reports
          // is handled fine by the TUI (verified on opencode), so at this
          // drain rate the queue cannot build up during a steady drag and
          // the scroll tracks the finger 1:1; only a fast fling leaves a
          // short momentum tail.
          var n = Math.min(Math.abs(wheelQueue), 3);
          wheelQueue -= step * n;
          for (var i = 0; i < n; i++) {
            try { dispatchSyntheticWheel(step); } catch (e2) {}
          }
        }, 8);
      }
      function dispatchSyntheticTap() {
        dispatchWithStdin(function() {
          terminal.element.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, cancelable: true,
            button: 0, buttons: 1,
            clientX: lastX, clientY: lastY,
            view: window
          }));
          terminal.element.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true, cancelable: true,
            button: 0, buttons: 0,
            clientX: lastX, clientY: lastY,
            view: window
          }));
        });
      }

      terminalElement.addEventListener('touchstart', function(e) {
        if (e.touches.length === 1) {
          scrollTouchY = e.touches[0].clientY;
          gestureStartX = e.touches[0].clientX;
          gestureStartY = e.touches[0].clientY;
          lastX = gestureStartX;
          lastY = gestureStartY;
          swiping = false;
          pendingLines = 0;
          termixLog('touchstart', 'mouse=' + (mouseActive() ? 1 : 0) + ' alt=' + (inAltBuffer() ? 1 : 0) + ' selecting=' + (typeof isCurrentlySelecting !== 'undefined' && isCurrentlySelecting ? 1 : 0));
        }
      }, { passive: true, capture: true });
      terminalElement.addEventListener('touchmove', function(e) {
        var t0 = e.touches && e.touches.length > 0 ? e.touches[0] : null;
        if (!t0 || scrollTouchY === null) return;
        var x = t0.clientX;
        var y = t0.clientY;
        lastX = x;
        lastY = y;

        if (mouseActive()) {
          // Mouse-tracked TUI owns the gesture. This branch must run BEFORE
          // the selection guard: a 350ms finger pause before the swipe can
          // stick isCurrentlySelecting on, which used to swallow every
          // wheel event and killed TUI scrolling.
          if (!swiping) {
            var moved = Math.abs(x - gestureStartX) + Math.abs(y - gestureStartY);
            if (moved < SWIPE_THRESHOLD_PX) return; // still a tap/click
            swiping = true;
            termixLog('swipe-start', Math.round(x) + ',' + Math.round(y));
          }
          e.preventDefault();
          var dyM = scrollTouchY - y;
          scrollTouchY = y;
          pendingLines += dyM / lineH;
          var wholeM = Math.trunc(pendingLines);
          if (wholeM !== 0) {
            pendingLines -= wholeM;
            try {
              termixLog('wheel', 'lines=' + wholeM + ' @' + Math.round(lastX) + ',' + Math.round(lastY));
              queueWheel(wholeM);
            } catch (e2) {}
          }
          return;
        }

        // While the user is text-selecting, leave the gesture alone so xterm's
        // selection drag can track the finger.
        if (typeof isCurrentlySelecting !== 'undefined' && isCurrentlySelecting) {
          return;
        }

        // Claim the gesture so WKWebView / Android WebView do not scroll the
        // whole page when the terminal content cannot scroll further.
        try { e.preventDefault(); } catch(e3) {}
        // Normal buffer: xterm's native touch handler scrolls the viewport
        // 1:1 with the finger; only the alt buffer (TUI without mouse
        // tracking) needs synthesized wheels.
        if (!inAltBuffer()) return;
        var dy = scrollTouchY - y;
        scrollTouchY = y;
        pendingLines += dy / lineH;
        var whole = Math.trunc(pendingLines);
        if (whole !== 0) {
          pendingLines -= whole;
          try { dispatchSyntheticWheel(whole); } catch (e2) {}
        }
      }, { passive: false, capture: true });
      terminalElement.addEventListener('touchend', function() {
        if (mouseActive() && !swiping && scrollTouchY !== null) {
          // Quick tap on a mouse-tracked TUI: forward the click the app
          // would otherwise never receive.
          termixLog('tap', '@' + Math.round(lastX) + ',' + Math.round(lastY));
          try { dispatchSyntheticTap(); } catch (e2) {}
        }
        scrollTouchY = null;
        swiping = false;
        pendingLines = 0;
      }, { passive: true, capture: true });
      terminalElement.addEventListener('touchcancel', function() {
        scrollTouchY = null;
        swiping = false;
        pendingLines = 0;
      }, { passive: true, capture: true });
    })();

    terminal.clear();
    terminal.reset();
    terminal.write('\\x1b[2J\\x1b[H');

    setTimeout(function() {
      fitAddon.fit();
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'terminalReady',
          data: { cols: terminal.cols, rows: terminal.rows }
        }));
      }
    }, 150);
  </script>
</body>
</html>
    `;
      },
      [
        hostConfig,
        screenDimensions,
        config.fontSize,
        config.fontFamily,
        onBackgroundColorChange,
      ],
    );

    useEffect(() => {
      const fontFamily = {
        ...MOBILE_DEFAULT_TERMINAL_CONFIG,
        ...config,
        ...hostConfig.terminalConfig,
      }.fontFamily;
      loadXtermAssets(fontFamily === "Caskaydia Cove Nerd Font Mono").then(
        (assets) => {
          xtermAssetsRef.current = assets;
          setHtmlContent(generateHTML(assets));
        },
      );
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handlePostConnectionSetup = useCallback(async () => {
      const terminalConfig: Partial<TerminalConfig> = {
        ...MOBILE_DEFAULT_TERMINAL_CONFIG,
        ...config,
        ...hostConfig.terminalConfig,
      };

      setTimeout(async () => {
        if (terminalConfig.environmentVariables?.length) {
          terminalConfig.environmentVariables.forEach((envVar, index) => {
            setTimeout(
              () => {
                const key = envVar.key;
                const value = envVar.value;
                wsManagerRef.current?.sendInput(`export ${key}="${value}"\n`);
              },
              100 * (index + 1),
            );
          });
        }

        if (terminalConfig.startupSnippetId) {
          const snippetDelay =
            100 * (terminalConfig.environmentVariables?.length || 0) + 200;
          setTimeout(async () => {
            try {
              const snippets = await getSnippets();
              const snippet = snippets.find(
                (s: any) => s.id === terminalConfig.startupSnippetId,
              );
              if (snippet) {
                wsManagerRef.current?.sendInput(`${snippet.content}\n`);
              }
            } catch (err) {
              console.warn("Failed to execute startup snippet:", err);
            }
          }, snippetDelay);
        }

        if (terminalConfig.autoMosh && terminalConfig.moshCommand) {
          const moshDelay =
            100 * (terminalConfig.environmentVariables?.length || 0) +
            (terminalConfig.startupSnippetId ? 400 : 200);
          setTimeout(() => {
            wsManagerRef.current?.sendInput(`${terminalConfig.moshCommand!}\n`);
          }, moshDelay);
        }
      }, 500);
    }, [config, hostConfig.terminalConfig]);

    const handleTotpSubmit = useCallback(
      (code: string) => {
        const wasPassword = isPasswordPrompt;
        wsManagerRef.current?.sendTotpResponse(code, wasPassword);
        // FORK: standalone mode — remember the typed password; it is saved
        // on the local host only once the session actually connects (the
        // "connected" state handler), so wrong passwords are never stored.
        if (wasPassword && code) {
          lastTypedPasswordRef.current = {
            hostId: Number(hostConfig.id),
            code,
          };
        }
        setTotpRequired(false);
        setTotpPrompt("");
        setIsPasswordPrompt(false);
        setConnectionState("connecting");
      },
      [isPasswordPrompt, hostConfig.id],
    );

    const handleAuthDialogSubmit = useCallback(
      (credentials: {
        password?: string;
        sshKey?: string;
        keyPassword?: string;
      }) => {
        wsManagerRef.current?.sendReconnectWithCredentials(
          credentials,
          terminalColsRef.current,
          terminalRowsRef.current,
        );
        setShowAuthDialog(false);
        setConnectionState("connecting");
      },
      [],
    );

    const handleTerminalLayout = useCallback((event: LayoutChangeEvent) => {
      const h = Math.round(event.nativeEvent.layout.height || 0);
      if (h <= 0 || h === viewportHeightRef.current) {
        return;
      }
      console.log(
        "[termix] onLayout h=" + h + " (prev " + viewportHeightRef.current + ")",
      );
      viewportHeightRef.current = h;
      // Debounce so mid-animation frames don't each trigger a pty resize.
      if (viewportDebounceTimerRef.current) {
        clearTimeout(viewportDebounceTimerRef.current);
      }
      viewportDebounceTimerRef.current = setTimeout(() => {
        viewportDebounceTimerRef.current = null;
        try {
          webViewRef.current?.injectJavaScript(
            `window.setTerminalViewportHeight && window.setTerminalViewportHeight(${h}); true;`,
          );
        } catch (err) {}
      }, 80);
    }, []);

    const handleWebViewMessage = useCallback((event: any) => {
      try {
        const message = JSON.parse(event.nativeEvent.data);

        switch (message.type) {
          case "terminalReady":
            terminalColsRef.current = message.data.cols;
            terminalRowsRef.current = message.data.rows;
            // Re-apply the RN-measured viewport height now that the terminal
            // exists — onLayout may have fired before the HTML finished loading.
            if (viewportHeightRef.current) {
              webViewRef.current?.injectJavaScript(
                `window.setTerminalViewportHeight && window.setTerminalViewportHeight(${viewportHeightRef.current}); true;`,
              );
            }
            wsManagerRef.current?.connect(message.data.cols, message.data.rows);
            break;

          case "resize":
            terminalColsRef.current = message.data.cols;
            terminalRowsRef.current = message.data.rows;
            console.log(
              "[termix] resize->ws cols=" +
                message.data.cols +
                " rows=" +
                message.data.rows,
            );
            wsManagerRef.current?.sendResize(
              message.data.cols,
              message.data.rows,
            );
            break;

          case "selectionStart":
            setIsSelecting(true);
            break;

          case "selectionEnd":
            setIsSelecting(false);
            break;

          case "scrollState":
            setShowScrollToBottomButton(!message.data.isAtBottom);
            break;

          case "input":
            // Wheel/mouse input synthesized inside the WebView (xterm onData),
            // forwarded to the pty so TUI apps can scroll their context.
            console.log(
              "[termix] input->ws " +
                String(message.data).length +
                "b " +
                JSON.stringify(String(message.data).slice(0, 16)),
            );
            wsManagerRef.current?.sendInput(message.data);
            break;

          case "termixDbg":
            // Mirrored WebView console lines (see [termix-dbg] in the HTML).
            console.log(message.data);
            break;
        }
      } catch (error) {
        console.error("[Terminal] Error parsing WebView message:", error);
      }
    }, []);

    useEffect(() => {
      wsManagerRef.current?.destroy();

      wsManagerRef.current = new NativeWebSocketManager({
        hostConfig: hostConfig as TerminalHostConfig,
        tabInstanceId,
        initialSessionId,
        onSessionIdChange,
        onStateChange: (state, data) => {
          switch (state) {
            case "connecting": {
              const retryCount = (data?.retryCount as number) || 0;
              setConnectionState(
                retryCount > 0 ? "reconnecting" : "connecting",
              );
              setRetryCount(retryCount);
              log.append({
                level: "info",
                message:
                  retryCount > 0
                    ? `Reconnecting… (attempt ${retryCount})`
                    : `Connecting to ${hostConfig.name}…`,
              });
              break;
            }
            case "connected": {
              const fromBackground = data?.fromBackground as boolean;
              const isReattach = data?.isReattach as boolean;
              setConnectionState("connected");
              setRetryCount(0);
              // FORK: standalone mode — the just-typed password actually
              // worked: store it on the local host (next session won't
              // re-prompt) and on the live config (in-tab reconnects).
              const pendingPassword = lastTypedPasswordRef.current;
              if (pendingPassword && pendingPassword.hostId > 0) {
                lastTypedPasswordRef.current = null;
                rememberLocalHostPassword(
                  pendingPassword.hostId,
                  pendingPassword.code,
                ).catch(() => {});
                wsManagerRef.current?.updateHostCredentials({
                  password: pendingPassword.code,
                });
              }
              if (!isReattach) {
                setHasReceivedData(false);
              }
              log.append({ level: "success", message: "Connected" });
              webViewRef.current?.injectJavaScript(
                `window.notifyConnected(${fromBackground}, ${isReattach}); true;`,
              );
              logActivity("terminal", hostConfig.id, hostConfig.name).catch(
                () => {},
              );
              break;
            }
            case "dataReceived":
              setHasReceivedData(true);
              break;
          }
        },
        onData: (data) => {
          console.log(
            "[termix] data-in " +
              (data && data.length ? data.length : String(data).length) +
              "b",
          );
          pendingDataRef.current.push(data);
          if (!dataFlushTimerRef.current) {
            dataFlushTimerRef.current = setTimeout(() => {
              dataFlushTimerRef.current = null;
              const batch = pendingDataRef.current.join("");
              pendingDataRef.current = [];
              webViewRef.current?.injectJavaScript(
                `window.writeToTerminal(${JSON.stringify(batch)}); true;`,
              );
            }, 16);
          }
          if (isScreenReaderEnabledRef.current) {
            writeToAccessibility(data);
          }
        },
        onTotpRequired: (prompt, isPassword) => {
          setTotpPrompt(prompt);
          setIsPasswordPrompt(isPassword);
          setTotpRequired(true);
        },
        onAuthDialogNeeded: (reason) => {
          setAuthDialogReason(reason);
          setShowAuthDialog(true);
          setConnectionState("disconnected");
        },
        onHostKeyVerificationRequired: (scenario, data) => {
          setHostKeyVerification({ scenario, data });
        },
        onPassphraseRequired: () => {
          setPassphraseRequired(true);
        },
        onWarpgateAuthRequired: (url, securityKey) => {
          setWarpgateAuth({ url, securityKey });
        },
        onPostConnectionSetup: () => handlePostConnectionSetup(),
        onDisconnected: (hostName) => {
          setConnectionState("disconnected");
          showToast.warning(`Disconnected from ${hostName}`);
          if (onClose) onClose();
        },
        onConnectionFailed: (message) => {
          log.append({ level: "error", message });
          handleConnectionFailure(message);
        },
        onConnectionLog: (entry) => log.ingest([entry]),
      });

      log.clear();
      setWebViewKey((prev) => prev + 1);
      setConnectionState("connecting");
      setHasReceivedData(false);
      setRetryCount(0);
      setShowScrollToBottomButton(false);
      // Clear any stale auth/verification dialogs from a previous connection attempt.
      setHostKeyVerification(null);
      setTotpRequired(false);
      setShowAuthDialog(false);
      setPassphraseRequired(false);
      setWarpgateAuth(null);

      if (xtermAssetsRef.current) {
        setHtmlContent(generateHTML(xtermAssetsRef.current));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hostConfig.id]);

    useEffect(() => {
      return () => {
        wsManagerRef.current?.destroy();
        wsManagerRef.current = null;
        if (dataFlushTimerRef.current) {
          clearTimeout(dataFlushTimerRef.current);
          dataFlushTimerRef.current = null;
        }
        if (accessibilityTimerRef.current) {
          clearTimeout(accessibilityTimerRef.current);
          accessibilityTimerRef.current = null;
        }
        if (viewportDebounceTimerRef.current) {
          clearTimeout(viewportDebounceTimerRef.current);
          viewportDebounceTimerRef.current = null;
        }
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        sendInput: (data: string) => {
          recordCommandInput(data);
          wsManagerRef.current?.sendInput(data);
        },
        fit: () => {
          try {
            webViewRef.current?.injectJavaScript(
              `window.nativeFit && window.nativeFit(); true;`,
            );
          } catch (e) {}
        },
        isDialogOpen: () => {
          return (
            totpRequired ||
            showAuthDialog ||
            hostKeyVerification !== null ||
            passphraseRequired ||
            warpgateAuth !== null
          );
        },
        notifyBackgrounded: () => {
          wsManagerRef.current?.notifyBackgrounded();
        },
        notifyForegrounded: () => {
          wsManagerRef.current?.notifyForegrounded();
        },
        scrollToBottom: () => {
          try {
            setShowScrollToBottomButton(false);
            webViewRef.current?.injectJavaScript(
              `window.resetScroll && window.resetScroll(); true;`,
            );
          } catch (e) {}
        },
        isSelecting: () => {
          return isSelecting;
        },
      }),
      [totpRequired, showAuthDialog, hostKeyVerification, isSelecting],
    );

    return (
      <View
        onLayout={handleTerminalLayout}
        style={{
          flex: isVisible ? 1 : 0,
          width: "100%",
          height: "100%",
          position: isVisible ? "relative" : "absolute",
          top: isVisible ? 0 : 0,
          left: isVisible ? 0 : 0,
          right: isVisible ? 0 : 0,
          bottom: isVisible ? 0 : 0,
          backgroundColor: terminalBackgroundColor,
        }}
      >
        <View
          style={{
            flex: 1,
            width: "100%",
            height: "100%",
            opacity: isVisible ? 1 : 0,
            position: "relative",
            zIndex: isVisible ? 1 : -1,
            backgroundColor: terminalBackgroundColor,
          }}
        >
          <View
            style={{ flex: 1, backgroundColor: terminalBackgroundColor }}
            pointerEvents={
              totpRequired || showAuthDialog || hostKeyVerification !== null
                ? "none"
                : "auto"
            }
          >
            <WebView
              key={`terminal-${hostConfig.id}-${webViewKey}`}
              ref={webViewRef}
              source={{ html: htmlContent }}
              style={{
                flex: 1,
                width: "100%",
                height: "100%",
                backgroundColor: terminalBackgroundColor,
                opacity:
                  connectionState === "connected" && hasReceivedData ? 1 : 0,
              }}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              startInLoadingState={false}
              scalesPageToFit={false}
              allowsInlineMediaPlayback={true}
              mediaPlaybackRequiresUserAction={false}
              keyboardDisplayRequiresUserAction={false}
              hideKeyboardAccessoryView={true}
              cacheEnabled={false}
              cacheMode="LOAD_NO_CACHE"
              androidLayerType="hardware"
              onMessage={handleWebViewMessage}
              onError={(syntheticEvent) => {
                const { nativeEvent } = syntheticEvent;
                handleConnectionFailure(
                  `WebView error: ${nativeEvent.description}`,
                );
              }}
              onHttpError={(syntheticEvent) => {
                const { nativeEvent } = syntheticEvent;
                handleConnectionFailure(
                  `WebView HTTP error: ${nativeEvent.statusCode}`,
                );
              }}
              scrollEnabled={false}
              overScrollMode="never"
              bounces={false}
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled={false}
              textZoom={100}
              setSupportMultipleWindows={false}
            />
          </View>

          {showScrollToBottomButton &&
            isVisible &&
            connectionState === "connected" &&
            !totpRequired &&
            !showAuthDialog &&
            hostKeyVerification === null && (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Scroll to bottom"
                onPress={() => {
                  setShowScrollToBottomButton(false);
                  webViewRef.current?.injectJavaScript(
                    `window.resetScroll && window.resetScroll(); true;`,
                  );
                }}
                style={{
                  position: "absolute",
                  right: 14,
                  bottom: 16,
                  width: 40,
                  height: 40,
                  borderRadius: 0,
                  backgroundColor: BACKGROUNDS.CARD,
                  borderWidth: 1,
                  borderColor: ACCENT,
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 20,
                  shadowColor: "#000",
                  shadowOpacity: 0.3,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 3 },
                  elevation: 6,
                }}
              >
                <ChevronDown size={20} color={ACCENT} />
              </TouchableOpacity>
            )}

          {/* Spinner shown until terminal has rendered its first output */}
          {(connectionState === "connecting" ||
            connectionState === "reconnecting" ||
            !hasReceivedData) &&
            connectionState !== "failed" && (
              <View
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  justifyContent: "center",
                  alignItems: "center",
                  backgroundColor: terminalBackgroundColor,
                  zIndex: 120,
                }}
              >
                <ActivityIndicator size="large" color={ACCENT} />
                <Text
                  style={{
                    color: TEXT_COLORS.PRIMARY,
                    fontSize: 16,
                    fontWeight: "600",
                    marginTop: 20,
                    textAlign: "center",
                    letterSpacing: 0.3,
                  }}
                >
                  {connectionState === "reconnecting"
                    ? "Reconnecting..."
                    : "Connecting..."}
                </Text>
                <Text
                  style={{
                    color: TEXT_COLORS.SECONDARY,
                    fontSize: 13,
                    marginTop: 6,
                    textAlign: "center",
                  }}
                >
                  {hostConfig.name}
                  {"  ·  "}
                  {hostConfig.ip}
                </Text>
              </View>
            )}

          <ConnectionLog
            entries={log.entries}
            isConnecting={
              connectionState === "connecting" ||
              connectionState === "reconnecting"
            }
            isConnected={connectionState === "connected"}
            hasConnectionError={connectionState === "failed"}
            onClear={log.clear}
          />
        </View>

        {isScreenReaderEnabled && (
          <View
            accessible={true}
            accessibilityLabel={accessibilityText}
            accessibilityLiveRegion="polite"
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              opacity: 0,
              top: -1000,
              left: -1000,
            }}
          />
        )}

        <TOTPDialog
          visible={totpRequired}
          onSubmit={handleTotpSubmit}
          onCancel={() => {
            setTotpRequired(false);
            setTotpPrompt("");
            setIsPasswordPrompt(false);
            if (onClose) onClose();
          }}
          prompt={totpPrompt}
          isPasswordPrompt={isPasswordPrompt}
        />

        <SSHAuthDialog
          visible={showAuthDialog}
          onSubmit={handleAuthDialogSubmit}
          onCancel={() => {
            setShowAuthDialog(false);
            if (onClose) onClose();
          }}
          hostInfo={{
            name: hostConfig.name,
            ip: hostConfig.ip,
            port: hostConfig.port,
            username: hostConfig.username,
          }}
          reason={authDialogReason}
        />

        <HostKeyVerificationDialog
          visible={hostKeyVerification !== null}
          scenario={hostKeyVerification?.scenario ?? "new"}
          data={hostKeyVerification?.data ?? null}
          onAccept={() => {
            wsManagerRef.current?.sendHostKeyResponse("accept");
            setHostKeyVerification(null);
          }}
          onReject={() => {
            wsManagerRef.current?.sendHostKeyResponse("reject");
            setHostKeyVerification(null);
            if (onClose) onClose();
          }}
        />

        <PassphraseDialog
          visible={passphraseRequired}
          onSubmit={(passphrase) => {
            wsManagerRef.current?.sendPassphraseResponse(passphrase);
            setPassphraseRequired(false);
          }}
          onCancel={() => {
            setPassphraseRequired(false);
            if (onClose) onClose();
          }}
          hostInfo={{
            name: hostConfig.name,
            ip: hostConfig.ip,
            port: hostConfig.port,
            username: hostConfig.username,
          }}
        />

        <WarpgateDialog
          visible={warpgateAuth !== null}
          url={warpgateAuth?.url ?? ""}
          securityKey={warpgateAuth?.securityKey ?? ""}
          onContinue={() => {
            wsManagerRef.current?.sendWarpgateContinue();
            setWarpgateAuth(null);
          }}
          onCancel={() => {
            setWarpgateAuth(null);
            if (onClose) onClose();
          }}
        />
      </View>
    );
  },
);

TerminalComponent.displayName = "Terminal";

export { TerminalComponent as Terminal };
export default TerminalComponent;
