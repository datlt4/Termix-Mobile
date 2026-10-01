import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";

type XtermAssets = {
  xtermJs: string;
  xtermCss: string;
  fitAddonJs: string;
  webglAddonJs: string;
  nerdFontBase64?: string;
};

let cachedCore: XtermAssets | null = null;
let cachedNerdFontBase64: string | null = null;

async function readAsset(asset: Asset): Promise<string> {
  const uri = asset.localUri ?? asset.uri;
  const response = await fetch(uri);
  return response.text();
}

export async function loadXtermAssets(
  includeNerdFont: boolean,
): Promise<XtermAssets> {
  if (!cachedCore) {
    const [xtermJsAsset, xtermCssAsset, fitAddonAsset, webglAddonAsset] = await Asset.loadAsync([
      require("../../../../assets/xterm/xterm.js.html"),
      require("../../../../assets/xterm/xterm.css.html"),
      require("../../../../assets/xterm/xterm-addon-fit.js.html"),
      require("../../../../assets/xterm/xterm-addon-webgl.js.html"),
    ]);

    const [xtermJs, xtermCss, fitAddonJs, webglAddonJs] = await Promise.all([
      readAsset(xtermJsAsset),
      readAsset(xtermCssAsset),
      readAsset(fitAddonAsset),
      readAsset(webglAddonAsset),
    ]);
    cachedCore = { xtermJs, xtermCss, fitAddonJs, webglAddonJs };
  }

  if (includeNerdFont && !cachedNerdFontBase64) {
    const [nerdFontAsset] = await Asset.loadAsync([
      require("../../../../assets/fonts/CaskaydiaCoveNerdFontMono-Regular.ttf"),
    ]);
    cachedNerdFontBase64 = await FileSystem.readAsStringAsync(
      nerdFontAsset.localUri ?? nerdFontAsset.uri,
      {
        encoding: FileSystem.EncodingType.Base64,
      },
    );
  }

  return {
    ...cachedCore,
    nerdFontBase64: includeNerdFont
      ? (cachedNerdFontBase64 ?? undefined)
      : undefined,
  };
}
