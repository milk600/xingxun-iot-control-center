package com.xingxun.iotcontrol;

import android.app.Activity;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Native transport used by the packaged Android runtime.
 *
 * The React bundle calls only the two configured cloud services: Huawei IoTDA
 * device shadow and DeepSeek. Fun-ASR uses a native WebSocket because browser
 * WebSockets cannot attach the required Authorization header.
 */
final class AndroidCloudBridge {
    private static final MediaType JSON = MediaType.parse("application/json; charset=utf-8");
    private static final String CLOUD_EVENT = "xingxun:native-cloud";
    private static final String ASR_EVENT = "xingxun:native-asr";
    private static final String LIFECYCLE_EVENT = "xingxun:native-lifecycle";
    private static final int MAX_QUEUED_AUDIO_CHUNKS = 160;
    private static final long ASR_CONNECT_TIMEOUT_MS = 10_000L;
    private static final long ASR_START_TIMEOUT_MS = 10_000L;
    private static final long ASR_FINISH_TIMEOUT_MS = 8_000L;

    private final Activity activity;
    private final WebView webView;
    private final OkHttpClient httpClient;
    private final ConcurrentHashMap<String, Call> calls = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, AsrSession> asrSessions = new ConcurrentHashMap<>();

    AndroidCloudBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.httpClient = new OkHttpClient.Builder()
                .connectTimeout(8, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(90, java.util.concurrent.TimeUnit.SECONDS)
                .writeTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                .build();
    }

    @JavascriptInterface
    public String getRuntimeConfig() {
        JSONObject value = new JSONObject();
        try {
            value.put("android", true);
            value.put("iotConfigured", hasHuaweiConfiguration());
            value.put("deepSeekConfigured", !BuildConfig.DEEPSEEK_API_KEY.trim().isEmpty());
            value.put("asrConfigured", !BuildConfig.DASHSCOPE_API_KEY.trim().isEmpty());
            value.put("serviceId", BuildConfig.HUAWEI_IOTDA_SERVICE_ID);
            value.put("staleAfterMs", BuildConfig.HUAWEI_IOTDA_STALE_AFTER_MS);
            value.put("offlineAfterMs", BuildConfig.HUAWEI_IOTDA_OFFLINE_AFTER_MS);
            value.put("deepSeekBaseUrl", BuildConfig.DEEPSEEK_BASE_URL);
            value.put("asrModel", BuildConfig.FUN_ASR_MODEL);
            value.put("jetsonWsUrl", BuildConfig.JETSON_WS_URL);
        } catch (JSONException ignored) {
            return "{}";
        }
        return value.toString();
    }

    @JavascriptInterface
    public void setActiveRoute(String path) {
        if (!(activity instanceof MainActivity)) return;
        ((MainActivity) activity).updateActiveRoute(path);
    }

    @JavascriptInterface
    public void setAgentActivity(String phase, boolean active) {
        if (!(activity instanceof MainActivity)) return;
        ((MainActivity) activity).updateAgentActivity(phase, active);
    }

    @JavascriptInterface
    public void saveDataUrl(String dataUrl, String requestedName) {
        if (!(activity instanceof MainActivity)) return;
        ((MainActivity) activity).saveDataUrl(dataUrl, requestedName);
    }

    @JavascriptInterface
    public void saveTextFile(String content, String requestedName, String mimeType) {
        if (!(activity instanceof MainActivity)) return;
        ((MainActivity) activity).saveTextFile(content, requestedName, mimeType);
    }

    @JavascriptInterface
    public void readIotShadow(String requestId) {
        if (!validRequestId(requestId)) return;
        if (!hasHuaweiConfiguration()) {
            dispatchCloudError(requestId, "Android 构建中缺少华为云 IoTDA 配置");
            return;
        }
        try {
            HttpUrl endpoint = HttpUrl.parse(BuildConfig.HUAWEI_IOTDA_ENDPOINT);
            if (endpoint == null || !"https".equalsIgnoreCase(endpoint.scheme())) {
                throw new IllegalArgumentException("华为云 IoTDA 地址无效");
            }
            HttpUrl url = endpoint.newBuilder()
                    .addPathSegments("v5/iot")
                    .addPathSegment(BuildConfig.HUAWEI_IOTDA_PROJECT_ID)
                    .addPathSegments("devices")
                    .addPathSegment(BuildConfig.HUAWEI_IOTDA_DEVICE_ID)
                    .addPathSegment("shadow")
                    .build();
            Request request = signedHuaweiRequest(url);
            enqueue(requestId, request);
        } catch (Exception error) {
            dispatchCloudError(requestId, publicMessage(error, "无法创建华为云请求"));
        }
    }

