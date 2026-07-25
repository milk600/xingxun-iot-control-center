import {
  createHmac,
  pbkdf2 as derivePassword,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AuthCredentialUpdateResponse,
  AuthPasswordChange,
  AuthPasswordReset,
  AuthRecoveryQuestionId,
  AuthRecoverySetup,
  AuthRegistration,
  AuthRegistrationResponse,
  AuthSession,
  AuthUser,
} from "./contracts";
import { AUTH_RECOVERY_QUESTIONS } from "./contracts";

const pbkdf2 = promisify(derivePassword);
const AUTH_CONFIG_PATHS = [...new Set([
  process.env.XINGXUN_AUTH_CONFIG,
  process.env.INIT_CWD ? path.join(process.env.INIT_CWD, "data", "local-auth.json") : undefined,
  path.join(process.cwd(), "data", "local-auth.json"),
].filter((value): value is string => Boolean(value)))];

export const LOCAL_AUTH_COOKIE = "xingxun_local_session";
export const REMEMBERED_SESSION_MS = 30 * 24 * 60 * 60 * 1_000;
export const BROWSER_SESSION_MS = 12 * 60 * 60 * 1_000;
const REGISTERED_PASSWORD_ITERATIONS = 310_000;
const RECOVERY_ANSWER_ITERATIONS = 240_000;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 32;
const RECOVERY_ANSWER_MIN_LENGTH = 2;
const RECOVERY_ANSWER_MAX_LENGTH = 64;

interface LocalAuthConfig {
  version: 1;
  username: string;
  displayName: string;
  passwordAlgorithm: "pbkdf2-sha1";
  passwordIterations: number;
  passwordSalt: string;
  passwordHash: string;
  sessionSecret: string;
  sessionVersion: number;
}

interface PasswordIdentity extends AuthUser {
  passwordIterations: number;
  passwordSalt: string;
  passwordHash: string;
  recoveryQuestionId?: AuthRecoveryQuestionId;
  recoveryIterations?: number;
  recoverySalt?: string;
  recoveryHash?: string;
}

interface EnrollmentPayloadV1 {
  version: 1;
  username: string;
  displayName: string;
  passwordAlgorithm: "pbkdf2-sha1";
  passwordIterations: number;
  passwordSalt: string;
  passwordHash: string;
  issuedAt: string;
}

interface EnrollmentPayloadV2 {
  version: 2;
  username: string;
  displayName: string;
  passwordAlgorithm: "pbkdf2-sha1";
  passwordIterations: number;
  passwordSalt: string;
  passwordHash: string;
  recoveryQuestionId: AuthRecoveryQuestionId;
  recoveryIterations: number;
  recoverySalt: string;
  recoveryHash: string;
  issuedAt: string;
}

type EnrollmentPayload = EnrollmentPayloadV1 | EnrollmentPayloadV2;

interface SessionPayload {
  username: string;
  displayName?: string;
  expiresAtMs: number;
  sessionVersion: number;
  recoveryConfigured?: boolean;
}

export class LocalAuthRegistrationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LocalAuthRegistrationError";
  }
}

let cachedConfig: LocalAuthConfig | null = null;

function configFromEnvironment(): LocalAuthConfig | null {
  const username = process.env.LOCAL_AUTH_USERNAME;
  const displayName = process.env.LOCAL_AUTH_DISPLAY_NAME;
  const passwordSalt = process.env.LOCAL_AUTH_PASSWORD_SALT;
  const passwordHash = process.env.LOCAL_AUTH_PASSWORD_HASH;
  const sessionSecret = process.env.LOCAL_AUTH_SESSION_SECRET;
  const iterations = Number(process.env.LOCAL_AUTH_PASSWORD_ITERATIONS);
  const sessionVersion = Number(process.env.LOCAL_AUTH_SESSION_VERSION ?? "1");
  if (!username || !displayName || !passwordSalt || !passwordHash || !sessionSecret) return null;
  return parseConfig({
    version: 1,
    username,
    displayName,
    passwordAlgorithm: "pbkdf2-sha1",
    passwordIterations: iterations,
    passwordSalt,
    passwordHash,
    sessionSecret,
    sessionVersion,
  });
}

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url");
}

function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

