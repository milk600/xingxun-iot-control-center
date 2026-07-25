package com.xingxun.iotcontrol;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.hardware.input.InputManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import org.json.JSONObject;

/**
 * Offline-first native shell for the packaged React control center.
 *
 * The WebView loads only APK assets from a synthetic secure origin. The
 * React UI, local IoT provider, route transitions, WebGL viewer and room PLY
 * files are all bundled under assets/web, so no PC or Node server is needed.
 */
public class MainActivity extends Activity implements InputManager.InputDeviceListener {
    private static final int FILE_CHOOSER_REQUEST = 4101;
    private static final int WEB_MEDIA_PERMISSION_REQUEST = 4102;
    private static final String OFFLINE_ORIGIN = "https://xingxun.local";
    private static final String OFFLINE_ENTRY = OFFLINE_ORIGIN + "/";
    private static final String ASSET_ROOT = "web/";
    private static final int MAX_TEXT_EXPORT_BYTES = 10 * 1024 * 1024;
    private static final long BACK_DISPATCH_TIMEOUT_MS = 350L;

    private FrameLayout rootContainer;
    private WebView webView;
    private LocalAuthBridge localAuthBridge;
    private AndroidCloudBridge cloudBridge;
    private View startupPanel;
    private TextView startupStatus;
    private Button retryButton;
    private Button exitButton;

