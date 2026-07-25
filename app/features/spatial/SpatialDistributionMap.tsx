"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import type { TelemetrySlot, TelemetrySlotId } from "@/app/lib/iot/contracts";
import {
  ROOM_ONE_NAVIGATION_MAP_ASSETS,
  ROOM_ONE_NAVIGATION_MAP_VIEW,
} from "@/app/lib/digital-twin/room-one-coordinate-system";
import type { HeatCell, HeatSample } from "@/app/lib/spatial/interpolation";
import {
  buildSpatialHeatGrid,
  heatSamplesForLayer,
  interpolateSpatialValueAt,
  representativeHeatSamples,
} from "@/app/lib/spatial/interpolation";
import { SLOT_COLORS, SLOT_ICONS } from "@/app/features/pages/PagePrimitives";
import { useSpatialMapping } from "./SpatialMappingContext";
import styles from "./SpatialDistributionMap.module.css";

const GRID_COLUMNS = 34;
const GRID_ROWS = 48;
const INFLUENCE_RADIUS = 0.22;
const MAX_INTERPOLATION_SAMPLES = 480;
const MAX_RENDERED_SAMPLE_POINTS = 320;
const MAP_CONTENT_BOUNDS = ROOM_ONE_NAVIGATION_MAP_VIEW.contentBounds;
const MAP_CONTENT_WIDTH = ROOM_ONE_NAVIGATION_MAP_VIEW.width * MAP_CONTENT_BOUNDS.width;
const MAP_CONTENT_HEIGHT = ROOM_ONE_NAVIGATION_MAP_VIEW.height * MAP_CONTENT_BOUNDS.height;
const MAP_IMAGE_STYLE = {
  width: `${100 / MAP_CONTENT_BOUNDS.width}%`,
  height: `${100 / MAP_CONTENT_BOUNDS.height}%`,
  left: `${-MAP_CONTENT_BOUNDS.left / MAP_CONTENT_BOUNDS.width * 100}%`,
  top: `${-MAP_CONTENT_BOUNDS.top / MAP_CONTENT_BOUNDS.height * 100}%`,
} as CSSProperties;

const PALETTES: Record<TelemetrySlotId, readonly [string, string, string]> = {
  "slot-1": ["#3b82f6", "#f6c453", "#ef6a3a"],
  "slot-2": ["#dff7f6", "#42c7c9", "#1977c9"],
  "slot-3": ["#dcfce7", "#4fc48b", "#2367b1"],
  "slot-4": ["#ede9fe", "#a978df", "#5940a8"],
  "slot-5": ["#fce7f3", "#dc76a0", "#9f3f74"],
  "slot-6": ["#475569", "#f1c75b", "#fff2a8"],
};

