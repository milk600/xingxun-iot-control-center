import { BasicCredentials, Region } from "@huaweicloud/huaweicloud-sdk-core";
import {
  IoTDAClient,
  ShowDeviceRequest,
  ShowDeviceShadowRequest,
  ShowProductRequest,
} from "@huaweicloud/huaweicloud-sdk-iotda";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少服务端环境变量 ${name}`);
  return value;
}

const endpoint = required("HUAWEI_IOTDA_ENDPOINT").replace(/\/$/, "");
const projectId = required("HUAWEI_IOTDA_PROJECT_ID");
const regionId = process.env.HUAWEI_IOTDA_REGION_ID?.trim() || "cn-north-4";
const deviceId = required("HUAWEI_IOTDA_DEVICE_ID");
const instanceId = process.env.HUAWEI_IOTDA_INSTANCE_ID?.trim();
const credentials = new BasicCredentials()
  .withAk(required("HUAWEICLOUD_SDK_AK"))
  .withSk(required("HUAWEICLOUD_SDK_SK"))
  .withProjectId(projectId);

if (new URL(endpoint).hostname.includes(".st1.")) {
  credentials.withDerivedPredicate((request) => (
    BasicCredentials.getDefaultDerivedPredicate(request)
  ));
}

const client = IoTDAClient.newBuilder()
  .withCredential(credentials)
  .withEndpoint(endpoint)
  .withRegion(new Region(regionId, endpoint))
  .build();
const request = new ShowDeviceShadowRequest(deviceId);
if (instanceId) request.withInstanceId(instanceId);
const response = await client.showDeviceShadow(request);
const deviceRequest = new ShowDeviceRequest(deviceId);
if (instanceId) deviceRequest.withInstanceId(instanceId);
const device = await client.showDevice(deviceRequest);
const rawDevice = device as unknown as Record<string, unknown>;
const productId = device.productId ?? rawDevice.product_id as string | undefined;
let productModel: unknown = null;
if (productId) {
  const productRequest = new ShowProductRequest(productId);
  if (instanceId) productRequest.withInstanceId(instanceId);
  const product = await client.showProduct(productRequest);
  const rawProduct = product as unknown as Record<string, unknown>;
  const capabilities = product.serviceCapabilities
    ?? rawProduct.service_capabilities as Array<Record<string, unknown>> | undefined
    ?? [];
  productModel = capabilities.map((capability) => {
    const rawCapability = capability as unknown as Record<string, unknown>;
    return {
      serviceId: capability.serviceId ?? rawCapability.service_id,
      properties: (capability.properties as Array<Record<string, unknown>> | undefined)?.map((property) => ({
        name: property.propertyName ?? property.property_name,
        dataType: property.dataType ?? property.data_type,
        unit: property.unit ?? "",
        min: property.min,
        max: property.max,
      })) ?? [],
    };
  });
}

console.log(JSON.stringify({
  deviceId: response.deviceId,
  productId,
  productModel,
  services: response.shadow?.map((service) => ({
    serviceId: service.serviceId,
    eventTime: service.reported?.eventTime,
    properties: service.reported?.properties ?? {},
  })) ?? [],
}, null, 2));
