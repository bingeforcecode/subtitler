import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { GlobalFonts } from "@napi-rs/canvas";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = resolve(__dirname, "..", "fonts");

/**
 * Curated subtitle font set. `file` is the TTF in ./fonts/, `family` is the
 * canvas/font-name we register it under (so subtitles.js can do
 * `ctx.font = '84px "Inter"'`).
 */
export const FONTS = [
  { key: "Inter",           file: "Inter-VF.ttf",                  family: "Inter",            label: "Inter" },
  { key: "Montserrat",      file: "Montserrat-VF.ttf",             family: "Montserrat",       label: "Montserrat" },
  { key: "BebasNeue",       file: "BebasNeue-Regular.ttf",         family: "Bebas Neue",       label: "Bebas Neue" },
  { key: "Anton",           file: "Anton-Regular.ttf",             family: "Anton",            label: "Anton" },
  { key: "Poppins",         file: "Poppins-Black.ttf",             family: "Poppins",          label: "Poppins Black" },
  { key: "Oswald",          file: "Oswald-VF.ttf",                 family: "Oswald",           label: "Oswald" },
  { key: "Roboto",          file: "Roboto-VF.ttf",                 family: "Roboto",           label: "Roboto" },
  { key: "ArchivoBlack",    file: "ArchivoBlack-Regular.ttf",      family: "Archivo Black",    label: "Archivo Black" },
  { key: "PermanentMarker", file: "PermanentMarker-Regular.ttf",   family: "Permanent Marker", label: "Permanent Marker" },
  { key: "Bangers",         file: "Bangers-Regular.ttf",           family: "Bangers",          label: "Bangers" },
];

let registered = false;

/**
 * Register all bundled TTF files with @napi-rs/canvas so they can be used
 * via `ctx.font = '... "Family"'`. Safe to call repeatedly.
 */
export function ensureFontsRegistered() {
  if (registered) return;
  for (const f of FONTS) {
    const p = join(FONTS_DIR, f.file);
    if (!existsSync(p)) {
      console.warn(`[fonts] missing ${p} — run \`npm run fonts\``);
      continue;
    }
    try {
      GlobalFonts.registerFromPath(p, f.family);
    } catch (err) {
      console.warn(`[fonts] failed to register ${f.family}:`, err.message);
    }
  }
  registered = true;
}

export function findFont(key) {
  return FONTS.find((f) => f.key === key) || FONTS[0];
}
