import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import {
  AGENT_CAPABILITY_GROUPS,
  AGENT_TOOL_DEFINITIONS,
  parseAgentAction,
} from "../app/lib/ai/action-registry";
import type { AgentAction } from "../app/lib/ai/contracts";
import { createAgentEnvelope, type AgentEnvelope } from "../app/lib/ai/contracts";
import { readAgentGatewayConfig } from "./config";
import { startAgentGateway } from "./gateway";

const args = process.argv.slice(2);
const GATEWAY_RESPONSE_TIMEOUT_MS = 240_000;

async function main() {
  const command = args[0] ?? "help";
  if (command === "serve") {
    startAgentGateway();
    return;
  }
  if (command === "doctor") {
    const config = readAgentGatewayConfig();
    console.log(`DeepSeek 官方 API：${config.deepSeekApiKey ? "已配置密钥" : "未配置 DEEPSEEK_API_KEY"}`);
    console.log(`Fun-ASR 百炼 API：${config.dashScopeApiKey ? "已配置密钥" : "未配置 DASHSCOPE_API_KEY"}`);
    console.log(`Workspace：${config.workspaceId || "未配置（文本可使用公共北京端点，Fun-ASR 建议填写）"}`);
    console.log(`模型：${config.model}`);
    console.log("推理：客户端可选思考/非思考模式；思考强度支持 high/max（默认 high）");
    console.log(`网关：ws://127.0.0.1:${config.port}`);
    console.log(`小车 AI 控制：${config.vehicleEnabled ? "允许" : "关闭"}`);
    return;
  }
  if (command === "pair") {
    console.log("配对码会显示在正在运行的 iotctl serve / npm run agent:dev 终端中。");
    return;
  }
  if (command === "actions") {
    printActions();
    return;
  }
  if (command === "describe") {
    printActionDefinition(args[1]);
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const client = await LocalGatewayClient.connect({
    realVehicleEnabled: args.includes("--allow-vehicle"),
    alertWorkOrderAutomationEnabled: args.includes("--allow-alert-write"),
    thinkingMode: args.includes("--non-thinking") ? "non-thinking" : "thinking",
    reasoningEffort: option("--reasoning-effort", "high") === "max" ? "max" : "high",
  });
  try {
    if (command === "status") await client.sendAndPrint("agent.ask", { text: "报告智能中枢当前状态" });
    else if (command === "ask") await client.sendAndPrint("agent.ask", { text: args.slice(1).join(" ") });
    else if (command === "action") await client.requestAction(parseRawAction(args[1], option("--json", "{}")));
    else if (command === "telemetry" && args[1] === "read") await client.requestAction(parseAgentAction("telemetry.read_current", args[2] ? { slotId: args[2] } : {}));
    else if (command === "telemetry" && args[1] === "focus") await client.requestAction(parseAgentAction("telemetry.focus", { slotId: args[2] }));
    else if (command === "ui" && args[1] === "open") await client.requestAction(parseAgentAction("ui.navigate", { page: args[2] ?? "overview" }));
    else if (command === "ui" && args[1] === "back") await client.requestAction(parseAgentAction("ui.back", {}));
    else if (command === "ui" && args[1] === "focus") await client.requestAction(parseAgentAction("ui.focus_region", { page: args[2], region: args[3] }));
    else if (command === "ui" && args[1] === "scroll") await client.requestAction(parseAgentAction("ui.scroll", {
      page: args[2], direction: args[3], ...(args[4] ? { amount: args[4] } : {}),
    }));
    else if (command === "monitoring" && args[1] === "tab") await client.requestAction(parseAgentAction("monitoring.set_tab", { tab: args[2] }));
    else if (command === "monitoring" && args[1] === "series" && args[2] === "only") await client.requestAction(parseAgentAction("monitoring.set_visible_series", { slotIds: commaList(args[3]) }));
    else if (command === "monitoring" && args[1] === "series" && (args[2] === "show" || args[2] === "hide")) await client.requestAction(parseAgentAction("monitoring.set_series_visibility", { slotId: args[3], visible: args[2] === "show" }));
    else if (command === "monitoring" && args[1] === "range") await client.requestAction(parseAgentAction("monitoring.set_range", { range: args[2] }));
    else if (command === "monitoring" && args[1] === "analyze") await client.requestAction(parseAgentAction("monitoring.generate_analysis", option("--slots", "") ? { slotIds: commaList(option("--slots", "")) } : {}));
    else if (command === "monitoring" && (args[1] === "pause" || args[1] === "resume")) await client.requestAction(parseAgentAction("monitoring.set_paused", { paused: args[1] === "pause" }));
    else if (command === "monitoring" && args[1] === "refresh") await client.requestAction(parseAgentAction("monitoring.refresh", {}));
    else if (command === "twin" && args[1] === "view") await client.requestAction(parseAgentAction("twin.set_view", { view: args[2] }));
    else if (command === "twin" && args[1] === "mode") await client.requestAction(parseAgentAction("twin.set_display_mode", { mode: args[2] }));
    else if (command === "twin" && args[1] === "gaps") await client.requestAction(parseAgentAction("twin.set_gap_diagnostic", { active: /^(on|true|1)$/i.test(args[2] ?? "") }));
    else if (command === "twin" && args[1] === "point-size") await client.requestAction(parseAgentAction("twin.set_point_size", { size: Number(args[2]) }));
    else if (command === "twin" && args[1] === "panel" && args[2] === "close") await client.requestAction(parseAgentAction("twin.close_panels", {}));
    else if (command === "twin" && args[1] === "panel") await client.requestAction(parseAgentAction("twin.open_panel", { panel: args[2] }));
    else if (command === "twin" && args[1] === "reset") await client.requestAction(parseAgentAction("twin.reset_view", {}));
    else if (command === "twin" && args[1] === "capture") await client.requestAction(parseAgentAction("twin.capture", {}));
    else if (command === "twin" && args[1] === "orbit") await client.requestAction(parseAgentAction("twin.orbit", {
      revolutions: Number(option("--revolutions", "1")),
      durationMs: Number(option("--duration", "9000")),
      elevationDeg: Number(option("--elevation", "35")),
      direction: option("--direction", "clockwise"),
    }));
    else if (command === "spatial" && args[1] === "layer") await client.requestAction(parseAgentAction("spatial.set_layer", { layer: args[2] }));
    else if (command === "spatial" && args[1] === "begin-calibration") await client.requestAction(parseAgentAction("spatial.begin_calibration", {}));
    else if (command === "spatial" && args[1] === "calibrate") await client.requestAction(parseAgentAction("spatial.calibrate", {
      x: Number(option("--x", "NaN")), y: Number(option("--y", "NaN")), headingDeg: Number(option("--heading", "0")),
    }));
    else if (command === "spatial" && args[1] === "dimensions") await client.requestAction(parseAgentAction("spatial.set_dimensions", {
      widthM: Number(option("--width", "NaN")), heightM: Number(option("--height", "NaN")),
    }));
    else if (command === "vehicle" && args[1] === "control-speed") await client.requestAction(parseAgentAction("vehicle.set_control_speed", { speedPercent: Number(args[2]) }));
    else if (command === "vehicle" && args[1] === "confirm") await client.requestAction(parseAgentAction("vehicle.confirm", {}));
    else if (command === "vehicle" && args[1] === "cancel") await client.requestAction(parseAgentAction("vehicle.cancel", {}));
    else if (command === "vehicle" && args[1] === "stop") await client.requestAction(parseAgentAction("vehicle.stop", {}));
    else if (command === "vehicle" && args[1] === "move") {
      const direction = args[2] ?? "forward";
      const speed = option("--speed", "20");
      const duration = option("--duration", "1000");
      await client.requestAction(parseAgentAction("vehicle.propose_move", { motion: direction, speedPercent: Number(speed), durationMs: Number(duration) }));
    } else if (command === "vehicle" && args[1] === "distance") {
      await client.requestAction(parseAgentAction("vehicle.move_distance", {
        direction: args[2] ?? "forward",
        distanceMm: Number(args[3]),
        maxSpeedMmps: Number(option("--max-speed", "300")),
        ...(option("--timeout", "") ? { timeoutS: Number(option("--timeout", "")) } : {}),
      }));
    } else if (command === "vehicle" && args[1] === "turn") {
      await client.requestAction(parseAgentAction("vehicle.turn_angle", {
        direction: args[2] ?? "left",
        angleDeg: Number(args[3]),
        maxSpeedMmps: Number(option("--max-speed", "300")),
        ...(option("--timeout", "") ? { timeoutS: Number(option("--timeout", "")) } : {}),
      }));
    } else if (command === "vehicle" && args[1] === "checkpoint") {
      await client.requestAction(parseAgentAction("vehicle.navigate_to_checkpoint", {
        checkpointName: args.slice(2).filter((item) => !item.startsWith("--")).join(" "),
      }));
    } else if (command === "vehicle" && args[1] === "inspect") {
      const checkpointName = args.slice(2).filter((item) => !item.startsWith("--")).join(" ");
      await client.sendAndPrint("agent.ask", { text: `前往${checkpointName}进行测量检测` });
    } else if (command === "connections" && args[1] === "refresh") await client.requestAction(parseAgentAction("connections.refresh", {}));
    else if (command === "alerts" && args[1] === "refresh") await client.requestAction(parseAgentAction("alerts.refresh", {}));
    else if (command === "alerts" && args[1] === "tab") await client.requestAction(parseAgentAction("alerts.set_tab", { tab: args[2] }));
    else if (command === "alerts" && args[1] === "severity") await client.requestAction(parseAgentAction("alerts.set_severity_filter", { severity: args[2] }));
    else if (command === "alerts" && args[1] === "slot") await client.requestAction(parseAgentAction("alerts.set_slot_filter", { slotId: args[2] }));
    else if (command === "alerts" && args[1] === "detail") await client.requestAction(parseAgentAction("alerts.open_detail", { alertId: args[2] }));
    else if (command === "alerts" && args[1] === "begin") await client.requestAction(parseAgentAction("alerts.begin_processing", {
      alertId: args[2], expectedVersion: Number(option("--version", "NaN")),
    }));
    else if (command === "alerts" && args[1] === "complete") await client.requestAction(parseAgentAction("alerts.complete_work_order", {
      alertId: args[2], expectedVersion: Number(option("--version", "NaN")),
      action: option("--action", "other"), note: option("--note", ""),
    }));
    else if (command === "overview" && args[1] === "refresh") await client.requestAction(parseAgentAction("overview.refresh", {}));
    else if (command === "settings" && args[1] === "section") await client.requestAction(parseAgentAction("settings.set_section", { section: args[2] }));
    else if (command === "settings" && args[1] === "refresh-interval") await client.requestAction(parseAgentAction("settings.set_refresh_interval", { intervalMs: Number(args[2]) }));
    else if (command === "settings" && args[1] === "pause-hidden") await client.requestAction(parseAgentAction("settings.set_pause_when_hidden", { enabled: onOff(args[2]) }));
    else if (command === "settings" && args[1] === "motion-speed") await client.requestAction(parseAgentAction("settings.set_motion_speed", { percent: Number(args[2]) }));
    else if (command === "settings" && args[1] === "vehicle-speed") await client.requestAction(parseAgentAction("settings.set_vehicle_default_speed", { percent: Number(args[2]) }));
    else if (command === "settings" && args[1] === "keyboard") await client.requestAction(parseAgentAction("settings.set_keyboard_control", { enabled: onOff(args[2]) }));
    else if (command === "settings" && args[1] === "voice") await client.requestAction(parseAgentAction("settings.set_voice_playback", { enabled: onOff(args[2]) }));
    else if (command === "settings" && args[1] === "diagnose") await client.requestAction(parseAgentAction("settings.run_diagnostics", {}));
    else if (command === "settings" && args[1] === "save") await client.requestAction(parseAgentAction("settings.save", {}));
    else printHelp();
  } finally {
    client.close();
  }
}

class LocalGatewayClient {
  private constructor(private readonly socket: WebSocket, private readonly id: string) {}

  static connect(preferences: {
    realVehicleEnabled?: boolean;
    alertWorkOrderAutomationEnabled?: boolean;
    thinkingMode?: "thinking" | "non-thinking";
    reasoningEffort?: "high" | "max";
  } = {}) {
    const config = readAgentGatewayConfig();
    return new Promise<LocalGatewayClient>((resolve, reject) => {
      const id = `cli-${crypto.randomUUID()}`;
      const socket = new WebSocket(`ws://127.0.0.1:${config.port}`);
      const timer = setTimeout(() => reject(new Error("无法连接智能网关")), 5000);
      socket.on("open", () => {
        socket.send(JSON.stringify(createAgentEnvelope("client.hello", id, "gateway", {
          role: "remote", name: "iotctl", token: "",
          realVehicleEnabled: preferences.realVehicleEnabled === true,
          alertWorkOrderAutomationEnabled: preferences.alertWorkOrderAutomationEnabled === true,
          thinkingMode: preferences.thinkingMode === "non-thinking" ? "non-thinking" : "thinking",
          reasoningEffort: preferences.reasoningEffort === "max" ? "max" : "high",
        })));
      });
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as AgentEnvelope;
        if (message.type === "pair.accepted" || message.type === "gateway.ready") {
          clearTimeout(timer);
          resolve(new LocalGatewayClient(socket, id));
        }
      });
      socket.on("error", reject);
    });
  }

  sendAndPrint(type: string, payload: unknown) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("网关响应超时")),
        GATEWAY_RESPONSE_TIMEOUT_MS,
      );
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as AgentEnvelope<string, { text?: string; message?: string }>;
        if (message.type === "agent.reply" || message.type === "action.accepted") {
          clearTimeout(timer); this.socket.off("message", onMessage);
          console.log(message.payload.text ?? message.payload.message ?? "完成"); resolve();
        }
        if (message.type === "agent.error") {
          clearTimeout(timer); this.socket.off("message", onMessage);
          reject(new Error(message.payload.message ?? "网关错误"));
        }
      };
      this.socket.on("message", onMessage);
      this.socket.send(JSON.stringify(createAgentEnvelope(type, this.id, "gateway", payload)));
    });
  }

  requestAction(action: AgentAction) {
    return this.sendAndPrint("action.request", { action });
  }

  close() { this.socket.close(); }
}

