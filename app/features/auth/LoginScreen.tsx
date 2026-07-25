"use client";
/* eslint-disable @next/next/no-img-element -- shared by the offline Android build */

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import {
  ArrowLeft,
  BookOpenText,
  Check,
  Eye,
  EyeOff,
  Fingerprint,
  LoaderCircle,
  LockKeyhole,
  RadioTower,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useAuth } from "./AuthContext";
import {
  AUTH_AGREEMENT_VERSION,
  AUTH_RECOVERY_QUESTIONS,
  type AuthRecoveryQuestionId,
} from "@/app/lib/auth/contracts";
import { acceptedCurrentAgreement, readDeviceAccount } from "@/app/lib/auth/device-account-store";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "@/app/lib/brand";
import { AgreementDialog, AgreementRow } from "./UserAgreement";
import { LoginShowcase } from "./LoginShowcase";
import { useAndroidBack } from "@/app/features/ui/useAndroidBack";
import styles from "./LoginScreen.module.css";

type LoginMode = "login" | "register" | "recover";
type RegistrationStep = "account" | "recovery" | "authorize";
type RecoveryStep = "identify" | "reset";
type VisiblePassword = "login" | "new" | "confirm" | "administrator" | "recovery-new" | "recovery-confirm" | null;
type MessageTone = "error" | "success";

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/;

