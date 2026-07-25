import type { Metadata } from "next";
import { OverviewPage } from "./features/pages/OverviewPage";

export const metadata: Metadata = {
  title: "控制概览",
  description: "室内空间状态、六路物联网遥测与巡检车控制概览。",
};

export default function Home() {
  return <OverviewPage />;
}
