"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fingerprint, RadioTower, ShieldCheck, X } from "lucide-react";
import { IotDashboardProvider } from "@/app/features/iot/use-iot-dashboard";
import { AppShell } from "@/app/features/shell/AppShell";
import { NavigationTransitionProvider } from "@/app/features/transitions/NavigationTransition";
import { AiControlProvider } from "@/app/features/ai/AiControlContext";
import { SpatialMappingProvider } from "@/app/features/spatial/SpatialMappingContext";
import { getScaledMotionDurationMs } from "@/app/lib/ui-preferences";
import type {
  AuthCredentials,
  AuthCredentialUpdateResponse,
  AuthErrorPayload,
  AuthPasswordChange,
  AuthPasswordReset,
  AuthProfile,
  AuthRecoverySetup,
  AuthRegistration,
  AuthRegistrationResponse,
  AuthRestoreResponse,
  AuthSession,
  AuthState,
} from "@/app/lib/auth/contracts";
import { AUTH_AGREEMENT_VERSION, AUTH_RECOVERY_QUESTIONS } from "@/app/lib/auth/contracts";
import {
  readDeviceAccount,
  readDeviceProfile,
  saveDeviceEnrollment,
  updateDeviceProfile,
} from "@/app/lib/auth/device-account-store";
import { AuthContext, useAuth, type AuthContextValue } from "./AuthStateContext";
import { AgreementVersionGate } from "./UserAgreement";
import styles from "./LoginScreen.module.css";

export { useAuth } from "./AuthStateContext";

interface NativeAuthBridge {
  getSession(): string;
  signIn(username: string, password: string, remember: boolean): string;
  registerAccount(administratorUsername: string, administratorPassword: string, username: string, password: string, recoveryQuestionId: string, recoveryAnswer: string): string;
  setupRecovery(recoveryQuestionId: string, recoveryAnswer: string): string;
  resetPassword(username: string, recoveryAnswer: string, newPassword: string): string;
  changePassword(currentPassword: string, newPassword: string): string;
  lock(): string;
  signOut(): string;
  authenticateBiometric(): void;
  enableBiometric(): void;
}

declare global {
  interface Window {
    XingXunAuth?: NativeAuthBridge;
  }
}

interface NativeAuthEventDetail {
  ok: boolean;
  response?: AuthRestoreResponse;
  error?: string;
}

function safeReturnTo(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname === "/login") return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function parseResponse<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function nativeBridge() {
  return typeof window !== "undefined" ? window.XingXunAuth : undefined;
}

async function readWebResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & AuthErrorPayload;
  if (!response.ok) {
    const error = new Error(payload.error || "登录暂不可用") as Error & { lockedUntil?: string };
    error.lockedUntil = payload.lockedUntil;
    throw error;
  }
  return payload;
}

