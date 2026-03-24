/**
 * Rasterize public/icon.svg to PNGs for PWA / iOS (SVG alone is often ignored).
 * Run: node scripts/generate-icons.mjs
 */
import sharp from "sharp";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");
const svg = readFileSync(join(publicDir, "icon.svg"));

const sizes = [
  [180, "apple-touch-icon.png"],
  [192, "icon-192.png"],
  [512, "icon-512.png"]
];
for (const [size, filename] of sizes) {
  const out = join(publicDir, filename);
  await sharp(svg).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
  console.log("wrote", out);
}
