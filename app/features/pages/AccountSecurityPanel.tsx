"use client";
/* eslint-disable @next/next/no-img-element -- local avatar data URLs and interactive crop previews */

import {
  Camera,
  Check,
  Eye,
  EyeOff,
  ImageUp,
  KeyRound,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useAuth } from "@/app/features/auth/AuthContext";
import { useAndroidBack } from "@/app/features/ui/useAndroidBack";
import { AUTH_AGREEMENT_VERSION, AUTH_RECOVERY_QUESTIONS } from "@/app/lib/auth/contracts";
import styles from "./AccountSecurityPanel.module.css";

const AVATAR_SIZE = 256;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const ACCEPTED_AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

interface CropImage {
  src: string;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

export function AccountSecurityPanel() {
  const auth = useAuth();
  const profile = auth.profile;
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [profileMessage, setProfileMessage] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [visiblePassword, setVisiblePassword] = useState<"current" | "new" | "confirm" | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [cropImage, setCropImage] = useState<CropImage | null>(null);
  const [cropMessage, setCropMessage] = useState("");

  useAndroidBack(Boolean(cropImage), () => setCropImage(null), 90);

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = displayName.trim();
    if (normalized.length < 2 || normalized.length > 20) {
      setProfileMessage("昵称需为 2–20 个字符");
      return;
    }
    setSavingProfile(true);
    setProfileMessage("");
    try {
      await auth.updateProfile({ displayName: normalized });
      setProfileMessage("昵称已更新");
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : "昵称保存失败");
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    setPasswordMessage("");
    if (!currentPassword) {
      setPasswordMessage("请输入当前密码");
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 32) {
      setPasswordMessage("新密码需为 8–32 位");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMessage("两次输入的新密码不一致");
      return;
    }
    setSavingPassword(true);
    try {
      await auth.changePassword({ currentPassword, newPassword });
    } catch (error) {
      setPasswordMessage(error instanceof Error ? error.message : "密码修改失败");
      setCurrentPassword("");
    } finally {
      setSavingPassword(false);
    }
  };

  const selectAvatar = async (file: File | undefined) => {
    setCropMessage("");
    if (!file) return;
    if (!ACCEPTED_AVATAR_TYPES.has(file.type)) {
      setProfileMessage("请选择 JPG、PNG 或 WebP 图片");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setProfileMessage("头像原文件不能超过 5MB");
      return;
    }
    try {
      setCropImage(await loadCropImage(file));
    } catch {
      setProfileMessage("图片读取失败，请重新选择");
    }
  };

  const removeAvatar = async () => {
    setSavingProfile(true);
    setProfileMessage("");
    try {
      await auth.updateProfile({ avatarDataUrl: null });
      setProfileMessage("头像已移除");
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : "头像移除失败");
    } finally {
      setSavingProfile(false);
    }
  };

  const recoveryQuestion = AUTH_RECOVERY_QUESTIONS.find((item) => item.id === profile?.recoveryQuestionId)?.label;
  const initial = (profile?.displayName || auth.session?.user.username || "管").trim().slice(0, 1).toUpperCase();

  return (
    <article className={styles.panel} data-ai-region="account-security">
      <header>
        <span><UserRound size={22} /></span>
        <div><h2>账户与安全</h2><small>管理当前设备上的个人资料和登录信息</small></div>
      </header>

      <section className={styles.profileSection}>
        <div className={styles.avatarColumn}>
          <Avatar dataUrl={profile?.avatarDataUrl ?? null} initial={initial} />
          <label className={styles.avatarUpload}>
            <ImageUp size={16} />更换头像
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => {
              void selectAvatar(event.target.files?.[0]);
              event.currentTarget.value = "";
            }} />
          </label>
          {profile?.avatarDataUrl && <button type="button" className={styles.removeAvatar} onClick={() => void removeAvatar()}><Trash2 size={15} />移除</button>}
        </div>

        <form className={styles.profileForm} onSubmit={saveName} noValidate>
          <label><span>昵称</span><input value={displayName} maxLength={20} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label><span>登录账号</span><input value={auth.session?.user.username ?? ""} readOnly aria-readonly="true" /></label>
          <p className={styles.feedback} role="status" aria-live="polite">{profileMessage}</p>
          <button type="submit" className={styles.primaryButton} disabled={savingProfile}>{savingProfile ? "正在保存" : "保存昵称"}</button>
        </form>
      </section>

      <section className={styles.statusGrid}>
        <div><span><ShieldCheck size={19} /></span><p><small>安全问题</small><strong>{recoveryQuestion ? "已设置" : "待设置"}</strong><em>{recoveryQuestion ?? "下次登录时需要完成设置"}</em></p></div>
        <div><span><Check size={19} /></span><p><small>用户协议</small><strong>{profile?.agreementVersion === AUTH_AGREEMENT_VERSION ? "已同意" : "待确认"}</strong><em>版本 {AUTH_AGREEMENT_VERSION}</em></p></div>
      </section>

      <section className={styles.passwordSection}>
        <div className={styles.sectionTitle}><span><KeyRound size={19} /></span><div><h3>修改密码</h3><p>修改后将退出当前会话</p></div></div>
        <form onSubmit={changePassword} noValidate>
          <PasswordInput label="当前密码" value={currentPassword} visible={visiblePassword === "current"} onChange={setCurrentPassword} onToggle={() => setVisiblePassword((value) => value === "current" ? null : "current")} autoComplete="current-password" />
          <PasswordInput label="新密码" value={newPassword} visible={visiblePassword === "new"} onChange={setNewPassword} onToggle={() => setVisiblePassword((value) => value === "new" ? null : "new")} autoComplete="new-password" />
          <PasswordInput label="确认新密码" value={confirmPassword} visible={visiblePassword === "confirm"} onChange={setConfirmPassword} onToggle={() => setVisiblePassword((value) => value === "confirm" ? null : "confirm")} autoComplete="new-password" />
          <p className={styles.feedback} role="status" aria-live="polite">{passwordMessage}</p>
          <button type="submit" className={styles.secondaryButton} disabled={savingPassword}>{savingPassword ? "正在修改" : "修改密码"}</button>
        </form>
      </section>

      {cropImage && (
        <AvatarCropDialog
          image={cropImage}
          message={cropMessage}
          onMessage={setCropMessage}
          onClose={() => setCropImage(null)}
          onSave={async (dataUrl) => {
            setSavingProfile(true);
            try {
              await auth.updateProfile({ avatarDataUrl: dataUrl });
              setProfileMessage("头像已更新");
              setCropImage(null);
            } catch (error) {
              setCropMessage(error instanceof Error ? error.message : "头像保存失败");
            } finally {
              setSavingProfile(false);
            }
          }}
        />
      )}
    </article>
  );
}