function finiteMapPoint(point: { x: number; y: number }) {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function convexHull(samples: readonly HeatSample[]) {
  const points = samples
    .filter(finiteMapPoint)
    .map(({ x, y }) => ({ x, y }))
    .sort((left, right) => left.x - right.x || left.y - right.y);
  const unique = points.filter((point, index) => (
    index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y
  ));
  if (unique.length < 3) return unique;
  const cross = (origin: typeof unique[number], left: typeof unique[number], right: typeof unique[number]) => (
    (left.x - origin.x) * (right.y - origin.y)
    - (left.y - origin.y) * (right.x - origin.x)
  );
  const lower: typeof unique = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: typeof unique = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function insideConvexPolygon(point: { x: number; y: number }, polygon: readonly { x: number; y: number }[]) {
  if (polygon.length < 3) return false;
  let direction = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const left = polygon[index];
    const right = polygon[(index + 1) % polygon.length];
    const cross = (right.x - left.x) * (point.y - left.y) - (right.y - left.y) * (point.x - left.x);
    if (Math.abs(cross) < 1e-8) continue;
    const nextDirection = Math.sign(cross);
    if (direction !== 0 && nextDirection !== direction) return false;
    direction = nextDirection;
  }
  return true;
}

function supportedCells(cells: readonly HeatCell[], samples: readonly HeatSample[], hull: readonly { x: number; y: number }[]) {
  const influenceRadiusSquared = INFLUENCE_RADIUS * INFLUENCE_RADIUS;
  return cells.filter((cell) => {
    if (!insideConvexPolygon(cell, hull)) return false;
    let nearby = 0;
    for (const sample of samples) {
      const deltaX = sample.x - cell.x;
      const deltaY = sample.y - cell.y;
      if (deltaX * deltaX + deltaY * deltaY <= influenceRadiusSquared) nearby += 1;
      if (nearby >= 3) return true;
    }
    return false;
  });
}

function parseHex(color: string) {
  const value = color.replace("#", "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function heatColor(palette: readonly [string, string, string], ratio: number, alpha: number) {
  const normalized = Math.min(1, Math.max(0, ratio)) * 2;
  const segment = Math.min(1, Math.floor(normalized));
  const amount = normalized - segment;
  const from = parseHex(palette[segment]);
  const to = parseHex(palette[segment + 1]);
  const channel = (left: number, right: number) => Math.round(left + (right - left) * amount);
  return `rgba(${channel(from.r, to.r)}, ${channel(from.g, to.g)}, ${channel(from.b, to.b)}, ${alpha.toFixed(3)})`;
}

function formatValue(value: number, unit: string, precision: number) {
  return `${value.toFixed(precision)}${unit}`;
}

export function SpatialDistributionMap({ slot }: { slot: TelemetrySlot }) {
  const { observations } = useSpatialMapping();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const palette = PALETTES[slot.slotId];
  const samples = useMemo(
    () => heatSamplesForLayer(observations, slot.slotId).filter((sample) => (
      sample.x >= 0 && sample.x <= 1 && sample.y >= 0 && sample.y <= 1
    )),
    [observations, slot.slotId],
  );
  const interpolationSamples = useMemo(
    () => representativeHeatSamples(samples, MAX_INTERPOLATION_SAMPLES),
    [samples],
  );
  const renderedSamples = useMemo(
    () => representativeHeatSamples(samples, MAX_RENDERED_SAMPLE_POINTS),
    [samples],
  );
  const grid = useMemo(
    () => buildSpatialHeatGrid(interpolationSamples, GRID_COLUMNS, GRID_ROWS, INFLUENCE_RADIUS),
    [interpolationSamples],
  );
  const hull = useMemo(() => convexHull(interpolationSamples), [interpolationSamples]);
  const drawableCells = useMemo(
    () => grid.interpolated ? supportedCells(grid.cells, interpolationSamples, hull) : [],
    [grid, hull, interpolationSamples],
  );
  const unit = observations.find((observation) => observation.values[slot.slotId])
    ?.values[slot.slotId]?.unit ?? slot.unit;
  const [probe, setProbe] = useState<{
    x: number;
    y: number;
    value: number | null;
    confidence: number;
  } | null>(null);

  const inspectPoint = useCallback((x: number, y: number) => {
    const insideSampleArea = insideConvexPolygon({ x, y }, hull);
    const interpolation = insideSampleArea
      ? interpolateSpatialValueAt(interpolationSamples, x, y, INFLUENCE_RADIUS)
      : null;
    setProbe({
      x,
      y,
      value: interpolation ? Math.max(grid.min ?? interpolation.value, Math.min(grid.max ?? interpolation.value, interpolation.value)) : null,
      confidence: interpolation?.confidence ?? 0,
    });
  }, [grid.max, grid.min, hull, interpolationSamples]);

  const inspectFromPointer = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    inspectPoint(
      Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    );
  }, [inspectPoint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = frameRef.current;
    if (!canvas || !host) return;
    const maskImage = new Image();
    maskImage.decoding = "async";
    const draw = () => {
      const bounds = host.getBoundingClientRect();
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      if (drawableCells.length === 0 || grid.min === null || grid.max === null) return;
      const span = grid.max - grid.min;
      const cellWidth = width / GRID_COLUMNS;
      const cellHeight = height / GRID_ROWS;
      for (const cell of drawableCells) {
        const ratio = span === 0 ? 0.5 : (cell.value - grid.min) / span;
        context.fillStyle = heatColor(palette, ratio, Math.min(0.72, cell.alpha));
        context.fillRect(
          cell.x * width - cellWidth * 0.55,
          cell.y * height - cellHeight * 0.55,
          cellWidth * 1.1,
          cellHeight * 1.1,
        );
      }
      if (maskImage.complete && maskImage.naturalWidth > 0) {
        context.globalCompositeOperation = "destination-in";
        context.drawImage(
          maskImage,
          MAP_CONTENT_BOUNDS.left * maskImage.naturalWidth,
          MAP_CONTENT_BOUNDS.top * maskImage.naturalHeight,
          MAP_CONTENT_BOUNDS.width * maskImage.naturalWidth,
          MAP_CONTENT_BOUNDS.height * maskImage.naturalHeight,
          0,
          0,
          width,
          height,
        );
        context.globalCompositeOperation = "source-over";
      }
    };
    maskImage.addEventListener("load", draw);
    maskImage.src = ROOM_ONE_NAVIGATION_MAP_ASSETS.mask;
    draw();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(draw);
    observer?.observe(host);
    if (!observer) window.addEventListener("resize", draw);
    return () => {
      maskImage.removeEventListener("load", draw);
      observer?.disconnect();
      window.removeEventListener("resize", draw);
    };
  }, [drawableCells, grid.max, grid.min, palette]);

  const hasSurface = drawableCells.length > 0;
  const summary = samples.length === 0
    ? "暂无空间采样"
    : hasSurface
      ? `${samples.length} 个位置样本`
      : `${samples.length} 个样本，继续巡检后形成分布面`;

  return (
    <div className={styles.root} aria-label={`${slot.label}空间分布图`}>
      <div
        ref={frameRef}
        className={styles.mapFrame}
        style={{ aspectRatio: `${MAP_CONTENT_WIDTH} / ${MAP_CONTENT_HEIGHT}`, "--metric-color": SLOT_COLORS[slot.slotId] } as CSSProperties}
        role="button"
        tabIndex={0}
        aria-label={`点击地图查询${slot.label}位置读数`}
        onClick={inspectFromPointer}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          inspectPoint(0.5, 0.5);
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.mapImage} style={MAP_IMAGE_STYLE} src={ROOM_ONE_NAVIGATION_MAP_ASSETS.image} alt="房间实景正俯视空间图" draggable={false} />
        <canvas ref={canvasRef} className={styles.heatCanvas} aria-hidden="true" />
        <svg className={styles.overlay} viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
          {renderedSamples.map((sample) => (
            <circle key={sample.id} className={styles.samplePoint} cx={sample.x * 1000} cy={sample.y * 1000} r="7">
              <title>{`${slot.label} ${formatValue(sample.value, unit, slot.precision)}`}</title>
            </circle>
          ))}
        </svg>
        {probe && (
          <div className={styles.probeLayer} aria-live="polite">
            <i className={styles.probeMarker} style={{ left: `${probe.x * 100}%`, top: `${probe.y * 100}%` }} aria-hidden="true" />
            <output
              className={styles.probeValue}
              style={{
                left: `${Math.min(0.82, Math.max(0.18, probe.x)) * 100}%`,
                top: `${Math.min(0.88, Math.max(0.18, probe.y)) * 100}%`,
              }}
            >
              <strong>{probe.value === null ? "此处样本不足" : formatValue(probe.value, unit, slot.precision)}</strong>
              <span>{probe.value === null ? "请让小车靠近该区域采样" : `位置估算 · 可信度 ${Math.round(probe.confidence * 100)}%`}</span>
            </output>
          </div>
        )}
        {!hasSurface && <div className={styles.emptyState}>{summary}</div>}
      </div>
      <footer className={styles.footer}>
        <span>{summary} · 点击地图查看位置读数</span>
        {grid.min !== null && grid.max !== null && (
          <div className={styles.legend} aria-label={`${slot.label}范围 ${grid.min} 至 ${grid.max}`}>
            <span>{formatValue(grid.min, unit, slot.precision)}</span>
            <i style={{ background: `linear-gradient(90deg, ${palette.join(", ")})` }} aria-hidden="true" />
            <span>{formatValue(grid.max, unit, slot.precision)}</span>
          </div>
        )}
      </footer>
    </div>
  );
}

