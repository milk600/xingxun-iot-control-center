import type { Metadata, Viewport } from "next";
import { AuthenticatedApplication, AuthProvider } from "@/app/features/auth/AuthContext";
import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from "@/app/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: PRODUCT_NAME,
    template: `%s | ${PRODUCT_NAME}`,
  },
  description: PRODUCT_DESCRIPTION,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <AuthProvider>
          <AuthenticatedApplication>{children}</AuthenticatedApplication>
        </AuthProvider>
      </body>
    </html>
  );
}