    @JavascriptInterface
    public void requestDeepSeek(String requestId, String body) {
        if (!validRequestId(requestId)) return;
        if (BuildConfig.DEEPSEEK_API_KEY.trim().isEmpty()) {
            dispatchCloudError(requestId, "Android 构建中缺少 DEEPSEEK_API_KEY");
            return;
        }
        try {
            String base = BuildConfig.DEEPSEEK_BASE_URL.replaceAll("/+$", "");
            HttpUrl url = HttpUrl.parse(base + "/chat/completions");
            if (url == null || !"https".equalsIgnoreCase(url.scheme())) {
                throw new IllegalArgumentException("DeepSeek 地址无效");
            }
            Request request = new Request.Builder()
                    .url(url)
                    .header("Authorization", "Bearer " + BuildConfig.DEEPSEEK_API_KEY)
                    .header("Content-Type", "application/json")
                    .post(RequestBody.create(JSON, body == null ? "{}" : body))
                    .build();
            enqueue(requestId, request);
        } catch (Exception error) {
            dispatchCloudError(requestId, publicMessage(error, "无法创建 DeepSeek 请求"));
        }
    }

    @JavascriptInterface
    public void cancelRequest(String requestId) {
        Call call = calls.remove(requestId);
        if (call != null) call.cancel();
    }

    @JavascriptInterface
    public void startAsr(String sessionId) {
        if (!validRequestId(sessionId)) return;
        if (BuildConfig.DASHSCOPE_API_KEY.trim().isEmpty()) {
            dispatchAsr(sessionId, "error", null, "Android 构建中缺少 DASHSCOPE_API_KEY");
            return;
        }
        AsrSession previous = asrSessions.remove(sessionId);
        if (previous != null) previous.close();
        AsrSession session = new AsrSession(sessionId);
        asrSessions.put(sessionId, session);
        session.open();
    }

    @JavascriptInterface
    public void sendAsrAudio(String sessionId, String base64Audio) {
        AsrSession session = asrSessions.get(sessionId);
        if (session == null || base64Audio == null || base64Audio.isEmpty()) return;
        try {
            byte[] audio = Base64.decode(base64Audio, Base64.DEFAULT);
            if (audio.length > 0) session.push(ByteString.of(audio));
        } catch (IllegalArgumentException ignored) {
            dispatchAsr(sessionId, "error", null, "语音音频格式无效");
        }
    }

    @JavascriptInterface
    public void finishAsr(String sessionId) {
        AsrSession session = asrSessions.get(sessionId);
        if (session != null) session.finish();
    }

    void onHostPause() {
        String message = "应用已进入后台，请返回后重试";
        dispatchLifecycle("paused", message);
        for (Map.Entry<String, Call> entry : new ArrayList<>(calls.entrySet())) {
            if (!calls.remove(entry.getKey(), entry.getValue())) continue;
            entry.getValue().cancel();
            dispatchCloudCancellation(entry.getKey(), message);
        }
        for (Map.Entry<String, AsrSession> entry : new ArrayList<>(asrSessions.entrySet())) {
            if (!asrSessions.remove(entry.getKey(), entry.getValue())) continue;
            entry.getValue().cancelForLifecycle(message);
        }
    }

    void onHostResume() {
        dispatchLifecycle("resumed", null);
    }

    void close() {
        for (Call call : calls.values()) call.cancel();
        calls.clear();
        for (AsrSession session : asrSessions.values()) session.close();
        asrSessions.clear();
        httpClient.dispatcher().cancelAll();
    }

    private boolean hasHuaweiConfiguration() {
        return !BuildConfig.HUAWEI_IOTDA_ENDPOINT.trim().isEmpty()
                && !BuildConfig.HUAWEI_IOTDA_PROJECT_ID.trim().isEmpty()
                && !BuildConfig.HUAWEI_IOTDA_DEVICE_ID.trim().isEmpty()
                && !BuildConfig.HUAWEI_IOTDA_AK.trim().isEmpty()
                && !BuildConfig.HUAWEI_IOTDA_SK.trim().isEmpty();
    }

