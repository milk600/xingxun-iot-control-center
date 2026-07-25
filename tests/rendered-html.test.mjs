import assert from "node:assert/strict";
import { createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Texture,
} from "three";
import {
  assertLocalModelFileSize,
  inspectPlyHeader,
  MAX_CPU_PLY_VERTICES,
  MAX_LOCAL_MODEL_FILE_BYTES,
  MAX_OPENMVS_POINT_CLOUD_VERTICES,
} from "../app/lib/digital-twin/model-safety.ts";
import {
  linearizeSrgbByte,
  parseOpenMvsDensePointCloud,
  pointCloudBucketCount,
  probePlyBlob,
} from "../app/lib/digital-twin/openmvs-ply.ts";
import {
  fixOpenMvsBaseColorTextures,
  isOpenMvsGenerator,
} from "../app/lib/digital-twin/openmvs-texture.ts";
import {
  ROOM_ONE_RECOMMENDED_MODELS,
} from "../app/lib/digital-twin/contracts.ts";
import {
  ROOM_ONE_TOP_DIRECTION,
  ROOM_ONE_TOP_RIGHT,
  ROOM_ONE_TOP_UP,
} from "../app/lib/digital-twin/room-one-coordinate-system.ts";
import {
  createInitialSnapshot,
  createUnavailableSlots,
  TELEMETRY_SLOT_IDS,
} from "../app/lib/iot/contracts.ts";
import { UI_REGION_IDS } from "../app/lib/ai/contracts.ts";
import {
  buildJetsonCommand,
  DEFAULT_JETSON_SETTINGS,
  parseJetsonInboundMessage,
  parseJetsonMessage,
} from "../app/lib/iot/jetson-websocket.ts";
import {
  mapHuaweiShadowToSlots,
  parseHuaweiCredentialCsv,
} from "../app/lib/iot/providers/huawei-iotda-sensors.server.ts";

const TEST_AUTH_PASSWORD = "public-test-password";
const testAuthSalt = randomBytes(20);
const TEST_AUTH_CONFIG = {
  username: "test-admin",
  displayName: "Test Administrator",
  passwordIterations: 12_000,
  passwordSalt: testAuthSalt.toString("base64url"),
  passwordHash: pbkdf2Sync(
    TEST_AUTH_PASSWORD,
    testAuthSalt,
    12_000,
    32,
    "sha1",
  ).toString("base64url"),
  sessionSecret: randomBytes(32).toString("base64url"),
  sessionVersion: 1,
};

Object.assign(process.env, {
  LOCAL_AUTH_USERNAME: TEST_AUTH_CONFIG.username,
  LOCAL_AUTH_DISPLAY_NAME: TEST_AUTH_CONFIG.displayName,
  LOCAL_AUTH_PASSWORD_ITERATIONS: String(TEST_AUTH_CONFIG.passwordIterations),
  LOCAL_AUTH_PASSWORD_SALT: TEST_AUTH_CONFIG.passwordSalt,
  LOCAL_AUTH_PASSWORD_HASH: TEST_AUTH_CONFIG.passwordHash,
  LOCAL_AUTH_SESSION_SECRET: TEST_AUTH_CONFIG.sessionSecret,
  LOCAL_AUTH_SESSION_VERSION: String(TEST_AUTH_CONFIG.sessionVersion),
});

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

function env() {
  return {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
  };
}

function context() {
  return {
    waitUntil() {},
    passThroughOnException() {},
  };
}

async function renderPage(worker, pathname) {
  const response = await worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    env(),
    context(),
  );
  const html = await response.text();
  return { response, html };
}

async function localAuthCookie() {
  const payload = Buffer.from(JSON.stringify({
    username: TEST_AUTH_CONFIG.username,
    displayName: TEST_AUTH_CONFIG.displayName,
    expiresAtMs: Date.now() + 60_000,
    sessionVersion: TEST_AUTH_CONFIG.sessionVersion,
  })).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(TEST_AUTH_CONFIG.sessionSecret, "base64url"))
    .update(payload)
    .digest("base64url");
  return `xingxun_local_session=${encodeURIComponent(`${payload}.${signature}`)}`;
}

