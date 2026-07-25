import type { Metadata } from "next";
import { SettingsPage } from "@/app/features/pages/SettingsPage";

export const metadata: Metadata = {
  title: "系统设置",
  description: "管理界面外观、三维渲染、车辆控制和本地模型偏好。",
};

export default function SettingsRoute() {
  return <SettingsPage />;
}
