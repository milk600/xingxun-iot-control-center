import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { usePathname } from "./next-navigation";
import { installOfflineIotProvider } from "./offline-iot-provider";
import { installAndroidLocalAgentRuntime } from "./local-agent-runtime";
import { OverviewPage } from "@/app/features/pages/OverviewPage";
import { MonitoringPage } from "@/app/features/pages/MonitoringPage";
import { VehiclePage } from "@/app/features/pages/VehiclePage";
import { IntegrationsPage } from "@/app/features/pages/IntegrationsPage";
import { SettingsPage } from "@/app/features/pages/SettingsPage";
import { AlertsPage } from "@/app/features/pages/AlertsPage";
import { DigitalTwinWorkspace } from "@/app/features/digital-twin/DigitalTwinWorkspace";
import { AuthenticatedApplication, AuthProvider } from "@/app/features/auth/AuthContext";
import { LoginScreen } from "@/app/features/auth/LoginScreen";
import { PRODUCT_NAME } from "@/app/lib/brand";
import { ANDROID_DEFAULT_PREFERENCES, UI_PREFERENCES_KEY } from "@/app/lib/ui-preferences";
import "@/app/globals.css";

const ROUTES: Record<string, { title: string; content: ReactNode }> = {
  "/": { title: "控制概览", content: <OverviewPage /> },
  "/digital-twin": { title: "空间孪生", content: <DigitalTwinWorkspace /> },
  "/vehicle": { title: "小车遥控", content: <VehiclePage /> },
  "/monitoring": { title: "数据监测", content: <MonitoringPage /> },
  "/alerts": { title: "告警管理", content: <AlertsPage /> },
  "/integrations": { title: "连接管理", content: <IntegrationsPage /> },
  "/settings": { title: "系统设置", content: <SettingsPage /> },
  "/login": { title: "登录", content: <LoginScreen /> },
};

function OfflineApplication() {
  const pathname = usePathname();
  const route = ROUTES[pathname] ?? ROUTES["/"];

  useEffect(() => {
    document.title = `${route.title} | ${PRODUCT_NAME}`;
  }, [route.title]);

  return (
    <AuthProvider>
      <AuthenticatedApplication>{route.content}</AuthenticatedApplication>
    </AuthProvider>
  );
}

if (!window.localStorage.getItem(UI_PREFERENCES_KEY)) {
  window.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(ANDROID_DEFAULT_PREFERENCES));
}

installOfflineIotProvider();
installAndroidLocalAgentRuntime();

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

createRoot(root).render(
  <StrictMode>
    <OfflineApplication />
  </StrictMode>,
);