function option(name: string, fallback: string) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function commaList(value: string | undefined) {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function onOff(value: string | undefined) {
  if (!/^(on|off|true|false|1|0)$/i.test(value ?? "")) throw new Error("开关参数请使用 on 或 off");
  return /^(on|true|1)$/i.test(value ?? "");
}

function parseRawAction(name: string | undefined, raw: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("--json 不是有效 JSON"); }
  return parseAgentAction(name, parsed);
}

function printHelp() {
  console.log(`iotctl serve
iotctl doctor
iotctl pair
iotctl status
iotctl actions
iotctl describe monitoring.set_visible_series
iotctl ask "只显示当前环境温度曲线" [--non-thinking] [--reasoning-effort high|max]
iotctl action monitoring.set_tab --json '{"tab":"live"}'
iotctl ui open digital-twin
iotctl ui back
iotctl ui focus monitoring indicator-posture
iotctl ui scroll monitoring down page
iotctl telemetry read [slot-1]
iotctl telemetry focus slot-1
iotctl monitoring tab live
iotctl monitoring series only slot-1,slot-2
iotctl monitoring series show slot-3
iotctl monitoring series hide slot-3
iotctl monitoring range 24h
iotctl monitoring analyze --slots slot-1,slot-2
iotctl monitoring pause | resume | refresh
iotctl twin view top
iotctl twin mode enhanced
iotctl twin gaps on
iotctl twin point-size 0.012
iotctl twin panel scene | devices | display | close
iotctl twin reset
iotctl twin capture
iotctl twin orbit --revolutions 1 --duration 9000 --elevation 35 --direction clockwise
iotctl spatial layer position | slot-1
iotctl spatial begin-calibration
iotctl spatial calibrate --x 0.52 --y 0.78 --heading 0
iotctl spatial dimensions --width 4.7 --height 7
iotctl vehicle control-speed 55
iotctl vehicle move forward --speed 20 --duration 1000 --allow-vehicle
iotctl vehicle distance forward 100 --max-speed 300 --allow-vehicle
iotctl vehicle turn left 90 --max-speed 300 --allow-vehicle
iotctl vehicle checkpoint 油桶 --allow-vehicle
iotctl vehicle inspect 油桶 --allow-vehicle
iotctl vehicle confirm | cancel | stop
iotctl connections refresh
iotctl alerts refresh
iotctl alerts tab pending | processing | completed | rules
iotctl alerts severity all | info | warning | critical
iotctl alerts slot all | slot-1
iotctl alerts detail <alert-id>
iotctl alerts begin <alert-id> --version 1 --allow-alert-write
iotctl alerts complete <alert-id> --version 2 --action sensor-check --note "已复核传感器数据" --allow-alert-write
iotctl overview refresh
iotctl settings section diagnostics
iotctl settings refresh-interval 3500
iotctl settings pause-hidden on | off
iotctl settings motion-speed 50
iotctl settings vehicle-speed 55
iotctl settings keyboard on | off
iotctl settings voice on | off
iotctl settings diagnose
iotctl settings save`);
}

function printActions() {
  for (const group of AGENT_CAPABILITY_GROUPS) {
    console.log(`\n${group.label} · ${group.summary}`);
    for (const actionName of group.actions) console.log(`  ${actionName}`);
  }
  console.log(`\n共 ${AGENT_TOOL_DEFINITIONS.length} 项原子动作；使用 iotctl describe <动作名> 查看参数。`);
}

function printActionDefinition(name: string | undefined) {
  const definition = AGENT_TOOL_DEFINITIONS.find((item) => item.function.name === name);
  if (!definition) throw new Error("未知动作；先运行 iotctl actions 查看完整清单");
  console.log(definition.function.name);
  console.log(definition.function.description);
  console.log(JSON.stringify(definition.function.parameters, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
