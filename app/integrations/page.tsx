import type { Metadata } from "next";
import { IntegrationsPage } from "@/app/features/pages/IntegrationsPage";

export const metadata: Metadata = {
  title: "连接管理",
  description: "查看传感器、小车与智能中枢的连接状态。",
};

export default function IntegrationsRoute() {
  return <IntegrationsPage />;
}
