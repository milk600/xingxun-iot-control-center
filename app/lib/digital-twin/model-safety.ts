import { isOpenMvsDensePointCloudHeader } from "./openmvs-ply.ts";

export const MAX_LOCAL_MODEL_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_CPU_PLY_VERTICES = 2_000_000;
export const MAX_OPENMVS_POINT_CLOUD_VERTICES = 10_000_000;
export const MAX_CPU_PLY_FACES = 4_000_000;

export type PlyModelKind = "gaussian" | "point-cloud" | "mesh";

export interface PlyHeaderInspection {
  kind: PlyModelKind;
  vertexCount: number | null;
  faceCount: number | null;
  optimizedPointCloud: boolean;
}

const GAUSSIAN_HEADER_PROPERTIES = ["scale_0", "scale_1", "scale_2", "rot_0", "opacity"];

function readElementCount(header: string, element: string): number | null {
  const match = header.match(new RegExp(`element\\s+${element}\\s+(\\d+)`));
  return match ? Number(match[1]) : null;
}

export function assertLocalModelFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error("模型文件大小无效。");
  }
  if (bytes > MAX_LOCAL_MODEL_FILE_BYTES) {
    throw new Error("模型文件超过 512 MB。请先精简点云、网格或高斯模型后再打开。");
  }
}

export function inspectPlyHeader(headerText: string): PlyHeaderInspection {
  const end = headerText.indexOf("end_header");
  if (!headerText.startsWith("ply") || end < 0) {
    throw new Error("未识别到有效的 PLY 文件头。");
  }

  const header = headerText.slice(0, end).toLowerCase();
  const gaussianScore = GAUSSIAN_HEADER_PROPERTIES.reduce(
    (score, property) => score + (header.includes(` ${property}`) ? 1 : 0),
    0,
  );
  const vertexCount = readElementCount(header, "vertex");
  const faceCount = readElementCount(header, "face");

  // Gaussian PLY stays on the streaming Spark path. CPU mesh limits must not
  // accidentally reroute it even if its vertex count is large.
  if (gaussianScore >= 4) {
    return { kind: "gaussian", vertexCount, faceCount, optimizedPointCloud: false };
  }

  if (vertexCount === null || vertexCount <= 0) {
    throw new Error("普通 PLY 文件没有可显示的顶点。");
  }

  const isPointCloud = (faceCount ?? 0) === 0;
  const optimizedPointCloud = isPointCloud && isOpenMvsDensePointCloudHeader(header);
  const vertexLimit = optimizedPointCloud
    ? MAX_OPENMVS_POINT_CLOUD_VERTICES
    : MAX_CPU_PLY_VERTICES;
  if (vertexCount > vertexLimit) {
    throw new Error(
      optimizedPointCloud
        ? "OpenMVS 彩色点云超过 1000 万点，超出当前浏览器显存预算。"
        : "普通 CPU PLY 超过 200 万个顶点。大型点云需使用受支持的 OpenMVS 稠密格式。",
    );
  }
  if ((faceCount ?? 0) > MAX_CPU_PLY_FACES) {
    throw new Error("CPU PLY 超过 400 万个三角面。请先简化网格后再打开，以免浏览器内存不足。");
  }

  return {
    kind: isPointCloud ? "point-cloud" : "mesh",
    vertexCount,
    faceCount,
    optimizedPointCloud,
  };
}