    private ValueCallback<Uri[]> pendingFileCallback;
    private PermissionRequest pendingPermissionRequest;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private boolean pageReady;
    private boolean mainFrameFailed;
    private boolean backDispatchPending;
    private int backDispatchSequence;
    private InputManager inputManager;
    private int activeGamepadDeviceId = -1;
    private float gamepadX;
    private float gamepadY;
    private float gamepadDpadX;
    private float gamepadDpadY;
    private final Set<Integer> pressedGamepadDirections = new HashSet<>();
    private final Set<String> activeAgentActivities = new HashSet<>();
    private String activeRoutePath = "";
    private boolean hostResumed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.activity_main);

        rootContainer = findViewById(R.id.rootContainer);
        webView = findViewById(R.id.webView);
        startupPanel = findViewById(R.id.connectionPanel);
        startupStatus = findViewById(R.id.connectionStatus);
        retryButton = findViewById(R.id.retryButton);
        exitButton = findViewById(R.id.cancelButton);

        configureWindow(false, false);
        configureWebView();
        inputManager = (InputManager) getSystemService(Context.INPUT_SERVICE);
        if (inputManager != null) inputManager.registerInputDeviceListener(this, null);

        retryButton.setOnClickListener(view -> loadApplication());
        exitButton.setOnClickListener(view -> finish());

        if (savedInstanceState != null && webView.restoreState(savedInstanceState) != null) {
            pageReady = true;
            webView.setAlpha(1f);
            startupPanel.setVisibility(View.GONE);
            updateSystemBars(webView.getUrl());
        } else {
            loadApplication();
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "ObsoleteSdkInt"})
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccess(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " XingXunAndroidOffline/2.0");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.setBackgroundColor(getColorCompat(R.color.app_background));
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setWebViewClient(createWebViewClient());
        webView.setWebChromeClient(createWebChromeClient());
        webView.setDownloadListener(createDownloadListener());
        localAuthBridge = new LocalAuthBridge(this, webView);
        cloudBridge = new AndroidCloudBridge(this, webView);
        webView.addJavascriptInterface(localAuthBridge, "XingXunAuth");
        webView.addJavascriptInterface(cloudBridge, "XingXunCloud");
    }

    private WebViewClient createWebViewClient() {
        return new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view,
                    WebResourceRequest request
            ) {
                WebResourceResponse response = openOfflineResource(request.getUrl());
                return response != null ? response : super.shouldInterceptRequest(view, request);
            }

            @Override
            @SuppressWarnings("deprecation")
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                WebResourceResponse response = openOfflineResource(Uri.parse(url));
                return response != null ? response : super.shouldInterceptRequest(view, url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternalIfNeeded(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openExternalIfNeeded(Uri.parse(url));
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                if (isTrustedUrl(url)) {
                    mainFrameFailed = false;
                    activeAgentActivities.clear();
                    updateSystemBars(url);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (!mainFrameFailed && isTrustedUrl(url)) {
                    pageReady = true;
                    hideStartupPanel();
                    view.animate().alpha(1f).setDuration(180L).start();
                    updateSystemBars(url);
                    dispatchConnectedGamepad();
                }
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(
                    WebView view,
                    int errorCode,
                    String description,
                    String failingUrl
            ) {
                super.onReceivedError(view, errorCode, description, failingUrl);
                if (failingUrl != null && failingUrl.equals(view.getUrl())) {
                    mainFrameFailed = true;
                    showStartupError(getString(R.string.offline_load_failed));
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                mainFrameFailed = true;
                showStartupError(getString(R.string.offline_load_failed));
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                super.doUpdateVisitedHistory(view, url, isReload);
                // The packaged app is a SPA. Once React is ready, history
                // callbacks may report the previous synthetic URL after a
                // pushState; the explicit, validated route bridge below is
                // the authoritative source for window flags.
                if (!pageReady) updateSystemBars(url);
            }
        };
    }

    private WebChromeClient createWebChromeClient() {
        return new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams
            ) {
                if (pendingFileCallback != null) pendingFileCallback.onReceiveValue(null);
                pendingFileCallback = filePathCallback;

                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(
                        Intent.EXTRA_ALLOW_MULTIPLE,
                        fileChooserParams.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE
                );
                String[] accepted = cleanMimeTypes(fileChooserParams.getAcceptTypes());
                if (accepted.length == 1) intent.setType(accepted[0]);
                else if (accepted.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, accepted);

                try {
                    startActivityForResult(
                            Intent.createChooser(intent, getString(R.string.file_chooser_title)),
                            FILE_CHOOSER_REQUEST
                    );
                    return true;
                } catch (ActivityNotFoundException error) {
                    pendingFileCallback = null;
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handleWebPermissionRequest(request));
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingPermissionRequest == request) pendingPermissionRequest = null;
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                rootContainer.addView(
                        view,
                        new FrameLayout.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT,
                                ViewGroup.LayoutParams.MATCH_PARENT
                        )
                );
                webView.setVisibility(View.INVISIBLE);
                enterImmersiveMode();
            }

            @Override
            public void onHideCustomView() {
                hideCustomView();
            }
        };
    }

    private WebResourceResponse openOfflineResource(Uri uri) {
        if (uri == null || !isTrustedUri(uri)) return null;
        String path = uri.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
        path = Uri.decode(path);
        while (path.startsWith("/")) path = path.substring(1);
        if (path.contains("..")) return errorResponse(403, "Forbidden");

        InputStream input = openAsset(path);
        String resolvedPath = path;
        if (input == null && isApplicationRoute(path)) {
            resolvedPath = "index.html";
            input = openAsset(resolvedPath);
        }
        if (input == null) return errorResponse(404, "Not Found");

        String mimeType = mimeTypeFor(resolvedPath);
        String encoding = mimeType.startsWith("text/")
                || mimeType.contains("javascript")
                || mimeType.contains("json")
                ? "UTF-8"
                : null;
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", OFFLINE_ORIGIN);
        headers.put(
                "Cache-Control",
                "index.html".equals(resolvedPath) ? "no-cache" : "public, max-age=31536000"
        );
        return new WebResourceResponse(mimeType, encoding, 200, "OK", headers, input);
    }

    private InputStream openAsset(String relativePath) {
        try {
            return getAssets().open(ASSET_ROOT + relativePath, AssetManager.ACCESS_STREAMING);
        } catch (IOException error) {
            return null;
        }
    }

    private boolean isApplicationRoute(String path) {
        return !path.startsWith("api/")
                && !path.startsWith("models/")
                && !path.startsWith("assets/")
                && !path.substring(path.lastIndexOf('/') + 1).contains(".");
    }

    private WebResourceResponse errorResponse(int status, String reason) {
        byte[] body = reason.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        return new WebResourceResponse(
                "text/plain",
                "UTF-8",
                status,
                reason,
                Collections.singletonMap("Cache-Control", "no-store"),
                new ByteArrayInputStream(body)
        );
    }

    private String mimeTypeFor(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".wasm")) return "application/wasm";
        if (lower.endsWith(".ply") || lower.endsWith(".glb") || lower.endsWith(".splat")) {
            return "application/octet-stream";
        }
        return "application/octet-stream";
    }

    private boolean openExternalIfNeeded(Uri uri) {
        if (isTrustedUri(uri)) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, uri.toString(), Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private DownloadListener createDownloadListener() {
        return (url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (url == null) return;
            if (url.startsWith("data:")) {
                saveDataUrl(url, URLUtil.guessFileName(dataUrlFallbackName(mimeType), contentDisposition, mimeType));
                return;
            }
            Uri uri = Uri.parse(url);
            if (!"http".equalsIgnoreCase(uri.getScheme())
                    && !"https".equalsIgnoreCase(uri.getScheme())) {
                Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show();
                return;
            }

            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request request = new DownloadManager.Request(uri);
            request.setTitle(fileName);
            request.setMimeType(mimeType);
            request.addRequestHeader("User-Agent", userAgent);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (manager != null) {
                manager.enqueue(request);
                Toast.makeText(this, getString(R.string.download_saved, fileName), Toast.LENGTH_LONG).show();
            }
        };
    }

    private void loadApplication() {
        pageReady = false;
        mainFrameFailed = false;
        webView.setAlpha(0f);
        startupStatus.setText(R.string.offline_loading);
        retryButton.setVisibility(View.GONE);
        startupPanel.setVisibility(View.VISIBLE);
        startupPanel.setAlpha(1f);
        webView.loadUrl(OFFLINE_ENTRY);
    }

    private void showStartupError(String message) {
        startupStatus.setText(message);
        retryButton.setVisibility(View.VISIBLE);
        startupPanel.setVisibility(View.VISIBLE);
        startupPanel.animate().alpha(1f).setDuration(180L).start();
    }

    private void hideStartupPanel() {
        if (startupPanel.getVisibility() != View.VISIBLE) return;
        webView.requestFocus();
        InputMethodManager inputMethodManager =
                (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (inputMethodManager != null) {
            inputMethodManager.hideSoftInputFromWindow(webView.getWindowToken(), 0);
        }
        startupPanel.animate()
                .alpha(0f)
                .setDuration(160L)
                .withEndAction(() -> startupPanel.setVisibility(View.GONE))
                .start();
    }

    private void handleWebPermissionRequest(PermissionRequest request) {
        if (!isTrustedUrl(request.getOrigin().toString())) {
            request.deny();
            return;
        }

        boolean wantsCamera = false;
        boolean wantsMicrophone = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) wantsCamera = true;
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) wantsMicrophone = true;
        }
        if (!wantsCamera && !wantsMicrophone) {
            request.deny();
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            ArrayList<String> missingPermissions = new ArrayList<>();
            if (wantsCamera && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                missingPermissions.add(Manifest.permission.CAMERA);
            }
            if (wantsMicrophone && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                missingPermissions.add(Manifest.permission.RECORD_AUDIO);
            }
            if (!missingPermissions.isEmpty()) {
                pendingPermissionRequest = request;
                requestPermissions(
                        missingPermissions.toArray(new String[0]),
                        WEB_MEDIA_PERMISSION_REQUEST
                );
                return;
            }
        }
        grantWebMediaRequest(request);
    }

    private void grantWebMediaRequest(PermissionRequest request) {
        ArrayList<String> allowed = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                    && (Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                    || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)) {
                allowed.add(resource);
            }
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                    && (Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                    || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)) {
                allowed.add(resource);
            }
        }
        if (allowed.isEmpty()) request.deny();
        else request.grant(allowed.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            String[] permissions,
            int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != WEB_MEDIA_PERMISSION_REQUEST || pendingPermissionRequest == null) return;
        PermissionRequest request = pendingPermissionRequest;
        pendingPermissionRequest = null;
        grantWebMediaRequest(request);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || pendingFileCallback == null) return;
        Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        pendingFileCallback.onReceiveValue(result);
        pendingFileCallback = null;
    }

    void saveDataUrl(String dataUrl, String requestedName) {
        new Thread(() -> {
            try {
                int separator = dataUrl.indexOf(',');
                if (separator < 0 || !dataUrl.substring(0, separator).contains(";base64")) {
                    throw new IOException("Unsupported data URL");
                }
                byte[] bytes = Base64.decode(dataUrl.substring(separator + 1), Base64.DEFAULT);
                File pictures = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
                if (pictures == null) throw new IOException("Pictures directory unavailable");
                if (!pictures.exists() && !pictures.mkdirs()) {
                    throw new IOException("Cannot create pictures directory");
                }
                File target = new File(pictures, sanitizeFileName(requestedName));
                try (FileOutputStream output = new FileOutputStream(target)) {
                    output.write(bytes);
                    output.flush();
                }
                runOnUiThread(() -> Toast.makeText(
                        this,
                        getString(R.string.download_saved, target.getAbsolutePath()),
                        Toast.LENGTH_LONG
                ).show());
            } catch (Exception error) {
                runOnUiThread(() -> Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show());
            }
        }, "xingxun-download").start();
    }

    void saveTextFile(String content, String requestedName, String mimeType) {
        final String safeContent = content == null ? "" : content;
        final String safeMimeType = normalizeTextMimeType(mimeType);
        final String safeFileName = ensureTextFileExtension(
                sanitizeFileName(requestedName, "xingxun-export-" + System.currentTimeMillis()),
                safeMimeType
        );
        new Thread(() -> {
            try {
                byte[] bytes = safeContent.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_TEXT_EXPORT_BYTES) {
                    throw new IOException("Text export exceeds the size limit");
                }
                String savedLocation = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        ? saveTextToDownloads(bytes, safeFileName, safeMimeType)
                        : saveTextToAppDownloads(bytes, safeFileName);
                runOnUiThread(() -> Toast.makeText(
                        this,
                        getString(R.string.download_saved, savedLocation),
                        Toast.LENGTH_LONG
                ).show());
            } catch (Exception error) {
                runOnUiThread(() -> Toast.makeText(
                        this,
                        R.string.download_failed,
                        Toast.LENGTH_SHORT
                ).show());
            }
        }, "xingxun-text-export").start();
    }

    @android.annotation.TargetApi(Build.VERSION_CODES.Q)
    private String saveTextToDownloads(byte[] bytes, String fileName, String mimeType)
            throws IOException {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
        values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
        values.put(
                MediaStore.Downloads.RELATIVE_PATH,
                Environment.DIRECTORY_DOWNLOADS + "/危化智巡"
        );
        values.put(MediaStore.Downloads.IS_PENDING, 1);

        Uri destination = getContentResolver().insert(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                values
        );
        if (destination == null) throw new IOException("Downloads provider unavailable");
        try {
            try (OutputStream output = getContentResolver().openOutputStream(destination, "w")) {
                if (output == null) throw new IOException("Cannot open export destination");
                output.write(bytes);
                output.flush();
            }
            ContentValues complete = new ContentValues();
            complete.put(MediaStore.Downloads.IS_PENDING, 0);
            getContentResolver().update(destination, complete, null, null);
            return Environment.DIRECTORY_DOWNLOADS + "/危化智巡/" + fileName;
        } catch (Exception error) {
            getContentResolver().delete(destination, null, null);
            if (error instanceof IOException) throw (IOException) error;
            throw new IOException("Cannot save text export", error);
        }
    }

    private String saveTextToAppDownloads(byte[] bytes, String fileName) throws IOException {
        File downloads = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (downloads == null) throw new IOException("Downloads directory unavailable");
        File directory = new File(downloads, "危化智巡");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("Cannot create Downloads directory");
        }
        File target = uniqueFile(directory, fileName);
        try (FileOutputStream output = new FileOutputStream(target)) {
            output.write(bytes);
            output.flush();
        }
        return target.getAbsolutePath();
    }

    private File uniqueFile(File directory, String fileName) {
        File target = new File(directory, fileName);
        if (!target.exists()) return target;
        int dot = fileName.lastIndexOf('.');
        String base = dot > 0 ? fileName.substring(0, dot) : fileName;
        String extension = dot > 0 ? fileName.substring(dot) : "";
        for (int suffix = 1; suffix < 1000; suffix++) {
            target = new File(directory, base + " (" + suffix + ")" + extension);
            if (!target.exists()) return target;
        }
        return new File(directory, base + "-" + System.currentTimeMillis() + extension);
    }

    private String sanitizeFileName(String value) {
        return sanitizeFileName(value, "capture-" + System.currentTimeMillis() + ".png");
    }

    private String sanitizeFileName(String value, String fallback) {
        if (value == null || value.trim().isEmpty()) return fallback;
        String safe = value
                .replaceAll("[\\p{Cntrl}\\\\/:*?\"<>|]", "-")
                .replaceAll("[. ]+$", "")
                .trim();
        if (safe.length() > 120) safe = safe.substring(0, 120);
        return safe.isEmpty() ? fallback : safe;
    }

    private String normalizeTextMimeType(String value) {
        String normalized = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        int parameters = normalized.indexOf(';');
        if (parameters >= 0) normalized = normalized.substring(0, parameters).trim();
        if ("text/csv".equals(normalized) || "application/csv".equals(normalized)) {
            return "text/csv";
        }
        if ("application/json".equals(normalized)) return "application/json";
        return "text/plain";
    }

    private String ensureTextFileExtension(String fileName, String mimeType) {
        String extension = "text/csv".equals(mimeType)
                ? ".csv"
                : ("application/json".equals(mimeType) ? ".json" : ".txt");
        return fileName.toLowerCase(Locale.ROOT).endsWith(extension)
                ? fileName
                : fileName + extension;
    }

    private String dataUrlFallbackName(String mimeType) {
        String normalized = mimeType == null ? "" : mimeType.toLowerCase(Locale.ROOT);
        if (normalized.contains("jpeg") || normalized.contains("jpg")) {
            return "vehicle-camera-" + System.currentTimeMillis() + ".jpg";
        }
        if (normalized.contains("png")) {
            return "capture-" + System.currentTimeMillis() + ".png";
        }
        return "download-" + System.currentTimeMillis();
    }

    private String[] cleanMimeTypes(String[] values) {
        ArrayList<String> result = new ArrayList<>();
        if (values != null) {
            for (String value : values) {
                if (value == null) continue;
                for (String token : value.split(",")) {
                    String mimeType = mimeTypeForAcceptToken(token);
                    if (mimeType != null && !result.contains(mimeType)) result.add(mimeType);
                }
            }
        }
        return result.toArray(new String[0]);
    }

    private String mimeTypeForAcceptToken(String token) {
        if (token == null) return null;
        String normalized = token.trim().toLowerCase(Locale.ROOT);
        if (normalized.isEmpty()) return null;
        switch (normalized) {
            case ".ply":
            case ".splat":
            case ".ksplat":
                return "application/octet-stream";
            case ".glb":
                return "model/gltf-binary";
            case ".gltf":
                return "model/gltf+json";
            case ".obj":
                return "model/obj";
            case ".png":
                return "image/png";
            case ".jpg":
            case ".jpeg":
                return "image/jpeg";
            case ".webp":
                return "image/webp";
            case ".gif":
                return "image/gif";
            case ".bmp":
                return "image/bmp";
            case ".heic":
                return "image/heic";
            case ".heif":
                return "image/heif";
            case ".svg":
                return "image/svg+xml";
            default:
                return normalized.matches("[a-z0-9.+-]+/[a-z0-9*.+-]+")
                        ? normalized
                        : null;
        }
    }

    private boolean isTrustedUrl(String candidate) {
        return candidate != null && isTrustedUri(Uri.parse(candidate));
    }

    private boolean isTrustedUri(Uri uri) {
        return uri != null
                && "https".equalsIgnoreCase(uri.getScheme())
                && "xingxun.local".equalsIgnoreCase(uri.getHost());
    }

    private void updateSystemBars(String url) {
        String path = url == null ? "" : Uri.parse(url).getPath();
        activeRoutePath = path == null ? "" : path;
        boolean digitalTwin = matchesRoute(path, "/digital-twin");
        boolean keepScreenOn = shouldKeepScreenOn(path);
        configureWindow(digitalTwin, keepScreenOn);
    }

    void updateActiveRoute(String path) {
        if (path == null
                || path.length() > 200
                || !path.startsWith("/")
                || path.indexOf('\n') >= 0
                || path.indexOf('\r') >= 0) {
            return;
        }
        runOnUiThread(() -> {
            activeRoutePath = path;
            boolean digitalTwin = matchesRoute(path, "/digital-twin");
            boolean keepScreenOn = shouldKeepScreenOn(path);
            // A route change is authoritative. Full-screen controls live only
            // on the vehicle/twin routes, which are already covered above.
            configureWindow(digitalTwin, keepScreenOn);
            if (matchesRoute(path, "/vehicle")) dispatchConnectedGamepad();
        });
    }

    void updateAgentActivity(String phase, boolean active) {
        if (!isAgentActivityPhase(phase)) return;
        runOnUiThread(() -> {
            if (active && !hostResumed) return;
            if (active) activeAgentActivities.add(phase);
            else activeAgentActivities.remove(phase);
            boolean digitalTwin = matchesRoute(activeRoutePath, "/digital-twin");
            configureWindow(digitalTwin, shouldKeepScreenOn(activeRoutePath));
        });
    }

    private boolean shouldKeepScreenOn(String path) {
        return customView != null
                || !activeAgentActivities.isEmpty()
                || matchesRoute(path, "/vehicle")
                || matchesRoute(path, "/monitoring")
                || matchesRoute(path, "/digital-twin");
    }

    private boolean isAgentActivityPhase(String phase) {
        return "recording".equals(phase)
                || "planning".equals(phase)
                || "executing".equals(phase)
                || "vehicle".equals(phase);
    }

    private boolean matchesRoute(String path, String route) {
        return path != null && (route.equals(path) || path.startsWith(route + "/"));
    }

    private void configureWindow(boolean dark, boolean keepScreenOn) {
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(dark ? Color.BLACK : getColorCompat(R.color.app_background));
        window.setNavigationBarColor(dark ? Color.BLACK : getColorCompat(R.color.app_background));
        webView.setKeepScreenOn(keepScreenOn);
        if (keepScreenOn) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        int flags = window.getDecorView().getSystemUiVisibility();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            else flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        window.getDecorView().setSystemUiVisibility(flags);
    }

    private void enterImmersiveMode() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }

    private void hideCustomView() {
        if (customView == null) return;
        rootContainer.removeView(customView);
        customView = null;
        webView.setVisibility(View.VISIBLE);
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
        updateSystemBars(webView.getUrl());
    }

    private void sendEmergencyStop() {
        if (!pageReady || webView == null || !isTrustedUrl(webView.getUrl())) return;
        String script = "(function(){try{window.dispatchEvent(new CustomEvent('xingxun:vehicle-stop-request',"
                + "{detail:{source:'android-lifecycle',requestedAt:new Date().toISOString()}}));}catch(e){}})();";
        webView.evaluateJavascript(script, null);
    }

    @Override
    public boolean dispatchGenericMotionEvent(MotionEvent event) {
        if (event != null
                && event.getAction() == MotionEvent.ACTION_MOVE
                && isGameController(event.getDevice())) {
            activeGamepadDeviceId = event.getDeviceId();
            gamepadX = centeredAxis(event, MotionEvent.AXIS_X);
            gamepadY = centeredAxis(event, MotionEvent.AXIS_Y);
            gamepadDpadX = centeredAxis(event, MotionEvent.AXIS_HAT_X);
            gamepadDpadY = centeredAxis(event, MotionEvent.AXIS_HAT_Y);
            dispatchGamepadConnection(event.getDevice(), true);
            dispatchGamepadInput(event.getDevice());
            return true;
        }
        return super.dispatchGenericMotionEvent(event);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event != null && isGameController(event.getDevice()) && isDirectionalGamepadKey(event.getKeyCode())) {
            activeGamepadDeviceId = event.getDeviceId();
            if (event.getAction() == KeyEvent.ACTION_DOWN) {
                pressedGamepadDirections.add(event.getKeyCode());
            } else if (event.getAction() == KeyEvent.ACTION_UP) {
                pressedGamepadDirections.remove(event.getKeyCode());
            }
            gamepadDpadX = (pressedGamepadDirections.contains(KeyEvent.KEYCODE_DPAD_RIGHT) ? 1f : 0f)
                    - (pressedGamepadDirections.contains(KeyEvent.KEYCODE_DPAD_LEFT) ? 1f : 0f);
            gamepadDpadY = (pressedGamepadDirections.contains(KeyEvent.KEYCODE_DPAD_DOWN) ? 1f : 0f)
                    - (pressedGamepadDirections.contains(KeyEvent.KEYCODE_DPAD_UP) ? 1f : 0f);
            dispatchGamepadConnection(event.getDevice(), true);
            dispatchGamepadInput(event.getDevice());
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onInputDeviceAdded(int deviceId) {
        InputDevice device = InputDevice.getDevice(deviceId);
        if (isGameController(device)) {
            if (activeGamepadDeviceId < 0) activeGamepadDeviceId = deviceId;
            dispatchGamepadConnection(device, true);
        }
    }

    @Override
    public void onInputDeviceChanged(int deviceId) {
        InputDevice device = InputDevice.getDevice(deviceId);
        if (isGameController(device)) dispatchGamepadConnection(device, true);
    }

    @Override
    public void onInputDeviceRemoved(int deviceId) {
        if (deviceId != activeGamepadDeviceId) return;
        activeGamepadDeviceId = -1;
        gamepadX = 0f;
        gamepadY = 0f;
        gamepadDpadX = 0f;
        gamepadDpadY = 0f;
        pressedGamepadDirections.clear();
        dispatchGamepadConnection(null, false);
        sendEmergencyStop();
    }

    private void dispatchConnectedGamepad() {
        for (int deviceId : InputDevice.getDeviceIds()) {
            InputDevice device = InputDevice.getDevice(deviceId);
            if (!isGameController(device)) continue;
            activeGamepadDeviceId = deviceId;
            dispatchGamepadConnection(device, true);
            return;
        }
    }

    private boolean isGameController(InputDevice device) {
        if (device == null) return false;
        int sources = device.getSources();
        return (sources & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD
                || (sources & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK;
    }

    private boolean isDirectionalGamepadKey(int keyCode) {
        return keyCode == KeyEvent.KEYCODE_DPAD_UP
                || keyCode == KeyEvent.KEYCODE_DPAD_DOWN
                || keyCode == KeyEvent.KEYCODE_DPAD_LEFT
                || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT;
    }

    private float centeredAxis(MotionEvent event, int axis) {
        InputDevice device = event.getDevice();
        if (device == null) return 0f;
        InputDevice.MotionRange range = device.getMotionRange(axis, event.getSource());
        if (range == null) return 0f;
        float value = event.getAxisValue(axis);
        return Math.abs(value) > range.getFlat() ? Math.max(-1f, Math.min(1f, value)) : 0f;
    }

    private void dispatchGamepadConnection(InputDevice device, boolean connected) {
        if (!pageReady || webView == null || !isTrustedUrl(webView.getUrl())) return;
        String name = connected && device != null ? device.getName() : "";
        int deviceId = connected && device != null ? device.getId() : -1;
        String script = "(function(){try{window.dispatchEvent(new CustomEvent("
                + "'xingxun:native-gamepad-connection',{detail:{connected:" + connected
                + ",deviceId:" + deviceId + ",name:" + JSONObject.quote(name)
                + "}}));}catch(e){}})();";
        webView.evaluateJavascript(script, null);
    }

    private void dispatchGamepadInput(InputDevice device) {
        if (!pageReady || webView == null || device == null || !isTrustedUrl(webView.getUrl())) return;
        String script = "(function(){try{window.dispatchEvent(new CustomEvent("
                + "'xingxun:native-gamepad-input',{detail:{deviceId:" + device.getId()
                + ",name:" + JSONObject.quote(device.getName())
                + ",x:" + gamepadX + ",y:" + gamepadY
                + ",dpadX:" + gamepadDpadX + ",dpadY:" + gamepadDpadY
                + "}}));}catch(e){}})();";
        webView.evaluateJavascript(script, null);
    }

    private int getColorCompat(int colorResource) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) return getColor(colorResource);
        //noinspection deprecation
        return getResources().getColor(colorResource);
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            hideCustomView();
            return;
        }
        if (startupPanel.getVisibility() == View.VISIBLE && pageReady) {
            hideStartupPanel();
            return;
        }
        if (backDispatchPending) {
            backDispatchPending = false;
            backDispatchSequence++;
            performDefaultBackNavigation();
            return;
        }
        if (pageReady && webView != null && isTrustedUrl(webView.getUrl())) {
            dispatchBackToWeb();
            return;
        }
        performDefaultBackNavigation();
    }

    private void dispatchBackToWeb() {
        backDispatchPending = true;
        final int sequence = ++backDispatchSequence;
        String script = "(function(){try{var event=new CustomEvent('xingxun:android-back',"
                + "{cancelable:true,detail:{source:'android',requestedAt:new Date().toISOString()}});"
                + "window.dispatchEvent(event);return event.defaultPrevented;}catch(error){return false;}})();";
        webView.evaluateJavascript(script, value -> finishBackDispatch(
                sequence,
                "true".equals(value)
        ));
        webView.postDelayed(() -> finishBackDispatch(sequence, false), BACK_DISPATCH_TIMEOUT_MS);
    }

    private void finishBackDispatch(int sequence, boolean consumed) {
        if (!backDispatchPending || sequence != backDispatchSequence) return;
        backDispatchPending = false;
        if (!consumed) performDefaultBackNavigation();
    }

    private void performDefaultBackNavigation() {
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        hostResumed = true;
        webView.onResume();
        if (cloudBridge != null) cloudBridge.onHostResume();
        if (customView != null) enterImmersiveMode();
        else updateSystemBars(webView.getUrl());
        dispatchConnectedGamepad();
    }

    @Override
    protected void onPause() {
        hostResumed = false;
        sendEmergencyStop();
        if (cloudBridge != null) cloudBridge.onHostPause();
        backDispatchPending = false;
        backDispatchSequence++;
        activeAgentActivities.clear();
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onDestroy() {
        sendEmergencyStop();
        if (inputManager != null) inputManager.unregisterInputDeviceListener(this);
        if (pendingFileCallback != null) pendingFileCallback.onReceiveValue(null);
        if (pendingPermissionRequest != null) pendingPermissionRequest.deny();
        if (cloudBridge != null) cloudBridge.close();
        webView.stopLoading();
        webView.removeJavascriptInterface("XingXunAuth");
        webView.removeJavascriptInterface("XingXunCloud");
        webView.setWebChromeClient(null);
        webView.setWebViewClient(null);
        webView.destroy();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && customView != null) enterImmersiveMode();
    }
}