    private Request signedHuaweiRequest(HttpUrl url) throws Exception {
        String sdkDate = utcTimestamp();
        TreeMap<String, String> signed = new TreeMap<>();
        signed.put("content-type", "application/json");
        signed.put("host", url.host() + (url.port() == HttpUrl.defaultPort(url.scheme()) ? "" : ":" + url.port()));
        if (!BuildConfig.HUAWEI_IOTDA_INSTANCE_ID.trim().isEmpty()) {
            signed.put("instance-id", BuildConfig.HUAWEI_IOTDA_INSTANCE_ID.trim());
        }
        signed.put("x-sdk-date", sdkDate);

        StringBuilder canonicalHeaders = new StringBuilder();
        StringBuilder signedHeaders = new StringBuilder();
        for (Map.Entry<String, String> entry : signed.entrySet()) {
            canonicalHeaders.append(entry.getKey()).append(':').append(entry.getValue().trim()).append('\n');
            if (signedHeaders.length() > 0) signedHeaders.append(';');
            signedHeaders.append(entry.getKey());
        }

        String canonicalRequest = "GET\n"
                + canonicalUri(url) + "\n"
                + canonicalQuery(url) + "\n"
                + canonicalHeaders + "\n"
                + signedHeaders + "\n"
                + sha256Hex("");
        boolean derived = url.host().contains(".st1.");
        String authorization;
        if (derived) {
            String info = sdkDate.substring(0, 8) + "/" + BuildConfig.HUAWEI_IOTDA_REGION_ID + "/iotdm";
            String stringToSign = "V11-HMAC-SHA256\n" + sdkDate + "\n" + info + "\n" + sha256Hex(canonicalRequest);
            String derivedKey = hkdfDerivedKey(BuildConfig.HUAWEI_IOTDA_AK, BuildConfig.HUAWEI_IOTDA_SK, info);
            String signature = hmacSha256Hex(derivedKey, stringToSign);
            authorization = "V11-HMAC-SHA256 Credential=" + BuildConfig.HUAWEI_IOTDA_AK + "/" + info
                    + ", SignedHeaders=" + signedHeaders
                    + ", Signature=" + signature;
        } else {
            String stringToSign = "SDK-HMAC-SHA256\n" + sdkDate + "\n" + sha256Hex(canonicalRequest);
            String signature = hmacSha256Hex(BuildConfig.HUAWEI_IOTDA_SK, stringToSign);
            authorization = "SDK-HMAC-SHA256 Access=" + BuildConfig.HUAWEI_IOTDA_AK
                    + ", SignedHeaders=" + signedHeaders
                    + ", Signature=" + signature;
        }

        Request.Builder builder = new Request.Builder()
                .url(url)
                .get()
                .header("Host", signed.get("host"))
                .header("Content-Type", signed.get("content-type"))
                .header("X-Sdk-Date", sdkDate)
                .header("Authorization", authorization)
                .header("Content-Type", "application/json");
        if (signed.containsKey("instance-id")) {
            builder.header("Instance-Id", signed.get("instance-id"));
        }
        return builder.build();
    }

    private void enqueue(String requestId, Request request) {
        Call call = httpClient.newCall(request);
        Call previous = calls.put(requestId, call);
        if (previous != null) previous.cancel();
        call.enqueue(new Callback() {
            @Override
            public void onFailure(Call failedCall, IOException error) {
                if (!calls.remove(requestId, failedCall)) return;
                if (!failedCall.isCanceled()) {
                    dispatchCloudError(requestId, publicMessage(error, "云端请求失败"));
                }
            }

            @Override
            public void onResponse(Call completedCall, Response response) {
                if (!calls.remove(requestId, completedCall)) {
                    response.close();
                    return;
                }
                String body = "";
                try (ResponseBody responseBody = response.body()) {
                    if (responseBody != null) body = responseBody.string();
                } catch (IOException error) {
                    dispatchCloudError(requestId, "云端响应读取失败");
                    response.close();
                    return;
                }
                dispatchCloud(requestId, response.code(), body, response.isSuccessful() ? null : responseMessage(body, response.code()));
                response.close();
            }
        });
    }

