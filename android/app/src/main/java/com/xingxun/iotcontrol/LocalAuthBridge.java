package com.xingxun.iotcontrol;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.Normalizer;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Iterator;
import java.util.Locale;
import java.util.TimeZone;
import java.util.regex.Pattern;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * Native offline authentication bridge. The bootstrap administrator
 * verifier is bundled by BuildConfig; registered accounts are stored as
 * independent salted verifiers in this app's private SharedPreferences.
 */
public final class LocalAuthBridge {
    private static final String PREFS_NAME = "xingxun_local_auth";
    private static final String KEY_SESSION_EXPIRY = "session_expiry";
    private static final String KEY_SESSION_USERNAME = "session_username";
    private static final String KEY_BIOMETRIC_ENABLED = "biometric_enabled";
    private static final String KEY_BIOMETRIC_USERNAME = "biometric_username";
    private static final String KEY_REGISTERED_ACCOUNTS = "registered_accounts_v2";
    private static final String KEY_REGISTERED_ACCOUNTS_V1 = "registered_accounts_v1";
    private static final long REMEMBER_MS = 30L * 24L * 60L * 60L * 1000L;
    private static final long TRANSIENT_MS = 12L * 60L * 60L * 1000L;
    private static final int REGISTERED_ITERATIONS = 310_000;
    private static final int RECOVERY_ITERATIONS = 210_000;
    private static final int MAX_FAILURES = 5;
    private static final long LOCKOUT_MS = 30_000L;
    private static final Pattern USERNAME_PATTERN = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$");

    private final Activity activity;
    private final WebView webView;
    private final SharedPreferences preferences;
    private int failureCount;
    private long lockedUntilMs;
    private long transientSessionExpiryMs;
    private String transientSessionUsername;

    LocalAuthBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.preferences = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    @JavascriptInterface
    public String getSession() {
        long expiry = activeSessionExpiry();
        return restoreJson(expiry, activeSessionUsername(expiry));
    }

    @JavascriptInterface
    public String signIn(String username, String password, boolean remember) {
        long now = System.currentTimeMillis();
        if (lockedUntilMs > now) {
            return errorJson("尝试次数过多，请稍后再试", lockedUntilMs);
        }

        Identity identity = findIdentity(username);
        boolean valid = identity != null && verifyPassword(identity, password == null ? "" : password);
        if (!valid) return failedCredentialJson("账号或密码不正确", now);

        clearFailures();
        long expiry = now + (remember ? REMEMBER_MS : TRANSIENT_MS);
        saveSession(identity.username, expiry, remember);
        return restoreJson(expiry, identity.username);
    }

    @JavascriptInterface
    public String registerAccount(
            String administratorUsername,
            String administratorPassword,
            String username,
            String password,
            String recoveryQuestionId,
            String recoveryAnswer
    ) {
        long now = System.currentTimeMillis();
        if (lockedUntilMs > now) {
            return errorJson("管理员验证次数过多，请稍后再试", lockedUntilMs);
        }

        String cleanUsername = username == null ? "" : username.trim();
        String cleanPassword = password == null ? "" : password;
        if (!USERNAME_PATTERN.matcher(cleanUsername).matches()) {
            return errorJson("账号需为 3–32 位字母、数字、点、短横线或下划线", 0L);
        }
        if (cleanPassword.length() < 8 || cleanPassword.length() > 32) {
            return errorJson("新密码需为 8–32 位", 0L);
        }
        if (!validRecoveryQuestion(recoveryQuestionId)) return errorJson("请选择有效的验证问题", 0L);
        String cleanAnswer = normalizeAnswer(recoveryAnswer);
        if (cleanAnswer.length() < 1 || cleanAnswer.length() > 100) return errorJson("请输入 1–100 位验证答案", 0L);

        Identity root = rootIdentity();
        boolean administratorValid = canonical(root.username).equals(canonical(administratorUsername))
                && verifyPassword(root, administratorPassword == null ? "" : administratorPassword);
        if (!administratorValid) {
            return failedCredentialJson("原始管理员账号或密码不正确", now);
        }
        clearFailures();

        if (findIdentity(cleanUsername) != null) return errorJson("该账号已存在", 0L);
        try {
            byte[] salt = new byte[20];
            new SecureRandom().nextBytes(salt);
            byte[] hash = derivePassword(cleanPassword, salt, REGISTERED_ITERATIONS, 32);
            byte[] recoverySalt = new byte[20];
            new SecureRandom().nextBytes(recoverySalt);
            byte[] recoveryHash = derivePassword(cleanAnswer, recoverySalt, RECOVERY_ITERATIONS, 32);
            JSONObject accounts = registeredAccounts();
            JSONObject account = new JSONObject();
            account.put("username", cleanUsername);
            account.put("displayName", cleanUsername);
            account.put("iterations", REGISTERED_ITERATIONS);
            account.put("salt", encodeBase64Url(salt));
            account.put("hash", encodeBase64Url(hash));
            account.put("createdAt", isoDate(now));
            account.put("recoveryQuestionId", recoveryQuestionId);
            account.put("recoveryIterations", RECOVERY_ITERATIONS);
            account.put("recoverySalt", encodeBase64Url(recoverySalt));
            account.put("recoveryHash", encodeBase64Url(recoveryHash));
            accounts.put(canonical(cleanUsername), account);
            if (!preferences.edit().putString(KEY_REGISTERED_ACCOUNTS, accounts.toString()).commit()) {
                return errorJson("账号保存失败", 0L);
            }
            JSONObject response = new JSONObject();
            response.put("user", userObject(new Identity(
                    cleanUsername,
                    cleanUsername,
                    REGISTERED_ITERATIONS,
                    encodeBase64Url(salt),
                    encodeBase64Url(hash), recoveryQuestionId, RECOVERY_ITERATIONS,
                    encodeBase64Url(recoverySalt), encodeBase64Url(recoveryHash)
            )));
            response.put("enrollment", "native-v2");
            response.put("recoveryQuestionId", recoveryQuestionId);
            return response.toString();
        } catch (Exception error) {
            return errorJson("账号创建失败", 0L);
        }
    }

