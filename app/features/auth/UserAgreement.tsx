"use client";

import { BookOpenText, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { AUTH_AGREEMENT_VERSION } from "@/app/lib/auth/contracts";
import styles from "./LoginScreen.module.css";

export function AgreementRow({ checked, disabled, onChange, onOpen }: {
  checked: boolean;
  disabled: boolean;
  onChange(checked: boolean): void;
  onOpen(): void;
}) {
  return (
    <div className={styles.agreementRow}>
      <label className={styles.remember}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        <span aria-hidden="true" />
        <strong>我已阅读并同意</strong>
      </label>
      <button type="button" onClick={onOpen}>《用户协议》</button>
    </div>
  );
}

export function AgreementDialog({ onClose }: { onClose(): void }) {
  return (
    <div className={styles.agreementBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={styles.agreementDialog} role="dialog" aria-modal="true" aria-labelledby="agreement-title">
        <header>
          <div><BookOpenText size={20} /><h2 id="agreement-title">用户协议</h2></div>
          <button type="button" aria-label="关闭用户协议" onClick={onClose}><X size={19} /></button>
        </header>
        <div>
          <p>版本日期：2026 年 7 月 21 日</p>
          <h3>本地数据</h3>
          <p>账号、昵称、头像和验证信息保存在当前设备。清除浏览器或应用数据后，本地资料可能无法恢复。</p>
          <h3>传感器与设备控制</h3>
          <p>系统用于展示传感器信息和控制已连接设备。执行车辆操作前应确认现场安全，并保持急停手段可用。</p>
          <h3>AI 服务</h3>
          <p>使用智能中枢时，指令文本可能发送至已配置的模型服务。AI 结果用于辅助操作；自主工单和车辆权限由当前用户手动开启或关闭。</p>
          <h3>用户责任</h3>
          <p>请妥善保管账号信息，并对当前设备发出的控制指令负责。Android 端可独立连接华为云 IoTDA、DeepSeek、Fun-ASR 与局域网 Jetson 设备。</p>
        </div>
        <button type="button" className={styles.submitButton} onClick={onClose}>我已阅读</button>
      </section>
    </div>
  );
}

export function AgreementVersionGate({ onAccept }: { onAccept(): Promise<void> }) {
  const [accepted, setAccepted] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const accept = async () => {
    if (!accepted || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await onAccept();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "协议状态保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={styles.loginPage}>
      <section className={styles.loginStage} aria-labelledby="agreement-gate-title">
        <div className={styles.loginCard}>
          <div className={styles.panelContent}>
            <div className={styles.welcome}>
              <span className={styles.authorizationIcon}><ShieldCheck size={22} /></span>
              <h1 id="agreement-gate-title">用户协议已更新</h1>
              <p>确认当前版本后继续进入系统</p>
            </div>
            <AgreementRow checked={accepted} disabled={busy} onChange={setAccepted} onOpen={() => setOpen(true)} />
            <p className={styles.formMessage} role="status" aria-live="polite">{message || `当前版本 ${AUTH_AGREEMENT_VERSION}`}</p>
            <button type="button" className={styles.submitButton} disabled={!accepted || busy} onClick={() => void accept()}>{busy ? "正在保存" : "同意并继续"}</button>
          </div>
        </div>
      </section>
      {open && <AgreementDialog onClose={() => setOpen(false)} />}
    </main>
  );
}