    private final class AsrSession extends WebSocketListener {
        private final String sessionId;
        private final String taskId = java.util.UUID.randomUUID().toString();
        private final ArrayDeque<ByteString> queuedAudio = new ArrayDeque<>();
        private final List<String> finalSentences = new ArrayList<>();
        private final Runnable connectWatchdog = () -> fail("语音识别连接超时，请重试");
        private final Runnable startWatchdog = () -> fail("语音识别服务启动超时，请重试");
        private final Runnable finishWatchdog = this::complete;
        private WebSocket socket;
        private boolean opened;
        private boolean started;
        private boolean readyDispatched;
        private boolean finishing;
        private boolean finishSent;
        private boolean terminalDispatched;
        private boolean closed;
        private String latestTranscript = "";

        AsrSession(String sessionId) {
            this.sessionId = sessionId;
        }

        synchronized void open() {
            if (closed) return;
            try {
                Request request = new Request.Builder()
                        .url(BuildConfig.FUN_ASR_WS_URL)
                        .header("Authorization", "Bearer " + BuildConfig.DASHSCOPE_API_KEY)
                        .build();
                webView.postDelayed(connectWatchdog, ASR_CONNECT_TIMEOUT_MS);
                socket = httpClient.newWebSocket(request, this);
            } catch (RuntimeException error) {
                fail(publicMessage(error, "无法创建语音识别连接"));
            }
        }

        @Override
        public synchronized void onOpen(WebSocket webSocket, Response response) {
            if (closed) {
                webSocket.close(1000, "session closed");
                return;
            }
            socket = webSocket;
            opened = true;
            webView.removeCallbacks(connectWatchdog);
            try {
                JSONObject header = new JSONObject()
                        .put("action", "run-task")
                        .put("task_id", taskId)
                        .put("streaming", "duplex");
                JSONObject parameters = new JSONObject()
                        .put("format", "pcm")
                        .put("sample_rate", 16000)
                        .put("language_hints", new JSONArray().put("zh"))
                        .put("semantic_punctuation_enabled", false)
                        .put("max_sentence_silence", 500);
                JSONObject context = new JSONObject()
                        .put("role", "user")
                        .put("content", new JSONArray().put(new JSONObject()
                                .put("type", "input_text")
                                .put("text", "危化智巡，空间孪生，数据位，华为云，巡检小车，俯视，缺口诊断")));
                JSONObject payload = new JSONObject()
                        .put("task_group", "audio")
                        .put("task", "asr")
                        .put("function", "recognition")
                        .put("model", BuildConfig.FUN_ASR_MODEL)
                        .put("parameters", parameters)
                        .put("input", new JSONObject().put("context", new JSONArray().put(context)));
                JSONObject request = new JSONObject().put("header", header).put("payload", payload);
                if (!webSocket.send(request.toString())) {
                    fail("语音识别启动请求发送失败，请重试");
                    return;
                }
                webView.postDelayed(startWatchdog, ASR_START_TIMEOUT_MS);
            } catch (JSONException error) {
                fail("语音识别请求创建失败");
            }
        }

        @Override
        public synchronized void onMessage(WebSocket webSocket, String text) {
            if (closed || terminalDispatched) return;
            try {
                JSONObject message = new JSONObject(text);
                JSONObject header = message.optJSONObject("header");
                String event = header == null ? "" : header.optString("event", "");
                if ("task-started".equals(event)) {
                    if (started) return;
                    started = true;
                    webView.removeCallbacks(startWatchdog);
                    while (!queuedAudio.isEmpty()) {
                        if (!webSocket.send(queuedAudio.removeFirst())) {
                            fail("语音音频发送失败，请重试");
                            return;
                        }
                    }
                    if (!readyDispatched) {
                        readyDispatched = true;
                        dispatchAsr(sessionId, "ready", null, null);
                    }
                    if (finishing) finishNow();
                    return;
                }
                if ("result-generated".equals(event)) {
                    JSONObject payload = message.optJSONObject("payload");
                    JSONObject output = payload == null ? null : payload.optJSONObject("output");
                    JSONObject sentence = output == null ? null : output.optJSONObject("sentence");
                    if (sentence == null || sentence.optBoolean("heartbeat", false)) return;
                    String value = sentence.optString("text", "").trim();
                    if (value.isEmpty()) return;
                    latestTranscript = value;
                    dispatchAsr(sessionId, "partial", value, null);
                    if (sentence.optBoolean("sentence_end", false)) {
                        finalSentences.add(value);
                        dispatchAsr(sessionId, "final", value, null);
                    }
                    return;
                }
                if ("task-finished".equals(event)) {
                    complete();
                    return;
                }
                if ("task-failed".equals(event)) {
                    fail(header == null ? "语音识别失败" : header.optString("error_message", "语音识别失败"));
                }
            } catch (JSONException ignored) {
                // Ignore unrelated protocol frames.
            }
        }

