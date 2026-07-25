import type { Metadata } from "next";
import { LoginScreen } from "@/app/features/auth/LoginScreen";
import { PRODUCT_NAME } from "@/app/lib/brand";

export const metadata: Metadata = {
  title: "登录",
  description: `登录${PRODUCT_NAME}。`,
};

export default function LoginPage() {
  return <LoginScreen />;
}
