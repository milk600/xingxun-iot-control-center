import type {
  DashboardSnapshot,
  VehicleCommandAck,
  VehicleCommandRequest,
} from "./contracts";

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("xingxun:auth-expired"));
    }
    throw new Error(payload.error ?? `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function getDashboardSnapshot(signal?: AbortSignal) {
  const response = await fetch("/api/iot/snapshot", {
    signal,
    cache: "no-store",
  });
  return readJson<DashboardSnapshot>(response);
}

export async function postVehicleCommand(
  input: VehicleCommandRequest,
  signal?: AbortSignal,
) {
  const response = await fetch("/api/iot/vehicle/commands", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<VehicleCommandAck>(response);
}
