"use client";
/* eslint-disable @next/next/no-img-element -- the component is shared by the offline Android build */

import {
  Camera,
  ChevronDown,
  Cloud,
  Crosshair,
  MapPinned,
  Radar,
  ScanLine,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  PRODUCT_DESCRIPTION,
  PRODUCT_NAME,
  PRODUCT_TAGLINE,
} from "@/app/lib/brand";
import { LoginSpatialField } from "./LoginSpatialField";
import styles from "./LoginScreen.module.css";

const SHOWCASE_ITEMS = [
  {
    title: "六路环境感知",
    description: "温湿度、气体与光照数据持续汇聚，实时状态一屏掌握。",
    image: "/images/showcase/environment-monitoring.svg",
    alt: "危化智巡六路环境数据实时监测界面",
  },
  {
    title: "空间孪生巡检",
    description: "把位置、轨迹与现场模型映射到同一空间视图。",
    image: "/images/showcase/digital-twin-demo.svg",
    alt: "危化智巡空间孪生与点云模型界面",
  },
  {
    title: "车端实时视野",
    description: "巡检地图、摄像头画面与车辆控制协同联动。",
    image: "/images/showcase/vehicle-control-demo.svg",
    alt: "危化智巡巡检车辆地图与摄像头双视图",
  },
  {
    title: "AI 辅助研判",
    description: "基于真实遥测生成问题分析、建议与可验证行动。",
    image: "/images/showcase/ai-analysis-demo.svg",
    alt: "危化智巡 AI 规划和操作引导界面",
  },
] as const;

