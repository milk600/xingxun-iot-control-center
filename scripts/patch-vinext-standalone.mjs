import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cachePath = join(
  projectRoot,
  "dist",
  "standalone",
  "node_modules",
  "vinext",
  "dist",
  "server",
  "static-file-cache.js",
);

if (!existsSync(cachePath)) {
  throw new Error(`Vinext standalone 静态资源模块不存在：${cachePath}`);
}

const original = "const pathname = \"/\" + relativePath;";
const patched = "const pathname = \"/\" + relativePath.split(path.sep).join(\"/\");";
const source = readFileSync(cachePath, "utf8");

if (source.includes(patched)) {
  process.stdout.write("Vinext Windows 静态资源路径兼容补丁已存在。\n");
} else if (source.includes(original)) {
  writeFileSync(cachePath, source.replace(original, patched), "utf8");
  process.stdout.write("已应用 Vinext Windows 静态资源路径兼容补丁。\n");
} else {
  throw new Error("无法定位 Vinext Windows 静态资源路径代码，未修改生产输出");
}
