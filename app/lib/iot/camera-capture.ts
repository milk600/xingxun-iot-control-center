const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

function twoDigits(value: number) {
  return value.toString().padStart(2, "0");
}

export function isCapturableVehicleFrame(source: string) {
  return source.startsWith(`${JPEG_DATA_URL_PREFIX}/9j/`);
}

export function vehicleCaptureFileName(date = new Date()) {
  const day = `${date.getFullYear()}${twoDigits(date.getMonth() + 1)}${twoDigits(date.getDate())}`;
  const time = `${twoDigits(date.getHours())}${twoDigits(date.getMinutes())}${twoDigits(date.getSeconds())}`;
  return `危化智巡-车辆视野-${day}-${time}.jpg`;
}

export function downloadVehicleFrame(source: string, documentRef: Document = document) {
  if (!isCapturableVehicleFrame(source)) {
    throw new Error("当前没有可保存的 JPEG 画面");
  }
  const fileName = vehicleCaptureFileName();
  const androidBridge = (documentRef.defaultView as (Window & {
    XingXunCloud?: { saveDataUrl?: (dataUrl: string, requestedName: string) => void };
  }) | null)?.XingXunCloud;
  if (typeof androidBridge?.saveDataUrl === "function") {
    androidBridge.saveDataUrl(source, fileName);
    return fileName;
  }
  const anchor = documentRef.createElement("a");
  anchor.href = source;
  anchor.download = fileName;
  anchor.style.display = "none";
  documentRef.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return fileName;
}
