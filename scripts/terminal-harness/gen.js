// Renders the mobile Terminal.tsx WebView HTML template with phone-like values.
const fs = require("fs");
const [,, tsxPath, assetsDir, outPath] = process.argv;
const src = fs.readFileSync(tsxPath, "utf8");
const a = src.indexOf("<!DOCTYPE html>"), b = src.indexOf("</html>", a) + "</html>".length;
const tpl = src.slice(a, b);
const read = (n) => fs.readFileSync(`${assetsDir}/${n}`, "utf8");
const assets = {
  xtermJs: read("xterm.js.html"),
  xtermCss: read("xterm.css.html"),
  fitAddonJs: read("xterm-addon-fit.js.html"),
  canvasAddonJs: fs.existsSync(`${assetsDir}/xterm-addon-canvas.js.html`) ? read("xterm-addon-canvas.js.html") : "",
  webglAddonJs: fs.existsSync(`${assetsDir}/xterm-addon-webgl.js.html`) ? read("xterm-addon-webgl.js.html") : "",
};
const themeColors = { background: "#18181b", foreground: "#f7f7f7", black: "#000", red: "#f55", green: "#5f5", yellow: "#ff5", blue: "#55f", magenta: "#f5f", cyan: "#5ff", white: "#ddd",
  brightBlack: "#777", brightRed: "#f77", brightGreen: "#7f7", brightYellow: "#ff7", brightBlue: "#77f", brightMagenta: "#f7f", brightCyan: "#7ff", brightWhite: "#fff" };
const ctx = { assets, baseFontSize: 8, fontFamily: "monospace", width: 480, height: 870,
  isScreenReaderEnabled: false, nerdFontFace: "", themeColors,
  terminalConfig: { cursorBlink: false, cursorStyle: "bar", letterSpacing: 0, lineHeight: 1.2, scrollback: 10000 } };
const fn = new Function(...Object.keys(ctx), "return `" + tpl.slice(0) + "`;");
fs.writeFileSync(outPath, fn(...Object.values(ctx)));
console.log("wrote", outPath, fs.statSync(outPath).size);
