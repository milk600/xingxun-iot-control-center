import assert from "node:assert/strict";
import test from "node:test";
import {
  downloadVehicleFrame,
  isCapturableVehicleFrame,
  vehicleCaptureFileName,
} from "../app/lib/iot/camera-capture";

const FRAME = "data:image/jpeg;base64,/9j/2Q==";

test("车辆截图只接受 Jetson JPEG Data URL", () => {
  assert.equal(isCapturableVehicleFrame(FRAME), true);
  assert.equal(isCapturableVehicleFrame("data:image/png;base64,iVBORw0K"), false);
  assert.equal(isCapturableVehicleFrame("https://example.test/frame.jpg"), false);
});

test("车辆截图文件名包含危化智巡品牌和本地时间", () => {
  assert.equal(
    vehicleCaptureFileName(new Date(2026, 6, 21, 9, 8, 7)),
    "危化智巡-车辆视野-20260721-090807.jpg",
  );
});

test("车辆截图使用原始 JPEG Data URL 触发一次本地下载", () => {
  let clicked = 0;
  let removed = 0;
  let appended = 0;
  const anchor = {
    href: "",
    download: "",
    style: { display: "" },
    click: () => { clicked += 1; },
    remove: () => { removed += 1; },
  };
  const documentRef = {
    createElement: () => anchor,
    body: { appendChild: () => { appended += 1; } },
  } as unknown as Document;

  const fileName = downloadVehicleFrame(FRAME, documentRef);
  assert.equal(anchor.href, FRAME);
  assert.equal(anchor.download, fileName);
  assert.equal(appended, 1);
  assert.equal(clicked, 1);
  assert.equal(removed, 1);
  assert.throws(() => downloadVehicleFrame("", documentRef), /没有可保存/);
});

test("安卓车辆截图通过原生桥保留中文文件名且不重复触发浏览器下载", () => {
  const saved: Array<{ dataUrl: string; name: string }> = [];
  let created = 0;
  const documentRef = {
    defaultView: {
      XingXunCloud: {
        saveDataUrl: (dataUrl: string, name: string) => saved.push({ dataUrl, name }),
      },
    },
    createElement: () => {
      created += 1;
      return {};
    },
  } as unknown as Document;

  const fileName = downloadVehicleFrame(FRAME, documentRef);
  assert.deepEqual(saved, [{ dataUrl: FRAME, name: fileName }]);
  assert.match(fileName, /^危化智巡-车辆视野-\d{8}-\d{6}\.jpg$/);
  assert.equal(created, 0);
});
