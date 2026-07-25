"use client";

import { createContext, useContext } from "react";
import type {
  AuthCredentials,
  AuthPasswordChange,
  AuthPasswordReset,
  AuthProfile,
  AuthRecoverySetup,
  AuthRegistration,
  AuthSession,
  AuthState,
  AuthUser,
} from "@/app/lib/auth/contracts";

export interface AuthContextValue {
  state: AuthState;
  session: AuthSession | null;
  profile: AuthProfile | null;
  error: string | null;
  lockedUntil: string | null;
  transitionStage: "idle" | "success";
  biometricAvailable: boolean;
  biometricEnrolled: boolean;
  shouldOfferBiometric: boolean;
  signIn(credentials: AuthCredentials): Promise<void>;
  registerAccount(registration: AuthRegistration): Promise<AuthUser>;
  setupRecovery(input: AuthRecoverySetup): Promise<void>;
  resetPassword(input: Omit<AuthPasswordReset, "enrollment">): Promise<void>;
  changePassword(input: Omit<AuthPasswordChange, "username" | "enrollment">): Promise<void>;
  updateProfile(changes: Partial<Pick<AuthProfile, "displayName" | "avatarDataUrl" | "agreementVersion">>): Promise<void>;
  clearError(): void;
  signInWithBiometric(): Promise<void>;
  enableBiometric(): Promise<void>;
  dismissBiometricOffer(): void;
  lock(): Promise<void>;
  signOut(): Promise<void>;
}

/**
 * Kept separate from the provider implementation so Vite HMR does not create
 * a new context identity while the root layout still renders the old provider.
 */
export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