        @Override
        public synchronized void onFailure(WebSocket webSocket, Throwable error, Response response) {
            if (closed || terminalDispatched) return;
            fail(publicMessage(error, "语音识别连接失败"));
        }

        @Override
        public synchronized void onClosed(WebSocket webSocket, int code, String reason) {
            if (closed || terminalDispatched) return;
            if (finishing) complete();
            else fail("语音识别连接已关闭，请重试");
        }

        synchronized void push(ByteString audio) {
            if (closed || terminalDispatched || finishing || audio == null || audio.size() == 0) return;
            if (started && socket != null) {
                if (!socket.send(audio)) fail("语音音频发送失败，请重试");
            } else if (queuedAudio.size() < MAX_QUEUED_AUDIO_CHUNKS) {
                queuedAudio.addLast(audio);
            }
        }

        synchronized void finish() {
            if (closed || terminalDispatched || finishing) return;
            finishing = true;
            if (!started && queuedAudio.isEmpty()) {
                complete("");
                return;
            }
            webView.postDelayed(finishWatchdog, ASR_FINISH_TIMEOUT_MS);
            if (started) finishNow();
        }

        private synchronized void finishNow() {
            if (closed || terminalDispatched || finishSent) return;
            if (!opened || socket == null) return;
            finishSent = true;
            try {
                JSONObject value = new JSONObject()
                        .put("header", new JSONObject()
                                .put("action", "finish-task")
                                .put("task_id", taskId)
                                .put("streaming", "duplex"))
                        .put("payload", new JSONObject().put("input", new JSONObject()));
                if (!socket.send(value.toString())) complete();
            } catch (JSONException error) {
                complete();
            }
        }

        private synchronized void complete() {
            complete(currentTranscript());
        }

        private synchronized void complete(String text) {
            if (closed || terminalDispatched) return;
            terminalDispatched = true;
            dispose(false);
            dispatchAsr(sessionId, "finished", text == null ? "" : text.trim(), null);
        }

        synchronized void fail(String message) {
            if (closed || terminalDispatched) return;
            terminalDispatched = true;
            dispose(true);
            dispatchAsr(sessionId, "error", null, message);
        }

        synchronized void cancelForLifecycle(String message) {
            fail(message);
        }

        synchronized void close() {
            if (closed) return;
            terminalDispatched = true;
            dispose(false);
        }

        private String currentTranscript() {
            String finalText = join(finalSentences).trim();
            return finalText.isEmpty() ? latestTranscript.trim() : finalText;
        }

        private void dispose(boolean cancel) {
            if (closed) return;
            closed = true;
            webView.removeCallbacks(connectWatchdog);
            webView.removeCallbacks(startWatchdog);
            webView.removeCallbacks(finishWatchdog);
            if (asrSessions.get(sessionId) == this) asrSessions.remove(sessionId);
            WebSocket activeSocket = socket;
            socket = null;
            queuedAudio.clear();
            if (activeSocket == null) return;
            if (cancel || !opened) activeSocket.cancel();
            else activeSocket.close(1000, "session complete");
        }
    }

    private void dispatchCloudError(String requestId, String error) {
        dispatchCloud(requestId, 0, "", error);
    }

    private void dispatchCloudCancellation(String requestId, String message) {
        dispatchCloud(requestId, 0, "", message, true);
    }

    private void dispatchCloud(String requestId, int status, String body, String error) {
        dispatchCloud(requestId, status, body, error, false);
    }

    private void dispatchCloud(String requestId, int status, String body, String error, boolean cancelled) {
        JSONObject detail = new JSONObject();
        try {
            detail.put("requestId", requestId);
            detail.put("status", status);
            detail.put("body", body == null ? "" : body);
            if (error != null) detail.put("error", error);
            if (cancelled) detail.put("cancelled", true);
        } catch (JSONException ignored) {
            return;
        }
        dispatch(CLOUD_EVENT, detail);
    }

