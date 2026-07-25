import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "assets", "icon.png");
const outDir = path.join(root, "public", "icons");

const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  const target = path.join(outDir, `icon-${size}.png`);
  await sharp(source).resize(size, size, { fit: "cover" }).png().toFile(target);
  console.log(`generated ${path.relative(root, target)}`);
}
