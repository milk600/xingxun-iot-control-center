"use client";

import {
  Camera,
  Expand,
  LoaderCircle,
  Move3D,
  RotateCcw,
  Rotate3D,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ROOM_ONE_RECOMMENDED_MODELS,
  type TwinStandardView,
  type TwinViewportAppearance,
} from "@/app/lib/digital-twin/contracts";
import {
  ROOM_ONE_TOP_DIRECTION,
  ROOM_ONE_TOP_UP,
} from "@/app/lib/digital-twin/room-one-coordinate-system";
import {
  assertLocalModelFileSize,
  inspectPlyHeader,
} from "@/app/lib/digital-twin/model-safety";
import { fixOpenMvsBaseColorTextures } from "@/app/lib/digital-twin/openmvs-texture";
import { getScaledMotionDurationMs } from "@/app/lib/ui-preferences";
import {
  AI_ACTION_EVENT,
  registerActionReceiver,
  readActionDispatchDetail,
  reportActionError,
  reportActionSuccess,
} from "@/app/lib/ai/action-events";
import type { AgentAction } from "@/app/lib/ai/contracts";
import {
  parsePlyFile,
  type SerializedPlyAttribute as SerializedAttribute,
} from "./preloadRoomOneTwinScene";
import {
  DIGITAL_TWIN_NAVIGATION_START,
  isDigitalTwinExitNavigation,
} from "./digitalTwinNavigation";
import styles from "./DigitalTwinWorkspace.module.css";

export type TwinModelPhase = "idle" | "loading" | "ready" | "error";
export type TwinModelKind = "gaussian" | "point-cloud" | "mesh" | "textured-mesh";

export interface TwinModelState {
  phase: TwinModelPhase;
  progress: number;
  message: string;
  elementCount: number | null;
  modelKind: TwinModelKind | null;
  rendererLabel: string | null;
  layerWarnings?: string[];
}

const IDLE_STATE: TwinModelState = {
  phase: "idle",
  progress: 0,
  message: "等待选择模型",
  elementCount: null,
  modelKind: null,
  rendererLabel: null,
};

const POINT_CLOUD_RENDERER_LABEL = "Three.js · 原生分辨率";

interface GaussianSplatViewportProps {
  file: File | null;
  gapFile: File | null;
  frameworkFile: File | null;
  appearance: TwinViewportAppearance;
  onStateChange: (state: TwinModelState) => void;
  onChooseFile: () => void;
}

type TwinOrbitOptions = Extract<AgentAction, { name: "twin.orbit" }>["arguments"];
type ViewportActionStateKey = "aiViewState" | "aiOrbitState";

function waitForViewportState(
  shell: HTMLElement | null,
  stateKey: ViewportActionStateKey,
  timeoutMs: number,
) {
  const canvas = shell?.querySelector<HTMLCanvasElement>("canvas");
  if (!canvas) return Promise.reject(new Error("三维视口尚未挂载，无法确认相机动作。"));

  return new Promise<void>((resolve, reject) => {
    const startedAt = window.performance.now();
    let frame = 0;
    const inspect = () => {
      if (!canvas.isConnected) {
        reject(new Error("三维视口已卸载，相机动作未完成。"));
        return;
      }
      const state = canvas.dataset[stateKey];
      if (state === "completed") {
        resolve();
        return;
      }
      if (state === "cancelled") {
        reject(new Error("相机动作被取消，未到达目标状态。"));
        return;
      }
      if (window.performance.now() - startedAt >= timeoutMs) {
        reject(new Error("三维视口没有返回相机动作完成状态。"));
        return;
      }
      frame = window.requestAnimationFrame(inspect);
    };
    frame = window.requestAnimationFrame(inspect);
    void frame;
  });
}

async function detectModelKind(file: File): Promise<TwinModelKind> {
  if (file.name.toLowerCase().endsWith(".glb")) return "textured-mesh";
  if (!file.name.toLowerCase().endsWith(".ply")) return "gaussian";

  const header = await file.slice(0, Math.min(file.size, 256 * 1024)).text();
  return inspectPlyHeader(header).kind;
}

async function assertSelfContainedGlb(file: File) {
  const prefix = await file.slice(0, 20).arrayBuffer();
  if (prefix.byteLength < 20) throw new Error("GLB 文件头不完整。");
  const view = new DataView(prefix);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) {
    throw new Error("当前文件不是有效的 GLB 2.0 模型。");
  }
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || jsonLength <= 0 || jsonLength > file.size - 20) {
    throw new Error("GLB 缺少有效的场景描述。");
  }
  const manifest = JSON.parse(await file.slice(20, 20 + jsonLength).text()) as {
    images?: Array<{ uri?: string }>;
    buffers?: Array<{ uri?: string }>;
  };
  const externalUri = [...(manifest.images ?? []), ...(manifest.buffers ?? [])]
    .map((resource) => resource.uri)
    .find((uri) => uri && !uri.startsWith("data:"));
  if (externalUri) {
    throw new Error(`此 GLB 仍引用外部文件“${externalUri}”。请先导出嵌入纹理的单文件 GLB。`);
  }
}

function disposeMaterial(material: import("three").Material) {
  for (const value of Object.values(material)) {
    if (value && typeof value === "object" && "isTexture" in value) {
      const texture = value as import("three").Texture;
      const image = texture.source?.data as { close?: () => void } | undefined;
      texture.dispose();
      image?.close?.();
    }
  }
  material.dispose();
}

function disposeObjectTree(root: import("three").Object3D) {
  const geometries = new Set<import("three").BufferGeometry>();
  const materials = new Set<import("three").Material>();
  root.traverse((object) => {
    const mesh = object as import("three").Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of meshMaterials) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) disposeMaterial(material);
  root.clear();
}

function deferNavigationDisposal(dispose: () => void) {
  window.setTimeout(() => {
    const requestIdle = (
      window as unknown as {
        requestIdleCallback?: (
          callback: () => void,
          options: { timeout: number },
        ) => number;
      }
    ).requestIdleCallback;
    if (requestIdle) {
      requestIdle.call(window, dispose, { timeout: 600 });
    } else {
      window.setTimeout(dispose, 0);
    }
  }, getScaledMotionDurationMs(170));
}