async function localEnrollment(username, password) {
  const salt = randomBytes(20);
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    username,
    displayName: username,
    passwordAlgorithm: "pbkdf2-sha1",
    passwordIterations: 12_000,
    passwordSalt: salt.toString("base64url"),
    passwordHash: pbkdf2Sync(password, salt, 12_000, 32, "sha1").toString("base64url"),
    issuedAt: new Date().toISOString(),
  })).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(TEST_AUTH_CONFIG.sessionSecret, "base64url"))
    .update(`enrollment:${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function openMvsDenseHeader(vertexCount) {
  return [
    "ply",
    "format binary_little_endian 1.0",
    `element vertex ${vertexCount}`,
    "property float32 x",
    "property float32 y",
    "property float32 z",
    "property uint8 red",
    "property uint8 green",
    "property uint8 blue",
    "property float32 nx",
    "property float32 ny",
    "property float32 nz",
    "property list uint8 uint32 view_indices",
    "property list uint8 float32 view_weights",
    "end_header",
    "",
  ].join("\n");
}

function openMvsDenseRecord({ position, color, views = [] }) {
  const byteLength = 29 + views.length * 8;
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  position.forEach((coordinate, index) => view.setFloat32(index * 4, coordinate, true));
  color.forEach((channel, index) => {
    bytes[12 + index] = channel;
  });
  view.setFloat32(15, 0, true);
  view.setFloat32(19, 0, true);
  view.setFloat32(23, 1, true);
  bytes[27] = views.length;
  views.forEach(({ imageIndex }, index) => {
    view.setUint32(28 + index * 4, imageIndex, true);
  });
  const weightCountOffset = 28 + views.length * 4;
  bytes[weightCountOffset] = views.length;
  views.forEach(({ weight }, index) => {
    view.setFloat32(weightCountOffset + 1 + index * 4, weight, true);
  });
  return bytes;
}

test("room map and digital twin share the calibrated top-view basis", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../public/models/room-01/room-top-map.json", import.meta.url),
    "utf8",
  ));
  const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
  const cross = (left, right) => [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];

  assert.equal(manifest.sceneRevision, 1);
  assert.equal(manifest.generatedFrom, ROOM_ONE_RECOMMENDED_MODELS.primary);
  assert.deepEqual(ROOM_ONE_RECOMMENDED_MODELS, {
    primary: "demo-room.ply",
    gap: "demo-room-gap.ply",
    framework: "demo-room-framework.ply",
  });
  assert.deepEqual(manifest.projection.direction, [...ROOM_ONE_TOP_DIRECTION]);
  assert.deepEqual(manifest.projection.up, [...ROOM_ONE_TOP_UP]);
  assert.deepEqual(manifest.projection.right, [...ROOM_ONE_TOP_RIGHT]);
  assert.ok(Math.abs(dot(ROOM_ONE_TOP_RIGHT, ROOM_ONE_TOP_UP)) < 1e-7);
  assert.ok(Math.abs(dot(ROOM_ONE_TOP_RIGHT, ROOM_ONE_TOP_RIGHT) - 1) < 1e-7);
  assert.ok(Math.abs(dot(ROOM_ONE_TOP_UP, ROOM_ONE_TOP_UP) - 1) < 1e-7);
  cross(ROOM_ONE_TOP_RIGHT, ROOM_ONE_TOP_UP).forEach((value, index) => {
    assert.ok(Math.abs(value - ROOM_ONE_TOP_DIRECTION[index]) < 1e-7);
  });
});

test("all product routes render through the local authentication boundary", async () => {
  const worker = await loadWorker();
  const routes = [
    ["/", "控制概览"],
    ["/digital-twin", "空间孪生"],
    ["/vehicle", "小车遥控"],
    ["/monitoring", "数据监测"],
    ["/integrations", "连接管理"],
    ["/settings", "系统设置"],
  ];

  for (const [pathname, title] of routes) {
    const { response, html } = await renderPage(worker, pathname);
    assert.equal(response.status, 200, `${pathname} 应能进入客户端认证边界`);
    assert.equal(response.headers.get("location"), null, `${pathname} 不应跳转登录`);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
    assert.match(html, new RegExp(title));
    assert.doesNotMatch(
      html,
      /signin-with-chatgpt|signout-with-chatgpt|登录\s*GPT|ChatGPT\s*登录/i,
      `${pathname} 不应要求 GPT 账号`,
    );
    assert.doesNotMatch(html, /codex-preview|SkeletonPreview|Your site is taking shape/);
    assert.match(html, /正在检查登录状态/);
  }
});

test("connection management and vehicle spatial inspection expose user-facing real state", async () => {
  const [page, dashboard, vehicle, spatialMap, spatialDistribution, spatialContext, styles, camera, cameraCapture, androidMain] = await Promise.all([
    readFile(new URL("../app/features/pages/IntegrationsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/iot/use-iot-dashboard.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/pages/VehiclePage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/spatial/VehicleSpatialMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/spatial/SpatialDistributionMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/spatial/SpatialMappingContext.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/spatial/VehicleSpatialMap.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/features/iot/VehicleCameraFeed.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/iot/camera-capture.ts", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/xingxun/iotcontrol/MainActivity.java", import.meta.url), "utf8"),
  ]);

  assert.match(page, /useAiControl/);
  assert.match(page, /jetsonEnabled/);
  assert.match(page, /snapshot\.partialErrors/);
  assert.match(page, /TELEMETRY_SLOT_IDS\.map/);
  assert.match(page, /localStorage\.removeItem\(LEGACY_MAPPING_DRAFT_KEY\)/);
  assert.doesNotMatch(page, /SlidingTabs|sourceKey|环境变量模板|车辆输入协议|\/api\/iot\/|复制 JSON|历史数据库尚未接入/);
  assert.match(dashboard, /jetsonEnabled/);

  assert.match(vehicle, /VehicleSpatialMap/);
  assert.match(vehicle, /VehicleCameraFeed/);
  assert.doesNotMatch(vehicle, /伪造视频|真实远程视频接口|尚未配置远程视频源|SlidingTabs|DirectionalPanel|Maximize2/);
  assert.match(spatialMap, /ROOM_ONE_NAVIGATION_MAP_ASSETS/);
  assert.doesNotMatch(spatialMap, /ROOM_ONE_TOP_MAP_ASSETS/);
  assert.match(spatialMap, /buildSpatialHeatGrid/);
  assert.match(spatialDistribution, /SpatialDistributionPanel/);
  assert.match(spatialDistribution, /ROOM_ONE_NAVIGATION_MAP_ASSETS/);
  assert.doesNotMatch(spatialDistribution, /ROOM_ONE_TOP_MAP_ASSETS/);
  assert.match(spatialDistribution, /slots\.map/);
  assert.match(spatialDistribution, /buildSpatialHeatGrid/);
  assert.match(spatialDistribution, /interpolateSpatialValueAt/);
  assert.match(spatialDistribution, /点击地图查看位置读数/);
  assert.match(spatialDistribution, /位置估算/);
  assert.match(spatialMap, /位置[\s\S]*温度[\s\S]*湿度[\s\S]*CO₂[\s\S]*TVOC[\s\S]*甲醛[\s\S]*光照/);
  assert.match(spatialMap, /样本不足，仅显示点位/);
  assert.match(spatialContext, /snapshot\.provider !== "huawei-cloud"/);
  assert.match(spatialContext, /!snapshot\.vehicle\.odometry/);
  assert.match(spatialContext, /seenObservationKeysRef/);
  assert.match(styles, /\.mapFrameCalibrating\s*\{/);
  assert.match(vehicle, /data-ai-region="vehicle-camera"/);
  assert.match(camera, /subscribeVideoFrames/);
  assert.match(camera, /requestAnimationFrame/);
  assert.match(camera, /未检测到摄像头/);
  assert.match(camera, /拍照并保存当前车载摄像头画面/);
  assert.match(camera, /cameraState\.tone === "live"/);
  assert.match(cameraCapture, /anchor\.href = source/);
  assert.match(cameraCapture, /危化智巡-车辆视野/);
  assert.match(androidMain, /dataUrlFallbackName/);
  assert.match(androidMain, /Environment\.DIRECTORY_PICTURES/);
  assert.doesNotMatch(camera, /伪造|模拟视频|调试/);
});

test("Agent page browsing has named regions, smooth scrolling, and non-layout focus feedback", async () => {
  const [overview, monitoring, vehicle, vehicleMap, spatialDistribution, twin, alerts, integrations, settings, accountSecurity, focusManager, focusStyles, voiceBar] = await Promise.all([
    readFile(new URL("../app/features/pages/OverviewPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/pages/MonitoringPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/pages/VehiclePage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/spatial/VehicleSpatialMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/spatial/SpatialDistributionMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/digital-twin/DigitalTwinWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/pages/AlertsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/pages/IntegrationsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/pages/SettingsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/pages/AccountSecurityPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ai/AiPageFocusManager.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ai/AiPageFocusManager.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ai/AiVoiceBar.tsx", import.meta.url), "utf8"),
  ]);
  const sources = {
    overview,
    monitoring: `${monitoring}\n${spatialDistribution}`,
    vehicle: `${vehicle}\n${vehicleMap}`,
    "digital-twin": twin,
    alerts,
    integrations,
    settings: `${settings}\n${accountSecurity}`,
  };
  for (const [page, regions] of Object.entries(UI_REGION_IDS)) {
    for (const region of regions) {
      assert.match(sources[page], new RegExp(`["']${region}["']`), `${page} 缺少 ${region} 定位锚点`);
    }
  }
  assert.match(focusManager, /ui\.focus_region/);
  assert.match(focusManager, /ui\.scroll/);
  assert.match(focusManager, /ui\.back/);
  assert.match(focusManager, /scrollIntoView/);
  assert.match(focusManager, /data-ai-focus-active/);
  assert.match(focusStyles, /outline:/);
  assert.match(focusStyles, /prefers-reduced-motion/);
  assert.match(voiceBar, /focusPresentationActive/);
  assert.match(voiceBar, /AiPanelTransition/);
  assert.match(monitoring, /viewSpatialTrend/);
  assert.match(monitoring, /setVisibleSlots\(\[slotId\]\)/);
  assert.match(alerts, /clearAlerts/);
  assert.match(alerts, /清除告警记录/);
});

