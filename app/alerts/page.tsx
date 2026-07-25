import type { Metadata } from "next";
import { AlertsPage } from "@/app/features/pages/AlertsPage";

export const metadata: Metadata = {
  title: "告警管理",
  description: "查看、跟进并处置星巡物联告警工单。",
};

export default function Page() {
  return <AlertsPage />;
}