export function GaussianSplatViewport({
  file,
  gapFile,
  frameworkFile,
  appearance,
  onStateChange,
  onChooseFile,
}: GaussianSplatViewportProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const fitViewRef = useRef<(() => void) | null>(null);
  const setViewRef = useRef<((view: TwinStandardView) => void) | null>(null);
  const orbitRef = useRef<((options: TwinOrbitOptions) => void) | null>(null);
  const pendingOrbitRef = useRef<TwinOrbitOptions | null>(null);
  const captureRef = useRef<(() => void) | null>(null);
  const applyAppearanceRef = useRef<((next: TwinViewportAppearance) => void) | null>(null);
  const appearanceStateRef = useRef(appearance);
  const [viewerState, setViewerState] = useState<TwinModelState>(IDLE_STATE);
  const [activeView, setActiveView] = useState<TwinStandardView>("top");

  const updateState = useCallback(
    (next: TwinModelState) => {
      setViewerState(next);
      onStateChange(next);
    },
    [onStateChange],
  );

  useEffect(() => {
    appearanceStateRef.current = appearance;
    applyAppearanceRef.current?.(appearance);
  }, [appearance]);

  useEffect(() => {
    const handleAction = (event: Event) => {
      const action = readActionDispatchDetail(event);
      if (!action) return;
      if (action.name === "twin.set_view") {
        if (!setViewRef.current || viewerState.phase !== "ready") {
          reportActionError(action, viewerState.phase === "error"
            ? viewerState.message
            : "三维模型视口尚未就绪。");
          return;
        }
        try {
          setViewRef.current(action.arguments.view);
          void waitForViewportState(shellRef.current, "aiViewState", 6_000)
            .then(() => reportActionSuccess(action, "标准视角已切换完成。"))
            .catch((error) => reportActionError(action, error, "标准视角切换失败。"));
        } catch (error) {
          reportActionError(action, error, "标准视角切换失败。");
        }
        return;
      }
      if (action.name === "twin.orbit") {
        if (!orbitRef.current || viewerState.phase !== "ready") {
          reportActionError(action, viewerState.phase === "error"
            ? viewerState.message
            : "三维模型视口尚未就绪，无法开始环视。");
          return;
        }
        try {
          orbitRef.current(action.arguments);
          void waitForViewportState(
            shellRef.current,
            "aiOrbitState",
            action.arguments.durationMs + 4_000,
          )
            .then(() => reportActionSuccess(action, "环绕检查动画已完成。"))
            .catch((error) => reportActionError(action, error, "环绕检查失败。"));
        } catch (error) {
          reportActionError(action, error, "环绕检查启动失败。");
        }
        return;
      }
      if (action.name === "twin.reset_view") {
        if (!fitViewRef.current || viewerState.phase !== "ready") {
          reportActionError(action, viewerState.phase === "error"
            ? viewerState.message
            : "三维模型视口尚未就绪，无法复位。");
          return;
        }
        try {
          fitViewRef.current();
          void waitForViewportState(shellRef.current, "aiViewState", 6_000)
            .then(() => reportActionSuccess(action, "三维视口已复位。"))
            .catch((error) => reportActionError(action, error, "三维视口复位失败。"));
        } catch (error) {
          reportActionError(action, error, "三维视口复位失败。");
        }
        return;
      }
      if (action.name === "twin.capture") {
        if (!captureRef.current || viewerState.phase !== "ready") {
          reportActionError(action, viewerState.phase === "error"
            ? viewerState.message
            : "三维模型视口尚未就绪，无法保存画面。");
          return;
        }
        try {
          captureRef.current();
          reportActionSuccess(action, "当前三维画面已生成并提交保存。");
        } catch (error) {
          reportActionError(action, error, "三维画面保存失败。");
        }
      }
    };
    window.addEventListener(AI_ACTION_EVENT, handleAction);
    const unregisterReceiver = registerActionReceiver([
      "twin.set_view",
      "twin.orbit",
      "twin.reset_view",
      "twin.capture",
    ]);
    return () => {
      unregisterReceiver();
      window.removeEventListener(AI_ACTION_EVENT, handleAction);
    };
  }, [viewerState.message, viewerState.phase]);

  useEffect(() => {
    const host = hostRef.current;
    fitViewRef.current = null;
    setViewRef.current = null;
    orbitRef.current = null;
    captureRef.current = null;
    applyAppearanceRef.current = null;

    if (!file || !host) {
      updateState(IDLE_STATE);
      return;
    }

    let cancelled = false;
    let navigationLeaving = false;
    let resizeObserver: ResizeObserver | null = null;
    let disposeScene: (() => void) | null = null;
    let terminateWorker: (() => void) | null = null;
    let suspendForNavigation: (() => void) | null = null;

    const handleNavigationStart = (event: Event) => {
      if (!isDigitalTwinExitNavigation(event)) return;
      navigationLeaving = true;
      suspendForNavigation?.();
    };
    window.addEventListener(DIGITAL_TWIN_NAVIGATION_START, handleNavigationStart);

    const initialize = async () => {
      assertLocalModelFileSize(file.size);
      updateState({
        phase: "loading",
        progress: 2,
        message: "正在识别模型格式",
        elementCount: null,
        modelKind: null,
        rendererLabel: null,
      });

      const probe = document.createElement("canvas");
      const probeContext = probe.getContext("webgl2");
      if (!probeContext) {
        throw new Error("当前浏览器未启用 WebGL 2，请使用最新版 Chrome 或 Edge。");
      }
      probeContext.getExtension("WEBGL_lose_context")?.loseContext();

      const modelKind = await detectModelKind(file);
      if (cancelled || navigationLeaving) return;

      const usesRoomOneTopCalibration =
        file.name === ROOM_ONE_RECOMMENDED_MODELS.primary;

      const THREE = await import("three");
      const { TrackballControls } = await import("three/addons/controls/TrackballControls.js");
      if (cancelled || navigationLeaving) return;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x000000);
      const camera = new THREE.PerspectiveCamera(52, 1, 0.01, 2_000);
      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
        preserveDrawingBuffer: true,
      });
      const nativePixelRatio = Math.max(1, window.devicePixelRatio || 1);
      renderer.setPixelRatio(nativePixelRatio);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
      renderer.domElement.className = styles.splatCanvas;
      renderer.domElement.setAttribute("aria-label", "室内三维数字孪生模型视口");
      renderer.domElement.tabIndex = 0;
      host.replaceChildren(renderer.domElement);

      const controls = new TrackballControls(camera, renderer.domElement);
      controls.rotateSpeed = modelKind === "point-cloud" ? 1.8 : 1.25;
      controls.zoomSpeed = 1.25;
      controls.panSpeed = 0.4;
      controls.staticMoving = true;
      controls.keys = ["", "", ""];
      controls.minDistance = 0.02;
      controls.maxDistance = 200;

      const modelRoot = new THREE.Group();
      const primaryLayer = new THREE.Group();
      const gapLayer = new THREE.Group();
      const frameworkLayer = new THREE.Group();
      primaryLayer.name = "primary-colored-open-top";
      gapLayer.name = "gap-diagnostic";
      frameworkLayer.name = "room-framework";
      modelRoot.add(primaryLayer, gapLayer, frameworkLayer);
      scene.add(modelRoot);
      const ownedGeometries = new Set<import("three").BufferGeometry>();
      const ownedMaterials = new Set<import("three").Material>();
      let sparkCleanup: (() => Promise<void>) | null = null;
      let sparkSuspend: (() => void) | null = null;
      let objectUrl: string | null = null;
      let controlsInteracting = false;
      let canvasHideTimer: number | null = null;
      let controlsDisposed = false;

      type CameraViewTransition = {
        startedAt: number;
        durationMs: number;
        fromTarget: import("three").Vector3;
        toTarget: import("three").Vector3;
        fromDirection: import("three").Vector3;
        directionRotation: import("three").Quaternion;
        fromDistance: number;
        toDistance: number;
        fromUp: import("three").Vector3;
        toUp: import("three").Vector3;
        fromQuaternion: import("three").Quaternion;
        toQuaternion: import("three").Quaternion;
        toPosition: import("three").Vector3;
      };
      type CameraOrbitTransition = {
        startedAt: number;
        durationMs: number;
        target: import("three").Vector3;
        verticalAxis: import("three").Vector3;
        startHorizontal: import("three").Vector3;
        startElevation: number;
        targetElevation: number;
        startDistance: number;
        targetDistance: number;
        revolutions: number;
        directionSign: number;
        fallbackUp: import("three").Vector3;
      };
      let cameraViewTransition: CameraViewTransition | null = null;
      let cameraOrbitTransition: CameraOrbitTransition | null = null;

      const cancelCameraMotion = () => {
        const hadMotion = Boolean(cameraViewTransition || cameraOrbitTransition);
        if (cameraViewTransition) renderer.domElement.dataset.aiViewState = "cancelled";
        cameraViewTransition = null;
        if (cameraOrbitTransition) renderer.domElement.dataset.aiOrbitState = "cancelled";
        cameraOrbitTransition = null;
        if (hadMotion && modelKind !== "gaussian" && !controlsInteracting) {
          renderer.setAnimationLoop(null);
        }
      };

      const advanceCameraViewTransition = (timestamp: number) => {
        const transition = cameraViewTransition;
        if (!transition) return false;

        const linearProgress = Math.min(
          1,
          Math.max(0, (timestamp - transition.startedAt) / transition.durationMs),
        );
        // Quintic smootherstep gives a deliberate hand-drag-like acceleration
        // and deceleration without the mechanical constant-speed orbit.
        const easedProgress = linearProgress * linearProgress * linearProgress
          * (linearProgress * (linearProgress * 6 - 15) + 10);
        const partialRotation = new THREE.Quaternion().identity().slerp(
          transition.directionRotation,
          easedProgress,
        );
        const direction = transition.fromDirection.clone()
          .applyQuaternion(partialRotation)
          .normalize();
        const distance = THREE.MathUtils.lerp(
          transition.fromDistance,
          transition.toDistance,
          easedProgress,
        );

        controls.target.lerpVectors(
          transition.fromTarget,
          transition.toTarget,
          easedProgress,
        );
        camera.position.copy(controls.target).addScaledVector(direction, distance);
        camera.up.lerpVectors(transition.fromUp, transition.toUp, easedProgress).normalize();
        camera.quaternion.slerpQuaternions(
          transition.fromQuaternion,
          transition.toQuaternion,
          easedProgress,
        );
        camera.updateMatrixWorld();

        if (linearProgress >= 1) {
          cameraViewTransition = null;
          renderer.domElement.dataset.aiViewState = "completed";
          controls.target.copy(transition.toTarget);
          camera.position.copy(transition.toPosition);
          camera.up.copy(transition.toUp);
          camera.quaternion.copy(transition.toQuaternion);
          camera.lookAt(controls.target);
          controls.update();
          if (modelKind !== "gaussian" && !controlsInteracting) {
            renderer.setAnimationLoop(null);
          }
        }
        return true;
      };

      const advanceCameraOrbitTransition = (timestamp: number) => {
        const transition = cameraOrbitTransition;
        if (!transition) return false;

        const linearProgress = Math.min(
          1,
          Math.max(0, (timestamp - transition.startedAt) / transition.durationMs),
        );
        const easedProgress = linearProgress * linearProgress * linearProgress
          * (linearProgress * (linearProgress * 6 - 15) + 10);
        const settleProgress = Math.min(1, linearProgress / 0.18);
        const easedSettle = settleProgress * settleProgress * (3 - 2 * settleProgress);
        const angle = transition.directionSign
          * Math.PI * 2
          * transition.revolutions
          * easedProgress;
        const horizontal = transition.startHorizontal.clone().applyAxisAngle(
          transition.verticalAxis,
          angle,
        );
        const elevation = THREE.MathUtils.lerp(
          transition.startElevation,
          transition.targetElevation,
          easedSettle,
        );
        const distance = THREE.MathUtils.lerp(
          transition.startDistance,
          transition.targetDistance,
          easedSettle,
        );
        const direction = horizontal.multiplyScalar(Math.cos(elevation))
          .addScaledVector(transition.verticalAxis, Math.sin(elevation))
          .normalize();
        const projectedUp = transition.verticalAxis.clone().addScaledVector(
          direction,
          -transition.verticalAxis.dot(direction),
        );

        controls.target.copy(transition.target);
        camera.position.copy(transition.target).addScaledVector(direction, distance);
        camera.up.copy(
          projectedUp.lengthSq() > 1e-6
            ? projectedUp.normalize()
            : transition.fallbackUp,
        );
        camera.lookAt(controls.target);
        camera.updateMatrixWorld();

        if (linearProgress >= 1) {
          cameraOrbitTransition = null;
          renderer.domElement.dataset.aiOrbitState = "completed";
          controls.update();
          if (modelKind !== "gaussian" && !controlsInteracting) {
            renderer.setAnimationLoop(null);
          }
        }
        return true;
      };

      const renderFrame = (timestamp = window.performance.now()) => {
        if (navigationLeaving || document.hidden) return;
        const cameraIsAnimating = advanceCameraViewTransition(timestamp)
          || advanceCameraOrbitTransition(timestamp);
        if (!cameraIsAnimating) controls.update();
        renderer.render(scene, camera);
      };
      const renderLoop = (timestamp: number) => renderFrame(timestamp);

      const beginInteraction = () => {
        if (navigationLeaving) return;
        cancelCameraMotion();
        controlsInteracting = true;
        if (modelKind !== "gaussian" && !document.hidden) {
          renderer.setAnimationLoop(renderLoop);
        }
      };

      const endInteraction = () => {
        controlsInteracting = false;
        if (modelKind !== "gaussian") renderer.setAnimationLoop(null);
        if (navigationLeaving) return;
        renderFrame();
      };

      controls.addEventListener("start", beginInteraction);
      controls.addEventListener("end", endInteraction);

      const resize = () => {
        if (navigationLeaving) return;
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        renderer.setPixelRatio(nativePixelRatio);
        renderer.domElement.dataset.renderPixelRatio = String(nativePixelRatio);
        renderer.domElement.dataset.renderWidth = String(Math.floor(width * nativePixelRatio));
        renderer.domElement.dataset.renderHeight = String(Math.floor(height * nativePixelRatio));
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        controls.handleResize();
        renderFrame();
      };

      let framedSphere = new THREE.Sphere(new THREE.Vector3(), 2);

      const frameSphere = (
        sphere: import("three").Sphere,
        view: TwinStandardView = "top",
        animated = false,
      ) => {
        const radius = Math.max(sphere.radius, 0.5);
        const viewConfig: Record<TwinStandardView, {
          direction: import("three").Vector3;
          up: import("three").Vector3;
          distance: number;
        }> = {
          perspective: {
            direction: new THREE.Vector3(1, 0.68, 1).normalize(),
            up: new THREE.Vector3(0, 1, 0),
            distance: 2.65,
          },
          top: {
            // The reconstructed room is tilted relative to world Y. Its PLY
            // stores the fitted downward vertical axis; viewing from the
            // opposite vector produces a true ceiling-side orthographic-like
            // top view. The in-plane PCA axis keeps the room's long edge
            // visually vertical instead of leaving it diagonally rolled.
            direction: usesRoomOneTopCalibration
              ? new THREE.Vector3(...ROOM_ONE_TOP_DIRECTION).normalize()
              : new THREE.Vector3(0, -1, -0.0001).normalize(),
            up: usesRoomOneTopCalibration
              ? new THREE.Vector3(...ROOM_ONE_TOP_UP).normalize()
              : new THREE.Vector3(0, 0, 1),
            distance: 2.45,
          },
          front: {
            direction: new THREE.Vector3(0, 0, 1),
            up: new THREE.Vector3(0, 1, 0),
            distance: 2.45,
          },
          left: {
            direction: new THREE.Vector3(-1, 0, 0),
            up: new THREE.Vector3(0, 1, 0),
            distance: 2.45,
          },
          right: {
            direction: new THREE.Vector3(1, 0, 0),
            up: new THREE.Vector3(0, 1, 0),
            distance: 2.45,
          },
        };
        const config = viewConfig[view];
        framedSphere = sphere.clone();
        const target = sphere.center.clone();
        const targetPosition = target.clone().addScaledVector(
          config.direction,
          radius * config.distance,
        );
        const targetUp = config.up.clone().normalize();
        const targetQuaternion = new THREE.Quaternion().setFromRotationMatrix(
          new THREE.Matrix4().lookAt(targetPosition, target, targetUp),
        );
        camera.near = Math.max(0.005, radius / 500);
        camera.far = Math.max(500, radius * 100);
        camera.updateProjectionMatrix();
        controls.minDistance = Math.max(0.02, radius * 0.06);
        controls.maxDistance = radius * 30;
        setActiveView(view);
        cancelCameraMotion();

        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (!animated || reducedMotion || document.hidden) {
          camera.up.copy(targetUp);
          controls.target.copy(target);
          camera.position.copy(targetPosition);
          camera.quaternion.copy(targetQuaternion);
          camera.lookAt(controls.target);
          controls.update();
          renderFrame();
          renderer.domElement.dataset.aiViewState = "completed";
          return;
        }

        const fromEye = camera.position.clone().sub(controls.target);
        const toEye = targetPosition.clone().sub(target);
        const fromDistance = Math.max(0.001, fromEye.length());
        const toDistance = Math.max(0.001, toEye.length());
        const fromDirection = fromEye.multiplyScalar(1 / fromDistance);
        const toDirection = toEye.multiplyScalar(1 / toDistance);
        const angle = fromDirection.angleTo(toDirection);
        const baseDurationMs = 540 + angle / Math.PI * 300;
        const durationMs = Math.min(
          1_800,
          Math.max(420, getScaledMotionDurationMs(baseDurationMs)),
        );
        cameraViewTransition = {
          startedAt: window.performance.now(),
          durationMs,
          fromTarget: controls.target.clone(),
          toTarget: target,
          fromDirection,
          directionRotation: new THREE.Quaternion().setFromUnitVectors(
            fromDirection,
            toDirection,
          ),
          fromDistance,
          toDistance,
          fromUp: camera.up.clone().normalize(),
          toUp: targetUp,
          fromQuaternion: camera.quaternion.clone(),
          toQuaternion: targetQuaternion,
          toPosition: targetPosition,
        };
        renderer.domElement.dataset.aiViewState = "running";
        if (modelKind !== "gaussian") renderer.setAnimationLoop(renderLoop);
      };

      setViewRef.current = (view) => frameSphere(framedSphere, view, true);

      const startOrbit = (options: TwinOrbitOptions) => {
        if (cancelled || navigationLeaving) return;
        cancelCameraMotion();

        const radius = Math.max(framedSphere.radius, 0.5);
        const target = framedSphere.center.clone();
        const verticalAxis = usesRoomOneTopCalibration
          ? new THREE.Vector3(...ROOM_ONE_TOP_DIRECTION).normalize()
          : new THREE.Vector3(0, 1, 0);
        const eye = camera.position.clone().sub(target);
        const startDistance = Math.max(0.001, eye.length());
        const eyeDirection = eye.multiplyScalar(1 / startDistance);
        const verticalComponent = THREE.MathUtils.clamp(
          eyeDirection.dot(verticalAxis),
          -1,
          1,
        );
        const startElevation = Math.asin(verticalComponent);
        let startHorizontal = eyeDirection.clone().addScaledVector(
          verticalAxis,
          -verticalComponent,
        );
        if (startHorizontal.lengthSq() < 1e-6) {
          startHorizontal = camera.up.clone().addScaledVector(
            verticalAxis,
            -camera.up.dot(verticalAxis),
          );
        }
        if (startHorizontal.lengthSq() < 1e-6) {
          startHorizontal = new THREE.Vector3(1, 0, 0).cross(verticalAxis);
        }
        startHorizontal.normalize();

        cameraOrbitTransition = {
          startedAt: window.performance.now(),
          durationMs: options.durationMs,
          target,
          verticalAxis,
          startHorizontal,
          startElevation,
          targetElevation: THREE.MathUtils.degToRad(options.elevationDeg),
          startDistance,
          targetDistance: radius * 2.7,
          revolutions: options.revolutions,
          directionSign: options.direction === "clockwise" ? -1 : 1,
          fallbackUp: camera.up.clone().normalize(),
        };
        setActiveView("perspective");
        renderer.domElement.dataset.aiOrbitState = "running";

        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          cameraOrbitTransition.startedAt -= options.durationMs;
          advanceCameraOrbitTransition(window.performance.now());
          renderFrame();
          return;
        }
        if (modelKind !== "gaussian") renderer.setAnimationLoop(renderLoop);
        renderFrame();
      };

      const activateOrbitControls = () => {
        orbitRef.current = startOrbit;
        const pendingOrbit = pendingOrbitRef.current;
        if (!pendingOrbit) return;
        pendingOrbitRef.current = null;
        window.requestAnimationFrame(() => orbitRef.current?.(pendingOrbit));
      };

      const normalizeAndFrame = (
        object: import("three").Object3D,
        preferredBounds?: import("three").Box3,
      ) => {
        object.updateMatrixWorld(true);
        const sourceBox = preferredBounds ?? new THREE.Box3().setFromObject(object);
        if (sourceBox.isEmpty()) throw new Error("模型中没有可显示的空间数据。");
        const center = sourceBox.getCenter(new THREE.Vector3());
        const sourceRadius = sourceBox.getBoundingSphere(new THREE.Sphere()).radius;
        if (!Number.isFinite(sourceRadius) || sourceRadius <= 0) {
          throw new Error("模型尺寸无效，无法自动取景。");
        }

        const scale = 2 / sourceRadius;
        object.scale.setScalar(scale);
        object.position.copy(center).multiplyScalar(-scale);
        object.updateMatrixWorld(true);
        const normalizedSphere = new THREE.Sphere(new THREE.Vector3(), 2);
        frameSphere(normalizedSphere, "top");
        return () => frameSphere(normalizedSphere, "top", true);
      };

      const getRobustPlyBounds = (geometry: import("three").BufferGeometry) => {
        const position = geometry.getAttribute("position");
        const sampleLimit = 60_000;
        const stride = Math.max(1, Math.floor(position.count / sampleLimit));
        const axes: [number[], number[], number[]] = [[], [], []];
        for (let index = 0; index < position.count; index += stride) {
          axes[0].push(position.getX(index));
          axes[1].push(position.getY(index));
          axes[2].push(position.getZ(index));
        }
        for (const axis of axes) axis.sort((left, right) => left - right);
        const lowIndex = Math.floor(axes[0].length * 0.01);
        const highIndex = Math.min(axes[0].length - 1, Math.ceil(axes[0].length * 0.99));
        const box = new THREE.Box3(
          new THREE.Vector3(axes[0][lowIndex], axes[1][lowIndex], axes[2][lowIndex]),
          new THREE.Vector3(axes[0][highIndex], axes[1][highIndex], axes[2][highIndex]),
        );
        return box.expandByScalar(box.getSize(new THREE.Vector3()).length() * 0.025);
      };

      const applyLayerOpacity = (
        layer: import("three").Object3D,
        opacity: number,
      ) => {
        const nextOpacity = Math.min(1, Math.max(0.05, opacity));
        layer.traverse((object) => {
          const renderable = object as import("three").Mesh | import("three").Points;
          if (!renderable.material) return;
          const materials = Array.isArray(renderable.material)
            ? renderable.material
            : [renderable.material];
          for (const material of materials) {
            material.transparent = nextOpacity < 0.999;
            material.opacity = nextOpacity;
            material.depthWrite = nextOpacity >= 0.999;
            material.needsUpdate = true;
          }
        });
      };

      const applyPrimaryMode = (next: TwinViewportAppearance) => {
        primaryLayer.traverse((object) => {
          const points = object as import("three").Points;
          if (points.isPoints && points.material instanceof THREE.PointsMaterial) {
            points.material.size = next.pointSize;
            points.material.vertexColors = next.displayMode !== "geometry"
              && Boolean(points.geometry.getAttribute("color"));
            points.material.color.set(next.displayMode === "geometry" ? 0xcbd5e1 : 0xffffff);
            points.material.needsUpdate = true;
            return;
          }

          const mesh = object as import("three").Mesh;
          if (!mesh.isMesh) return;
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const material of materials) {
            const surface = material as import("three").MeshStandardMaterial;
            if (!("color" in surface)) continue;
            if (!surface.userData.twinOriginalAppearance) {
              surface.userData.twinOriginalAppearance = {
                color: surface.color.clone(),
                map: surface.map ?? null,
                vertexColors: surface.vertexColors,
              };
            }
            const original = surface.userData.twinOriginalAppearance as {
              color: import("three").Color;
              map: import("three").Texture | null;
              vertexColors: boolean;
            };
            if (next.displayMode === "geometry") {
              surface.color.set(0xcbd5e1);
              surface.map = null;
              surface.vertexColors = false;
            } else {
              surface.color.copy(original.color);
              surface.map = original.map;
              surface.vertexColors = original.vertexColors;
            }
            surface.needsUpdate = true;
          }
        });
      };

      const applyAppearance = (next: TwinViewportAppearance) => {
        scene.background = new THREE.Color(0x000000);
        renderer.toneMapping = next.displayMode === "color"
          ? THREE.NoToneMapping
          : THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = next.displayMode === "enhanced" ? 1.18 : 1;

        primaryLayer.visible = true;
        gapLayer.visible = next.diagnosticActive;
        frameworkLayer.visible = next.diagnosticActive;
        applyPrimaryMode(next);
        applyLayerOpacity(primaryLayer, next.diagnosticActive ? 0.16 : 1);
        applyLayerOpacity(gapLayer, 1);
        applyLayerOpacity(frameworkLayer, 0.9);
        renderFrame();
      };

      applyAppearanceRef.current = applyAppearance;
      applyAppearance(appearanceStateRef.current);

      captureRef.current = () => {
        renderFrame();
        const fileName = `room-01-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
        const dataUrl = renderer.domElement.toDataURL("image/png", 1);
        if (typeof window.XingXunCloud?.saveDataUrl === "function") {
          window.XingXunCloud.saveDataUrl(dataUrl, fileName);
          return;
        }
        const anchor = document.createElement("a");
        anchor.download = fileName;
        anchor.href = dataUrl;
        anchor.click();
      };

      const handleVisibility = () => {
        if (navigationLeaving || document.hidden) {
          renderer.setAnimationLoop(null);
        } else if (modelKind === "gaussian" || controlsInteracting || cameraViewTransition || cameraOrbitTransition) {
          renderer.setAnimationLoop(renderLoop);
        } else {
          renderFrame();
        }
      };

      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
      resize();
      if (modelKind === "gaussian") renderer.setAnimationLoop(renderLoop);
      document.addEventListener("visibilitychange", handleVisibility);

      const disposeControls = () => {
        if (controlsDisposed) return;
        controlsDisposed = true;
        controls.enabled = false;
        controls.removeEventListener("start", beginInteraction);
        controls.removeEventListener("end", endInteraction);
        controls.dispose();
      };

      suspendForNavigation = () => {
        if (canvasHideTimer !== null) return;
        navigationLeaving = true;
        controlsInteracting = false;
        cameraViewTransition = null;
        if (cameraOrbitTransition) renderer.domElement.dataset.aiOrbitState = "cancelled";
        cameraOrbitTransition = null;
        renderer.setAnimationLoop(null);
        sparkSuspend?.();
        resizeObserver?.disconnect();
        terminateWorker?.();
        document.removeEventListener("visibilitychange", handleVisibility);
        disposeControls();
        renderer.domElement.setAttribute("aria-hidden", "true");
        renderer.domElement.classList.add(styles.isCanvasLeaving);
        canvasHideTimer = window.setTimeout(() => {
          renderer.domElement.style.visibility = "hidden";
        }, getScaledMotionDurationMs(82));
      };

      let disposed = false;
      disposeScene = () => {
        if (disposed) return;
        disposed = true;
        terminateWorker?.();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        document.removeEventListener("visibilitychange", handleVisibility);
        renderer.setAnimationLoop(null);
        disposeControls();
        renderer.domElement.remove();
        if (canvasHideTimer !== null) window.clearTimeout(canvasHideTimer);

        const releaseGpuResources = () => {
          const finishRelease = () => {
            scene.clear();
            for (const geometry of ownedGeometries) geometry.dispose();
            for (const material of ownedMaterials) disposeMaterial(material);
            renderer.renderLists.dispose();
            renderer.dispose();
            renderer.forceContextLoss();
          };
          if (sparkCleanup) {
            void sparkCleanup().then(finishRelease, finishRelease);
          } else {
            finishRelease();
          }
        };

        if (navigationLeaving) deferNavigationDisposal(releaseGpuResources);
        else releaseGpuResources();
      };

      if (modelKind === "gaussian") {
        const { SparkRenderer, SplatMesh } = await import("@sparkjsdev/spark");
        if (cancelled || navigationLeaving) return;
        const spark = new SparkRenderer({ renderer });
        scene.add(spark);
        const splatMesh = new SplatMesh({
          stream: file.stream(),
          streamLength: file.size,
          fileName: file.name,
          editable: false,
          raycastable: false,
          lod: false,
          onProgress: (event: ProgressEvent) => {
            if (cancelled || navigationLeaving) return;
            const progress = event.lengthComputable && event.total > 0
              ? Math.min(96, Math.max(4, Math.round((event.loaded / event.total) * 96)))
              : 38;
            updateState({
              phase: "loading",
              progress,
              message: progress < 90 ? "正在读取并解析高斯模型" : "正在上传到显卡",
              elementCount: null,
              modelKind,
              rendererLabel: "Spark 3DGS",
            });
          },
        });
        splatMesh.quaternion.set(1, 0, 0, 0);
        scene.add(splatMesh);

        const fitGaussian = (animated = false) => {
          if (!splatMesh.isInitialized) return;
          splatMesh.updateMatrixWorld(true);
          const box = splatMesh.getBoundingBox(false).applyMatrix4(splatMesh.matrixWorld);
          const sphere = box.getBoundingSphere(new THREE.Sphere());
          if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) sphere.radius = 1;
          frameSphere(sphere, "top", animated);
        };
        fitViewRef.current = () => fitGaussian(true);

        sparkSuspend = () => {
          spark.autoUpdate = false;
          spark.preUpdate = false;
          spark.sortDirty = false;
          spark.lodDirty = false;
          spark.enableDriveLod = false;
          if (spark.sortTimeoutId !== -1) window.clearTimeout(spark.sortTimeoutId);
          if (spark.updateTimeoutId !== -1) window.clearTimeout(spark.updateTimeoutId);
        };

        sparkCleanup = async () => {
          sparkSuspend?.();
          try {
            await splatMesh.initialized;
          } catch {
            // Invalid or interrupted streams are still safe to release.
          }
          while (
            spark.sorting
            || (spark.sortWorker && Object.keys(spark.sortWorker.messages).length > 0)
            || (spark.lodWorker && Object.keys(spark.lodWorker.messages).length > 0)
            || spark.numLodFetchers > 0
            || spark.lodUpdates.length > 0
          ) {
            await new Promise((resolve) => window.setTimeout(resolve, 25));
          }
          splatMesh.dispose();
          spark.dispose();
          spark.geometry.dispose();
          spark.material.dispose();
        };

        await splatMesh.initialized;
        if (cancelled || navigationLeaving) return;
        fitGaussian();
        activateOrbitControls();
        updateState({
          phase: "ready",
          progress: 100,
          message: "高斯模型已在本地浏览器中加载",
          elementCount: splatMesh.numSplats,
          modelKind,
          rendererLabel: "Spark 3DGS",
        });
        return;
      }

      scene.add(new THREE.HemisphereLight(0xffffff, 0x72809a, 1.7));
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
      keyLight.position.set(4, 7, 5);
      scene.add(keyLight);

      if (modelKind === "textured-mesh") {
        updateState({
          phase: "loading",
          progress: 8,
          message: "正在读取 GLB 网格与纹理",
          elementCount: null,
          modelKind,
          rendererLabel: "Three.js GLB",
        });
        await assertSelfContainedGlb(file);
        if (cancelled || navigationLeaving) return;
        const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
        if (cancelled || navigationLeaving) return;
        objectUrl = URL.createObjectURL(file);
        const gltf = await new Promise<Awaited<ReturnType<InstanceType<typeof GLTFLoader>["loadAsync"]>>>(
          (resolve, reject) => {
            new GLTFLoader().load(
              objectUrl!,
              resolve,
              (event) => {
                if (cancelled || navigationLeaving) return;
                const progress = event.lengthComputable && event.total > 0
                  ? Math.min(92, Math.round((event.loaded / event.total) * 84) + 8)
                  : 45;
                updateState({
                  phase: "loading",
                  progress,
                  message: progress < 88 ? "正在读取 GLB 网格与纹理" : "正在创建三维场景",
                  elementCount: null,
                  modelKind,
                  rendererLabel: "Three.js GLB",
                });
              },
              reject,
            );
          },
        );
        if (cancelled || navigationLeaving) {
          disposeObjectTree(gltf.scene);
          return;
        }
        fixOpenMvsBaseColorTextures(
          gltf.scene,
          gltf.parser.json?.asset?.generator,
        );
        primaryLayer.add(gltf.scene);
        let triangleCount = 0;
        gltf.scene.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          ownedGeometries.add(object.geometry);
          const count = object.geometry.index?.count ?? object.geometry.getAttribute("position")?.count ?? 0;
          triangleCount += Math.floor(count / 3);
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) ownedMaterials.add(material);
        });
        fitViewRef.current = normalizeAndFrame(modelRoot);
        activateOrbitControls();
        updateState({
          phase: "ready",
          progress: 100,
          message: "纹理网格已在本地浏览器中加载",
          elementCount: triangleCount,
          modelKind,
          rendererLabel: "Three.js GLB",
        });
        return;
      }

      updateState({
        phase: "loading",
        progress: 4,
        message: modelKind === "point-cloud" ? "正在流式读取彩色点云" : "正在读取 CPU 重建 PLY",
        elementCount: null,
        modelKind,
        rendererLabel: modelKind === "point-cloud" ? POINT_CLOUD_RENDERER_LABEL : "Three.js PLY",
      });
      const parser = parsePlyFile(file, (ratio) => {
        if (cancelled || navigationLeaving) return;
        const progress = Math.min(94, 6 + Math.round(ratio * 88));
        updateState({
          phase: "loading",
          progress,
          message: modelKind === "point-cloud"
            ? "正在后台解析并优化点云"
            : progress < 48 ? "正在读取 CPU 重建 PLY" : "正在后台解析顶点与面片",
          elementCount: null,
          modelKind,
          rendererLabel: modelKind === "point-cloud" ? POINT_CLOUD_RENDERER_LABEL : "Three.js PLY",
        });
      });
      terminateWorker = parser.terminate;
      const parsed = await parser.promise;
      terminateWorker();
      terminateWorker = null;
      if (cancelled || navigationLeaving) return;

      const typedArrayConstructors: Record<string, new (buffer: ArrayBuffer) => import("three").TypedArray> = {
        Float32Array,
        Float64Array,
        Int8Array,
        Uint8Array,
        Uint8ClampedArray,
        Int16Array,
        Uint16Array,
        Int32Array,
        Uint32Array,
      };
      const restoreAttribute = (serialized: SerializedAttribute) => {
        const Constructor = typedArrayConstructors[serialized.arrayType];
        if (!Constructor) throw new Error(`PLY 使用了不支持的数组类型：${serialized.arrayType}`);
        return new THREE.BufferAttribute(
          new Constructor(serialized.buffer),
          serialized.itemSize,
          serialized.normalized,
        );
      };

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", restoreAttribute(parsed.position));
      if (parsed.normal) geometry.setAttribute("normal", restoreAttribute(parsed.normal));
      if (parsed.color) geometry.setAttribute("color", restoreAttribute(parsed.color));
      if (parsed.index) geometry.setIndex(restoreAttribute(parsed.index));
      ownedGeometries.add(geometry);

      let renderedObject: import("three").Object3D;
      let preferredBounds: import("three").Box3 | undefined;
      if (modelKind === "mesh") {
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({
          color: parsed.color ? 0xffffff : 0xdce6f3,
          vertexColors: Boolean(parsed.color),
          roughness: 0.9,
          metalness: 0,
          side: THREE.DoubleSide,
        });
        ownedMaterials.add(material);
        renderedObject = new THREE.Mesh(geometry, material);
      } else {
        const material = new THREE.PointsMaterial({
          color: parsed.color ? 0xffffff : 0x5f83bd,
          vertexColors: Boolean(parsed.color),
          size: 0.012,
          sizeAttenuation: true,
        });
        ownedMaterials.add(material);
        renderedObject = new THREE.Points(geometry, material);
        renderedObject.frustumCulled = false;
        geometry.setDrawRange(0, parsed.vertexCount);
        renderer.domElement.dataset.pointFullCount = String(parsed.vertexCount);
        renderer.domElement.dataset.pointDrawCount = String(parsed.vertexCount);
        preferredBounds = getRobustPlyBounds(geometry);
      }
      primaryLayer.add(renderedObject);

      fitViewRef.current = normalizeAndFrame(modelRoot, preferredBounds);

      const layerWarnings: string[] = [];
      const loadAuxiliaryPointLayer = async (
        auxiliaryFile: File,
        layer: import("three").Group,
        color: number,
        label: string,
      ) => {
        if (!auxiliaryFile.name.toLowerCase().endsWith(".ply")) {
          throw new Error(`${label}必须使用 PLY 格式。`);
        }
        assertLocalModelFileSize(auxiliaryFile.size);
        const auxiliaryParser = parsePlyFile(auxiliaryFile);
        terminateWorker = auxiliaryParser.terminate;
        const auxiliary = await auxiliaryParser.promise;
        auxiliaryParser.terminate();
        terminateWorker = null;
        if (cancelled || navigationLeaving) return;

        const layerGeometry = new THREE.BufferGeometry();
        layerGeometry.setAttribute("position", restoreAttribute(auxiliary.position));
        layerGeometry.setDrawRange(0, auxiliary.vertexCount);
        ownedGeometries.add(layerGeometry);
        const layerMaterial = new THREE.PointsMaterial({
          color,
          size: label === "缺口诊断层" ? 0.015 : 0.013,
          sizeAttenuation: true,
          transparent: true,
          depthWrite: false,
        });
        ownedMaterials.add(layerMaterial);
        const points = new THREE.Points(layerGeometry, layerMaterial);
        points.name = label;
        points.frustumCulled = false;
        layer.add(points);
      };

      for (const auxiliary of [
        { file: gapFile, layer: gapLayer, color: 0xff6a3d, label: "缺口诊断层" },
        { file: frameworkFile, layer: frameworkLayer, color: 0x40cfff, label: "房间框架层" },
      ]) {
        if (!auxiliary.file) continue;
        updateState({
          phase: "loading",
          progress: 96,
          message: `正在装配${auxiliary.label}`,
          elementCount: parsed.vertexCount,
          modelKind,
          rendererLabel: POINT_CLOUD_RENDERER_LABEL,
        });
        try {
          await loadAuxiliaryPointLayer(
            auxiliary.file,
            auxiliary.layer,
            auxiliary.color,
            auxiliary.label,
          );
        } catch (error: unknown) {
          layerWarnings.push(
            `${auxiliary.label}：${error instanceof Error ? error.message : "读取失败"}`,
          );
        }
      }

      applyAppearance(appearanceStateRef.current);
      renderFrame();
      activateOrbitControls();
      updateState({
        phase: "ready",
        progress: 100,
        message: modelKind === "mesh"
          ? "CPU 重建网格已加载"
          : parsed.optimizedPointCloud
            ? "完整彩色点云已按原生分辨率加载"
            : "CPU 重建彩色点云已按原生分辨率加载",
        elementCount: modelKind === "mesh" ? parsed.faceCount : parsed.vertexCount,
        modelKind,
        rendererLabel: modelKind === "point-cloud" ? POINT_CLOUD_RENDERER_LABEL : "Three.js PLY",
        layerWarnings,
      });
    };

    void initialize().catch((error: unknown) => {
      if (cancelled || navigationLeaving) return;
      resizeObserver?.disconnect();
      const cleanup = disposeScene;
      disposeScene = null;
      cleanup?.();
      host.replaceChildren();
      updateState({
        phase: "error",
        progress: 0,
        message: error instanceof Error ? error.message : "模型加载失败",
        elementCount: null,
        modelKind: null,
        rendererLabel: null,
      });
    });

    return () => {
      cancelled = true;
      window.removeEventListener(DIGITAL_TWIN_NAVIGATION_START, handleNavigationStart);
      fitViewRef.current = null;
      setViewRef.current = null;
      orbitRef.current = null;
      pendingOrbitRef.current = null;
      captureRef.current = null;
      applyAppearanceRef.current = null;
      resizeObserver?.disconnect();
      terminateWorker?.();
      disposeScene?.();
      host.replaceChildren();
    };
  }, [file, frameworkFile, gapFile, updateState]);

  const enterFullscreen = async () => {
    const shell = shellRef.current;
    if (!shell) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await shell.requestFullscreen();
  };

  const viewportControlsReady = viewerState.phase === "ready";

  return (
    <div ref={shellRef} className={styles.viewportShell}>
      <div ref={hostRef} className={styles.viewportHost} />

      {!file && (
        <div className={styles.viewportEmpty}>
          <span className={styles.emptyIcon} aria-hidden="true"><Rotate3D size={30} /></span>
          <strong>载入你的室内扫描模型</strong>
          <button type="button" onClick={onChooseFile}>选择三维模型</button>
        </div>
      )}

      {viewerState.phase === "loading" && (
        <div className={styles.loadingOverlay} role="status" aria-live="polite">
          <LoaderCircle className={styles.spinner} size={24} aria-hidden="true" />
          <div><strong>{viewerState.message}</strong><span>{viewerState.progress}%</span></div>
          <div className={styles.progressTrack}><i style={{ width: `${viewerState.progress}%` }} /></div>
        </div>
      )}

      {viewerState.phase === "error" && (
        <div className={styles.viewerError} role="alert">
          <TriangleAlert size={23} aria-hidden="true" />
          <div><strong>无法打开这个模型</strong><p>{viewerState.message}</p></div>
          <button type="button" onClick={onChooseFile}>重新选择</button>
        </div>
      )}

      <div
        className={`${styles.viewportToolbar} ${viewportControlsReady ? "" : styles.isViewportChromePending}`}
        aria-label="三维视口工具"
        aria-hidden={!viewportControlsReady}
      >
        <div className={styles.viewPresetGroup} aria-label="标准视角">
          {([
            ["perspective", "3D", "透视视角"],
            ["top", "TOP", "俯视视角"],
            ["front", "FR", "前视视角"],
            ["left", "L", "左视视角"],
            ["right", "R", "右视视角"],
          ] as const).map(([view, shortLabel, label]) => (
            <button
              key={view}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={activeView === view}
              className={activeView === view ? styles.isActive : undefined}
              disabled={!viewportControlsReady}
              onClick={() => setViewRef.current?.(view)}
            >
              {shortLabel}
            </button>
          ))}
        </div>
        <div className={styles.viewActionGroup}>
          <button type="button" title="复位俯视视角" aria-label="复位三维模型俯视视角" disabled={!viewportControlsReady} onClick={() => fitViewRef.current?.()}>
            <RotateCcw size={18} />
          </button>
          <button type="button" title="保存当前画面" aria-label="保存当前三维画面" disabled={!viewportControlsReady} onClick={() => captureRef.current?.()}>
            <Camera size={18} />
          </button>
          <button type="button" title="切换全屏" aria-label="切换三维模型全屏" disabled={!viewportControlsReady} onClick={() => void enterFullscreen()}>
            <Expand size={18} />
          </button>
        </div>
      </div>
      <div
        className={`${styles.viewportAxis} ${viewportControlsReady ? "" : styles.isViewportChromePending}`}
        aria-hidden="true"
      >
        <Move3D size={16} />
        <span><i />X</span><span><i />Y</span><span><i />Z</span>
      </div>
    </div>
  );
}