test("login UI is shared by web and offline Android without clear-text credentials", async () => {
  const [login, showcase, loginStyles, brand, authContext, offline, packageJson] = await Promise.all([
    readFile(new URL("../app/features/auth/LoginScreen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/auth/LoginShowcase.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/auth/LoginScreen.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/brand.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/auth/AuthContext.tsx", import.meta.url), "utf8"),
    readFile(new URL("../offline/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(login, /欢迎回来/);
  assert.match(login, /保持登录/);
  assert.match(login, /使用指纹或面容/);
  assert.match(login, /创建账号/);
  assert.match(login, /管理员授权/);
  assert.match(login, /LoginShowcase/);
  assert.match(showcase, /六路环境感知/);
  assert.match(showcase, /空间孪生巡检/);
  assert.match(showcase, /车端实时视野/);
  assert.match(showcase, /AI 辅助研判/);
  assert.match(showcase, /environment-monitoring\.svg/);
  assert.match(showcase, /digital-twin-demo\.svg/);
  assert.match(showcase, /vehicle-control-demo\.svg/);
  assert.match(showcase, /ai-analysis-demo\.svg/);
  assert.doesNotMatch(showcase, /\/images\/showcase\/[^"]+\.(?:png|jpe?g|webp)/i);
  assert.doesNotMatch(showcase, /styles\.storyIcon/);
  assert.match(showcase, /styles\.storyNumber/);
  assert.match(showcase, /IntersectionObserver/);
  assert.match(showcase, /window\.innerHeight \* 0\.68/);
  assert.match(showcase, /window\.innerHeight \* 0\.42/);
  assert.match(showcase, /visibleStoryIndexesRef\.current\.size === 0/);
  assert.doesNotMatch(showcase, /experienceRef\.current\?\.style\.setProperty|--hero-scroll/);
  assert.match(showcase, /style\.translate/);
  assert.match(login, /loginShellStoryMode/);
  assert.match(login, /toggleAttribute\("inert", !visible\)/);
  assert.match(login, /classList\.toggle\(styles\.loginStageCollapsed, !visible\)/);
  assert.doesNotMatch(loginStyles, /visibility 0s linear|transition-delay: 0s, 0s, 760ms/);
  assert.match(loginStyles, /\.authColumn\s*\{[^}]*position:\s*fixed/);
  assert.match(loginStyles, /\.loginStage\s*\{[^}]*position:\s*relative/);
  assert.doesNotMatch(loginStyles, /grid-template-columns 820ms/);
  assert.doesNotMatch(showcase, /key=\{activeIndex\}/);
  assert.match(showcase, /data-showcase-device/);
  assert.match(brand, /PRODUCT_NAME = "危化智巡"/);
  assert.match(authContext, /registerAccount/);
  assert.match(login, /xingxun-mark\.svg/);
  assert.doesNotMatch(login, /\/brand\/[^"]+\.(?:png|jpe?g|webp)/i);
  assert.doesNotMatch(login, /room-login-preview/);
  assert.match(authContext, /AuthenticatedApplication/);
  assert.match(authContext, /stopVehicleBeforeExit/);
  assert.match(offline, /"\/login"/);
  assert.match(packageJson, /auth:setup/);
  assert.doesNotMatch(`${login}\n${authContext}\n${offline}`, /19491001/);
});

test("the built API runtime accepts a signed browser account without filesystem writes", async () => {
  const worker = await loadWorker();
  const username = "runtime-operator";
  const password = "runtime-enrollment-password";
  const enrollment = await localEnrollment(username, password);
  const response = await worker.fetch(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password, remember: true, enrollment }),
    }),
    env(),
    context(),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.session.user.username, username);
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
});

test("overview renders all six reserved telemetry slots", async () => {
  const worker = await loadWorker();
  const { response, html } = await renderPage(worker, "/");
  const overview = await readFile(
    new URL("../app/features/pages/OverviewPage.tsx", import.meta.url),
    "utf8",
  );

  assert.equal(response.status, 200);
  assert.match(html, /正在检查登录状态/);
  assert.match(overview, /TELEMETRY_SLOT_IDS\.map/);

  const initial = createInitialSnapshot();
  assert.deepEqual(Object.keys(initial.slots), [...TELEMETRY_SLOT_IDS]);
  assert.ok(Object.values(initial.slots).every((slot) => slot.state === "loading"));
  assert.ok(Object.values(initial.slots).every((slot) => slot.auxiliaryReadings.length === 0));
  assert.equal(initial.vehicle.connection, "stale");
  assert.equal(initial.vehicle.motion, "stop");
  assert.equal(initial.vehicle.speedPercent, 0);

  const unavailable = createUnavailableSlots("暂不可用");
  assert.deepEqual(Object.keys(unavailable), [...TELEMETRY_SLOT_IDS]);
  assert.ok(Object.values(unavailable).every((slot) => slot.state === "error"));
});

test("telemetry contract keeps six stable slots and all display states", async () => {
  assert.deepEqual(TELEMETRY_SLOT_IDS, [
    "slot-1",
    "slot-2",
    "slot-3",
    "slot-4",
    "slot-5",
    "slot-6",
  ]);

  const source = await readFile(
    new URL("../app/lib/iot/contracts.ts", import.meta.url),
    "utf8",
  );
  const declaration = source.match(/export type DataState\s*=([\s\S]*?);/)?.[1] ?? "";
  const states = [...declaration.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(states, ["loading", "live", "stale", "offline", "empty", "error"]);
});

test("Huawei IoTDA device shadow maps six environmental metrics and light details", () => {
  const now = Date.parse("2026-07-17T10:00:20Z");
  const slots = mapHuaweiShadowToSlots({
    device_id: "sensor-1",
    shadow: [{
      service_id: "Environment",
      reported: {
        properties: {
          temperature: 26,
          humidity: "61",
          lightRaw: 2345,
          lightPercent: 57,
          co2: 768,
          TVOC: "0.125",
          ch2o: 0.038,
        },
        event_time: "20260717T100010Z",
      },
    }],
  }, "Environment", now);

  assert.equal(slots["slot-1"].value, 26);
  assert.equal(slots["slot-2"].value, 61);
  assert.equal(slots["slot-3"].value, 768);
  assert.equal(slots["slot-3"].unit, "ppm");
  assert.equal(slots["slot-4"].value, 0.125);
  assert.equal(slots["slot-4"].sourceKey, "Environment.TVOC");
  assert.equal(slots["slot-5"].value, 0.038);
  assert.equal(slots["slot-5"].unit, "mg/m³");
  assert.equal(slots["slot-6"].value, 57);
  assert.equal(slots["slot-6"].unit, "%");
  assert.equal(slots["slot-6"].sourceKey, "Environment.lightPercent");
  assert.deepEqual(slots["slot-6"].auxiliaryReadings, [{
    sourceKey: "Environment.lightRaw",
    label: "光照原始值",
    value: 2345,
    unit: "ADC",
    precision: 0,
  }]);
  assert.equal(slots["slot-1"].state, "live");
  assert.equal(slots["slot-5"].state, "live");
  assert.equal(slots["slot-6"].state, "live");

  const zeroLight = mapHuaweiShadowToSlots({
    shadow: [{
      service_id: "Environment",
      reported: {
        properties: { lightPercent: 0, lightRaw: 0 },
        event_time: "20260717T100010Z",
      },
    }],
  }, "Environment", now);
  assert.equal(zeroLight["slot-6"].value, 0);
  assert.equal(zeroLight["slot-6"].state, "live");
  assert.equal(zeroLight["slot-6"].auxiliaryReadings[0]?.value, 0);

  const stale = mapHuaweiShadowToSlots({
    shadow: [{
      service_id: "Environment",
      reported: { properties: { temperature: 25, tvoc: "0.2" }, event_time: "20260717T095900Z" },
    }],
  }, "Environment", now);
  assert.equal(stale["slot-1"].state, "stale");
  assert.equal(stale["slot-2"].state, "empty");
  assert.equal(stale["slot-4"].value, 0.2);
});

test("Huawei IAM credential CSV supports the console export format without exposing secrets", () => {
  const credential = parseHuaweiCredentialCsv(
    '\uFEFFUser Name,Access Key Id,Secret Access Key\r\ntest-user,"example-ak","example-sk"\r\n',
  );
  assert.deepEqual(credential, {
    accessKeyId: "example-ak",
    secretAccessKey: "example-sk",
  });
  assert.throws(
    () => parseHuaweiCredentialCsv("User Name,Access Key Id\ntest-user,example-ak"),
    /Secret Access Key/,
  );
});

test("Jetson adapter uses safe defaults and preserves move, stop, and odom payloads", () => {
  assert.deepEqual(DEFAULT_JETSON_SETTINGS, {
    enabled: false,
    wsUrl: "ws://127.0.0.1:8765",
    maxWheelSpeed: 300,
  });
  const command = {
    requestId: "test-move",
    motion: "forward",
    speedPercent: 50,
    issuedAt: new Date(0).toISOString(),
  };
  assert.deepEqual(buildJetsonCommand(command, 300), {
    cmd: "move",
    speeds: [150, -150, 150, -150],
  });
  assert.deepEqual(buildJetsonCommand({ ...command, motion: "left" }, 300), {
    cmd: "move",
    speeds: [-150, -150, 150, 150],
  });
  assert.deepEqual(buildJetsonCommand({ ...command, motion: "stop" }, 300), { cmd: "stop" });
  assert.deepEqual(parseJetsonMessage(JSON.stringify({
    type: "odom",
    data: { M1: 1, M2: -2, M3: 3, M4: -4 },
  })), {
    type: "odom",
    data: { M1: 1, M2: -2, M3: 3, M4: -4 },
  });
  assert.equal(parseJetsonMessage('{"type":"odom","data":{"M1":1}}'), null);
  assert.deepEqual(parseJetsonInboundMessage(JSON.stringify({
    type: "video",
    data: "/9j/2Q==",
  })), {
    type: "video",
    data: "/9j/2Q==",
  });
});

test("digital twin keeps pole-free rotation, native resolution, and the full point count", async () => {
  const source = await readFile(
    new URL("../app/features/digital-twin/GaussianSplatViewport.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /TrackballControls/);
  assert.doesNotMatch(source, /three\/addons\/controls\/OrbitControls\.js/);
  assert.match(source, /controls\.handleResize\(\)/);
  assert.match(source, /controls\.staticMoving = true/);
  assert.match(
    source,
    /controls\.rotateSpeed\s*=\s*(?:modelKind\s*===\s*"point-cloud"\s*\?\s*)?1\.8/,
  );
  assert.match(source, /const nativePixelRatio\s*=\s*Math\.max\(1,\s*window\.devicePixelRatio\s*\|\|\s*1\)/);
  assert.match(source, /renderer\.setPixelRatio\(nativePixelRatio\)/);
  assert.match(source, /geometry\.setDrawRange\(0,\s*parsed\.vertexCount\)/);
  assert.match(source, /dataset\.pointFullCount\s*=\s*String\(parsed\.vertexCount\)/);
  assert.match(source, /dataset\.pointDrawCount\s*=\s*String\(parsed\.vertexCount\)/);
  assert.doesNotMatch(source, /POINT_CLOUD_MAX_RENDER|pointCloudPixelRatio/);
  assert.doesNotMatch(source, /parsed\.interactiveVertexCount|pointInteractiveCount/);
  assert.doesNotMatch(source, /showInteractionLod|restoreFullPointCloud/);
  assert.doesNotMatch(source, /beginInteraction[\s\S]{0,600}setDrawRange/);
  assert.doesNotMatch(source, /endInteraction[\s\S]{0,600}setDrawRange/);
  assert.doesNotMatch(source, /轻量\s*LOD|拖动时.*(?:LOD|加速)|720p\s*流畅/);
  assert.match(source, /Three\.js\s*·\s*原生分辨率/);
  assert.match(source, /const targetUp = config\.up\.clone\(\)\.normalize\(\)/);
  assert.match(source, /camera\.up\.copy\(targetUp\)/);
  assert.match(
    source,
    /cameraViewTransition\s*=\s*\{[\s\S]*?dataset\.aiViewState\s*=\s*"running";\s*if\s*\(modelKind\s*!==\s*"gaussian"\)\s*renderer\.setAnimationLoop\(renderLoop\);/,
  );
  assert.match(
    source,
    /cameraOrbitTransition\s*=\s*\{[\s\S]*?dataset\.aiOrbitState\s*=\s*"running";[\s\S]*?if\s*\(modelKind\s*!==\s*"gaussian"\)\s*renderer\.setAnimationLoop\(renderLoop\);/,
  );
  assert.match(source, /function waitForViewportState\(/);
  assert.match(source, /三维视口没有返回相机动作完成状态/);
  assert.match(
    source,
    /setViewRef\.current\(action\.arguments\.view\);[\s\S]{0,240}waitForViewportState\([\s\S]{0,240}reportActionSuccess\(action,\s*"标准视角已切换完成。"\)/,
  );
  assert.match(
    source,
    /orbitRef\.current\(action\.arguments\);[\s\S]{0,320}waitForViewportState\([\s\S]{0,260}reportActionSuccess\(action,\s*"环绕检查动画已完成。"\)/,
  );
  assert.doesNotMatch(source, /动画已启动。/);
});

test("digital twin opens top-down with fixed black layers and a minimal inspector", async () => {
  const [viewport, workspace, workspaceStyles, contract] = await Promise.all([
    readFile(
      new URL("../app/features/digital-twin/GaussianSplatViewport.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/digital-twin/DigitalTwinWorkspace.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/digital-twin/DigitalTwinWorkspace.module.css", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/lib/digital-twin/contracts.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(viewport, /useState<TwinStandardView>\("top"\)/);
  assert.match(viewport, /view:\s*TwinStandardView\s*=\s*"top"/);
  assert.match(viewport, /frameSphere\(normalizedSphere,\s*"top"\)/);
  assert.match(viewport, /frameSphere\(sphere,\s*"top",\s*animated\)/);
  assert.match(viewport, /scene\.background\s*=\s*new THREE\.Color\(0x000000\)/);
  assert.match(viewport, /primaryLayer\.visible\s*=\s*true/);
  assert.match(viewport, /gapLayer\.visible\s*=\s*next\.diagnosticActive/);
  assert.match(viewport, /frameworkLayer\.visible\s*=\s*next\.diagnosticActive/);
  assert.match(viewport, /applyLayerOpacity\(primaryLayer,\s*next\.diagnosticActive\s*\?\s*0\.16\s*:\s*1\)/);

  assert.match(workspace, /label:\s*"彩色"/);
  assert.match(workspace, /label:\s*"增强"/);
  assert.match(workspace, /label:\s*"几何"/);
  assert.match(workspace, /点尺寸/);
  assert.match(workspace, /按住查看缺口/);
  assert.match(workspace, /彩色真实点云/);
  assert.match(workspace, /缺口诊断层/);
  assert.match(workspace, /房间几何框架/);
  assert.match(workspace, /diagnosticPointerIdRef/);
  assert.match(workspace, /event\.pointerId !== diagnosticPointerIdRef\.current/);
  assert.match(workspace, /按住期间可用另一根手指移动模型/);
  assert.match(workspaceStyles, /\.mobileSheet\.isOpen\s*\{[^}]*translate3d\(0,\s*0,\s*0\)/);
  assert.match(workspaceStyles, /\.sheetBackdrop\.isOpen/);
  assert.match(workspace, /mobileSheet === next && mobileSheetOpen/);
  assert.match(workspace, /aria-pressed=\{mobileSheetOpen && mobileSheet === "scene"\}/);
  assert.match(workspaceStyles, /\.sheetBackdrop\s*\{[^}]*pointer-events:\s*none/);
  assert.match(workspaceStyles, /\.sheetBackdrop\.isOpen\s*\{[^}]*pointer-events:\s*auto/);
  assert.match(workspaceStyles, /\.mobileSheet\s*\{[^}]*pointer-events:\s*none/);
  assert.match(workspaceStyles, /\.mobileSheet\.isOpen\s*\{[^}]*pointer-events:\s*auto/);
  assert.match(workspaceStyles, /@keyframes twinSheetContentIn/);
  assert.doesNotMatch(
    workspace,
    /VIEW INSPECTOR|显示检查器|场景信息|坐标锁定|视口背景|本地只读|原生 DPR|LIVE SPATIAL CANVAS|交互过程保持完整点数|更换图层/,
  );

  const appearance = contract.match(
    /export interface TwinViewportAppearance\s*\{([\s\S]*?)\}/,
  )?.[1] ?? "";
  assert.match(appearance, /displayMode:\s*TwinDisplayMode/);
  assert.match(appearance, /pointSize:\s*number/);
  assert.match(appearance, /diagnosticActive:\s*boolean/);
  assert.doesNotMatch(appearance, /background|Visible|Opacity/);
});

test("bundled twin assets preload once and reuse the calibrated room view", async () => {
  const [shell, preloader, viewport, coordinates, workspace, pageTransitions] = await Promise.all([
    readFile(new URL("../app/features/shell/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/digital-twin/preloadRoomOneTwinScene.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/digital-twin/GaussianSplatViewport.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/digital-twin/room-one-coordinate-system.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/digital-twin/DigitalTwinWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/pages/PageTransitions.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(shell, /preloadRoomOneTwinScene/);
  assert.match(shell, /},\s*350\)/);
  assert.match(preloader, /cache:\s*"force-cache"/);
  assert.match(preloader, /const sharedParseQueue/);
  assert.match(preloader, /roomOnePreloadPromise/);
  assert.match(preloader, /loadRoomOneTwinSceneFiles/);
  assert.match(viewport, /file\.name\s*===\s*ROOM_ONE_RECOMMENDED_MODELS\.primary/);
  assert.match(viewport, /ROOM_ONE_TOP_DIRECTION/);
  assert.match(viewport, /ROOM_ONE_TOP_UP/);
  assert.match(coordinates, /ROOM_ONE_TOP_DIRECTION = \[0, 1, 0\]/);
  assert.match(coordinates, /ROOM_ONE_TOP_UP = \[0, 0, -1\]/);
  assert.match(coordinates, /ROOM_ONE_TOP_RIGHT = \[1, 0, 0\]/);
  assert.match(coordinates, /room-top-map\.svg\?v=1/);
  assert.match(coordinates, /room-navigation-overhead-map\.svg\?v=1/);
  assert.match(workspace, /displayModeMidpointRef/);
  assert.match(workspace, /setPanelTab/);
  assert.match(pageTransitions, /export function DirectionalPanel/);
  assert.match(pageTransitions, /export function SlidingTabs/);
});

test("navigation transitions preserve direction, history, and vehicle safety", async () => {
  const [navigation, layout, authContext, vehicle] = await Promise.all([
    readFile(
      new URL("../app/features/transitions/NavigationTransition.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/auth/AuthContext.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/features/pages/VehiclePage.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.doesNotMatch(navigation, /document\.startViewTransition/);
  assert.match(navigation, /element\.animate\(keyframes,\s*options\)/);
  assert.match(navigation, /animation\.finished/);
  assert.match(navigation, /cubic-bezier\(\.16,\s*1,\s*\.3,\s*1\)/);
  assert.match(navigation, /xingxun:navigation-start/);
  assert.match(navigation, /xingxun:navigation-end/);
  assert.match(navigation, /navigation-transition-curtain/);
  assert.match(navigation, /sessionStorage/);
  assert.match(navigation, /window\.history\.back\(\)/);
  assert.match(navigation, /handlePopState[\s\S]*?runTransition\(/);
  assert.match(navigation, /reducedMotion\s*\|\|\s*document\.hidden/);
  assert.match(navigation, /visibilitychange/);
  assert.match(navigation, /scrollTo\(\{\s*top:\s*nextEntry\.scrollY/);
  assert.match(navigation, /to\s*===\s*"\/digital-twin"/);
  assert.match(navigation, /type NavigationDirection\s*=\s*"forward"\s*\|\s*"back"\s*\|\s*"drill-in"/);
  assert.match(layout, /<AuthProvider>/);
  assert.match(layout, /<AuthenticatedApplication>\{children\}<\/AuthenticatedApplication>/);
  assert.match(authContext, /<NavigationTransitionProvider>/);
  assert.match(authContext, /<IotDashboardProvider>/);
  assert.match(authContext, /<AppShell>\{children\}<\/AppShell>/);
  assert.match(vehicle, /const navigationStart\s*=\s*\(\)\s*=>\s*stopMotion\(\)/);
  assert.match(vehicle, /window\.addEventListener\("xingxun:navigation-start",\s*navigationStart\)/);
});

test("motion speed preference uses one progress slider and a shared animation clock", async () => {
  const [preferences, settings, navigation, pageStyles, shellStyles, twin, viewport] = await Promise.all([
    readFile(new URL("../app/lib/ui-preferences.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/pages/SettingsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/transitions/NavigationTransition.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/pages/Pages.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/features/shell/AppShell.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/features/digital-twin/DigitalTwinWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/digital-twin/GaussianSplatViewport.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(preferences, /motionSpeedPercent:\s*number/);
  assert.match(preferences, /DEFAULT_MOTION_SPEED_PERCENT\s*=\s*50/);
  assert.match(preferences, /MOTION_SPEED_MIN\s*=\s*25/);
  assert.match(preferences, /MOTION_SPEED_MAX\s*=\s*180/);
  assert.match(preferences, /applyMotionSpeedToDocument/);
  assert.match(settings, /type="range"/);
  assert.match(settings, /id="motion-speed"/);
  assert.match(settings, /previewMotionSpeed/);
  assert.match(navigation, /motionSpeedPercentRef/);
  assert.match(navigation, /getScaledMotionDurationMs\(LIVE_EXIT_DURATION_MS/);
  assert.match(navigation, /getScaledMotionDurationMs\(LIVE_ENTER_DURATION_MS/);
  assert.match(pageStyles, /--motion-duration-panel/);
  assert.match(shellStyles, /--motion-duration-route-enter/);
  assert.match(twin, /getScaledMotionDurationMs\(110\)/);
  assert.match(viewport, /getScaledMotionDurationMs\(82\)/);
  assert.match(viewport, /type CameraViewTransition/);
  assert.match(viewport, /directionRotation:\s*new THREE\.Quaternion\(\)\.setFromUnitVectors/);
  assert.match(viewport, /linearProgress \* linearProgress \* linearProgress/);
  assert.match(viewport, /cancelCameraMotion\(\);[\s\S]*?controlsInteracting = true/);
  assert.match(viewport, /setViewRef\.current = \(view\) => frameSphere\(framedSphere, view, true\)/);
});

test("settings separates browser refresh from persistent Huawei collector polling", async () => {
  const [settings, context, contracts, huaweiProvider] = await Promise.all([
    readFile(new URL("../app/features/pages/SettingsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ai/AiControlContext.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/iot/telemetry-history-contracts.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/iot/providers/huawei-iotda-sensors.server.ts", import.meta.url), "utf8"),
  ]);
  assert.match(settings, /华为云后台读取间隔/);
  assert.match(settings, /页面显示刷新间隔/);
  assert.match(settings, /!androidStandalone/);
  assert.match(settings, /saveCollectorPollInterval/);
  assert.match(settings, /pendingSettingsRef/);
  assert.match(settings, /if \(!collectorSettingsDirty\)[\s\S]*persistSettings\(next\)/);
  assert.match(settings, /state\.phase === "error"[\s\S]*pendingSettingsRef\.current = null[\s\S]*setSaved\(false\)/);
  assert.match(context, /telemetry\.collector\.settings\.request/);
  assert.match(context, /telemetry\.collector\.settings\.update/);
  assert.match(context, /telemetry\.collector\.settings\.result/);
  assert.match(context, /telemetry\.collector\.settings\.error/);
  assert.match(contracts, /TELEMETRY_POLL_INTERVALS\s*=\s*\[1000, 3500, 5000, 10000\]/);
  assert.match(huaweiProvider, /DEFAULT_REQUEST_CACHE_MS\s*=\s*0/);
});

test("Android keeps a one-second direct-read default, native exports, and layered back handling", async () => {
  const [preferences, offline, offlineProvider, localStore, settings, primitives, nativeCloud, androidBack, mainActivity, cloudBridge, animatedSelect] = await Promise.all([
    readFile(new URL("../app/lib/ui-preferences.ts", import.meta.url), "utf8"),
    readFile(new URL("../offline/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../offline/offline-iot-provider.ts", import.meta.url), "utf8"),
    readFile(new URL("../offline/local-data-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/pages/SettingsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/pages/PagePrimitives.tsx", import.meta.url), "utf8"),
    readFile(new URL("../offline/native-cloud.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ui/useAndroidBack.ts", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/xingxun/iotcontrol/MainActivity.java", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/xingxun/iotcontrol/AndroidCloudBridge.java", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ui/AnimatedSelect.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(preferences, /ANDROID_DEFAULT_PREFERENCES[\s\S]*?refreshIntervalMs:\s*1000/);
  assert.match(preferences, /window\.location\.hostname === "xingxun\.local"/);
  assert.match(offline, /JSON\.stringify\(ANDROID_DEFAULT_PREFERENCES\)/);
  assert.match(offline, /"\/integrations":\s*\{\s*title:\s*"连接管理"/);
  assert.match(offlineProvider, /recordAndroidCollectionFailure/);
  assert.match(offlineProvider, /recordAndroidCollectionRecovery/);
  assert.match(offlineProvider, /isExpectedNativeCloudCancellation\(error,\s*signal\)[\s\S]*?throw error/);
  assert.match(offlineProvider, /recordAndroidCollectionFailure\(error,\s*snapshot\.generatedAt\)[\s\S]*?recordAndroidSnapshot\(snapshot\)/);
  assert.match(localStore, /detectAndroidDuplicateObservationStateEvents/);
  assert.match(localStore, /createAndroidIndependentObservationCounter/);
  assert.match(settings, /JSON\.stringify\(runtimeDefaultPreferences\)/);
  assert.match(settings, /页面与华为云直读间隔/);
  assert.match(settings, /直接读取华为云 IoTDA 并刷新页面/);
  assert.match(primitives, /typeof window\.XingXunCloud\?\.saveTextFile === "function"/);
  assert.match(primitives, /saveTextFile\(content, fileName, mimeType\)/);
  assert.match(primitives, /URL\.createObjectURL\(new Blob\(\[content\]/);
  assert.match(nativeCloud, /saveTextFile\(content: string, requestedName: string, mimeType: string\): void/);
  assert.match(nativeCloud, /setActiveRoute\(path: string\): void/);
  assert.match(nativeCloud, /detail\.cancelled[\s\S]*?new DOMException\([^)]*"AbortError"\)/);
  assert.match(nativeCloud, /isExpectedNativeCloudCancellation/);
  assert.match(mainActivity, /CustomEvent\('xingxun:android-back'/);
  assert.match(mainActivity, /event\.defaultPrevented/);
  assert.match(mainActivity, /matchesRoute\(path, "\/vehicle"\)/);
  assert.match(mainActivity, /matchesRoute\(path, "\/monitoring"\)/);
  assert.match(mainActivity, /FLAG_KEEP_SCREEN_ON/);
  assert.match(mainActivity, /webView\.setKeepScreenOn\(keepScreenOn\)/);
  assert.match(mainActivity, /void updateActiveRoute\(String path\)/);
  assert.match(mainActivity, /cloudBridge\.onHostPause\(\)/);
  assert.match(mainActivity, /cloudBridge\.onHostResume\(\)/);
  assert.match(cloudBridge, /public void saveTextFile\(String content, String requestedName, String mimeType\)/);
  assert.match(cloudBridge, /public void setActiveRoute\(String path\)/);
  assert.match(cloudBridge, /void onHostPause\(\)/);
  assert.match(cloudBridge, /dispatchLifecycle\("paused", message\)/);
  assert.match(cloudBridge, /void onHostResume\(\)[\s\S]*?dispatchLifecycle\("resumed", null\)/);
  assert.match(cloudBridge, /dispatchCloudCancellation\(entry\.getKey\(\), message\)/);
  assert.match(cloudBridge, /detail\.put\("cancelled", true\)/);
  assert.match(cloudBridge, /cancelForLifecycle\(message\)/);
  assert.match(androidBack, /right\.priority - left\.priority/);
  assert.match(androidBack, /event\.preventDefault\(\)/);
  assert.match(animatedSelect, /useAndroidBack\(open,[\s\S]*?100\)/);
});

test("dashboard polling is serial, visibility-aware, and always stops after cancelling navigation", async () => {
  const [dashboard, vehicle] = await Promise.all([
    readFile(new URL("../app/features/iot/use-iot-dashboard.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/iot/use-jetson-vehicle.ts", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /refreshPromiseRef/);
  assert.match(dashboard, /window\.setTimeout\([\s\S]*?refreshIntervalMs/);
  assert.doesNotMatch(dashboard, /window\.setInterval/);
  assert.match(dashboard, /pauseWhenHidden && document\.visibilityState === "hidden"/);
  assert.match(dashboard, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(dashboard, /const cancelActiveRefresh[\s\S]*?refreshController\.current\?\.abort\([\s\S]*?"AbortError"/);
  assert.match(dashboard, /document\.visibilityState === "hidden"[\s\S]*?cancelActiveRefresh\("页面已隐藏，暂停数据读取"\)/);
  assert.match(dashboard, /window\.addEventListener\("xingxun:native-lifecycle", handleNativeLifecycle\)/);
  assert.match(dashboard, /state === "paused"[\s\S]*?nativeHostPaused = true[\s\S]*?cancelActiveRefresh/);
  assert.match(dashboard, /controller\.signal\.aborted \|\| isAbortError\(error\)/);
  assert.match(dashboard, /cancelNavigation\(\);[\s\S]*?sendStop\(\);/);
  assert.match(vehicle, /if \(socket\?\.readyState === WebSocket\.OPEN\)[\s\S]*?cmd: "stop"/);
  assert.doesNotMatch(vehicle, /navigationRef\.current\?\.state !== "running"/);
});

test("Agent thinking mode and reasoning effort are selectable and sent end to end", async () => {
  const [preferences, settings, voiceBar, preferenceOptions, animatedSelect, animatedSelectStyles, context, gateway, androidRuntime] = await Promise.all([
    readFile(new URL("../app/lib/ai/preferences.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/pages/SettingsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ai/AiVoiceBar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ai/agent-preference-options.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ui/AnimatedSelect.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ui/AnimatedSelect.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ai/AiControlContext.tsx", import.meta.url), "utf8"),
    readFile(new URL("../agent/gateway.ts", import.meta.url), "utf8"),
    readFile(new URL("../offline/local-agent-runtime.ts", import.meta.url), "utf8"),
  ]);

  assert.match(preferences, /thinkingMode:\s*"thinking"/);
  assert.match(preferences, /reasoningEffort:\s*"high"/);
  assert.match(settings, /Agent 思考模式/);
  assert.match(settings, /AnimatedSelect/);
  assert.match(preferenceOptions, /非思考模式/);
  assert.match(preferenceOptions, /标准（high）/);
  assert.match(preferenceOptions, /最高（max）/);
  assert.match(settings, /disabled=\{aiSettings\.thinkingMode === "non-thinking"\}/);
  assert.match(voiceBar, /ai\.preferences\.thinkingMode/);
  assert.match(voiceBar, /ai\.preferences\.reasoningEffort/);
  assert.match(context, /thinkingMode:\s*prefs\.thinkingMode/);
  assert.match(context, /reasoningEffort:\s*prefs\.reasoningEffort/);
  assert.match(gateway, /thinkingMode:\s*client\.thinkingMode/);
  assert.match(gateway, /reasoningEffort:\s*client\.reasoningEffort/);
  assert.match(androidRuntime, /thinkingMode:\s*this\.thinkingMode/);
  assert.match(androidRuntime, /reasoningEffort:\s*this\.reasoningEffort/);
  assert.match(animatedSelect, /aria-haspopup="listbox"/);
  assert.match(animatedSelect, /role="option"/);
  assert.match(animatedSelect, /createPortal/);
  assert.match(animatedSelect, /prefers-reduced-motion: reduce/);
  assert.match(animatedSelect, /ArrowDown/);
  assert.match(animatedSelect, /Escape/);
  assert.match(animatedSelectStyles, /--motion-duration-quick/);
  assert.match(animatedSelectStyles, /cubic-bezier\(\.16, 1, \.3, 1\)/);
  assert.match(animatedSelectStyles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("telemetry persists across routes and defers snapshot paints during motion", async () => {
  const source = await readFile(
    new URL("../app/features/iot/use-iot-dashboard.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /createContext<IotDashboardContextValue\s*\|\s*null>/);
  assert.match(source, /export function IotDashboardProvider/);
  assert.match(source, /navigationActiveRef\.current/);
  assert.match(source, /queuedSnapshotRef\.current\s*=\s*next/);
  assert.match(source, /xingxun:navigation-start/);
  assert.match(source, /xingxun:navigation-end/);
});

test("digital twin freezes rendering before navigation and defers GPU disposal", async () => {
  const [viewport, workspace, styles] = await Promise.all([
    readFile(new URL("../app/features/digital-twin/GaussianSplatViewport.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/digital-twin/DigitalTwinWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/digital-twin/DigitalTwinWorkspace.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(viewport, /deferNavigationDisposal/);
  assert.match(viewport, /renderer\.setAnimationLoop\(null\)/);
  assert.match(viewport, /renderer\.forceContextLoss\(\)/);
  assert.match(viewport, /styles\.isCanvasLeaving/);
  assert.match(workspace, /styles\.isNavigationLeaving/);
  assert.match(styles, /\.splatCanvas\.isCanvasLeaving/);
  assert.match(styles, /\.page\.isNavigationLeaving/);
});

test("vehicle controls stop on release, focus loss, hidden page, and unmount", async () => {
  const source = await readFile(
    new URL("../app/features/pages/VehiclePage.tsx", import.meta.url),
    "utf8",
  );

  const driveButton = source.slice(
    source.indexOf("function DriveButton"),
    source.indexOf("export function VehiclePage"),
  );
  const globalKeyDown = source.slice(
    source.indexOf("const keyDown = (event: KeyboardEvent) =>"),
    source.indexOf("const keyUp = (event: KeyboardEvent) =>"),
  );

  assert.match(source, /onPointerUp=\{pointerStop\}/);
  assert.match(source, /onPointerCancel=\{pointerStop\}/);
  assert.match(source, /onLostPointerCapture=\{pointerStop\}/);
  assert.match(driveButton, /const pointerStop[\s\S]*?onStop\(\)[\s\S]*?document\.activeElement === event\.currentTarget[\s\S]*?event\.currentTarget\.blur\(\)/);
  assert.match(driveButton, /event\.key === "Enter"/);
  assert.doesNotMatch(driveButton, /event\.key === " "/);
  assert.ok(globalKeyDown.indexOf('event.code === "Space"') < globalKeyDown.indexOf("isEditableTarget(event.target)"));
  assert.match(globalKeyDown, /event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?if \(!event\.repeat\) emergencyStop\(\)/);
  assert.match(source, /window\.addEventListener\("keydown",\s*keyDown,\s*true\)/);
  assert.match(source, /window\.removeEventListener\("keydown",\s*keyDown,\s*true\)/);
  assert.match(source, /window\.addEventListener\("blur",\s*stopMotion\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange",\s*visibility\)/);
  assert.match(source, /document\.visibilityState\s*===\s*"hidden"/);
  assert.match(source, /window\.removeEventListener\("blur",\s*stopMotion\)/);
  assert.match(source, /document\.removeEventListener\("visibilitychange",\s*visibility\)/);
  assert.match(source, /return\s*\(\)\s*=>\s*\{[\s\S]*?stopMotion\(\);[\s\S]*?\}/);
});

test("Jetson offline state cannot block Agent preferences or pin the message bar open", async () => {
  const [gateway, context, voiceBar] = await Promise.all([
    readFile(new URL("../agent/gateway.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ai/AiControlContext.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ai/AiVoiceBar.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(gateway, /payload\.automatic === true && movementControllerId === null/);
  assert.match(gateway, /!shuttingDown && movementControllerId === client\.id/);
  assert.doesNotMatch(gateway, /client\.role === "remote" && client\.realVehicleEnabled/);
  assert.match(context, /send\("vehicle\.stop", \{ automatic: true \}\)/);
  assert.match(context, /removeEventListener\("pagehide", stopWhenLeaving\)/);
  assert.match(context, /const requiresReconnect = current\.gatewayUrl !== next\.gatewayUrl/);
  assert.match(context, /if \(requiresReconnect\)[\s\S]*connection preferences changed[\s\S]*return;/);
  assert.match(context, /send\("client\.preferences"/);
  assert.match(voiceBar, /\["understanding", "executing", "confirming"\]\.includes\(ai\.session\.phase\)/);
  assert.doesNotMatch(voiceBar, /\["understanding", "executing", "confirming", "speaking", "error"\]/);
});

test("vehicle UI separates control transport from validated device telemetry", async () => {
  const [hook, page, dashboard, offline] = await Promise.all([
    readFile(new URL("../app/features/iot/use-jetson-vehicle.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/pages/VehiclePage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/iot/use-iot-dashboard.ts", import.meta.url), "utf8"),
    readFile(new URL("../offline/offline-iot-provider.ts", import.meta.url), "utf8"),
  ]);
  const openHandler = hook.slice(
    hook.indexOf('socket.addEventListener("open"'),
    hook.indexOf('socket.addEventListener("message"'),
  );
  const messageHandler = hook.slice(
    hook.indexOf('socket.addEventListener("message"'),
    hook.indexOf('socket.addEventListener("close"'),
  );
  const sendHandler = hook.slice(
    hook.indexOf("const sendCommand = useCallback"),
    hook.indexOf("return { enabled:"),
  );

  assert.match(openHandler, /controlLink:\s*"connected"/);
  assert.doesNotMatch(openHandler, /connection:\s*"online"|lastSeenAt:/);
  assert.match(messageHandler, /parseJetsonInboundMessage/);
  assert.match(messageHandler, /connection:\s*"online"/);
  assert.match(messageHandler, /lastSeenAt:\s*now/);
  assert.doesNotMatch(sendHandler, /setTelemetry/);
  assert.match(page, /控制链路已连接，等待车辆回传/);
  assert.match(page, /链路连通不等于设备状态在线/);
  assert.match(page, /暂无有效车辆回传/);
  assert.doesNotMatch(page, /车辆在线|可以开始控制/);
  assert.match(dashboard, /const effectiveSnapshot = \{ \.\.\.snapshot, vehicle: jetsonTelemetry \}/);
  assert.doesNotMatch(offline, /batteryPercent:\s*82|obstacleDistanceCm:\s*Math|connection:\s*"online"/);
});

test("mock sensors never fabricate vehicle state or execution", async () => {
  const worker = await loadWorker();
  const cookie = await localAuthCookie();
  const snapshotResponse = await worker.fetch(
    new Request("http://localhost/api/iot/snapshot", { headers: { cookie } }),
    env(),
    context(),
  );
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.provider, "mock");
  assert.deepEqual(Object.keys(snapshot.slots), [
    "slot-1",
    "slot-2",
    "slot-3",
    "slot-4",
    "slot-5",
    "slot-6",
  ]);
  assert.deepEqual(
    Object.values(snapshot.slots).map((slot) => slot.slotId),
    [...TELEMETRY_SLOT_IDS],
  );
  assert.ok(Object.values(snapshot.slots).every((slot) => slot.state === "live"));
  assert.equal(snapshot.slots["slot-6"].unit, "%");
  assert.equal(snapshot.slots["slot-6"].auxiliaryReadings[0].sourceKey, "mock.environment.lightRaw");
  assert.equal(snapshot.vehicle.controlLink, "disabled");
  assert.equal(snapshot.vehicle.connection, "offline");
  assert.equal(snapshot.vehicle.observedAt, null);
  assert.equal(snapshot.vehicle.lastSeenAt, null);
  assert.equal(snapshot.vehicle.batteryPercent, null);
  assert.equal(snapshot.vehicle.obstacleDistanceCm, null);
  assert.equal(snapshot.vehicle.signalDbm, null);
  assert.equal(snapshot.vehicle.headingDeg, null);
  assert.equal(snapshot.vehicle.wheelSpeeds, null);
  assert.equal(snapshotResponse.headers.get("cache-control"), "no-store");

  const commandResponse = await worker.fetch(
    new Request("http://localhost/api/iot/vehicle/commands", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        requestId: "test-forward-1",
        motion: "forward",
        speedPercent: 42,
        issuedAt: new Date().toISOString(),
      }),
    }),
    env(),
    context(),
  );
  assert.equal(commandResponse.status, 409);
  const ack = await commandResponse.json();
  assert.equal(ack.status, "rejected");
  assert.equal(ack.requestId, "test-forward-1");
  assert.match(ack.message, /不会发送车辆指令/);

  const stopResponse = await worker.fetch(
    new Request("http://localhost/api/iot/vehicle/commands", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        requestId: "test-stop-normalizes-speed",
        motion: "stop",
        speedPercent: 100,
        issuedAt: new Date().toISOString(),
      }),
    }),
    env(),
    context(),
  );
  assert.equal(stopResponse.status, 409);

  const stoppedSnapshotResponse = await worker.fetch(
    new Request("http://localhost/api/iot/snapshot", { headers: { cookie } }),
    env(),
    context(),
  );
  const stoppedSnapshot = await stoppedSnapshotResponse.json();
  assert.equal(stoppedSnapshot.vehicle.motion, "stop");
  assert.equal(stoppedSnapshot.vehicle.speedPercent, 0);

  const invalidCommands = [
    { motion: "fly", speedPercent: 50 },
    { requestId: "negative", motion: "forward", speedPercent: -1, issuedAt: new Date().toISOString() },
    { requestId: "too-fast", motion: "forward", speedPercent: 101, issuedAt: new Date().toISOString() },
    { requestId: "missing-time", motion: "forward", speedPercent: 50 },
  ];
  for (const command of invalidCommands) {
    const invalidResponse = await worker.fetch(
      new Request("http://localhost/api/iot/vehicle/commands", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(command),
      }),
      env(),
      context(),
    );
    assert.equal(invalidResponse.status, 400);
  }

  const invalidJsonResponse = await worker.fetch(
    new Request("http://localhost/api/iot/vehicle/commands", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{not-json",
    }),
    env(),
    context(),
  );
  assert.equal(invalidJsonResponse.status, 400);
});

test("responsive shell defines compact and mobile layout breakpoints", async () => {
  const styles = (
    await Promise.all([
      "../app/globals.css",
      "../app/features/shell/AppShell.module.css",
      "../app/features/pages/Pages.module.css",
      "../app/features/digital-twin/DigitalTwinWorkspace.module.css",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")))
  ).join("\n");
  assert.match(styles, /@media\s*\([^)]*max-width:\s*1024px[^)]*\)/);
  assert.match(styles, /@media\s*\([^)]*max-width:\s*768px[^)]*\)/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
});

test("AI controls retract after three idle seconds and remain recoverable", async () => {
  const [component, styles, context, evidenceGuide] = await Promise.all([
    readFile(new URL("../app/features/ai/AiVoiceBar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ai/AiVoiceBar.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/features/ai/AiControlContext.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/ai/evidence-guide.ts", import.meta.url), "utf8"),
  ]);

  assert.match(component, /AUTO_HIDE_DELAY_MS\s*=\s*3_000/);
  assert.match(component, /event\.clientY\s*>=\s*window\.innerHeight\s*-\s*BOTTOM_WAKE_DISTANCE_PX/);
  assert.match(component, /Boolean\(ai\.pendingVehicle\)/);
  assert.match(component, /\["listening", "understanding", "confirming", "executing"\]/);
  assert.match(component, /aria-label="显示 AI 智能中枢"/);
  assert.match(styles, /\.hostHidden\s*\{[^}]*translate3d/);
  assert.match(styles, /\.wakeZoneVisible\s*\{[^}]*pointer-events:\s*auto/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
  for (const stage of ["理解目标", "识别证据", "选择界面", "校验动作", "执行动作", "任务完成"]) {
    assert.match(context, new RegExp(stage));
  }
  assert.match(context, /buildPublicPlanningProgress/);
  assert.match(component, /role="progressbar"/);
  assert.match(component, /currentSummary/);
  assert.match(styles, /\.planningProgressTrack\s*>\s*i\s*\{[^}]*transition:\s*width[^}]*cubic-bezier\(\.22,1,\.36,1\)/);
  assert.match(component, /AiPanelTransition/);
  assert.match(styles, /ai-panel-view-enter-forward/);
  assert.match(styles, /ai-panel-view-enter-back/);
  assert.match(component, /当前证据|证据 \$\{ai\.evidenceGuide\.position\}/);
  assert.match(component, /继续/);
  assert.match(component, /结束讲解/);
  assert.match(component, /setFocusPresentationActive\(false\)/);
  assert.match(component, /evidenceGuide\.phase !== "complete"/);
  assert.match(context, /evidenceGuidePausedRef/);
  assert.match(context, /spatialSampleCounts/);
  assert.match(evidenceGuide, /dataAvailability/);
  assert.match(evidenceGuide, /不能据此判断变化程度/);
  assert.match(styles, /\.guideHost\s*\{[^}]*420px/);
  assert.match(styles, /ai-evidence-guide-out/);
});

test("starter preview and dependency are removed", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("local model safety allows exact OpenMVS point clouds without relaxing ordinary PLY", () => {
  assert.equal(MAX_CPU_PLY_VERTICES, 2_000_000);
  assert.equal(MAX_OPENMVS_POINT_CLOUD_VERTICES, 10_000_000);
  assert.doesNotThrow(() => assertLocalModelFileSize(12 * 1024 * 1024));
  assert.throws(
    () => assertLocalModelFileSize(MAX_LOCAL_MODEL_FILE_BYTES + 1),
    /512 MB/,
  );

  const pointCloud = inspectPlyHeader([
    "ply",
    "format binary_little_endian 1.0",
    "element vertex 597456",
    "property float x",
    "property float y",
    "property float z",
    "end_header",
  ].join("\n"));
  assert.equal(pointCloud.kind, "point-cloud");
  assert.equal(pointCloud.vertexCount, 597456);
  assert.equal(pointCloud.optimizedPointCloud, false);

  assert.throws(
    () => inspectPlyHeader("ply\nelement vertex 2000001\nproperty float x\nend_header"),
    /普通 CPU PLY 超过 200 万个顶点/,
  );

  const openMvs = inspectPlyHeader(openMvsDenseHeader(9_190_830));
  assert.equal(openMvs.kind, "point-cloud");
  assert.equal(openMvs.vertexCount, 9_190_830);
  assert.equal(openMvs.faceCount, null);
  assert.equal(openMvs.optimizedPointCloud, true);
  assert.doesNotThrow(() => inspectPlyHeader(openMvsDenseHeader(10_000_000)));
  assert.throws(
    () => inspectPlyHeader(openMvsDenseHeader(10_000_001)),
    /OpenMVS 彩色点云超过 1000 万点/,
  );

  assert.throws(
    () => inspectPlyHeader("ply\nelement vertex 10\nelement face 4000001\nend_header"),
    /400 万个三角面/,
  );

  const gaussian = inspectPlyHeader([
    "ply",
    "element vertex 9000000",
    "property float scale_0",
    "property float scale_1",
    "property float scale_2",
    "property float rot_0",
    "property float opacity",
    "end_header",
  ].join("\n"));
  assert.equal(gaussian.kind, "gaussian");
});

test("OpenMVS binary little-endian parser streams coordinates, linear RGB, and progress", async () => {
  const points = [
    {
      position: [1, 2, 3],
      color: [255, 128, 0],
      views: [],
    },
    {
      position: [-4, 0.5, 8],
      color: [12, 34, 56],
      views: [{ imageIndex: 7, weight: 0.75 }],
    },
    {
      position: [9, -10, 11.25],
      color: [64, 192, 240],
      views: [
        { imageIndex: 2, weight: 0.25 },
        { imageIndex: 11, weight: 0.5 },
      ],
    },
  ];
  const header = openMvsDenseHeader(points.length);
  const blob = new Blob([
    header,
    ...points.map((point) => openMvsDenseRecord(point)),
  ]);

  const probe = await probePlyBlob(blob);
  assert.equal(probe.dataOffset, new TextEncoder().encode(header).byteLength);
  assert.equal(probe.vertexCount, points.length);
  assert.equal(probe.isOpenMvsDensePointCloud, true);

  const progress = [];
  const parsed = await parseOpenMvsDensePointCloud(blob, probe, (update) => {
    progress.push({ ...update });
  });

  assert.equal(parsed.vertexCount, points.length);
  assert.equal(parsed.bucketCount, 1);
  assert.equal(parsed.interactiveVertexCount, points.length);
  assert.equal(pointCloudBucketCount(2_000_000), 8);
  assert.deepEqual(Array.from(parsed.positions), points.flatMap((point) => point.position));
  assert.equal(linearizeSrgbByte(128), 55);
  assert.notEqual(linearizeSrgbByte(128), 128);
  assert.deepEqual(
    Array.from(parsed.colors),
    points.flatMap((point) => point.color.map(linearizeSrgbByte)),
  );
  assert.ok(progress.length >= points.length, "解析过程中应持续上报点数进度");
  assert.ok(
    progress.every((update, index) => (
      update.ratio >= 0
      && update.ratio <= 1
      && (index === 0 || update.pointsRead >= progress[index - 1].pointsRead)
    )),
  );
  assert.deepEqual(progress.at(-1), {
    bytesRead: blob.size,
    pointsRead: points.length,
    ratio: 1,
  });
});

test("OpenMVS GLB textures flip V once while standard GLB textures stay unchanged", () => {
  const openMvsTexture = new Texture();
  openMvsTexture.flipY = false;
  const sharedMaterial = new MeshBasicMaterial({ map: openMvsTexture });
  const scene = new Group();
  scene.add(
    new Mesh(new BoxGeometry(), sharedMaterial),
    new Mesh(new BoxGeometry(), sharedMaterial),
  );
  const previousVersion = openMvsTexture.version;

  assert.equal(isOpenMvsGenerator("OpenMVS TextureMesh"), true);
  assert.equal(fixOpenMvsBaseColorTextures(scene, "OpenMVS TextureMesh"), 1);
  assert.equal(openMvsTexture.flipY, false);
  assert.equal(openMvsTexture.repeat.y, -1);
  assert.equal(openMvsTexture.offset.y, 1);
  assert.equal(openMvsTexture.version, previousVersion + 1);
  assert.equal(fixOpenMvsBaseColorTextures(scene, "OpenMVS TextureMesh"), 0);

  const standardTexture = new Texture();
  standardTexture.flipY = false;
  const standardScene = new Group();
  standardScene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial({ map: standardTexture })));
  const standardVersion = standardTexture.version;
  assert.equal(fixOpenMvsBaseColorTextures(standardScene, "Blender glTF Exporter"), 0);
  assert.equal(standardTexture.flipY, false);
  assert.equal(standardTexture.version, standardVersion);
});
