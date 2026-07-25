import { spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(runtimeDir);
const nodePath = join(runtimeDir, "node.exe");
const envFile = join(rootDir, ".env.local");
const children = new Set();
let shuttingDown = false;

async function portAvailable(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(450);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    const available = () => {
      socket.destroy();
      resolve(true);
    };
    socket.once("timeout", available);
    socket.once("error", available);
  });
}

async function waitForWeb(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:3000/");
      if (response.ok || response.status === 302 || response.status === 307) return;
    } catch {
      // The production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error("网页服务未在 20 秒内就绪");
}

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Best effort during coordinated shutdown.
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) stopChild(child);
  setTimeout(() => process.exit(exitCode), 600).unref();
}

for (const port of [3000, 8766]) {
  if (!(await portAvailable(port))) {
    console.error(`[启动失败] 端口 ${port} 已被其他程序占用。`);
    process.exit(1);
  }
}

console.log("正在启动危化智巡生产服务……");
const keepAwake = run(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(runtimeDir, "keep-awake.ps1")],
  { stdio: "ignore" },
);
const web = run(nodePath, [
  `--env-file=${envFile}`,
  join(rootDir, "web", "server.js"),
]);
const gateway = run(nodePath, [
  `--env-file=${envFile}`,
  join(runtimeDir, "agent-gateway.mjs"),
]);

web.once("exit", (code) => {
  if (!shuttingDown) {
    console.error(`网页服务已退出（code=${code ?? "unknown"}）。`);
    shutdown(code ?? 1);
  }
});
gateway.once("exit", (code) => {
  if (!shuttingDown) {
    console.error(`智能中枢已退出（code=${code ?? "unknown"}）。`);
    shutdown(code ?? 1);
  }
});
keepAwake.once("exit", (code) => {
  if (!shuttingDown && code && code !== 0) {
    console.warn(`防休眠进程已退出（code=${code}），网页与智能中枢继续运行。`);
  }
});

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

try {
  await waitForWeb();
  console.log("危化智巡已启动：http://localhost:3000");
  if (process.env.XINGXUN_SKIP_BROWSER !== "1") {
    const opener = spawn(
      "cmd.exe",
      ["/d", "/s", "/c", "start", "", "http://localhost:3000"],
      { windowsHide: true, detached: true, stdio: "ignore" },
    );
    opener.unref();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  shutdown(1);
}

await new Promise(() => undefined);
