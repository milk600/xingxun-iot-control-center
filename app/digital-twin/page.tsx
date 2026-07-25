import type { Metadata } from "next";
import { DigitalTwinWorkspace } from "@/app/features/digital-twin/DigitalTwinWorkspace";

export const metadata: Metadata = {
  title: "空间孪生",
  description: "读取本地 PLY 点云、纹理 GLB 或 3D Gaussian Splatting 模型，并预留物联网点位。",
};

export default function DigitalTwinPage() {
  return <DigitalTwinWorkspace />;
}
