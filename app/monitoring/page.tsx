import type { Metadata } from "next";
import { MonitoringPage } from "@/app/features/pages/MonitoringPage";

export const metadata: Metadata = {
  title: "数据监测",
  description: "查看六路物联网数据位、历史记录与智能分析。",
};

export default function MonitoringRoute() {
  return <MonitoringPage />;
}