export function LoginShowcase({
  onLoginStageVisibilityChange,
}: {
  onLoginStageVisibilityChange(visible: boolean): void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const heroCopyRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const storyRefs = useRef<Array<HTMLElement | null>>([]);
  const visibleStoryIndexesRef = useRef<Set<number>>(new Set());

  const updateStagePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    stage.style.setProperty("--pointer-x", x.toFixed(3));
    stage.style.setProperty("--pointer-y", y.toFixed(3));
  };

  const resetStagePointer = () => {
    stageRef.current?.style.setProperty("--pointer-x", "0");
    stageRef.current?.style.setProperty("--pointer-y", "0");
  };

  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const index = Number((entry.target as HTMLElement).dataset.storyIndex);
        if (!Number.isInteger(index)) return;
        if (entry.isIntersecting) visibleStoryIndexesRef.current.add(index);
        else visibleStoryIndexesRef.current.delete(index);
      });
    }, {
      rootMargin: "12% 0px 12%",
      threshold: [0, 0.01],
    });
    storyRefs.current.forEach((node) => node && observer.observe(node));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const desktopQuery = window.matchMedia("(min-width: 1180px)");
    const nativeScrollTimeline = CSS.supports("animation-timeline: scroll()");
    let collapsed: boolean | null = null;
    let frame = 0;

    const updateScrollScene = () => {
      frame = 0;
      if (!desktopQuery.matches) {
        if (collapsed !== false) {
          collapsed = false;
          onLoginStageVisibilityChange(true);
        }
      } else {
        const collapseAt = window.innerHeight * 0.68;
        const expandAt = window.innerHeight * 0.42;

        if (collapsed === null) {
          collapsed = window.scrollY >= collapseAt;
          onLoginStageVisibilityChange(!collapsed);
        } else if (!collapsed && window.scrollY >= collapseAt) {
          collapsed = true;
          onLoginStageVisibilityChange(false);
        } else if (collapsed && window.scrollY <= expandAt) {
          collapsed = false;
          onLoginStageVisibilityChange(true);
        }
      }

      if (!nativeScrollTimeline) {
        const progress = Math.min(1, Math.max(0, window.scrollY / Math.max(1, window.innerHeight * 0.92)));
        if (heroCopyRef.current) {
          heroCopyRef.current.style.translate = `0 ${(-18 * progress).toFixed(2)}px`;
        }
        if (stageRef.current) {
          stageRef.current.style.translate = `0 ${(-22 * progress).toFixed(2)}px`;
          stageRef.current.style.rotate = `x ${(1.5 * progress).toFixed(3)}deg`;
        }
      }

      if (visibleStoryIndexesRef.current.size === 0) return;

      const focusLine = window.innerHeight * 0.5;
      let nextIndex = -1;
      let nextDistance = Number.POSITIVE_INFINITY;
      storyRefs.current.forEach((node, index) => {
        if (!node) return;
        if (visibleStoryIndexesRef.current.size > 0 && !visibleStoryIndexesRef.current.has(index)) return;
        const rect = node.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) return;
        const distance = Math.abs((rect.top + rect.bottom) / 2 - focusLine);
        if (distance < nextDistance) {
          nextDistance = distance;
          nextIndex = index;
        }
      });
      if (nextIndex >= 0) {
        setActiveIndex((current) => current === nextIndex ? current : nextIndex);
      }
    };

    const scheduleScrollScene = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateScrollScene);
    };

    scheduleScrollScene();
    window.addEventListener("scroll", scheduleScrollScene, { passive: true });
    window.addEventListener("resize", scheduleScrollScene);
    desktopQuery.addEventListener("change", scheduleScrollScene);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scheduleScrollScene);
      window.removeEventListener("resize", scheduleScrollScene);
      desktopQuery.removeEventListener("change", scheduleScrollScene);
    };
  }, [onLoginStageVisibilityChange]);

  return (
    <div className={styles.experienceColumn}>
      <section className={styles.productHero} aria-labelledby="product-introduction-title">
        <div ref={heroCopyRef} className={styles.heroCopy}>
          <span className={styles.heroEyebrow}>
            <ShieldCheck size={16} aria-hidden="true" />
            {PRODUCT_NAME} · {PRODUCT_TAGLINE}
          </span>
          <h1 id="product-introduction-title">
            <span className={styles.heroHeadlineLead}>让每一次危化巡检，</span>
            <span>都可视、可控、可追溯</span>
          </h1>
          <p>{PRODUCT_DESCRIPTION}</p>
          <div className={styles.heroSignals} aria-label="平台核心能力">
            <span><Radar size={16} aria-hidden="true" />六路感知</span>
            <span><MapPinned size={16} aria-hidden="true" />空间巡检</span>
            <span><Sparkles size={16} aria-hidden="true" />AI 研判</span>
          </div>
          <a className={styles.scrollCue} href="#platform-capabilities">
            探索平台能力 <ChevronDown size={16} aria-hidden="true" />
          </a>
        </div>

        <div
          ref={stageRef}
          className={styles.vehicleShowcase}
          aria-label="危化巡检车辆三维实物展示"
          onPointerMove={updateStagePointer}
          onPointerLeave={resetStagePointer}
        >
          <div className={styles.spatialField}><LoginSpatialField /></div>
          <div className={styles.stageChrome} aria-hidden="true">
            <span><i />LIVE DIGITAL VEHICLE</span>
            <strong>WH-I / 3D</strong>
          </div>
          <span className={`${styles.vehicleHalo} ${styles.vehicleHaloLarge}`} aria-hidden="true" />
          <span className={`${styles.vehicleHalo} ${styles.vehicleHaloSmall}`} aria-hidden="true" />
          <span className={styles.stageScanBeam} aria-hidden="true" />
          <div className={styles.vehicleWorld}>
            <span className={styles.spatialFloor} aria-hidden="true" />
            <span className={`${styles.stageOrbit} ${styles.stageOrbitOne}`} aria-hidden="true" />
            <span className={`${styles.stageOrbit} ${styles.stageOrbitTwo}`} aria-hidden="true" />
            <img
              className={`${styles.vehicleImage} ${styles.vehicleImageRearLeft}`}
              src="/images/vehicles/vehicle-camera-front-v2.webp"
              alt=""
              width="989"
              height="909"
              decoding="async"
            />
            <img
              className={`${styles.vehicleImage} ${styles.vehicleImageRearRight}`}
              src="/images/vehicles/vehicle-camera-low-v2.webp"
              alt=""
              width="898"
              height="1003"
              decoding="async"
            />
            <img
              className={`${styles.vehicleImage} ${styles.vehicleImagePrimary}`}
              src="/images/vehicles/vehicle-three-quarter-v2.webp"
              alt="搭载工业相机、计算单元和环境传感器的危化巡检车辆"
              width="1013"
              height="703"
              decoding="async"
            />
            <span className={`${styles.stageCallout} ${styles.calloutCamera}`}><Camera size={13} />工业视觉<i /></span>
            <span className={`${styles.stageCallout} ${styles.calloutCloud}`}><Cloud size={13} />六路环境感知<i /></span>
            <span className={`${styles.stageCallout} ${styles.calloutPosition}`}><Crosshair size={13} />空间定位<i /></span>
          </div>
          <div className={styles.stageTelemetry} aria-hidden="true">
            <span><small>视觉链路</small><strong>1080P · LIVE</strong></span>
            <span><small>环境通道</small><strong>06 CONNECTED</strong></span>
            <span><small>空间状态</small><strong>MAPPED</strong></span>
          </div>
          <span className={styles.vehicleStatus}><i aria-hidden="true" />真实设备 · 多传感协同</span>
        </div>
      </section>

      <section id="platform-capabilities" className={styles.featureStory} aria-labelledby="platform-capabilities-title">
        <header className={styles.storyHeading}>
          <span>一套平台，贯通巡检全流程</span>
          <h2 id="platform-capabilities-title">从现场感知到智能研判</h2>
          <p>真实功能界面随滚动逐步展开，所有关键状态都有清晰、可验证的依据。</p>
        </header>

        <div className={styles.storyLayout}>
          <div className={styles.storySteps}>
            {SHOWCASE_ITEMS.map((item, index) => (
              <article
                key={item.title}
                ref={(node) => { storyRefs.current[index] = node; }}
                data-story-index={index}
                className={`${styles.storyStep}${activeIndex === index ? ` ${styles.storyStepActive}` : ""}`}
              >
                <span className={styles.storyNumber}>0{index + 1}</span>
                <div><h3>{item.title}</h3><p>{item.description}</p></div>
                <img src={item.image} alt={item.alt} width="1440" height="900" loading="lazy" decoding="async" />
              </article>
            ))}
          </div>

          <div className={styles.storyVisual} aria-hidden="true">
            <span className={`${styles.visualDepthCard} ${styles.visualDepthCardOne}`} />
            <span className={`${styles.visualDepthCard} ${styles.visualDepthCardTwo}`} />
            <div
              className={styles.visualDevice}
              data-showcase-device="true"
              style={{ "--story-progress": activeIndex } as CSSProperties}
            >
              <div className={styles.visualHeader}>
                <span><Sparkles size={15} />平台实景</span>
                <strong>{PRODUCT_NAME}</strong>
              </div>
              <div className={styles.visualViewport}>
                <span className={styles.visualScanLine} />
                {SHOWCASE_ITEMS.map((item, index) => (
                  <img
                    key={item.image}
                    className={activeIndex === index ? styles.visualImageActive : undefined}
                    style={{ "--visual-distance": index - activeIndex } as CSSProperties}
                    src={item.image}
                    alt=""
                    width="1440"
                    height="900"
                    loading={index === 0 ? "eager" : "lazy"}
                    decoding="async"
                  />
                ))}
                <span className={styles.visualReticle}><ScanLine size={16} /></span>
              </div>
              <footer><span>0{activeIndex + 1}</span><strong>{SHOWCASE_ITEMS[activeIndex].title}</strong><i /></footer>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
