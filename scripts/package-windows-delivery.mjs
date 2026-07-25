import { createHash } from "node:crypto";
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = resolve(projectRoot, "..");
const productVersion = "2.7.0";
const apkName = `危化智巡-v${productVersion}.apk`;
const deliveryName = `危化智巡-用户交付-v${productVersion}`;
const target = resolve(process.argv[2] ?? join(desktop, deliveryName));
const staging = resolve(`${target}.staging`);
const previous = resolve(`${target}.previous`);
const expectedTarget = resolve(join(desktop, deliveryName));
const webSource = join(projectRoot, "dist", "standalone");
const apkSource = join(
  projectRoot,
  "android",
  "app",
  "build",
  "outputs",
  "apk",
  "release",
  apkName,
);
const nodeSource = resolve(process.execPath);
const sourceEnvPath = join(projectRoot, ".env.local");
const sourceDatabase = join(projectRoot, "data", "telemetry-history.sqlite");

if (target !== expectedTarget) {
  throw new Error(`交付目标必须为 ${expectedTarget}`);
}
for (const required of [webSource, apkSource, nodeSource, sourceEnvPath, sourceDatabase]) {
  if (!existsSync(required)) throw new Error(`缺少交付输入：${required}`);
}

const database = new DatabaseSync(sourceDatabase);
const integrity = database.prepare("PRAGMA integrity_check").get();
if (integrity?.integrity_check !== "ok") {
  database.close();
  throw new Error(`遥测数据库完整性检查失败：${JSON.stringify(integrity)}`);
}
database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
database.close();

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(join(staging, "runtime"), { recursive: true });
mkdirSync(join(staging, "config"), { recursive: true });
mkdirSync(join(staging, "data"), { recursive: true });

cpSync(webSource, join(staging, "web"), { recursive: true });
pruneDevelopmentArtifacts(join(staging, "web"));
patchVinextWindowsStaticCache(join(staging, "web"));
cpSync(nodeSource, join(staging, "runtime", "node.exe"));
cpSync(
  join(projectRoot, "scripts", "delivery-launcher.mjs"),
  join(staging, "runtime", "launcher.mjs"),
);
cpSync(
  join(projectRoot, "scripts", "delivery-keep-awake.ps1"),
  join(staging, "runtime", "keep-awake.ps1"),
);
cpSync(apkSource, join(staging, apkName));