function Avatar({ dataUrl, initial }: { dataUrl: string | null; initial: string }) {
  return <span className={styles.avatar}>{dataUrl ? <img src={dataUrl} alt="用户头像" /> : <strong>{initial}</strong>}</span>;
}

function PasswordInput({ label, value, visible, autoComplete, onChange, onToggle }: {
  label: string;
  value: string;
  visible: boolean;
  autoComplete: string;
  onChange(value: string): void;
  onToggle(): void;
}) {
  return (
    <label className={styles.passwordField}>
      <span>{label}</span>
      <span><input type={visible ? "text" : "password"} value={value} maxLength={32} autoComplete={autoComplete} onChange={(event) => onChange(event.target.value)} /><button type="button" aria-pressed={visible} aria-label={visible ? `隐藏${label}` : `显示${label}`} title={visible ? `隐藏${label}` : `显示${label}`} onClick={onToggle}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></span>
    </label>
  );
}

function AvatarCropDialog({ image, message, onMessage, onClose, onSave }: {
  image: CropImage;
  message: string;
  onMessage(message: string): void;
  onClose(): void;
  onSave(dataUrl: string): Promise<void>;
}) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState(AVATAR_SIZE);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; origin: Point; offset: Point } | null>(null);
  const scale = useMemo(() => Math.max(viewportSize / image.width, viewportSize / image.height) * zoom, [image.height, image.width, viewportSize, zoom]);
  const displayWidth = image.width * scale;
  const displayHeight = image.height * scale;
  const limits = { x: Math.max(0, (displayWidth - viewportSize) / 2), y: Math.max(0, (displayHeight - viewportSize) / 2) };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateSize = () => setViewportSize(Math.max(1, viewport.getBoundingClientRect().width));
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const clampedOffset = clampOffset(offset, limits);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, origin: { x: event.clientX, y: event.clientY }, offset: clampedOffset };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset(clampOffset({ x: drag.offset.x + event.clientX - drag.origin.x, y: drag.offset.y + event.clientY - drag.origin.y }, limits));
  };
  const pointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const save = async () => {
    onMessage("");
    try {
      await onSave(await renderAvatar(image, scale, clampedOffset, viewportSize));
    } catch {
      onMessage("头像处理失败，请重新选择图片");
    }
  };

  return (
    <div className={styles.cropBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={styles.cropDialog} role="dialog" aria-modal="true" aria-labelledby="avatar-crop-title">
        <header><div><Camera size={20} /><h2 id="avatar-crop-title">调整头像</h2></div><button type="button" aria-label="关闭头像裁切" onClick={onClose}><X size={18} /></button></header>
        <div ref={viewportRef} className={styles.cropViewport} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}>
          <img src={image.src} alt="待裁切头像" draggable={false} style={{ width: displayWidth, height: displayHeight, transform: `translate3d(calc(-50% + ${clampedOffset.x}px), calc(-50% + ${clampedOffset.y}px), 0)` }} />
          <span aria-hidden="true" />
        </div>
        <label className={styles.zoomControl}><span>缩放</span><input type="range" min="1" max="3" step="0.01" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
        <p className={styles.feedback} role="status" aria-live="polite">{message}</p>
        <footer><button type="button" className={styles.cancelButton} onClick={onClose}>取消</button><button type="button" className={styles.primaryButton} onClick={() => void save()}>保存头像</button></footer>
      </section>
    </div>
  );
}

function clampOffset(point: Point, limits: Point): Point {
  return {
    x: Math.max(-limits.x, Math.min(limits.x, point.x)),
    y: Math.max(-limits.y, Math.min(limits.y, point.y)),
  };
}

function loadCropImage(file: File) {
  return new Promise<CropImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("invalid image"));
      image.onload = () => resolve({ src: String(reader.result), width: image.naturalWidth, height: image.naturalHeight });
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function renderAvatar(image: CropImage, scale: number, offset: Point, viewportSize: number) {
  return new Promise<string>((resolve, reject) => {
    const source = new Image();
    source.onerror = () => reject(new Error("invalid image"));
    source.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = AVATAR_SIZE;
      canvas.height = AVATAR_SIZE;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("canvas unavailable"));
        return;
      }
      const sourceSize = viewportSize / scale;
      const sourceX = Math.max(0, Math.min(image.width - sourceSize, (image.width - sourceSize) / 2 - offset.x / scale));
      const sourceY = Math.max(0, Math.min(image.height - sourceSize, (image.height - sourceSize) / 2 - offset.y / scale));
      context.drawImage(source, sourceX, sourceY, sourceSize, sourceSize, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
      resolve(canvas.toDataURL("image/webp", 0.88));
    };
    source.src = image.src;
  });
}
