// FORK: pin nodejs-mobile-react-native to arm64-v8a.
//
// The plugin's gradle script reads the app's ndk.abiFilters across project
// boundaries; with the AGP version used here that read returns the platform
// default ABI set (including "x86"), which the plugin does not support:
//   "Unsupported architecture for nodejs-mobile native modules: x86"
//
// Phones in use are arm64, so we hard-pin both the plugin's packaged ABIs and
// the npm-module build to arm64-v8a. Runs from npm "postinstall" and is
// idempotent (safe to re-run).
"use strict";

const fs = require("fs");
const path = require("path");

const target = path.join(
  __dirname,
  "..",
  "node_modules",
  "nodejs-mobile-react-native",
  "android",
  "build.gradle",
);

if (!fs.existsSync(target)) {
  console.log("[fork] nodejs-mobile-react-native not installed; skipping ABI pin");
  process.exit(0);
}

let src = fs.readFileSync(target, "utf8");
if (src.includes("FORK: arm64-only")) {
  console.log("[fork] nodejs-mobile ABI pin already applied");
  process.exit(0);
}

const old71 = 'abiFilters = project(":app").android.defaultConfig.ndk.abiFilters ?: ["armeabi-v7a", "x86_64", "arm64-v8a"]';
const new71 = 'abiFilters = ["arm64-v8a"]  // FORK: arm64-only (cross-project abiFilters read is unreliable on this AGP)';

const old240 = "def nativeModulesABIs = android.defaultConfig.ndk.abiFilters;";
const new240 = "def nativeModulesABIs = [\"arm64-v8a\"] as Set<String>;  // FORK: arm64-only";

if (!src.includes(old71) || !src.includes(old240)) {
  // Upstream changed the file; fail loudly rather than ship an unpatched build.
  console.error("[fork] ERROR: nodejs-mobile ABI anchors not found; update scripts/patch-nodejs-mobile-abi.js");
  process.exit(1);
}

src = src.replace(old71, new71);
src = src.replace(old240, new240);
fs.writeFileSync(target, src);
console.log("[fork] nodejs-mobile ABI pinned to arm64-v8a");