export function LoginScreen() {
  const auth = useAuth();
  const [mode, setMode] = useState<LoginMode>("login");
  const [registrationStep, setRegistrationStep] = useState<RegistrationStep>("account");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [administratorUsername, setAdministratorUsername] = useState("admin");
  const [administratorPassword, setAdministratorPassword] = useState("");
  const [recoveryQuestionId, setRecoveryQuestionId] = useState<AuthRecoveryQuestionId>(AUTH_RECOVERY_QUESTIONS[0].id);
  const [recoveryAnswer, setRecoveryAnswer] = useState("");
  const [recoveryUsername, setRecoveryUsername] = useState("");
  const [recoveryLoadedQuestion, setRecoveryLoadedQuestion] = useState<AuthRecoveryQuestionId | null>(null);
  const [recoveryNewPassword, setRecoveryNewPassword] = useState("");
  const [recoveryConfirmPassword, setRecoveryConfirmPassword] = useState("");
  const [recoveryStep, setRecoveryStep] = useState<RecoveryStep>("identify");
  const [agreementAccepted, setAgreementAccepted] = useState(false);
  const [agreementOpen, setAgreementOpen] = useState(false);
  const [visiblePassword, setVisiblePassword] = useState<VisiblePassword>(null);
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<MessageTone>("error");
  const [clockMs, setClockMs] = useState(() => Date.now());
  const loginPasswordRef = useRef<HTMLInputElement>(null);
  const newUsernameRef = useRef<HTMLInputElement>(null);
  const administratorPasswordRef = useRef<HTMLInputElement>(null);
  const loginShellRef = useRef<HTMLDivElement>(null);
  const authColumnRef = useRef<HTMLElement>(null);
  const loginStageRef = useRef<HTMLDivElement>(null);
  const busy = auth.state === "authenticating";
  const remainingSeconds = auth.lockedUntil
    ? Math.max(0, Math.ceil((Date.parse(auth.lockedUntil) - clockMs) / 1_000))
    : 0;
  const locked = auth.state === "locked" && remainingSeconds > 0;

  useAndroidBack(agreementOpen, () => setAgreementOpen(false), 90);

  useEffect(() => {
    if (!auth.lockedUntil) return;
    const timer = window.setInterval(() => setClockMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [auth.lockedUntil]);

  const handleLoginStageVisibilityChange = useCallback((visible: boolean) => {
    const shell = loginShellRef.current;
    const authColumn = authColumnRef.current;
    const loginStage = loginStageRef.current;
    if (!shell || !authColumn || !loginStage) return;

    shell.classList.toggle(styles.loginShellStoryMode, !visible);
    loginStage.classList.toggle(styles.loginStageCollapsed, !visible);
    authColumn.toggleAttribute("inert", !visible);
    if (visible) authColumn.removeAttribute("aria-hidden");
    else authColumn.setAttribute("aria-hidden", "true");
  }, []);

  useEffect(() => {
    let active = true;
    if (mode !== "login" || !username.trim()) return;
    void acceptedCurrentAgreement(username).then((accepted) => {
      if (active) setAgreementAccepted(accepted);
    });
    return () => { active = false; };
  }, [mode, username]);

  useEffect(() => {
    if (!auth.error || busy) return;
    if (mode === "login") loginPasswordRef.current?.focus();
    else if (registrationStep === "authorize") administratorPasswordRef.current?.focus();
  }, [auth.error, busy, mode, registrationStep]);

  const showMessage = (message: string, tone: MessageTone = "error") => {
    setLocalMessage(message);
    setMessageTone(tone);
  };

  const resetMessage = () => {
    setLocalMessage(null);
    setMessageTone("error");
    auth.clearError();
  };

  const switchMode = (nextMode: LoginMode) => {
    resetMessage();
    setVisiblePassword(null);
    setMode(nextMode);
    if (nextMode === "register") {
      setRegistrationStep("account");
      window.requestAnimationFrame(() => newUsernameRef.current?.focus());
      setAgreementAccepted(false);
    }
    if (nextMode === "recover") {
      setRecoveryUsername(username.trim());
      setRecoveryStep("identify");
      setRecoveryLoadedQuestion(null);
      setRecoveryAnswer("");
      setRecoveryNewPassword("");
      setRecoveryConfirmPassword("");
    }
  };

  const submitLogin = async (event: FormEvent) => {
    event.preventDefault();
    resetMessage();
    if (!username.trim() || !password) {
      showMessage("请输入账号和密码");
      loginPasswordRef.current?.focus();
      return;
    }
    if (!agreementAccepted) {
      showMessage("请先阅读并同意《用户协议》");
      return;
    }
    try {
      await auth.signIn({ username: username.trim(), password, remember, agreementVersion: AUTH_AGREEMENT_VERSION });
    } catch {
      setPassword("");
    }
  };

  const continueRegistration = (event: FormEvent) => {
    event.preventDefault();
    resetMessage();
    const normalizedUsername = newUsername.trim();
    if (!USERNAME_PATTERN.test(normalizedUsername)) {
      showMessage("账号需为 3–32 位字母、数字、点、短横线或下划线");
      newUsernameRef.current?.focus();
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 32) {
      showMessage("新密码需为 8–32 位");
      return;
    }
    if (newPassword !== confirmPassword) {
      showMessage("两次输入的新密码不一致");
      return;
    }
    setRegistrationStep("recovery");
    setVisiblePassword(null);
  };

  const continueRegistrationRecovery = (event: FormEvent) => {
    event.preventDefault();
    resetMessage();
    const normalizedAnswer = recoveryAnswer.normalize("NFKC").trim();
    if (normalizedAnswer.length < 2 || normalizedAnswer.length > 64) {
      showMessage("验证答案需为 2–64 位");
      return;
    }
    if (!agreementAccepted) {
      showMessage("请先阅读并同意《用户协议》");
      return;
    }
    setRegistrationStep("authorize");
    setVisiblePassword(null);
    window.requestAnimationFrame(() => administratorPasswordRef.current?.focus());
  };

  const loadRecoveryQuestion = async (event: FormEvent) => {
    event.preventDefault();
    resetMessage();
    const normalizedUsername = recoveryUsername.trim();
    if (!normalizedUsername) {
      showMessage("请输入账号");
      return;
    }
    const account = await readDeviceAccount(normalizedUsername);
    if (!account?.enrollment || !account.recoveryQuestionId) {
      showMessage("此设备没有该账号的验证信息");
      return;
    }
    setRecoveryLoadedQuestion(account.recoveryQuestionId);
    setRecoveryStep("reset");
  };

  const submitRecovery = async (event: FormEvent) => {
    event.preventDefault();
    resetMessage();
    if (!recoveryAnswer.trim()) {
      showMessage("请输入验证答案");
      return;
    }
    if (recoveryNewPassword.length < 8 || recoveryNewPassword.length > 32) {
      showMessage("新密码需为 8–32 位");
      return;
    }
    if (recoveryNewPassword !== recoveryConfirmPassword) {
      showMessage("两次输入的新密码不一致");
      return;
    }
    try {
      await auth.resetPassword({
        username: recoveryUsername.trim(),
        recoveryAnswer,
        newPassword: recoveryNewPassword,
      });
      setUsername(recoveryUsername.trim());
      setPassword("");
      setRecoveryAnswer("");
      setRecoveryNewPassword("");
      setRecoveryConfirmPassword("");
      setVisiblePassword(null);
      setMode("login");
      showMessage("密码已更新，请重新登录", "success");
    } catch {
      setRecoveryAnswer("");
    }
  };

  const submitRegistration = async (event: FormEvent) => {
    event.preventDefault();
    resetMessage();
    if (!administratorUsername.trim() || !administratorPassword) {
      showMessage("请输入原始管理员账号和密码");
      administratorPasswordRef.current?.focus();
      return;
    }
    try {
      const user = await auth.registerAccount({
        username: newUsername.trim(),
        password: newPassword,
        recoveryQuestionId,
        recoveryAnswer,
        agreementVersion: AUTH_AGREEMENT_VERSION,
        administratorUsername: administratorUsername.trim(),
        administratorPassword,
      });
      setUsername(user.username);
      setPassword("");
      setNewUsername("");
      setNewPassword("");
      setConfirmPassword("");
      setRecoveryAnswer("");
      setAdministratorPassword("");
      setVisiblePassword(null);
      setRegistrationStep("account");
      setMode("login");
      showMessage("账号已创建，请登录", "success");
    } catch {
      setAdministratorPassword("");
    }
  };

  const errorMessage = locked
    ? `请在 ${remainingSeconds} 秒后重试`
    : localMessage ?? auth.error ?? "";
  const effectiveTone: MessageTone = locked || auth.error ? "error" : messageTone;

  return (
    <main className={`${styles.loginPage}${auth.transitionStage === "success" ? ` ${styles.loginLeaving}` : ""}`}>
      <div className={styles.ambientScene} aria-hidden="true">
        <span className={styles.ambientLight} />
        <span className={`${styles.orbit} ${styles.orbitOuter}`} />
        <span className={`${styles.orbit} ${styles.orbitMiddle}`} />
        <span className={`${styles.orbit} ${styles.orbitInner}`} />
        <span className={`${styles.orbitDot} ${styles.dotOne}`} />
        <span className={`${styles.orbitDot} ${styles.dotTwo}`} />
        <span className={`${styles.orbitDot} ${styles.dotThree}`} />
      </div>

      <div ref={loginShellRef} className={styles.loginShell}>
        <LoginShowcase onLoginStageVisibilityChange={handleLoginStageVisibilityChange} />

        <section
          ref={authColumnRef}
          className={`${styles.authColumn}${mode === "login" ? "" : ` ${styles.authColumnScrollable}`}`}
          aria-label={`${PRODUCT_NAME}账户登录`}
        >
          <div ref={loginStageRef} className={styles.loginStage}>
            <header className={styles.productBrand}>
              <span className={styles.productIcon}>
                <img src="/brand/xingxun-mark.svg" alt="危化智巡项目标识" />
                <i aria-hidden="true"><RadioTower size={12} strokeWidth={2} /></i>
              </span>
              <span><strong>{PRODUCT_NAME}</strong><small>{PRODUCT_TAGLINE}</small></span>
            </header>

            <div className={styles.loginCard}>
          {mode === "login" ? (
            <div className={styles.panelContent} key="login-panel">
              <div className={styles.welcome}>
                <h2 id="login-title">欢迎回来</h2>
                <p>登录以进入控制中心</p>
              </div>

              <form onSubmit={submitLogin} noValidate>
                <TextField
                  label="账号"
                  icon={<UserRound size={18} aria-hidden="true" />}
                  value={username}
                  onChange={setUsername}
                  autoComplete="username"
                  disabled={busy || locked}
                />
                <PasswordField
                  label="密码"
                  inputRef={loginPasswordRef}
                  value={password}
                  onChange={setPassword}
                  autoComplete="current-password"
                  visible={visiblePassword === "login"}
                  onToggle={() => setVisiblePassword((current) => current === "login" ? null : "login")}
                  disabled={busy || locked}
                />

                <label className={styles.remember}>
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(event) => setRemember(event.target.checked)}
                    disabled={busy || locked}
                  />
                  <span aria-hidden="true" />
                  <strong>保持登录</strong>
                </label>

                <AgreementRow
                  checked={agreementAccepted}
                  disabled={busy || locked}
                  onChange={setAgreementAccepted}
                  onOpen={() => setAgreementOpen(true)}
                />

                <FormMessage message={errorMessage} tone={effectiveTone} />

                <button
                  className={styles.submitButton}
                  type="submit"
                  disabled={busy || locked || !agreementAccepted}
                  title={!agreementAccepted ? "请先同意用户协议" : undefined}
                >
                  {busy ? <><LoaderCircle size={18} className={styles.spinner} />正在验证</> : "登录"}
                </button>

                {auth.biometricAvailable && auth.biometricEnrolled && (
                  <button
                    className={styles.biometricButton}
                    type="button"
                    disabled={busy}
                    onClick={() => void auth.signInWithBiometric()}
                  >
                    <Fingerprint size={19} />使用指纹或面容
                  </button>
                )}
              </form>

              <div className={styles.loginLinks}>
                <button type="button" onClick={() => switchMode("recover")}>忘记密码</button>
                <span aria-hidden="true" />
                <p>还没有账号？<button type="button" onClick={() => switchMode("register")}>创建账号</button></p>
              </div>
            </div>
          ) : mode === "register" && registrationStep === "account" ? (
            <div className={styles.panelContent} key="register-account-panel">
              <PanelBackButton label="返回登录" onClick={() => switchMode("login")} />
              <div className={styles.welcome}>
                <h2 id="login-title">创建账号</h2>
                <p>设置新的登录信息</p>
              </div>
              <form onSubmit={continueRegistration} noValidate>
                <TextField
                  label="新账号"
                  inputRef={newUsernameRef}
                  icon={<UserRound size={18} aria-hidden="true" />}
                  value={newUsername}
                  onChange={setNewUsername}
                  autoComplete="username"
                  disabled={busy || locked}
                />
                <PasswordField
                  label="新密码"
                  value={newPassword}
                  onChange={setNewPassword}
                  autoComplete="new-password"
                  visible={visiblePassword === "new"}
                  onToggle={() => setVisiblePassword((current) => current === "new" ? null : "new")}
                  disabled={busy || locked}
                />
                <PasswordField
                  label="确认新密码"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  autoComplete="new-password"
                  visible={visiblePassword === "confirm"}
                  onToggle={() => setVisiblePassword((current) => current === "confirm" ? null : "confirm")}
                  disabled={busy || locked}
                />
                <FormMessage message={errorMessage} tone={effectiveTone} />
                <button className={styles.submitButton} type="submit" disabled={busy || locked}>继续</button>
              </form>
            </div>
          ) : mode === "register" && registrationStep === "recovery" ? (
            <div className={styles.panelContent} key="register-recovery-panel">
              <PanelBackButton label="返回上一步" onClick={() => {
                resetMessage();
                setRegistrationStep("account");
              }} />
              <div className={styles.welcome}>
                <span className={styles.authorizationIcon}><BookOpenText size={22} /></span>
                <h2 id="login-title">设置验证信息</h2>
                <p>用于在当前设备找回密码</p>
              </div>
              <form onSubmit={continueRegistrationRecovery} noValidate>
                <SelectField
                  label="安全问题"
                  value={recoveryQuestionId}
                  disabled={busy || locked}
                  onChange={(value) => setRecoveryQuestionId(value as AuthRecoveryQuestionId)}
                  options={AUTH_RECOVERY_QUESTIONS.map((question) => ({ value: question.id, label: question.label }))}
                />
                <TextField
                  label="验证答案"
                  icon={<ShieldCheck size={18} aria-hidden="true" />}
                  value={recoveryAnswer}
                  onChange={setRecoveryAnswer}
                  autoComplete="off"
                  disabled={busy || locked}
                />
                <AgreementRow
                  checked={agreementAccepted}
                  disabled={busy || locked}
                  onChange={setAgreementAccepted}
                  onOpen={() => setAgreementOpen(true)}
                />
                <FormMessage message={errorMessage} tone={effectiveTone} />
                <button
                  className={styles.submitButton}
                  type="submit"
                  disabled={busy || locked || !agreementAccepted}
                  title={!agreementAccepted ? "请先同意用户协议" : undefined}
                >继续</button>
              </form>
            </div>
          ) : mode === "register" ? (
            <div className={styles.panelContent} key="register-authorize-panel">
              <PanelBackButton label="返回上一步" onClick={() => {
                resetMessage();
                setRegistrationStep("recovery");
                setVisiblePassword(null);
              }} />
              <div className={styles.welcome}>
                <span className={styles.authorizationIcon}><ShieldCheck size={22} /></span>
                <h2 id="login-title">管理员授权</h2>
                <p>验证原始管理员身份</p>
              </div>
              <form onSubmit={submitRegistration} noValidate>
                <TextField
                  label="原始管理员账号"
                  icon={<UserRound size={18} aria-hidden="true" />}
                  value={administratorUsername}
                  onChange={setAdministratorUsername}
                  autoComplete="username"
                  disabled={busy || locked}
                />
                <PasswordField
                  label="原始管理员密码"
                  inputRef={administratorPasswordRef}
                  value={administratorPassword}
                  onChange={setAdministratorPassword}
                  autoComplete="current-password"
                  visible={visiblePassword === "administrator"}
                  onToggle={() => setVisiblePassword((current) => current === "administrator" ? null : "administrator")}
                  disabled={busy || locked}
                />
                <FormMessage message={errorMessage} tone={effectiveTone} />
                <button className={styles.submitButton} type="submit" disabled={busy || locked}>
                  {busy ? <><LoaderCircle size={18} className={styles.spinner} />正在创建</> : <><Check size={18} />创建账号</>}
                </button>
              </form>
            </div>
          ) : recoveryStep === "identify" ? (
            <div className={styles.panelContent} key="recover-identify-panel">
              <PanelBackButton label="返回登录" onClick={() => switchMode("login")} />
              <div className={styles.welcome}>
                <span className={styles.authorizationIcon}><ShieldCheck size={22} /></span>
                <h2 id="login-title">找回密码</h2>
                <p>验证当前设备保存的安全信息</p>
              </div>
              <form onSubmit={loadRecoveryQuestion} noValidate>
                <TextField
                  label="账号"
                  icon={<UserRound size={18} aria-hidden="true" />}
                  value={recoveryUsername}
                  onChange={setRecoveryUsername}
                  autoComplete="username"
                  disabled={busy || locked}
                />
                <FormMessage message={errorMessage} tone={effectiveTone} />
                <button className={styles.submitButton} type="submit" disabled={busy || locked}>下一步</button>
              </form>
            </div>
          ) : (
            <div className={styles.panelContent} key="recover-reset-panel">
              <PanelBackButton label="返回上一步" onClick={() => {
                resetMessage();
                setRecoveryStep("identify");
                setRecoveryLoadedQuestion(null);
              }} />
              <div className={styles.welcome}>
                <h2 id="login-title">设置新密码</h2>
                <p>{AUTH_RECOVERY_QUESTIONS.find((question) => question.id === recoveryLoadedQuestion)?.label}</p>
              </div>
              <form onSubmit={submitRecovery} noValidate>
                <TextField
                  label="验证答案"
                  icon={<ShieldCheck size={18} aria-hidden="true" />}
                  value={recoveryAnswer}
                  onChange={setRecoveryAnswer}
                  autoComplete="off"
                  disabled={busy || locked}
                />
                <PasswordField
                  label="新密码"
                  value={recoveryNewPassword}
                  onChange={setRecoveryNewPassword}
                  autoComplete="new-password"
                  visible={visiblePassword === "recovery-new"}
                  onToggle={() => setVisiblePassword((current) => current === "recovery-new" ? null : "recovery-new")}
                  disabled={busy || locked}
                />
                <PasswordField
                  label="确认新密码"
                  value={recoveryConfirmPassword}
                  onChange={setRecoveryConfirmPassword}
                  autoComplete="new-password"
                  visible={visiblePassword === "recovery-confirm"}
                  onToggle={() => setVisiblePassword((current) => current === "recovery-confirm" ? null : "recovery-confirm")}
                  disabled={busy || locked}
                />
                <FormMessage message={errorMessage} tone={effectiveTone} />
                <button className={styles.submitButton} type="submit" disabled={busy || locked}>{busy ? "正在更新" : "更新密码"}</button>
              </form>
            </div>
          )}
            </div>
          </div>
        </section>
      </div>
      {agreementOpen && <AgreementDialog onClose={() => setAgreementOpen(false)} />}
    </main>
  );
}

function TextField({
  label,
  icon,
  value,
  onChange,
  autoComplete,
  disabled,
  inputRef,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  onChange(value: string): void;
  autoComplete: string;
  disabled: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <span className={styles.inputShell}>
        {icon}
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          inputMode="text"
          disabled={disabled}
        />
      </span>
    </label>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  visible,
  onToggle,
  disabled,
  inputRef,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  autoComplete: string;
  visible: boolean;
  onToggle(): void;
  disabled: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <span className={styles.inputShell}>
        <LockKeyhole size={18} aria-hidden="true" />
        <input
          ref={inputRef}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          disabled={disabled}
        />
        <button
          type="button"
          aria-label={visible ? `隐藏${label}` : `显示${label}`}
          title={visible ? `隐藏${label}` : `显示${label}`}
          onClick={onToggle}
        >
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </span>
    </label>
  );
}

function FormMessage({ message, tone }: { message: string; tone: MessageTone }) {
  return <p className={`${styles.formMessage} ${tone === "success" ? styles.formMessageSuccess : ""}`} role="status" aria-live="polite">{message}</p>;
}

function SelectField({ label, value, options, disabled, onChange }: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
  onChange(value: string): void;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <span className={styles.selectShell}>
        <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </span>
    </label>
  );
}

function PanelBackButton({ label, onClick }: { label: string; onClick(): void }) {
  return <button type="button" className={styles.panelBack} onClick={onClick}><ArrowLeft size={16} />{label}</button>;
}
