"use client";

import { useEffect, useRef } from "react";
import type {
  BufferGeometry,
  Group,
  LineBasicMaterial,
  MeshBasicMaterial,
  PerspectiveCamera,
  PointsMaterial,
  Scene,
  WebGLRenderer,
} from "three";

export function LoginSpatialField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const interactionRoot = canvas.parentElement?.parentElement;

    let disposed = false;
    let animationFrame = 0;
    let renderer: WebGLRenderer | null = null;
    let scene: Scene | null = null;
    let camera: PerspectiveCamera | null = null;
    let sceneGroup: Group | null = null;
    let particleGeometry: BufferGeometry | null = null;
    let particleMaterial: PointsMaterial | null = null;
    const geometries: BufferGeometry[] = [];
    const materials: Array<MeshBasicMaterial | LineBasicMaterial> = [];
    const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointer.targetX = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      pointer.targetY = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    };

    const onPointerLeave = () => {
      pointer.targetX = 0;
      pointer.targetY = 0;
    };

    const resizeObserver = new ResizeObserver(() => {
      if (!renderer || !camera) return;
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      renderer.setSize(width, height, false);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5));
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });

    void import("three").then((THREE) => {
      if (disposed) return;

      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5));

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
      camera.position.set(0, 0.15, 7.4);

      sceneGroup = new THREE.Group();
      sceneGroup.rotation.x = -0.08;
      scene.add(sceneGroup);

      const particleCount = 920;
      const positions = new Float32Array(particleCount * 3);
      for (let index = 0; index < particleCount; index += 1) {
        const radius = 1.3 + Math.pow(Math.random(), 0.56) * 5.3;
        const angle = Math.random() * Math.PI * 2;
        positions[index * 3] = Math.cos(angle) * radius;
        positions[index * 3 + 1] = Math.sin(angle) * radius * 0.56;
        positions[index * 3 + 2] = -1.5 - Math.random() * 4.8;
      }
      particleGeometry = new THREE.BufferGeometry();
      particleGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      particleMaterial = new THREE.PointsMaterial({
        color: 0x4f8fff,
        size: 0.022,
        transparent: true,
        opacity: 0.54,
        depthWrite: false,
      });
      sceneGroup.add(new THREE.Points(particleGeometry, particleMaterial));

      const ringBlueprints = [
        { radius: 2.15, tube: 0.006, color: 0x397cf1, opacity: 0.38, rx: 1.2, ry: 0.15 },
        { radius: 2.75, tube: 0.004, color: 0x18b7be, opacity: 0.24, rx: 1.0, ry: -0.2 },
        { radius: 3.35, tube: 0.003, color: 0x397cf1, opacity: 0.16, rx: 1.34, ry: 0.3 },
      ];

      ringBlueprints.forEach((blueprint, index) => {
        const geometry = new THREE.TorusGeometry(blueprint.radius, blueprint.tube, 5, 180);
        const material = new THREE.MeshBasicMaterial({
          color: blueprint.color,
          transparent: true,
          opacity: blueprint.opacity,
          depthWrite: false,
        });
        const ring = new THREE.Mesh(geometry, material);
        ring.rotation.set(blueprint.rx, blueprint.ry, index * 0.38);
        ring.position.z = -2.6 - index * 0.22;
        geometries.push(geometry);
        materials.push(material);
        sceneGroup?.add(ring);
      });

      const polyGeometry = new THREE.IcosahedronGeometry(1.02, 1);
      const polyMaterial = new THREE.MeshBasicMaterial({
        color: 0x4a83eb,
        wireframe: true,
        transparent: true,
        opacity: 0.1,
        depthWrite: false,
      });
      const poly = new THREE.Mesh(polyGeometry, polyMaterial);
      poly.position.set(2.45, 0.55, -3.6);
      geometries.push(polyGeometry);
      materials.push(polyMaterial);
      sceneGroup.add(poly);

      const secondaryGeometry = new THREE.OctahedronGeometry(0.62, 1);
      const secondaryMaterial = new THREE.MeshBasicMaterial({
        color: 0x10aeb6,
        wireframe: true,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      });
      const secondaryPoly = new THREE.Mesh(secondaryGeometry, secondaryMaterial);
      secondaryPoly.position.set(-2.85, -0.68, -3.2);
      geometries.push(secondaryGeometry);
      materials.push(secondaryMaterial);
      sceneGroup.add(secondaryPoly);

      const start = performance.now();
      const animate = (now: number) => {
        if (disposed || !renderer || !scene || !camera || !sceneGroup) return;
        const seconds = (now - start) / 1_000;
        pointer.x += (pointer.targetX - pointer.x) * 0.045;
        pointer.y += (pointer.targetY - pointer.y) * 0.045;
        sceneGroup.rotation.y = seconds * 0.035 + pointer.x * 0.075;
        sceneGroup.rotation.x = -0.08 + pointer.y * 0.05;
        poly.rotation.x = seconds * 0.13;
        poly.rotation.y = seconds * 0.18;
        secondaryPoly.rotation.x = -seconds * 0.16;
        secondaryPoly.rotation.z = seconds * 0.12;
        camera.position.x = pointer.x * 0.12;
        camera.position.y = 0.15 - pointer.y * 0.08;
        camera.lookAt(0, 0, -1.9);
        renderer.render(scene, camera);
        animationFrame = window.requestAnimationFrame(animate);
      };

      resizeObserver.observe(canvas);
      interactionRoot?.addEventListener("pointermove", onPointerMove, { passive: true });
      interactionRoot?.addEventListener("pointerleave", onPointerLeave);
      animationFrame = window.requestAnimationFrame(animate);
    }).catch(() => {
      // The CSS scene remains complete if WebGL is unavailable.
    });

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      interactionRoot?.removeEventListener("pointermove", onPointerMove);
      interactionRoot?.removeEventListener("pointerleave", onPointerLeave);
      particleGeometry?.dispose();
      particleMaterial?.dispose();
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      renderer?.dispose();
      renderer = null;
      scene = null;
      camera = null;
      sceneGroup = null;
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" />;
}