    @JavascriptInterface
    public String setupRecovery(String recoveryQuestionId, String recoveryAnswer) {
        long expiry = activeSessionExpiry();
        String username = activeSessionUsername(expiry);
        Identity identity = expiry > System.currentTimeMillis() ? findIdentity(username) : null;
        if (identity == null) return errorJson("登录状态已失效", 0L);
        if (!validRecoveryQuestion(recoveryQuestionId)) return errorJson("请选择有效的验证问题", 0L);
        String answer = normalizeAnswer(recoveryAnswer);
        if (answer.length() < 1 || answer.length() > 100) return errorJson("请输入 1–100 位验证答案", 0L);
        try {
            byte[] salt = new byte[20];
            new SecureRandom().nextBytes(salt);
            byte[] hash = derivePassword(answer, salt, RECOVERY_ITERATIONS, 32);
            Identity updated = new Identity(
                    identity.username, identity.displayName, identity.iterations, identity.salt, identity.hash,
                    recoveryQuestionId, RECOVERY_ITERATIONS, encodeBase64Url(salt), encodeBase64Url(hash)
            );
            if (!saveIdentity(updated)) return errorJson("验证信息保存失败", 0L);
            return credentialUpdateJson(updated);
        } catch (Exception error) {
            return errorJson("验证信息保存失败", 0L);
        }
    }

    @JavascriptInterface
    public String resetPassword(String username, String recoveryAnswer, String newPassword) {
        long now = System.currentTimeMillis();
        if (lockedUntilMs > now) return errorJson("尝试次数过多，请稍后再试", lockedUntilMs);
        Identity identity = findIdentity(username);
        if (identity == null || identity.recoveryQuestionId == null || identity.recoveryHash == null || identity.recoverySalt == null) {
            return failedCredentialJson("此账号没有可用的验证信息", now);
        }
        if (!validPassword(newPassword)) return errorJson("新密码需为 8–32 位", 0L);
        try {
            byte[] expected = decodeBase64Url(identity.recoveryHash);
            byte[] candidate = derivePassword(normalizeAnswer(recoveryAnswer), decodeBase64Url(identity.recoverySalt), identity.recoveryIterations, expected.length);
            if (!MessageDigest.isEqual(candidate, expected)) return failedCredentialJson("验证答案不正确", now);
            clearFailures();
            Identity updated = withNewPassword(identity, newPassword);
            if (!saveIdentity(updated)) return errorJson("新密码保存失败", 0L);
            clearSession();
            preferences.edit().remove(KEY_BIOMETRIC_ENABLED).remove(KEY_BIOMETRIC_USERNAME).apply();
            return credentialUpdateJson(updated);
        } catch (Exception error) {
            return errorJson("密码重置失败", 0L);
        }
    }