function SpatialDistributionMapPlaceholder({ slot }: { slot: TelemetrySlot }) {
  return (
    <div className={`${styles.root} ${styles.placeholderRoot}`} aria-busy="true" aria-label={`正在准备${slot.label}空间分布图`}>
      <div
        className={styles.mapFrame}
        style={{ aspectRatio: `${MAP_CONTENT_WIDTH} / ${MAP_CONTENT_HEIGHT}` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.mapImage} style={MAP_IMAGE_STYLE} src={ROOM_ONE_NAVIGATION_MAP_ASSETS.image} alt="" draggable={false} />
        <div className={styles.placeholderBadge}>正在准备分布图</div>
      </div>
      <footer className={styles.footer}>
        <span>正在载入{slot.label}位置样本</span>
      </footer>
    </div>
  );
}

export function SpatialDistributionPanel({
  slots,
  selectedSlotId,
  onViewTrend,
}: {
  slots: readonly TelemetrySlot[];
  selectedSlotId: TelemetrySlotId;
  onViewTrend: (slotId: TelemetrySlotId) => void;
}) {
  const renderOrder = useMemo(
    () => [
      selectedSlotId,
      ...slots.map((slot) => slot.slotId).filter((slotId) => slotId !== selectedSlotId),
    ],
    [selectedSlotId, slots],
  );
  const [readySlotIds, setReadySlotIds] = useState<Set<TelemetrySlotId>>(
    () => new Set([selectedSlotId]),
  );
  const visibleReadySlotIds = useMemo(() => {
    if (readySlotIds.has(selectedSlotId)) return readySlotIds;
    return new Set([...readySlotIds, selectedSlotId]);
  }, [readySlotIds, selectedSlotId]);

  useEffect(() => {
    const nextSlotId = renderOrder.find((slotId) => !visibleReadySlotIds.has(slotId));
    if (!nextSlotId) return;
    let timer: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        setReadySlotIds((current) => {
          if (current.has(nextSlotId)) return current;
          const next = new Set(current);
          next.add(nextSlotId);
          return next;
        });
      }, 24);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [renderOrder, visibleReadySlotIds]);

  if (slots.length === 0) return null;
  return (
    <section className={styles.panel} data-ai-region="spatial-distribution" aria-labelledby="spatial-distribution-title">
      <header className={styles.header}>
        <h2 id="spatial-distribution-title">空间数据分布</h2>
      </header>
      <div className={styles.mapGrid} role="list" aria-label="六路空间数据分布图">
        {slots.map((slot) => {
            const Icon = SLOT_ICONS[slot.slotId];
            return (
              <article
                key={slot.slotId}
                role="listitem"
                className={styles.metricCard}
                data-selected={slot.slotId === selectedSlotId}
                style={{ "--metric-color": SLOT_COLORS[slot.slotId] } as CSSProperties}
              >
                <button
                  type="button"
                  className={styles.metricCardHeader}
                  aria-pressed={slot.slotId === selectedSlotId}
                  onClick={() => onViewTrend(slot.slotId)}
                >
                  <span><Icon size={16} aria-hidden="true" />{slot.label}</span>
                  <span>查看趋势</span>
                </button>
                {visibleReadySlotIds.has(slot.slotId)
                  ? <SpatialDistributionMap slot={slot} />
                  : <SpatialDistributionMapPlaceholder slot={slot} />}
              </article>
            );
          })}
      </div>
    </section>
  );
}
