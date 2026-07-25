export type VehicleMoveAuthorization = "direct" | "confirmation";
export type ConfirmedVehicleMoveAuthorization = "execute" | "disabled";

/**
 * The browser permission never overrides the gateway's deployment-level switch.
 * Only when both are enabled may an AI proposal execute without confirmation.
 */
export function vehicleMoveAuthorization(
  gatewayEnabled: boolean,
  clientAutonomousControlEnabled: boolean,
): VehicleMoveAuthorization {
  return gatewayEnabled && clientAutonomousControlEnabled ? "direct" : "confirmation";
}

/**
 * An explicit, one-time user confirmation is the alternative to autonomous
 * client permission. It remains guarded by the deployment-level gateway
 * switch, but must not require the autonomous-control preference as well.
 */
export function confirmedVehicleMoveAuthorization(
  gatewayEnabled: boolean,
): ConfirmedVehicleMoveAuthorization {
  return gatewayEnabled ? "execute" : "disabled";
}