await build({
  entryPoints: [join(projectRoot, "agent", "gateway.ts")],
  outfile: join(staging, "runtime", "agent-gateway.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

const envText = readFileSync(sourceEnvPath, "utf8");
let deliveryEnv = envText;
const credentialMappings = [
  ["DASHSCOPE_CREDENTIALS_FILE", "dashscope-credentials.csv"],
  ["HUAWEI_CREDENTIALS_FILE", "huawei-credentials.csv"],
];
for (const [variable, deliveryName] of credentialMappings) {
  const pattern = new RegExp(`^\\s*${variable}\\s*=\\s*(.*)\\s*$`, "m");
  const match = deliveryEnv.match(pattern);
  if (!match) throw new Error(`.env.local 缺少 ${variable}`);
  const configured = unquote(match[1].trim());
  const sourcePath = resolve(projectRoot, configured);
  if (!existsSync(sourcePath)) throw new Error(`${variable} 指向的文件不存在`);
  cpSync(sourcePath, join(staging, "config", deliveryName));
  deliveryEnv = deliveryEnv.replace(
    pattern,
    `${variable}=./config/${deliveryName}`,
  );
}
deliveryEnv = setEnvValue(deliveryEnv, "IOT_WEB_BASE_URL", "http://localhost:3000");
deliveryEnv = setEnvValue(deliveryEnv, "AI_GATEWAY_PORT", "8766");
deliveryEnv = setEnvValue(
  deliveryEnv,
  "TELEMETRY_HISTORY_DB",
  "./data/telemetry-history.sqlite",
);
writeFileSync(join(staging, ".env.local"), deliveryEnv, "utf8");

for (const name of ["local-auth.json", "telemetry-history.sqlite"]) {
  const source = join(projectRoot, "data", name);
  if (!existsSync(source)) throw new Error(`缺少运行数据：${source}`);
  cpSync(source, join(staging, "data", name));
}

writeFileSync(
  join(staging, "启动危化智巡.cmd"),
  `@echo off
cd /d "%~dp0"
title XingXun IoT Control Center
echo Keep this window open. Press Ctrl+C to stop all services safely.
echo.
"%~dp0runtime\\node.exe" "%~dp0runtime\\launcher.mjs"
echo.
echo XingXun IoT Control Center has stopped.
pause
`,
  "utf8",
);
writeFileSync(
  join(staging, "使用说明.txt"),
  `危化智巡 v${productVersion}

1. 双击“启动危化智巡.cmd”。
2. 网页会自动打开：http://localhost:3000
3. 运行期间会临时阻止电脑休眠，不会永久修改系统电源设置。
4. 按 Ctrl+C 可同时关闭网页、智能中枢并释放防休眠。
5. “${apkName}”用于安装 Android 客户端。

本目录已经包含 Windows x64 便携 Node、生产网页、智能中枢、数字孪生模型、
华为云/DeepSeek/Fun-ASR 配置、本地账号和遥测历史，不需要 npm install。
`,
  "utf8",
);

const stagedApks = collectFiles(staging, (name) => name.toLowerCase().endsWith(".apk"));
const expectedApk = resolve(join(staging, apkName));
if (stagedApks.length !== 1 || resolve(stagedApks[0]) !== expectedApk) {
  throw new Error(`交付目录必须且只能包含一个指定 APK，当前检测到 ${stagedApks.length} 个`);
}

const manifest = await createManifest(staging);
writeFileSync(join(staging, "SHA256SUMS.txt"), `${manifest}\n`, "utf8");
rmSync(previous, { recursive: true, force: true });
if (existsSync(target)) renameSync(target, previous);
try {
  renameSync(staging, target);
  rmSync(previous, { recursive: true, force: true });
} catch (error) {
  if (!existsSync(target) && existsSync(previous)) renameSync(previous, target);
  throw error;
}
console.log(`交付目录已生成：${target}`);

function unquote(value) {
  if (
    value.length >= 2
    && ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function setEnvValue(text, key, value) {
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, `${key}=${value}`);
  return `${text.replace(/\\s*$/, "")}\n${key}=${value}\n`;
}

function pruneDevelopmentArtifacts(root) {
  const blockedDirectories = new Set([
    "__tests__",
    "playwright",
    "test",
    "tests",
  ]);
  const blockedFiles = new Set([
    ".eslintignore",
    "eslint.config.js",
    "eslint.config.mjs",
    "tsconfig.json",
  ]);
  const blockedFilePrefixes = [".eslintrc", "tsconfig."];
  const blockedExtensions = new Set([".cts", ".map", ".mts", ".ts", ".tsx"]);

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (blockedDirectories.has(entry.name.toLowerCase())) {
        rmSync(fullPath, { recursive: true, force: true });
      } else {
        pruneDevelopmentArtifacts(fullPath);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const lowerName = entry.name.toLowerCase();
    const extension = lowerName.slice(lowerName.lastIndexOf("."));
    if (
      blockedFiles.has(lowerName)
      || blockedFilePrefixes.some((prefix) => lowerName.startsWith(prefix))
      || blockedExtensions.has(extension)
    ) {
      rmSync(fullPath, { force: true });
    }
  }
}

function collectFiles(root, predicate) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, predicate));
    } else if (entry.isFile() && predicate(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function patchVinextWindowsStaticCache(webRoot) {
  const cachePath = join(
    webRoot,
    "node_modules",
    "vinext",
    "dist",
    "server",
    "static-file-cache.js",
  );
  const original = "const pathname = \"/\" + relativePath;";
  const patched = "const pathname = \"/\" + relativePath.split(path.sep).join(\"/\");";
  const source = readFileSync(cachePath, "utf8");
  if (source.includes(patched)) return;
  if (!source.includes(original)) {
    throw new Error("无法应用 Vinext Windows 静态资源路径兼容补丁");
  }
  writeFileSync(cachePath, source.replace(original, patched), "utf8");
}

async function createManifest(root) {
  const { readdir } = await import("node:fs/promises");
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name !== "SHA256SUMS.txt") files.push(fullPath);
    }
  }
  await visit(root);
  files.sort((left, right) => left.localeCompare(right, "zh-CN"));
  const rows = [];
  for (const file of files) {
    const hash = await sha256(file);
    const relative = file.slice(root.length + 1).replaceAll("\\", "/");
    rows.push(`${hash}  ${relative}`);
  }
  return rows.join("\n");
}

function sha256(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", rejectHash);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex").toUpperCase()));
  });
}
