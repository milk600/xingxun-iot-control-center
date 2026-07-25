import type { IoTProvider } from "./provider.server";
import { CompositeIoTProvider } from "./providers/composite.server";
import { HuaweiCloudGatewayProvider } from "./providers/huawei-cloud.server";
import { HuaweiIoTDASensorSource } from "./providers/huawei-iotda-sensors.server";
import { mockIoTProvider } from "./providers/mock.server";

let cachedProvider: IoTProvider | undefined;

export function getIoTProvider(): IoTProvider {
  if (cachedProvider) return cachedProvider;

  const sensorProvider = process.env.IOT_SENSOR_PROVIDER;
  if (sensorProvider === "huawei-iotda" || process.env.IOT_PROVIDER === "huawei-iotda") {
    const endpoint = process.env.HUAWEI_IOTDA_ENDPOINT;
    const projectId = process.env.HUAWEI_IOTDA_PROJECT_ID;
    const deviceId = process.env.HUAWEI_IOTDA_DEVICE_ID;
    const token = process.env.HUAWEI_IOTDA_TOKEN;
    const iamEndpoint = process.env.HUAWEI_IAM_ENDPOINT;
    const iamAccountName = process.env.HUAWEI_IAM_ACCOUNT_NAME;
    const iamUsername = process.env.HUAWEI_IAM_USERNAME;
    const iamPassword = process.env.HUAWEI_IAM_PASSWORD;
    const projectName = process.env.HUAWEI_IOTDA_PROJECT_NAME;
    const credentialFile = process.env.HUAWEI_CREDENTIALS_FILE;
    const accessKeyId = process.env.HUAWEICLOUD_SDK_AK;
    const secretAccessKey = process.env.HUAWEICLOUD_SDK_SK;
    const regionId = process.env.HUAWEI_IOTDA_REGION_ID || projectName || "cn-north-4";
    const hasIam = Boolean(iamEndpoint && iamAccountName && iamUsername && iamPassword && projectName);
    const hasAkSk = Boolean(credentialFile || (accessKeyId && secretAccessKey));

    if (!endpoint || !projectId || !deviceId || (!token && !hasIam && !hasAkSk)) {
      throw new Error(
        "Huawei IoTDA sensors require endpoint, project ID, device ID, and AK/SK credentials, an application token, or complete IAM credentials",
      );
    }

    const sensors = new HuaweiIoTDASensorSource({
      endpoint,
      projectId,
      deviceId,
      serviceId: process.env.HUAWEI_IOTDA_SERVICE_ID || "Environment",
      instanceId: process.env.HUAWEI_IOTDA_INSTANCE_ID,
      token,
      akSk: hasAkSk
        ? {
            regionId,
            credentialFile,
            accessKeyId,
            secretAccessKey,
          }
        : undefined,
      iam: hasIam
        ? {
            endpoint: iamEndpoint!,
            accountName: iamAccountName!,
            username: iamUsername!,
            password: iamPassword!,
            projectName: projectName!,
          }
        : undefined,
      staleAfterMs: Number(process.env.HUAWEI_IOTDA_STALE_AFTER_MS) || undefined,
      offlineAfterMs: Number(process.env.HUAWEI_IOTDA_OFFLINE_AFTER_MS) || undefined,
    });
    cachedProvider = new CompositeIoTProvider(sensors, mockIoTProvider);
    return cachedProvider;
  }

  if (process.env.IOT_PROVIDER === "huawei-cloud") {
    const baseUrl = process.env.HUAWEI_IOT_GATEWAY_URL;
    const token = process.env.HUAWEI_IOT_GATEWAY_TOKEN;

    if (!baseUrl || !token) {
      throw new Error(
        "Huawei Cloud provider requires HUAWEI_IOT_GATEWAY_URL and HUAWEI_IOT_GATEWAY_TOKEN",
      );
    }

    cachedProvider = new HuaweiCloudGatewayProvider({ baseUrl, token });
    return cachedProvider;
  }

  cachedProvider = mockIoTProvider;
  return cachedProvider;
}
