import { readFile, writeFile } from "node:fs/promises";
import { parseHuaweiCredentialCsv } from "../app/lib/iot/providers/huawei-iotda-sensors.server";

const envFile = new URL("../.env.local", import.meta.url);
const credentialFile = process.env.HUAWEI_CREDENTIALS_FILE?.trim();

if (!credentialFile) {
  throw new Error("请先在 .env.local 中配置 HUAWEI_CREDENTIALS_FILE");
}

const credential = parseHuaweiCredentialCsv(await readFile(credentialFile, "utf8"));
let envSource = await readFile(envFile, "utf8");

function upsertEnv(source: string, key: string, value: string) {
  const line = `${key}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(source)) return source.replace(pattern, line);
  const anchor = /^HUAWEI_CREDENTIALS_FILE=.*$/m;
  if (anchor.test(source)) return source.replace(anchor, (match) => `${match}\n${line}`);
  return `${source.replace(/\s*$/, "")}\n${line}\n`;
}

envSource = upsertEnv(envSource, "HUAWEICLOUD_SDK_SK", credential.secretAccessKey);
envSource = upsertEnv(envSource, "HUAWEICLOUD_SDK_AK", credential.accessKeyId);
await writeFile(envFile, envSource, { encoding: "utf8", mode: 0o600 });

console.log("华为云 AK/SK 已写入本机服务端环境；未输出凭据内容。");