function parseConfig(value: unknown): LocalAuthConfig {
  if (!value || typeof value !== "object") {
    throw new Error("本地登录配置无效，请运行 npm run auth:setup");
  }
  const input = value as Partial<LocalAuthConfig>;
  if (
    input.version !== 1 ||
    typeof input.username !== "string" ||
    typeof input.displayName !== "string" ||
    input.passwordAlgorithm !== "pbkdf2-sha1" ||
    typeof input.passwordIterations !== "number" ||
    typeof input.passwordSalt !== "string" ||
    typeof input.passwordHash !== "string" ||
    typeof input.sessionSecret !== "string" ||
    typeof input.sessionVersion !== "number"
  ) {
    throw new Error("本地登录配置不完整，请运行 npm run auth:setup");
  }
  return input as LocalAuthConfig;
}

function parseEnrollmentPayload(value: unknown): EnrollmentPayload | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<EnrollmentPayload>;
  if (
    (input.version !== 1 && input.version !== 2) ||
    typeof input.username !== "string" ||
    typeof input.displayName !== "string" ||
    input.passwordAlgorithm !== "pbkdf2-sha1" ||
    typeof input.passwordIterations !== "number" ||
    typeof input.passwordSalt !== "string" ||
    typeof input.passwordHash !== "string" ||
    typeof input.issuedAt !== "string"
  ) return null;
  if (input.version === 2 && (
    !isRecoveryQuestionId(input.recoveryQuestionId) ||
    typeof input.recoveryIterations !== "number" ||
    typeof input.recoverySalt !== "string" ||
    typeof input.recoveryHash !== "string"
  )) return null;
  return input as EnrollmentPayload;
}

function isRecoveryQuestionId(value: unknown): value is AuthRecoveryQuestionId {
  return AUTH_RECOVERY_QUESTIONS.some((question) => question.id === value);
}

function normalizedRecoveryAnswer(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

function assertPassword(password: string) {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new LocalAuthRegistrationError("密码需为 8–32 位", 400);
  }
}

function assertRecoveryAnswer(answer: string) {
  const normalized = normalizedRecoveryAnswer(answer);
  if (normalized.length < RECOVERY_ANSWER_MIN_LENGTH || normalized.length > RECOVERY_ANSWER_MAX_LENGTH) {
    throw new LocalAuthRegistrationError("验证答案需为 2–64 位", 400);
  }
  return normalized;
}