    @JavascriptInterface
    public String changePassword(String currentPassword, String newPassword) {
        long expiry = activeSessionExpiry();
        String username = activeSessionUsername(expiry);
        Identity identity = expiry > System.currentTimeMillis() ? findIdentity(username) : null;
        if (identity == null) return errorJson("登录状态已失效", 0L);
        if (!verifyPassword(identity, currentPassword == null ? "" : currentPassword)) return errorJson("当前密码不正确", 0L);
        if (!validPassword(newPassword)) return errorJson("新密码需为 8–32 位", 0L);
        try {
            Identity updated = withNewPassword(identity, newPassword);
            if (!saveIdentity(updated)) return errorJson("新密码保存失败", 0L);
            return credentialUpdateJson(updated);
        } catch (Exception error) {
            return errorJson("密码修改失败", 0L);
        }
    }

    @JavascriptInterface
    public String lock() {
        clearSession();
        return restoreJson(0L, null);
    }

    @JavascriptInterface
    public String signOut() {
        clearSession();
        preferences.edit()
                .remove(KEY_BIOMETRIC_ENABLED)
                .remove(KEY_BIOMETRIC_USERNAME)
                .apply();
        return restoreJson(0L, null);
    }

    @JavascriptInterface
    public void authenticateBiometric() {
        String biometricUsername = preferences.getString(
                KEY_BIOMETRIC_USERNAME,
                BuildConfig.XINGXUN_AUTH_USERNAME
        );
        if (!preferences.getBoolean(KEY_BIOMETRIC_ENABLED, false)
                || findIdentity(biometricUsername) == null) {
            dispatchBiometric(false, null, "尚未启用生物识别");
            return;
        }
        showBiometricPrompt(false, biometricUsername);
    }

    @JavascriptInterface
    public void enableBiometric() {
        long expiry = activeSessionExpiry();
        String username = activeSessionUsername(expiry);
        if (expiry <= System.currentTimeMillis() || findIdentity(username) == null) {
            dispatchBiometric(false, null, "请先使用密码登录");
            return;
        }
        showBiometricPrompt(true, username);
    }

    private void saveSession(String username, long expiry, boolean remember) {
        if (remember) {
            preferences.edit()
                    .putLong(KEY_SESSION_EXPIRY, expiry)
                    .putString(KEY_SESSION_USERNAME, username)
                    .apply();
            transientSessionExpiryMs = 0L;
            transientSessionUsername = null;
        } else {
            preferences.edit()
                    .remove(KEY_SESSION_EXPIRY)
                    .remove(KEY_SESSION_USERNAME)
                    .apply();
            transientSessionExpiryMs = expiry;
            transientSessionUsername = username;
        }
    }

    private void clearSession() {
        transientSessionExpiryMs = 0L;
        transientSessionUsername = null;
        preferences.edit()
                .remove(KEY_SESSION_EXPIRY)
                .remove(KEY_SESSION_USERNAME)
                .apply();
    }

    private long activeSessionExpiry() {
        long now = System.currentTimeMillis();
        long persisted = preferences.getLong(KEY_SESSION_EXPIRY, 0L);
        long expiry = Math.max(persisted, transientSessionExpiryMs);
        if (expiry <= now) {
            clearSession();
            return 0L;
        }
        return expiry;
    }

    private String activeSessionUsername(long expiry) {
        if (expiry <= System.currentTimeMillis()) return null;
        if (transientSessionExpiryMs == expiry && transientSessionUsername != null) {
            return transientSessionUsername;
        }
        return preferences.getString(KEY_SESSION_USERNAME, BuildConfig.XINGXUN_AUTH_USERNAME);
    }

    private String canonical(String username) {
        return username == null ? "" : username.trim().toLowerCase(Locale.ROOT);
    }

    private Identity rootIdentity() {
        return new Identity(
                BuildConfig.XINGXUN_AUTH_USERNAME,
                decodedDisplayName(),
                BuildConfig.XINGXUN_AUTH_ITERATIONS,
                BuildConfig.XINGXUN_AUTH_SALT,
                BuildConfig.XINGXUN_AUTH_HASH,
                null, 0, null, null
        );
    }

    private Identity findIdentity(String username) {
        String normalized = canonical(username);
        try {
            JSONObject account = registeredAccounts().optJSONObject(normalized);
            if (account != null) return new Identity(
                    account.getString("username"),
                    account.optString("displayName", account.getString("username")),
                    account.getInt("iterations"),
                    account.getString("salt"),
                    account.getString("hash"),
                    account.optString("recoveryQuestionId", null),
                    account.optInt("recoveryIterations", 0),
                    account.optString("recoverySalt", null),
                    account.optString("recoveryHash", null)
            );
        } catch (Exception error) {
            return null;
        }
        Identity root = rootIdentity();
        return canonical(root.username).equals(normalized) ? root : null;
    }

