import type { Metadata } from "next";
import { VehiclePage } from "@/app/features/pages/VehiclePage";

export const metadata: Metadata = {
  title: "小车遥控",
  description: "安全控制巡检车前进、后退与左右转向，并查看真实设备回传和指令回执。",
};

export default function VehicleRoute() {
  return <VehiclePage />;
}