    private void dispatchAsr(String sessionId, String type, String text, String error) {
        JSONObject detail = new JSONObject();
        try {
            detail.put("sessionId", sessionId);
            detail.put("type", type);
            if (text != null) detail.put("text", text);
            if (error != null) detail.put("error", error);
        } catch (JSONException ignored) {
            return;
        }
        dispatch(ASR_EVENT, detail);
    }

    private void dispatchLifecycle(String state, String reason) {
        JSONObject detail = new JSONObject();
        try {
            detail.put("state", state);
            if (reason != null) detail.put("reason", reason);
        } catch (JSONException ignored) {
            return;
        }
        dispatch(LIFECYCLE_EVENT, detail);
    }

    private void dispatch(String eventName, JSONObject detail) {
        String script = "window.dispatchEvent(new CustomEvent(" + JSONObject.quote(eventName)
                + ",{detail:" + detail.toString() + "}));";
        activity.runOnUiThread(() -> {
            if (!activity.isFinishing()) webView.evaluateJavascript(script, null);
        });
    }

    private static String canonicalUri(HttpUrl url) throws Exception {
        String path = url.encodedPath();
        if (path == null || path.isEmpty()) return "/";
        return path.endsWith("/") ? path : path + "/";
    }

    private static String canonicalQuery(HttpUrl url) throws Exception {
        if (url.querySize() == 0) return "";
        List<String> values = new ArrayList<>();
        for (int index = 0; index < url.querySize(); index++) {
            String name = url.queryParameterName(index);
            String value = url.queryParameterValue(index);
            values.add(rfc3986(name) + "=" + rfc3986(value == null ? "" : value));
        }
        java.util.Collections.sort(values);
        return join(values, "&");
    }

    private static String rfc3986(String value) throws Exception {
        return URLEncoder.encode(value, "UTF-8")
                .replace("+", "%20")
                .replace("%7E", "~");
    }

    private static String utcTimestamp() {
        SimpleDateFormat format = new SimpleDateFormat("yyyyMMdd'T'HHmmss'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }

    private static String sha256Hex(String value) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        return hex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
    }

    private static String hmacSha256Hex(String secret, String value) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return hex(mac.doFinal(value.getBytes(StandardCharsets.UTF_8)));
    }

    private static String hkdfDerivedKey(String accessKey, String secretKey, String info) throws Exception {
        Mac extract = Mac.getInstance("HmacSHA256");
        extract.init(new SecretKeySpec(accessKey.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] pseudoRandomKey = extract.doFinal(secretKey.getBytes(StandardCharsets.UTF_8));
        Mac expand = Mac.getInstance("HmacSHA256");
        expand.init(new SecretKeySpec(pseudoRandomKey, "HmacSHA256"));
        byte[] infoBytes = info.getBytes(StandardCharsets.UTF_8);
        byte[] input = new byte[infoBytes.length + 1];
        System.arraycopy(infoBytes, 0, input, 0, infoBytes.length);
        input[input.length - 1] = 0x01;
        return hex(expand.doFinal(input));
    }

    private static String hex(byte[] value) {
        StringBuilder output = new StringBuilder(value.length * 2);
        for (byte item : value) output.append(String.format(Locale.US, "%02x", item & 0xff));
        return output.toString();
    }

    private static boolean validRequestId(String value) {
        return value != null && value.matches("[A-Za-z0-9_.:-]{1,100}");
    }

    private static String responseMessage(String body, int status) {
        try {
            JSONObject payload = new JSONObject(body);
            String message = payload.optString("error_msg", payload.optString("message", ""));
            if (!message.isEmpty()) return message;
            JSONObject error = payload.optJSONObject("error");
            if (error != null && !error.optString("message", "").isEmpty()) return error.optString("message");
        } catch (JSONException ignored) {
            // Fall through to the HTTP status.
        }
        return "云端请求失败（HTTP " + status + "）";
    }

    private static String publicMessage(Throwable error, String fallback) {
        String message = error == null ? null : error.getMessage();
        return message == null || message.trim().isEmpty() ? fallback : message.trim();
    }

    private static String join(List<String> values) {
        return join(values, "");
    }

    private static String join(List<String> values, String separator) {
        StringBuilder output = new StringBuilder();
        for (String value : values) {
            if (output.length() > 0) output.append(separator);
            output.append(value);
        }
        return output.toString();
    }
}
