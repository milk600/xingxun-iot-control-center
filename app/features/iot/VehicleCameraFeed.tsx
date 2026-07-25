"use client";

import { Camera, Maximize2, Radio, VideoOff, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIotDashboard } from "./use-iot-dashboard";
import type { JetsonVideoFrame } from "@/app/lib/iot/jetson-websocket";
import { downloadVehicleFrame, isCapturableVehicleFrame } from "@/app/lib/iot/camera-capture";
import styles from "./VehicleCameraFeed.module.css";

const CAMERA_STALE_AFTER_MS = 2_000;

interface CameraStats {
  width: number | null;
  height: number | null;
  fps: number;
  now: number;
  lastFrameAt: number;
}

export function VehicleCameraFeed() {
  const { snapshot, subscribeVideoFrames } = useIotDashboard();
  const imageRef = useRef<HTMLImageElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const pendingFrameRef = useRef<JetsonVideoFrame | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef(0);
  const frameCountRef = useRef(0);
  const sampledFrameCountRef = useRef(0);
  const sampledAtRef = useRef(0);
  const captureFeedbackTimerRef = useRef<number | null>(null);
  const [hasPicture, setHasPicture] = useState(false);
  const [captureFeedback, setCaptureFeedback] = useState<string | null>(null);
  const [stats, setStats] = useState<CameraStats>({ width: null, height: null, fps: 0, now: 0, lastFrameAt: 0 });

  const paintLatestFrame = useCallback(() => {
    animationFrameRef.current = null;
    const frame = pendingFrameRef.current;
    const image = imageRef.current;
    pendingFrameRef.current = null;
    if (!frame || !image) return;

    try {
      // Keep the previously decoded JPEG visible until the browser has decoded
      // the next data URL. Revoking a Blob URL here creates a visible empty frame
      // on some Android WebViews and Chromium builds.
      image.src = `data:image/jpeg;base64,${frame.data}`;
    } catch {
      // The protocol parser already rejects malformed frames. A decode failure
      // is isolated to this frame so odometry and vehicle control remain live.
    }
  }, []);

  useEffect(() => subscribeVideoFrames((frame) => {
    pendingFrameRef.current = frame;
    lastFrameAtRef.current = Date.parse(frame.receivedAt);
    frameCountRef.current += 1;
    if (animationFrameRef.current === null) {
      animationFrameRef.current = window.requestAnimationFrame(paintLatestFrame);
    }
  }), [paintLatestFrame, subscribeVideoFrames]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const previousSampleAt = sampledAtRef.current || now - 1_000;
      const elapsedSeconds = Math.max(0.001, (now - previousSampleAt) / 1_000);
      const received = frameCountRef.current - sampledFrameCountRef.current;
      sampledFrameCountRef.current = frameCountRef.current;
      sampledAtRef.current = now;
      setStats((current) => ({
        ...current,
        fps: Math.round(received / elapsedSeconds),
        now,
        lastFrameAt: lastFrameAtRef.current,
      }));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
    if (captureFeedbackTimerRef.current !== null) window.clearTimeout(captureFeedbackTimerRef.current);
  }, []);

  const cameraState = useMemo(() => {
    const link = snapshot.vehicle.controlLink;
    const lastFrameAt = stats.lastFrameAt;
    if (link === "connecting") return { tone: "connecting", label: "正在连接", detail: "正在连接车载摄像头", icon: Radio } as const;
    if (link !== "connected") return { tone: "offline", label: "离线", detail: "未检测到摄像头", icon: WifiOff } as const;
    if (!lastFrameAt) return { tone: "empty", label: "未检测到", detail: "未检测到摄像头", icon: VideoOff } as const;
    if (stats.now - lastFrameAt > CAMERA_STALE_AFTER_MS) {
      return { tone: "stale", label: "画面中断", detail: "摄像头画面中断", icon: VideoOff } as const;
    }
    return { tone: "live", label: "实时", detail: "车载摄像头实时画面", icon: Camera } as const;
  }, [snapshot.vehicle.controlLink, stats.lastFrameAt, stats.now]);

  const StateIcon = cameraState.icon;
  const resolution = stats.width && stats.height ? `${stats.width} × ${stats.height}` : "等待画面";
  const canCapture = cameraState.tone === "live" && hasPicture;

  const captureFrame = useCallback(() => {
    const source = imageRef.current?.src ?? "";
    if (cameraState.tone !== "live" || !hasPicture || !isCapturableVehicleFrame(source)) return;
    try {
      downloadVehicleFrame(source);
      setCaptureFeedback("已开始保存到本地");
    } catch {
      setCaptureFeedback("照片保存失败");
    }
    if (captureFeedbackTimerRef.current !== null) window.clearTimeout(captureFeedbackTimerRef.current);
    captureFeedbackTimerRef.current = window.setTimeout(() => setCaptureFeedback(null), 2_600);
  }, [cameraState.tone, hasPicture]);

  const enterFullscreen = useCallback(() => {
    const target = rootRef.current;
    if (!target?.requestFullscreen) return;
    void target.requestFullscreen().catch(() => undefined);
  }, []);

  return (
    <section
      ref={rootRef}
      className={`${styles.root} ${styles[`state_${cameraState.tone}`]}`}
      aria-label="车载摄像头"
    >
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <span className={styles.titleIcon}><Camera size={19} aria-hidden="true" /></span>
          <div><h3>车载摄像头</h3><p aria-live="polite">{cameraState.label}</p></div>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.captureButton}
            onClick={captureFrame}
            disabled={!canCapture}
            title={canCapture ? "拍照并保存到本地" : "收到实时画面后可拍照"}
            aria-label="拍照并保存当前车载摄像头画面"
          >
            <Camera size={18} aria-hidden="true" />
          </button>
          <button type="button" className={styles.fullscreenButton} onClick={enterFullscreen} title="全屏查看" aria-label="全屏查看车载摄像头">
            <Maximize2 size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className={styles.stage}>
        {/* A live data URL cannot use Next.js image optimization. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imageRef}
          className={`${styles.image}${hasPicture ? ` ${styles.imageVisible}` : ""}`}
          alt="车载摄像头实时画面"
          draggable={false}
      onLoad={(event) => {
        const width = event.currentTarget.naturalWidth;
        const height = event.currentTarget.naturalHeight;
        setHasPicture(true);
        setStats((current) => {
          const nextWidth = width || current.width;
          const nextHeight = height || current.height;
          if (current.width === nextWidth && current.height === nextHeight) {
            return current;
          }
          return {
            ...current,
            width: nextWidth,
            height: nextHeight,
          };
        });
      }}
        />
        {cameraState.tone !== "live" && (
          <div className={styles.stateOverlay} role="status">
            <span><StateIcon size={24} aria-hidden="true" /></span>
            <strong>{cameraState.detail}</strong>
          </div>
        )}
      </div>

      <footer className={styles.footer}>
        <span className={styles.status}><i aria-hidden="true" />{cameraState.label}</span>
        <span className={styles.metadata} aria-live="polite">
          {captureFeedback ?? `${resolution}${cameraState.tone === "live" ? ` · ${stats.fps} FPS` : ""}`}
        </span>
      </footer>
    </section>
  );
}
