export type AuthState =
  | "checking"
  | "anonymous"
  | "authenticating"
  | "authenticated"
  | "locked";

export interface AuthUser {
  username: string;
  displayName: string;
}

export const AUTH_AGREEMENT_VERSION = "2026-07-21";

export const AUTH_RECOVERY_QUESTIONS = [
  { id: "first-school", label: "你的第一所学校名称是？" },
  { id: "birth-city", label: "你的出生城市是？" },
  { id: "favorite-city", label: "你最喜欢的城市是？" },
  { id: "childhood-friend", label: "你童年好友的名字是？" },
  { id: "favorite-book", label: "你最喜欢的一本书是？" },
] as const;

export type AuthRecoveryQuestionId = (typeof AUTH_RECOVERY_QUESTIONS)[number]["id"];

export interface AuthProfile {
  username: string;
  displayName: string;
  avatarDataUrl: string | null;
  agreementVersion: string | null;
  recoveryQuestionId: AuthRecoveryQuestionId | null;
  updatedAt: string;
}

export interface AuthSession {
  user: AuthUser;
  platform: "web" | "android";
  expiresAt: string;
  biometricAvailable: boolean;
  biometricEnrolled: boolean;
  recoveryConfigured: boolean;
}

export interface AuthRestoreResponse {
  session: AuthSession | null;
  biometricAvailable: boolean;
  biometricEnrolled: boolean;
}

export interface AuthCredentials {
  username: string;
  password: string;
  remember: boolean;
  enrollment?: string;
  agreementVersion?: string;
}

export interface AuthRegistration {
  username: string;
  password: string;
  recoveryQuestionId: AuthRecoveryQuestionId;
  recoveryAnswer: string;
  agreementVersion: string;
  administratorUsername: string;
  administratorPassword: string;
}

export interface AuthRegistrationResponse {
  user: AuthUser;
  enrollment?: string;
  recoveryQuestionId: AuthRecoveryQuestionId;
}

export interface AuthRecoverySetup {
  recoveryQuestionId: AuthRecoveryQuestionId;
  recoveryAnswer: string;
  enrollment?: string;
}

export interface AuthPasswordReset {
  username: string;
  recoveryAnswer: string;
  newPassword: string;
  enrollment: string;
}

export interface AuthPasswordChange {
  username: string;
  currentPassword: string;
  newPassword: string;
  enrollment?: string;
}

export interface AuthCredentialUpdateResponse {
  user: AuthUser;
  enrollment: string;
  recoveryQuestionId: AuthRecoveryQuestionId;
  session?: AuthSession;
}

export interface AuthErrorPayload {
  error: string;
  lockedUntil?: string;
}