    private JSONObject registeredAccounts() {
        try {
            String stored = preferences.getString(KEY_REGISTERED_ACCOUNTS, null);
            if (stored == null) stored = preferences.getString(KEY_REGISTERED_ACCOUNTS_V1, "{}");
            JSONObject parsed = new JSONObject(stored);
            Iterator<String> keys = parsed.keys();
            while (keys.hasNext()) {
                if (parsed.optJSONObject(keys.next()) == null) return new JSONObject();
            }
            return parsed;
        } catch (Exception error) {
            return new JSONObject();
        }
    }

    private boolean saveIdentity(Identity identity) {
        try {
            JSONObject accounts = registeredAccounts();
            JSONObject account = new JSONObject();
            account.put("username", identity.username);
            account.put("displayName", identity.displayName);
            account.put("iterations", identity.iterations);
            account.put("salt", identity.salt);
            account.put("hash", identity.hash);
            account.put("createdAt", isoDate(System.currentTimeMillis()));
            if (identity.recoveryQuestionId != null) {
                account.put("recoveryQuestionId", identity.recoveryQuestionId);
                account.put("recoveryIterations", identity.recoveryIterations);
                account.put("recoverySalt", identity.recoverySalt);
                account.put("recoveryHash", identity.recoveryHash);
            }
            accounts.put(canonical(identity.username), account);
            return preferences.edit().putString(KEY_REGISTERED_ACCOUNTS, accounts.toString()).commit();
        } catch (Exception error) {
            return false;
        }
    }

    private Identity withNewPassword(Identity identity, String password) throws Exception {
        byte[] salt = new byte[20];
        new SecureRandom().nextBytes(salt);
        byte[] hash = derivePassword(password, salt, REGISTERED_ITERATIONS, 32);
        return new Identity(
                identity.username, identity.displayName, REGISTERED_ITERATIONS,
                encodeBase64Url(salt), encodeBase64Url(hash), identity.recoveryQuestionId,
                identity.recoveryIterations, identity.recoverySalt, identity.recoveryHash
        );
    }

    private String credentialUpdateJson(Identity identity) {
        JSONObject response = new JSONObject();
        try {
            response.put("user", userObject(identity));
            response.put("enrollment", "native-v2");
            response.put("recoveryQuestionId", identity.recoveryQuestionId);
        } catch (JSONException ignored) {
        }
        return response.toString();
    }

    private boolean validPassword(String value) {
        return value != null && value.length() >= 8 && value.length() <= 32;
    }

    private boolean validRecoveryQuestion(String value) {
        return "first-school".equals(value) || "birth-city".equals(value)
                || "favorite-city".equals(value) || "childhood-friend".equals(value)
                || "favorite-book".equals(value);
    }

    private String normalizeAnswer(String value) {
        return Normalizer.normalize(value == null ? "" : value, Normalizer.Form.NFKC).trim();
    }

    private boolean verifyPassword(Identity identity, String password) {
        try {
            byte[] salt = decodeBase64Url(identity.salt);
            byte[] expected = decodeBase64Url(identity.hash);
            byte[] candidate = derivePassword(password, salt, identity.iterations, expected.length);
            return MessageDigest.isEqual(candidate, expected);
        } catch (Exception error) {
            return false;
        }
    }