async function stopVehicleBeforeExit() {
  const body = JSON.stringify({
    requestId: `auth-exit-${Date.now()}`,
    motion: "stop",
    speedPercent: 0,
    issuedAt: new Date().toISOString(),
  });
  try {
    await fetch("/api/iot/vehicle/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    });
  } catch {
    // Unmounting the vehicle controller also performs its own best-effort stop.
  }
}

function waitForNativeBiometric(method: "authenticateBiometric" | "enableBiometric") {
  const bridge = nativeBridge();
  if (!bridge) return Promise.reject(new Error("当前设备不支持生物识别"));
  return new Promise<AuthRestoreResponse>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("生物识别等待超时"));
    }, 45_000);
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<NativeAuthEventDetail>).detail;
      cleanup();
      if (detail?.ok && detail.response) resolve(detail.response);
      else reject(new Error(detail?.error || "未能完成生物识别"));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener("xingxun:native-auth", onResult);
    };
    window.addEventListener("xingxun:native-auth", onResult, { once: true });
    bridge[method]();
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("checking");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  const [transitionStage, setTransitionStage] = useState<"idle" | "success">("idle");
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnrolled, setBiometricEnrolled] = useState(false);
  const [shouldOfferBiometric, setShouldOfferBiometric] = useState(false);
  const mountedRef = useRef(true);

  const applyRestore = useCallback(async (response: AuthRestoreResponse) => {
    setBiometricAvailable(response.biometricAvailable);
    setBiometricEnrolled(response.biometricEnrolled);
    if (response.session) {
      const restoredProfile = await readDeviceProfile(response.session.user.username);
      setProfile(restoredProfile);
      setSession({
        ...response.session,
        recoveryConfigured: response.session.recoveryConfigured ?? false,
        user: { ...response.session.user, displayName: restoredProfile.displayName },
      });
    } else {
      setProfile(null);
      setSession(null);
    }
    setState(response.session ? "authenticated" : "anonymous");
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const restore = async () => {
      try {
        const bridge = nativeBridge();
        const response = bridge
          ? parseResponse<AuthRestoreResponse>(bridge.getSession())
          : await readWebResponse<AuthRestoreResponse>(await fetch("/api/auth/session", { cache: "no-store" }));
        if (mountedRef.current) await applyRestore(response);
      } catch (restoreError) {
        if (!mountedRef.current) return;
        setError(restoreError instanceof Error ? restoreError.message : "登录状态读取失败");
        setState("anonymous");
      }
    };
    void restore();
    return () => { mountedRef.current = false; };
  }, [applyRestore]);

  useEffect(() => {
    const expired = () => {
      setSession(null);
      setProfile(null);
      setState("anonymous");
      setError("登录状态已失效，请重新登录");
    };
    window.addEventListener("xingxun:auth-expired", expired);
    return () => window.removeEventListener("xingxun:auth-expired", expired);
  }, []);

  const finishSignIn = useCallback(async (response: AuthRestoreResponse) => {
    setTransitionStage("success");
    await new Promise((resolve) => window.setTimeout(resolve, getScaledMotionDurationMs(360)));
    const nextProfile = response.session ? await readDeviceProfile(response.session.user.username) : null;
    setProfile(nextProfile);
    setSession(response.session ? {
      ...response.session,
      recoveryConfigured: response.session.recoveryConfigured ?? false,
      user: {
        ...response.session.user,
        displayName: nextProfile?.displayName ?? response.session.user.displayName,
      },
    } : null);
    setBiometricAvailable(response.biometricAvailable);
    setBiometricEnrolled(response.biometricEnrolled);
    setShouldOfferBiometric(Boolean(
      response.session?.platform === "android" && response.biometricAvailable && !response.biometricEnrolled,
    ));
    setError(null);
    setLockedUntil(null);
    setState("authenticated");
    setTransitionStage("idle");
  }, []);

  const signIn = useCallback(async (credentials: AuthCredentials) => {
    setState("authenticating");
    setError(null);
    try {
      const bridge = nativeBridge();
      let response: AuthRestoreResponse;
      if (bridge) {
        const nativeResponse = parseResponse<AuthRestoreResponse & AuthErrorPayload>(
          bridge.signIn(credentials.username, credentials.password, credentials.remember),
        );
        if (nativeResponse.error) {
          const nativeError = new Error(nativeResponse.error) as Error & { lockedUntil?: string };
          nativeError.lockedUntil = nativeResponse.lockedUntil;
          throw nativeError;
        }
        response = nativeResponse;
      } else {
        const enrollment = credentials.enrollment ?? (await readDeviceAccount(credentials.username))?.enrollment;
        response = await readWebResponse<AuthRestoreResponse>(await fetch("/api/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...credentials, ...(enrollment ? { enrollment } : {}) }),
          }));
      }
      if (!response.session) throw new Error("登录响应缺少会话");
      await finishSignIn(response);
      if (credentials.agreementVersion) {
        const nextProfile = await updateDeviceProfile(response.session.user.username, {
          agreementVersion: credentials.agreementVersion,
        });
        setProfile(nextProfile);
        setSession((current) => current ? {
          ...current,
          user: { ...current.user, displayName: nextProfile.displayName },
        } : current);
      }
    } catch (signInError) {
      const failure = signInError as Error & { lockedUntil?: string };
      const nextLockedUntil = failure.lockedUntil ?? null;
      setLockedUntil(nextLockedUntil);
      setError(failure.message || "登录失败");
      setState(nextLockedUntil ? "locked" : "anonymous");
      throw failure;
    }
  }, [finishSignIn]);

  const registerAccount = useCallback(async (registration: AuthRegistration) => {
    setState("authenticating");
    setError(null);
    try {
      const bridge = nativeBridge();
      let response: AuthRegistrationResponse;
      if (bridge) {
        const nativeResponse = parseResponse<AuthRegistrationResponse & AuthErrorPayload>(
          bridge.registerAccount(
            registration.administratorUsername,
            registration.administratorPassword,
            registration.username,
            registration.password,
            registration.recoveryQuestionId,
            registration.recoveryAnswer,
          ),
        );
        if (nativeResponse.error) {
          const nativeError = new Error(nativeResponse.error) as Error & { lockedUntil?: string };
          nativeError.lockedUntil = nativeResponse.lockedUntil;
          throw nativeError;
        }
        response = nativeResponse;
      } else {
        if (await readDeviceAccount(registration.username)) {
          throw new Error("该账号已存在");
        }
        response = await readWebResponse<AuthRegistrationResponse>(await fetch("/api/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(registration),
        }));
        if (!response.enrollment) throw new Error("注册响应缺少账号凭证");
      }
      if (response.enrollment) {
        await saveDeviceEnrollment(response.user.username, response.enrollment, response.recoveryQuestionId);
      }
      await updateDeviceProfile(response.user.username, {
        displayName: response.user.displayName,
        agreementVersion: registration.agreementVersion,
        recoveryQuestionId: response.recoveryQuestionId,
      });
      setError(null);
      setLockedUntil(null);
      setState("anonymous");
      return response.user;
    } catch (registrationError) {
      const failure = registrationError as Error & { lockedUntil?: string };
      const nextLockedUntil = failure.lockedUntil ?? null;
      setLockedUntil(nextLockedUntil);
      setError(failure.message || "注册失败");
      setState(nextLockedUntil ? "locked" : "anonymous");
      throw failure;
    }
  }, []);

  const setupRecovery = useCallback(async (input: AuthRecoverySetup) => {
    if (!session) throw new Error("登录状态已失效");
    setError(null);
    try {
      const bridge = nativeBridge();
      let response: AuthCredentialUpdateResponse;
      if (bridge) {
        const nativeResponse = parseResponse<AuthCredentialUpdateResponse & AuthErrorPayload>(
          bridge.setupRecovery(input.recoveryQuestionId, input.recoveryAnswer),
        );
        if (nativeResponse.error) throw new Error(nativeResponse.error);
        response = nativeResponse;
      } else {
        const enrollment = input.enrollment ?? (await readDeviceAccount(session.user.username))?.enrollment;
        response = await readWebResponse<AuthCredentialUpdateResponse>(await fetch("/api/auth/recovery/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input, ...(enrollment ? { enrollment } : {}) }),
        }));
      }
      if (response.enrollment) {
        await saveDeviceEnrollment(session.user.username, response.enrollment, response.recoveryQuestionId);
      }
      const nextProfile = await updateDeviceProfile(session.user.username, {
        recoveryQuestionId: response.recoveryQuestionId,
      });
      setProfile(nextProfile);
      setSession((current) => current ? { ...current, recoveryConfigured: true } : current);
    } catch (setupError) {
      const message = setupError instanceof Error ? setupError.message : "安全问题保存失败";
      setError(message);
      throw setupError;
    }
  }, [session]);

  const resetPassword = useCallback(async (input: Omit<AuthPasswordReset, "enrollment">) => {
    setError(null);
    try {
      const bridge = nativeBridge();
      let response: AuthCredentialUpdateResponse;
      if (bridge) {
        const nativeResponse = parseResponse<AuthCredentialUpdateResponse & AuthErrorPayload>(
          bridge.resetPassword(input.username, input.recoveryAnswer, input.newPassword),
        );
        if (nativeResponse.error) throw new Error(nativeResponse.error);
        response = nativeResponse;
      } else {
        const account = await readDeviceAccount(input.username);
        if (!account?.enrollment || !account.recoveryQuestionId) {
          throw new Error("此设备没有可用的验证信息");
        }
        response = await readWebResponse<AuthCredentialUpdateResponse>(await fetch("/api/auth/recovery/reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input, enrollment: account.enrollment }),
        }));
      }
      await saveDeviceEnrollment(input.username, response.enrollment, response.recoveryQuestionId);
      setLockedUntil(null);
    } catch (resetError) {
      const failure = resetError as Error & { lockedUntil?: string };
      setLockedUntil(failure.lockedUntil ?? null);
      setError(failure.message || "密码重置失败");
      throw failure;
    }
  }, []);

  const updateProfile = useCallback(async (
    changes: Partial<Pick<AuthProfile, "displayName" | "avatarDataUrl" | "agreementVersion">>,
  ) => {
    if (!session) throw new Error("登录状态已失效");
    const next = await updateDeviceProfile(session.user.username, changes);
    setProfile(next);
    setSession((current) => current ? {
      ...current,
      user: { ...current.user, displayName: next.displayName },
    } : current);
  }, [session]);

  const signInWithBiometric = useCallback(async () => {
    setState("authenticating");
    setError(null);
    try {
      await finishSignIn(await waitForNativeBiometric("authenticateBiometric"));
    } catch (biometricError) {
      setError(biometricError instanceof Error ? biometricError.message : "未能完成生物识别");
      setState("anonymous");
    }
  }, [finishSignIn]);

  const enableBiometric = useCallback(async () => {
    try {
      const response = await waitForNativeBiometric("enableBiometric");
      setBiometricAvailable(response.biometricAvailable);
      setBiometricEnrolled(response.biometricEnrolled);
      if (response.session) setSession(response.session);
      setShouldOfferBiometric(false);
    } catch (biometricError) {
      setError(biometricError instanceof Error ? biometricError.message : "未能启用生物识别");
    }
  }, []);

  const exit = useCallback(async (mode: "lock" | "signOut") => {
    setTransitionStage("success");
    await stopVehicleBeforeExit();
    window.dispatchEvent(new CustomEvent("xingxun:auth-exit", { detail: { mode } }));
    const bridge = nativeBridge();
    if (bridge) {
      if (mode === "lock") bridge.lock();
      else bridge.signOut();
    } else {
      await fetch("/api/auth/logout", { method: "POST", keepalive: true }).catch(() => undefined);
    }
    await new Promise((resolve) => window.setTimeout(resolve, getScaledMotionDurationMs(220)));
    setSession(null);
    setProfile(null);
    setState("anonymous");
    setShouldOfferBiometric(false);
    if (mode === "signOut") setBiometricEnrolled(false);
    setTransitionStage("idle");
  }, []);

  const changePassword = useCallback(async (
    input: Omit<AuthPasswordChange, "username" | "enrollment">,
  ) => {
    if (!session) throw new Error("登录状态已失效");
    setError(null);
    try {
      const bridge = nativeBridge();
      let response: AuthCredentialUpdateResponse;
      if (bridge) {
        const nativeResponse = parseResponse<AuthCredentialUpdateResponse & AuthErrorPayload>(
          bridge.changePassword(input.currentPassword, input.newPassword),
        );
        if (nativeResponse.error) throw new Error(nativeResponse.error);
        response = nativeResponse;
      } else {
        const enrollment = (await readDeviceAccount(session.user.username))?.enrollment;
        response = await readWebResponse<AuthCredentialUpdateResponse>(await fetch("/api/auth/password/change", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: session.user.username,
            ...input,
            ...(enrollment ? { enrollment } : {}),
          }),
        }));
      }
      await saveDeviceEnrollment(session.user.username, response.enrollment, response.recoveryQuestionId);
      await exit("signOut");
    } catch (passwordError) {
      const message = passwordError instanceof Error ? passwordError.message : "密码修改失败";
      setError(message);
      throw passwordError;
    }
  }, [exit, session]);

  const value = useMemo<AuthContextValue>(() => ({
    state,
    session,
    profile,
    error,
    lockedUntil,
    transitionStage,
    biometricAvailable,
    biometricEnrolled,
    shouldOfferBiometric,
    signIn,
    registerAccount,
    setupRecovery,
    resetPassword,
    changePassword,
    updateProfile,
    clearError: () => {
      setError(null);
    },
    signInWithBiometric,
    enableBiometric,
    dismissBiometricOffer: () => setShouldOfferBiometric(false),
    lock: () => exit("lock"),
    signOut: () => exit("signOut"),
  }), [biometricAvailable, biometricEnrolled, changePassword, enableBiometric, error, exit, lockedUntil, profile, registerAccount, resetPassword, session, setupRecovery, shouldOfferBiometric, signIn, signInWithBiometric, state, transitionStage, updateProfile]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthenticatedApplication({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const loginRoute = pathname === "/login";

  useEffect(() => {
    if (auth.state === "checking" || auth.state === "authenticating") return;
    if (!auth.session && !loginRoute) {
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    if (auth.session && loginRoute) {
      router.replace(safeReturnTo(searchParams.get("returnTo")));
    }
  }, [auth.session, auth.state, loginRoute, router, searchParams]);

  if (auth.state === "checking" || (auth.session && loginRoute)) {
    return <AuthLoadingScreen />;
  }
  if (!auth.session) {
    return loginRoute ? children : <AuthLoadingScreen />;
  }
  if (auth.profile?.agreementVersion !== AUTH_AGREEMENT_VERSION) {
    return <AgreementVersionGate onAccept={() => auth.updateProfile({ agreementVersion: AUTH_AGREEMENT_VERSION })} />;
  }
  if (!auth.session.recoveryConfigured) {
    return <RecoverySetupScreen />;
  }

  return (
    <NavigationTransitionProvider>
      <IotDashboardProvider>
        <SpatialMappingProvider>
          <AiControlProvider>
            <AppShell>{children}</AppShell>
            {auth.shouldOfferBiometric && <BiometricEnrollmentPrompt />}
          </AiControlProvider>
        </SpatialMappingProvider>
      </IotDashboardProvider>
    </NavigationTransitionProvider>
  );
}

function RecoverySetupScreen() {
  const auth = useAuth();
  const [questionId, setQuestionId] = useState(AUTH_RECOVERY_QUESTIONS[0].id);
  const [answer, setAnswer] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (answer.normalize("NFKC").trim().length < 2) {
      setMessage("请输入至少 2 个字符的验证答案");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await auth.setupRecovery({ recoveryQuestionId: questionId, recoveryAnswer: answer });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "安全问题保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={styles.loginPage}>
      <section className={styles.loginStage} aria-labelledby="recovery-setup-title">
        <div className={styles.loginCard}>
          <div className={styles.panelContent}>
            <div className={styles.welcome}>
              <span className={styles.authorizationIcon}><ShieldCheck size={22} /></span>
              <h1 id="recovery-setup-title">设置密码验证</h1>
              <p>完成后可以在此设备找回密码</p>
            </div>
            <form onSubmit={submit} noValidate>
              <label className={styles.field}>
                <span>安全问题</span>
                <span className={styles.inputShell}>
                  <select value={questionId} onChange={(event) => setQuestionId(event.target.value as typeof questionId)} disabled={busy}>
                    {AUTH_RECOVERY_QUESTIONS.map((question) => <option key={question.id} value={question.id}>{question.label}</option>)}
                  </select>
                </span>
              </label>
              <label className={styles.field}>
                <span>验证答案</span>
                <span className={styles.inputShell}><input value={answer} maxLength={64} autoComplete="off" onChange={(event) => setAnswer(event.target.value)} disabled={busy} /></span>
              </label>
              <p className={styles.formMessage} role="status" aria-live="polite">{message}</p>
              <button className={styles.submitButton} type="submit" disabled={busy}>{busy ? "正在保存" : "保存并进入"}</button>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}

function AuthLoadingScreen() {
  return (
    <div className={styles.authLoading} role="status" aria-label="正在检查登录状态">
      <span><RadioTower size={23} /></span>
    </div>
  );
}

function BiometricEnrollmentPrompt() {
  const auth = useAuth();
  return (
    <div className={styles.biometricBackdrop} role="presentation">
      <section className={styles.biometricPrompt} role="dialog" aria-modal="true" aria-labelledby="biometric-title">
        <button type="button" className={styles.promptClose} aria-label="暂不启用" onClick={auth.dismissBiometricOffer}><X size={18} /></button>
        <span className={styles.biometricIcon}><Fingerprint size={24} /></span>
        <h2 id="biometric-title">启用生物识别</h2>
        <p>下次可以使用指纹或面容快速进入。</p>
        <button type="button" className={styles.promptPrimary} onClick={() => void auth.enableBiometric()}>启用</button>
        <button type="button" className={styles.promptSecondary} onClick={auth.dismissBiometricOffer}>稍后</button>
      </section>
    </div>
  );
}
