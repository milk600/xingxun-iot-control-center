import type { SpatialObservation } from "./contracts";
import type { TelemetrySlotId } from "@/app/lib/iot/contracts";

export interface HeatSample {
  id: string;
  x: number;
  y: number;
  value: number;
  observedAt: string;
}

export interface HeatCell {
  x: number;
  y: number;
  value: number;
  alpha: number;
  support: number;
}

export interface SpatialInterpolationResult {
  value: number;
  nearestDistance: number;
  support: number;
  confidence: number;
}

const MAX_GRID_INTERPOLATION_SAMPLES = 480;

export function heatSamplesForLayer(
  observations: readonly SpatialObservation[],
  slotId: TelemetrySlotId,
): HeatSample[] {
  return observations.flatMap((observation) => {
    const reading = observation.values[slotId];
    return reading && Number.isFinite(reading.value)
      ? [{
          id: observation.id,
          x: observation.x,
          y: observation.y,
          value: reading.value,
          observedAt: observation.observedAt,
        }]
      : [];
  });
}

function nonCollinear(samples: readonly HeatSample[]) {
  if (samples.length < 3) return false;
  const first = samples[0];
  const second = samples.find((sample, index) => (
    index > 0
    && Math.hypot(sample.x - first.x, sample.y - first.y) > 0.0001
  ));
  if (!second) return false;
  for (const sample of samples) {
    const area = (second.x - first.x) * (sample.y - first.y)
      - (second.y - first.y) * (sample.x - first.x);
    if (Math.abs(area) > 0.0004) return true;
  }
  return false;
}

export function representativeHeatSamples(
  samples: readonly HeatSample[],
  maximum = MAX_GRID_INTERPOLATION_SAMPLES,
) {
  const limit = Math.max(3, Math.floor(maximum));
  if (samples.length <= limit) return [...samples];

  const selectedIndices = new Set<number>([0, samples.length - 1]);
  const extrema = [
    (sample: HeatSample) => sample.x,
    (sample: HeatSample) => -sample.x,
    (sample: HeatSample) => sample.y,
    (sample: HeatSample) => -sample.y,
    (sample: HeatSample) => sample.value,
    (sample: HeatSample) => -sample.value,
  ];
  for (const score of extrema) {
    let bestIndex = 0;
    let bestScore = score(samples[0]);
    for (let index = 1; index < samples.length; index += 1) {
      const nextScore = score(samples[index]);
      if (nextScore <= bestScore) continue;
      bestScore = nextScore;
      bestIndex = index;
    }
    selectedIndices.add(bestIndex);
  }
  for (let step = 0; selectedIndices.size < limit && step < limit * 2; step += 1) {
    selectedIndices.add(Math.round(step * (samples.length - 1) / Math.max(1, limit - 1)));
  }
  return [...selectedIndices]
    .sort((left, right) => left - right)
    .slice(0, limit)
    .map((index) => samples[index]);
}

function interpolatePreparedSpatialValueAt(
  finite: readonly HeatSample[],
  x: number,
  y: number,
  influenceRadius: number,
): SpatialInterpolationResult | null {
  const nearest: Array<{ sample: HeatSample; distanceSquared: number }> = [];
  for (const sample of finite) {
    const deltaX = sample.x - x;
    const deltaY = sample.y - y;
    const distanceSquared = deltaX * deltaX + deltaY * deltaY;
    if (nearest.length === 6 && distanceSquared >= nearest[5].distanceSquared) continue;
    let insertAt = nearest.length;
    while (insertAt > 0 && nearest[insertAt - 1].distanceSquared > distanceSquared) insertAt -= 1;
    nearest.splice(insertAt, 0, { sample, distanceSquared });
    if (nearest.length > 6) nearest.pop();
  }
  const radiusSquared = influenceRadius * influenceRadius;
  if (nearest.length < 3 || nearest[0].distanceSquared > radiusSquared) return null;
  let weighted = 0;
  let weightSum = 0;
  for (const { sample, distanceSquared } of nearest) {
    const weight = 1 / (distanceSquared + 0.0004);
    weighted += sample.value * weight;
    weightSum += weight;
  }
  const nearestDistance = Math.sqrt(nearest[0].distanceSquared);
  return {
    value: weighted / weightSum,
    nearestDistance,
    support: nearest.length,
    confidence: Math.max(0, 1 - nearestDistance / influenceRadius),
  };
}

export function interpolateSpatialValueAt(
  samples: readonly HeatSample[],
  x: number,
  y: number,
  influenceRadius = 0.2,
): SpatialInterpolationResult | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  const finite = samples.filter((sample) => (
    Number.isFinite(sample.x)
    && Number.isFinite(sample.y)
    && Number.isFinite(sample.value)
    && sample.x >= 0 && sample.x <= 1
    && sample.y >= 0 && sample.y <= 1
  ));
  if (!nonCollinear(finite)) return null;
  return interpolatePreparedSpatialValueAt(finite, x, y, influenceRadius);
}

export function buildSpatialHeatGrid(
  samples: readonly HeatSample[],
  columns = 64,
  rows = 80,
  influenceRadius = 0.2,
): { cells: HeatCell[]; interpolated: boolean; min: number | null; max: number | null } {
  const finite = samples.filter((sample) => (
    Number.isFinite(sample.x)
    && Number.isFinite(sample.y)
    && Number.isFinite(sample.value)
    && sample.x >= 0 && sample.x <= 1
    && sample.y >= 0 && sample.y <= 1
  ));
  if (finite.length === 0) return { cells: [], interpolated: false, min: null, max: null };
  const values = finite.map((sample) => sample.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!nonCollinear(finite)) return { cells: [], interpolated: false, min, max };
  const interpolationSamples = representativeHeatSamples(
    finite,
    MAX_GRID_INTERPOLATION_SAMPLES,
  );

  const cells: HeatCell[] = [];
  for (let row = 0; row < rows; row += 1) {
    const y = (row + 0.5) / rows;
    for (let column = 0; column < columns; column += 1) {
      const x = (column + 0.5) / columns;
      const interpolation = interpolatePreparedSpatialValueAt(
        interpolationSamples,
        x,
        y,
        influenceRadius,
      );
      if (!interpolation) continue;
      cells.push({
        x,
        y,
        value: Math.max(min, Math.min(max, interpolation.value)),
        alpha: 0.18 + interpolation.confidence * 0.62,
        support: interpolation.support,
      });
    }
  }
  return { cells, interpolated: true, min, max };
}