    private byte[] derivePassword(String password, byte[] salt, int iterations, int byteLength) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, iterations, byteLength * 8);
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1").generateSecret(spec).getEncoded();
        } finally {
            spec.clearPassword();
        }
    }

    private byte[] decodeBase64Url(String value) {
        return Base64.decode(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private String encodeBase64Url(byte[] value) {
        return Base64.encodeToString(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private String failedCredentialJson(String message, long now) {
        failureCount += 1;
        if (failureCount >= MAX_FAILURES) {
            failureCount = 0;
            lockedUntilMs = now + LOCKOUT_MS;
            return errorJson("尝试次数过多，请稍后再试", lockedUntilMs);
        }
        return errorJson(message, 0L);
    }

    private void clearFailures() {
        failureCount = 0;
        lockedUntilMs = 0L;
    }

    private boolean biometricAvailable() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false;
        KeyguardManager manager = (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE);
        return manager != null && manager.isDeviceSecure();
    }

    @SuppressLint({"MissingPermission", "NewApi"})
    private void showBiometricPrompt(boolean enrollment, String username) {
        if (!biometricAvailable() || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            dispatchBiometric(false, null, "当前设备未设置可用的生物识别");
            return;
        }
        activity.runOnUiThread(() -> {
            CancellationSignal cancellationSignal = new CancellationSignal();
            BiometricPrompt prompt = new BiometricPrompt.Builder(activity)
                    .setTitle(enrollment ? "启用生物识别" : "验证身份")
                    .setSubtitle("危化智巡")
                    .setNegativeButton("取消", activity.getMainExecutor(), (dialog, which) ->
                            dispatchBiometric(false, null, "已取消生物识别"))
                    .build();
            prompt.authenticate(cancellationSignal, activity.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationError(int errorCode, CharSequence errorString) {
                    dispatchBiometric(false, null, errorString == null ? "生物识别失败" : errorString.toString());
                }

                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    if (enrollment) {
                        preferences.edit()
                                .putBoolean(KEY_BIOMETRIC_ENABLED, true)
                                .putString(KEY_BIOMETRIC_USERNAME, username)
                                .apply();
                    }
                    long expiry = System.currentTimeMillis() + REMEMBER_MS;
                    saveSession(username, expiry, true);
                    dispatchBiometric(true, restoreObject(expiry, username), null);
                }
            });
        });
    }

    private void dispatchBiometric(boolean ok, JSONObject response, String error) {
        try {
            JSONObject detail = new JSONObject();
            detail.put("ok", ok);
            if (response != null) detail.put("response", response);
            if (error != null) detail.put("error", error);
            String script = "window.dispatchEvent(new CustomEvent('xingxun:native-auth',{detail:"
                    + detail.toString() + "}));";
            activity.runOnUiThread(() -> webView.evaluateJavascript(script, null));
        } catch (JSONException ignored) {
        }
    }

    private String restoreJson(long expiry, String username) {
        return restoreObject(expiry, username).toString();
    }

    private JSONObject restoreObject(long expiry, String username) {
        JSONObject response = new JSONObject();
        try {
            boolean available = biometricAvailable();
            String biometricUsername = preferences.getString(
                    KEY_BIOMETRIC_USERNAME,
                    BuildConfig.XINGXUN_AUTH_USERNAME
            );
            boolean enrolledForAnyAccount = available
                    && preferences.getBoolean(KEY_BIOMETRIC_ENABLED, false)
                    && findIdentity(biometricUsername) != null;
            Identity identity = expiry > System.currentTimeMillis() ? findIdentity(username) : null;
            boolean enrolled = enrolledForAnyAccount && (identity == null
                    || canonical(identity.username).equals(canonical(biometricUsername)));
            response.put("biometricAvailable", available);
            response.put("biometricEnrolled", enrolled);
            if (identity != null) {
                JSONObject session = new JSONObject();
                session.put("user", userObject(identity));
                session.put("platform", "android");
                session.put("expiresAt", isoDate(expiry));
                session.put("biometricAvailable", available);
                session.put("biometricEnrolled", enrolled);
                session.put("recoveryConfigured", identity.recoveryQuestionId != null);
                response.put("session", session);
            } else {
                response.put("session", JSONObject.NULL);
            }
        } catch (JSONException ignored) {
        }
        return response;
    }

    private JSONObject userObject(Identity identity) throws JSONException {
        JSONObject user = new JSONObject();
        user.put("username", identity.username);
        user.put("displayName", identity.displayName);
        return user;
    }

    private String decodedDisplayName() {
        try {
            return new String(Base64.decode(BuildConfig.XINGXUN_AUTH_DISPLAY_NAME, Base64.DEFAULT), StandardCharsets.UTF_8);
        } catch (Exception error) {
            return "管理员";
        }
    }

    private String errorJson(String message, long lockUntil) {
        JSONObject response = new JSONObject();
        try {
            response.put("error", message);
            if (lockUntil > 0L) response.put("lockedUntil", isoDate(lockUntil));
        } catch (JSONException ignored) {
        }
        return response.toString();
    }

    private String isoDate(long timestamp) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(timestamp));
    }

    private static final class Identity {
        final String username;
        final String displayName;
        final int iterations;
        final String salt;
        final String hash;
        final String recoveryQuestionId;
        final int recoveryIterations;
        final String recoverySalt;
        final String recoveryHash;

        Identity(String username, String displayName, int iterations, String salt, String hash,
                 String recoveryQuestionId, int recoveryIterations, String recoverySalt, String recoveryHash) {
            this.username = username;
            this.displayName = displayName;
            this.iterations = iterations;
            this.salt = salt;
            this.hash = hash;
            this.recoveryQuestionId = recoveryQuestionId;
            this.recoveryIterations = recoveryIterations;
            this.recoverySalt = recoverySalt;
            this.recoveryHash = recoveryHash;
        }
    }
}
