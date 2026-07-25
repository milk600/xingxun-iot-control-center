import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import test from "node:test";

const password = "local-auth-test-password";
const salt = randomBytes(18);
const iterations = 12_000;
process.env.LOCAL_AUTH_USERNAME = "test-admin";
process.env.LOCAL_AUTH_DISPLAY_NAME = "测试管理员";
process.env.LOCAL_AUTH_PASSWORD_ITERATIONS = String(iterations);
process.env.LOCAL_AUTH_PASSWORD_SALT = salt.toString("base64url");
process.env.LOCAL_AUTH_PASSWORD_HASH = pbkdf2Sync(password, salt, iterations, 32, "sha1").toString("base64url");
process.env.LOCAL_AUTH_SESSION_SECRET = randomBytes(32).toString("base64url");
process.env.LOCAL_AUTH_SESSION_VERSION = "1";

const auth = await import("../app/lib/auth/local-auth.server.ts");
let operatorEnrollment = "";

test("local auth verifies the configured administrator without storing clear text", async () => {
  assert.equal(await auth.verifyLocalCredentials("test-admin", password), true);
  assert.equal(await auth.verifyLocalCredentials("test-admin", "wrong-password"), false);
  assert.equal(await auth.verifyLocalCredentials("someone-else", password), false);
});

test("local auth signs, verifies, and rejects tampered sessions", async () => {
  const created = await auth.createLocalSessionToken({
    username: "test-admin",
    displayName: "测试管理员",
  }, true);
  const verified = await auth.verifyLocalSessionToken(created.token);
  assert.equal(verified?.user.username, "test-admin");
  assert.equal(verified?.platform, "web");
  assert.equal(await auth.verifyLocalSessionToken(`${created.token}x`), null);
  assert.match(
    auth.sessionCookie(created.token, new Request("http://localhost/api/auth/login"), true, created.expiresAtMs),
    /HttpOnly; SameSite=Strict; Max-Age=/,
  );
});

test("the original administrator can register a salted local account that can sign in", async () => {
  const registeredPassword = "registered-user-password";
  const registration = await auth.registerLocalAccount({
    username: "room-operator",
    password: registeredPassword,
    recoveryQuestionId: "first-school",
    recoveryAnswer: "Example University",
    agreementVersion: "2026-07-21",
    administratorUsername: "test-admin",
    administratorPassword: password,
  });
  assert.deepEqual(registration.user, { username: "room-operator", displayName: "room-operator" });
  assert.ok(registration.enrollment);
  operatorEnrollment = registration.enrollment;
  assert.equal(await auth.verifyLocalCredentials(
    "room-operator",
    registeredPassword,
    registration.enrollment,
  ), true);
  assert.equal(await auth.verifyLocalCredentials(
    "room-operator",
    "wrong-password",
    registration.enrollment,
  ), false);
  assert.equal(await auth.verifyLocalCredentials(
    "room-operator",
    registeredPassword,
    `${registration.enrollment}x`,
  ), false);

  const created = await auth.createLocalSessionToken(registration.user, false);
  const verified = await auth.verifyLocalSessionToken(created.token);
  assert.equal(verified?.user.username, "room-operator");

  const [encodedPayload] = registration.enrollment.split(".");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  assert.equal(payload.password, undefined);
  assert.notEqual(payload.passwordHash, registeredPassword);
  assert.equal(payload.passwordAlgorithm, "pbkdf2-sha1");
});

test("recovery answers reset the password without exposing the answer", async () => {
  assert.ok(operatorEnrollment);
  const reset = await auth.resetLocalPassword({
    username: "room-operator",
    recoveryAnswer: "  Example University  ",
    newPassword: "reset-password-2026",
    enrollment: operatorEnrollment,
  });
  assert.equal(await auth.verifyLocalCredentials("room-operator", "reset-password-2026", reset.enrollment), true);
  assert.equal(await auth.verifyLocalCredentials("room-operator", "registered-user-password", reset.enrollment), false);
  const payload = JSON.parse(Buffer.from(reset.enrollment.split(".")[0], "base64url").toString("utf8"));
  assert.equal(payload.recoveryAnswer, undefined);
  assert.ok(payload.recoveryHash);
  await assert.rejects(
    auth.resetLocalPassword({ ...reset, username: "room-operator", recoveryAnswer: "wrong", newPassword: "another-pass-2026", enrollment: reset.enrollment }),
    (error: unknown) => error instanceof auth.LocalAuthRegistrationError && error.status === 401,
  );
});

test("password changes enforce the shared 8 to 32 character boundary", async () => {
  await assert.rejects(
    auth.changeLocalPassword({ username: "room-operator", currentPassword: "registered-user-password", newPassword: "short", enrollment: operatorEnrollment }),
    (error: unknown) => error instanceof auth.LocalAuthRegistrationError && error.status === 400,
  );
  await assert.rejects(
    auth.changeLocalPassword({ username: "room-operator", currentPassword: "registered-user-password", newPassword: "x".repeat(33), enrollment: operatorEnrollment }),
    (error: unknown) => error instanceof auth.LocalAuthRegistrationError && error.status === 400,
  );
  const changed = await auth.changeLocalPassword({
    username: "room-operator",
    currentPassword: "registered-user-password",
    newPassword: "12345678",
    enrollment: operatorEnrollment,
  });
  assert.equal(await auth.verifyLocalCredentials("room-operator", "12345678", changed.enrollment), true);
});

test("registered users cannot authorize more accounts and the root name cannot be overwritten", async () => {
  await assert.rejects(
    auth.registerLocalAccount({
      username: "second-operator",
      password: "another-safe-password",
      recoveryQuestionId: "birth-city",
      recoveryAnswer: "Shenyang",
      agreementVersion: "2026-07-21",
      administratorUsername: "room-operator",
      administratorPassword: "registered-user-password",
    }),
    (error: unknown) => error instanceof auth.LocalAuthRegistrationError && error.status === 401,
  );
  await assert.rejects(
    auth.registerLocalAccount({
      username: "TEST-ADMIN",
      password: "another-safe-password",
      recoveryQuestionId: "birth-city",
      recoveryAnswer: "Shenyang",
      agreementVersion: "2026-07-21",
      administratorUsername: "test-admin",
      administratorPassword: password,
    }),
    (error: unknown) => error instanceof auth.LocalAuthRegistrationError && error.status === 409,
  );
});
