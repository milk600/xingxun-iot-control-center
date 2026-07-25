import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const children = new Set<ChildProcess>();
let shuttingDown = false;

function trackedSpawn(
  command: string,
  args: string[],
  stdio: "inherit" | "ignore" = "inherit",
) {
  const child = spawn(command, args, {
    stdio,
    windowsHide: true,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function runNpmScript(script: "dev:lan" | "agent:start") {
  // Node 24 no longer launches .cmd shims directly on Windows. Use cmd.exe
  // explicitly for these fixed, trusted npm script names.
  return process.platform === "win32"
    ? trackedSpawn("cmd.exe", ["/d", "/s", "/c", `npm.cmd run ${script}`])
    : trackedSpawn("npm", ["run", script]);
}

function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
  try {
    if (process.platform === "win32" && child.pid) {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // The process already exited while coordinated shutdown was running.
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = code;
  for (const child of children) stopChild(child);
}

const keepAwake = process.platform === "win32"
  ? trackedSpawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve("scripts", "delivery-keep-awake.ps1"),
      ],
      "ignore",
    )
  : null;
const web = runNpmScript("dev:lan");
const gateway = runNpmScript("agent:start");

const superviseService = (name: string, child: ChildProcess) => {
  child.once("error", (error) => {
    if (shuttingDown) return;
    console.error(`${name}启动失败：${error.message}`);
    shutdown(1);
  });
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`${name}已退出（${signal ? `signal=${signal}` : `code=${code ?? "unknown"}`}）。`);
    shutdown(code && code !== 0 ? code : 1);
  });
};

superviseService("网页服务", web);
superviseService("智能中枢", gateway);
if (keepAwake) superviseService("防休眠服务", keepAwake);

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
