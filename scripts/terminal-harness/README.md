# Terminal WebView harness

Runs the exact terminal page that `app/tabs/sessions/terminal/Terminal.tsx`
renders (phone-sized, 8px font) in desktop Electron against a real pty, and
drives it with CDP touch events. Used to find why swipes did not scroll
(touch target detached by the DOM renderer) and to validate the xterm 6 move.

    node gen.js ../../app/tabs/sessions/terminal/Terminal.tsx ../../assets/xterm /tmp/term.html
    # opencode (mouse-tracked TUI) or MODE=shell (bash + seq 1 3000)
    NODE_PTY=/path/to/desktop/termix/node_modules/node-pty \
    OPENCODE_SESSION=<session id with long history> HTML=/tmp/term.html OUT=/tmp/r.json LAT=35 \
      xvfb-run -a -s "-screen 0 1280x1024x24" /path/to/desktop/termix/node_modules/.bin/electron --no-sandbox .
    python3 analyze.py /tmp/r.json          # TUI: wheel reports + screen changes per gesture
    python3 analyze_shell.py /tmp/r.json    # MODE=shell: viewport lines moved per gesture

`LAT` adds one-way latency (ms) to mimic the phone's network path; set
`DEBUGLOG=1` to switch on the page's `[termix]` traces.