export async function readLocalAuthConfig() {
  if (cachedConfig) return cachedConfig;
  const environmentConfig = configFromEnvironment();
  if (environmentConfig) {
    cachedConfig = environmentConfig;
    return cachedConfig;
  }
  for (const configPath of AUTH_CONFIG_PATHS) {
    try {
      const raw = await readFile(configPath, "utf8");
      cachedConfig = parseConfig(JSON.parse(raw));
      return cachedConfig;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("本地登录配置无法解析");
      if (error instanceof Error && error.message.includes("本地登录配置")) throw error;
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("尚未初始化本地登录，请运行 npm run auth:setup");
}

function rootIdentity(config: LocalAuthConfig): PasswordIdentity {
  return {
    username: config.username,
    displayName: config.displayName,
    passwordIterations: config.passwordIterations,
    passwordSalt: config.passwordSalt,
    passwordHash: config.passwordHash,
  };
}

function enrollmentIdentity(payload: EnrollmentPayload): PasswordIdentity {
  return {
    username: payload.username,
    displayName: payload.displayName,
    passwordIterations: payload.passwordIterations,
    passwordSalt: payload.passwordSalt,
    passwordHash: payload.passwordHash,
    ...(payload.version === 2 ? {
      recoveryQuestionId: payload.recoveryQuestionId,
      recoveryIterations: payload.recoveryIterations,
      recoverySalt: payload.recoverySalt,
      recoveryHash: payload.recoveryHash,
    } : {}),
  };
}

function recoveryConfigured(identity: PasswordIdentity) {
  return Boolean(
    identity.recoveryQuestionId &&
    identity.recoveryIterations &&
    identity.recoverySalt &&
    identity.recoveryHash,
  );
}

async function verifyPassword(identity: PasswordIdentity, password: string) {
  const expected = Buffer.from(identity.passwordHash, "base64url");
  const candidate = await pbkdf2(
    password,
    Buffer.from(identity.passwordSalt, "base64url"),
    identity.passwordIterations,
    expected.length,
    "sha1",
  );
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function signEnrollmentPayload(payload: EnrollmentPayload, config: LocalAuthConfig) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", base64UrlDecode(config.sessionSecret))
    .update(`enrollment:${encodedPayload}`)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

async function verifyEnrollmentToken(token: string | null | undefined) {
  if (!token) return null;
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra) return null;
  const config = await readLocalAuthConfig();
  const expectedSignature = createHmac("sha256", base64UrlDecode(config.sessionSecret))
    .update(`enrollment:${encodedPayload}`)
    .digest();
  let suppliedSignature: Buffer;
  try {
    suppliedSignature = base64UrlDecode(signature);
  } catch {
    return null;
  }
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) return null;
  try {
    return parseEnrollmentPayload(JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")));
  } catch {
    return null;
  }
}

export async function authenticateLocalCredentials(
  username: string,
  password: string,
  enrollment?: string,
) {
  const account = await authenticateLocalAccount(username, password, enrollment);
  return account?.user ?? null;
}

export async function authenticateLocalAccount(
  username: string,
  password: string,
  enrollment?: string,
) {
  const config = await readLocalAuthConfig();
  const normalized = normalizeUsername(username);
  let identity: PasswordIdentity | null = null;
  const payload = await verifyEnrollmentToken(enrollment);
  if (payload && normalizeUsername(payload.username) === normalized) {
    identity = enrollmentIdentity(payload);
  } else if (normalizeUsername(config.username) === normalized) {
    identity = rootIdentity(config);
  }
  const timingIdentity = identity ?? rootIdentity(config);
  const passwordMatches = await verifyPassword(timingIdentity, password);
  if (!identity || !passwordMatches) return null;
  return {
    user: { username: identity.username, displayName: identity.displayName } satisfies AuthUser,
    recoveryConfigured: recoveryConfigured(identity),
    recoveryQuestionId: identity.recoveryQuestionId ?? null,
  };
}

export async function verifyLocalCredentials(
  username: string,
  password: string,
  enrollment?: string,
) {
  return Boolean(await authenticateLocalCredentials(username, password, enrollment));
}

export async function verifyOriginalAdministrator(username: string, password: string) {
  const config = await readLocalAuthConfig();
  if (normalizeUsername(username) !== normalizeUsername(config.username)) {
    await verifyPassword(rootIdentity(config), password);
    return false;
  }
  return verifyPassword(rootIdentity(config), password);
}

export async function registerLocalAccount(
  registration: AuthRegistration,
): Promise<AuthRegistrationResponse> {
  const username = registration.username.trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw new LocalAuthRegistrationError("账号需为 3–32 位字母、数字、点、短横线或下划线", 400);
  }
  assertPassword(registration.password);
  if (!isRecoveryQuestionId(registration.recoveryQuestionId)) {
    throw new LocalAuthRegistrationError("请选择有效的安全问题", 400);
  }
  const normalizedAnswer = assertRecoveryAnswer(registration.recoveryAnswer);
  if (!await verifyOriginalAdministrator(
    registration.administratorUsername,
    registration.administratorPassword,
  )) {
    throw new LocalAuthRegistrationError("原始管理员账号或密码不正确", 401);
  }

  const config = await readLocalAuthConfig();
  if (normalizeUsername(config.username) === normalizeUsername(username)) {
    throw new LocalAuthRegistrationError("该账号已存在", 409);
  }
  const salt = randomBytes(20);
  const hash = await pbkdf2(
    registration.password,
    salt,
    REGISTERED_PASSWORD_ITERATIONS,
    32,
    "sha1",
  );
  const recoverySalt = randomBytes(20);
  const recoveryHash = await pbkdf2(
    normalizedAnswer,
    recoverySalt,
    RECOVERY_ANSWER_ITERATIONS,
    32,
    "sha1",
  );
  const payload: EnrollmentPayloadV2 = {
    version: 2,
    username,
    displayName: username,
    passwordAlgorithm: "pbkdf2-sha1",
    passwordIterations: REGISTERED_PASSWORD_ITERATIONS,
    passwordSalt: salt.toString("base64url"),
    passwordHash: hash.toString("base64url"),
    recoveryQuestionId: registration.recoveryQuestionId,
    recoveryIterations: RECOVERY_ANSWER_ITERATIONS,
    recoverySalt: recoverySalt.toString("base64url"),
    recoveryHash: recoveryHash.toString("base64url"),
    issuedAt: new Date().toISOString(),
  };
  return {
    user: { username, displayName: username },
    enrollment: signEnrollmentPayload(payload, config),
    recoveryQuestionId: registration.recoveryQuestionId,
  };
}

async function identityForCredential(username: string, enrollment?: string) {
  const config = await readLocalAuthConfig();
  const payload = await verifyEnrollmentToken(enrollment);
  if (payload && normalizeUsername(payload.username) === normalizeUsername(username)) {
    return enrollmentIdentity(payload);
  }
  if (normalizeUsername(config.username) === normalizeUsername(username)) {
    return rootIdentity(config);
  }
  return null;
}

async function buildRecoveryEnrollment(
  identity: PasswordIdentity,
  recoveryQuestionId: AuthRecoveryQuestionId,
  recoveryAnswer: string,
  newPassword?: string,
) {
  const config = await readLocalAuthConfig();
  const normalizedAnswer = assertRecoveryAnswer(recoveryAnswer);
  const recoverySalt = randomBytes(20);
  const recoveryHash = await pbkdf2(normalizedAnswer, recoverySalt, RECOVERY_ANSWER_ITERATIONS, 32, "sha1");
  let passwordIterations = identity.passwordIterations;
  let passwordSalt = identity.passwordSalt;
  let passwordHash = identity.passwordHash;
  if (newPassword !== undefined) {
    assertPassword(newPassword);
    const salt = randomBytes(20);
    const hash = await pbkdf2(newPassword, salt, REGISTERED_PASSWORD_ITERATIONS, 32, "sha1");
    passwordIterations = REGISTERED_PASSWORD_ITERATIONS;
    passwordSalt = salt.toString("base64url");
    passwordHash = hash.toString("base64url");
  }
  const payload: EnrollmentPayloadV2 = {
    version: 2,
    username: identity.username,
    displayName: identity.displayName,
    passwordAlgorithm: "pbkdf2-sha1",
    passwordIterations,
    passwordSalt,
    passwordHash,
    recoveryQuestionId,
    recoveryIterations: RECOVERY_ANSWER_ITERATIONS,
    recoverySalt: recoverySalt.toString("base64url"),
    recoveryHash: recoveryHash.toString("base64url"),
    issuedAt: new Date().toISOString(),
  };
  return signEnrollmentPayload(payload, config);
}

async function verifyRecoveryAnswer(identity: PasswordIdentity, answer: string) {
  const normalized = normalizedRecoveryAnswer(answer);
  if (!recoveryConfigured(identity) || !identity.recoverySalt || !identity.recoveryHash || !identity.recoveryIterations) {
    return false;
  }
  const expected = Buffer.from(identity.recoveryHash, "base64url");
  const candidate = await pbkdf2(
    normalized,
    Buffer.from(identity.recoverySalt, "base64url"),
    identity.recoveryIterations,
    expected.length,
    "sha1",
  );
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export async function setupLocalRecovery(
  username: string,
  input: AuthRecoverySetup,
): Promise<AuthCredentialUpdateResponse> {
  if (!isRecoveryQuestionId(input.recoveryQuestionId)) {
    throw new LocalAuthRegistrationError("请选择有效的安全问题", 400);
  }
  const identity = await identityForCredential(username, input.enrollment);
  if (!identity) throw new LocalAuthRegistrationError("当前账号凭证无效", 401);
  const enrollment = await buildRecoveryEnrollment(
    identity,
    input.recoveryQuestionId,
    input.recoveryAnswer,
  );
  return {
    user: { username: identity.username, displayName: identity.displayName },
    enrollment,
    recoveryQuestionId: input.recoveryQuestionId,
  };
}

export async function resetLocalPassword(
  input: AuthPasswordReset,
): Promise<AuthCredentialUpdateResponse> {
  const payload = await verifyEnrollmentToken(input.enrollment);
  if (!payload || payload.version !== 2 || normalizeUsername(payload.username) !== normalizeUsername(input.username)) {
    throw new LocalAuthRegistrationError("此设备没有可用的验证信息", 404);
  }
  const identity = enrollmentIdentity(payload);
  if (!await verifyRecoveryAnswer(identity, input.recoveryAnswer)) {
    throw new LocalAuthRegistrationError("验证答案不正确", 401);
  }
  assertPassword(input.newPassword);
  const config = await readLocalAuthConfig();
  const passwordSalt = randomBytes(20);
  const passwordHash = await pbkdf2(input.newPassword, passwordSalt, REGISTERED_PASSWORD_ITERATIONS, 32, "sha1");
  const nextPayload: EnrollmentPayloadV2 = {
    ...payload,
    passwordIterations: REGISTERED_PASSWORD_ITERATIONS,
    passwordSalt: passwordSalt.toString("base64url"),
    passwordHash: passwordHash.toString("base64url"),
    issuedAt: new Date().toISOString(),
  };
  return {
    user: { username: identity.username, displayName: identity.displayName },
    enrollment: signEnrollmentPayload(nextPayload, config),
    recoveryQuestionId: payload.recoveryQuestionId,
  };
}

export async function changeLocalPassword(
  input: AuthPasswordChange,
): Promise<AuthCredentialUpdateResponse> {
  const identity = await identityForCredential(input.username, input.enrollment);
  if (!identity || !await verifyPassword(identity, input.currentPassword)) {
    throw new LocalAuthRegistrationError("当前密码不正确", 401);
  }
  if (!identity.recoveryQuestionId || !identity.recoverySalt || !identity.recoveryHash || !identity.recoveryIterations) {
    throw new LocalAuthRegistrationError("请先设置安全问题", 409);
  }
  assertPassword(input.newPassword);
  const config = await readLocalAuthConfig();
  const passwordSalt = randomBytes(20);
  const passwordHash = await pbkdf2(input.newPassword, passwordSalt, REGISTERED_PASSWORD_ITERATIONS, 32, "sha1");
  const payload: EnrollmentPayloadV2 = {
    version: 2,
    username: identity.username,
    displayName: identity.displayName,
    passwordAlgorithm: "pbkdf2-sha1",
    passwordIterations: REGISTERED_PASSWORD_ITERATIONS,
    passwordSalt: passwordSalt.toString("base64url"),
    passwordHash: passwordHash.toString("base64url"),
    recoveryQuestionId: identity.recoveryQuestionId,
    recoveryIterations: identity.recoveryIterations,
    recoverySalt: identity.recoverySalt,
    recoveryHash: identity.recoveryHash,
    issuedAt: new Date().toISOString(),
  };
  return {
    user: { username: identity.username, displayName: identity.displayName },
    enrollment: signEnrollmentPayload(payload, config),
    recoveryQuestionId: identity.recoveryQuestionId,
  };
}

export async function createLocalSessionToken(
  user: AuthUser,
  remember: boolean,
  recoveryIsConfigured = true,
) {
  const config = await readLocalAuthConfig();
  const expiresAtMs = Date.now() + (remember ? REMEMBERED_SESSION_MS : BROWSER_SESSION_MS);
  const payload: SessionPayload = {
    username: user.username,
    displayName: user.displayName,
    expiresAtMs,
    sessionVersion: config.sessionVersion,
    recoveryConfigured: recoveryIsConfigured,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", base64UrlDecode(config.sessionSecret))
    .update(encodedPayload)
    .digest("base64url");
  return {
    token: `${encodedPayload}.${signature}`,
    session: sessionFromPayload(payload, user, "web"),
    expiresAtMs,
  };
}

export async function verifyLocalSessionToken(token: string | null | undefined) {
  if (!token) return null;
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra) return null;
  const config = await readLocalAuthConfig();
  const expectedSignature = createHmac("sha256", base64UrlDecode(config.sessionSecret))
    .update(encodedPayload)
    .digest();
  let suppliedSignature: Buffer;
  try {
    suppliedSignature = base64UrlDecode(signature);
  } catch {
    return null;
  }
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.username !== "string" ||
    payload.sessionVersion !== config.sessionVersion ||
    !Number.isFinite(payload.expiresAtMs) ||
    payload.expiresAtMs <= Date.now()
  ) return null;

  const displayName = typeof payload.displayName === "string"
    ? payload.displayName
    : normalizeUsername(payload.username) === normalizeUsername(config.username)
      ? config.displayName
      : null;
  if (!displayName) return null;
  return sessionFromPayload(
    payload,
    { username: payload.username, displayName },
    "web",
  );
}

export async function readLocalSession(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").flatMap((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 0) return [];
      return [[entry.slice(0, separator).trim(), decodeURIComponent(entry.slice(separator + 1).trim())]];
    }),
  );
  return verifyLocalSessionToken(cookies[LOCAL_AUTH_COOKIE]);
}

export function sessionCookie(token: string, request: Request, remember: boolean, expiresAtMs: number) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const persistence = remember
    ? `; Max-Age=${Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1_000))}`
    : "";
  return `${LOCAL_AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${persistence}${secure}`;
}

export function clearedSessionCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${LOCAL_AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

function sessionFromPayload(
  payload: SessionPayload,
  user: AuthUser,
  platform: AuthSession["platform"],
): AuthSession {
  return {
    user,
    platform,
    expiresAt: new Date(payload.expiresAtMs).toISOString(),
    biometricAvailable: false,
    biometricEnrolled: false,
    recoveryConfigured: payload.recoveryConfigured ?? false,
  };
}

export function unauthorizedResponse() {
  return Response.json({ error: "登录状态已失效" }, {
    status: 401,
    headers: { "cache-control": "no-store" },
  });
}
