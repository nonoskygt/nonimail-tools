package com.nonosky.nonimail;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;

/** Ventana de la app: muestra la interfaz web que sirve el servidor local (ver NodeService). */
public class MainActivity extends Activity {
    private static WeakReference<MainActivity> current = new WeakReference<>(null);
    private WebView web;
    private String base;
    private final Handler ui = new Handler(Looper.getMainLooper());

    static void finishAll() { MainActivity a = current.get(); if (a != null) a.finishAndRemoveTask(); }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        current = new WeakReference<>(this);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
        startForegroundService(new Intent(this, NodeService.class));

        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int bg = dark ? 0xFF0A1020 : 0xFFF8FAFC;
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(bg);
        web = new WebView(this);
        web.setBackgroundColor(bg);
        root.addView(web);
        setContentView(root);
        // pantalla de borde a borde (Android 15): la barra de estado, la de navegación y el teclado no tapan la app
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsets.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsets.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        web.addJavascriptInterface(new Bridge(), "NoniBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String url = req.getUrl().toString();
                if (base != null && url.startsWith(base)) return false;
                openExternal(url);
                return true;
            }
        });
        web.loadDataWithBaseURL(null, splash(dark), "text/html", "utf-8", null);
        waitForServer(0);
    }

    private static String splash(boolean dark) {
        String fg = dark ? "#94A3B8" : "#475569", bg = dark ? "#0A1020" : "#F8FAFC";
        return "<html><body style='margin:0;height:100vh;display:grid;place-items:center;background:" + bg + ";font-family:sans-serif;color:" + fg + "'>"
            + "<div style='text-align:center'><svg width='72' height='72' viewBox='0 0 512 512'><rect width='512' height='512' rx='116' fill='#2563EB'/>"
            + "<rect x='92' y='176' width='288' height='212' rx='40' fill='#fff'/><path d='M132 218 L236 294 L340 218' fill='none' stroke='#2563EB' stroke-width='30' stroke-linecap='round' stroke-linejoin='round'/>"
            + "<path d='M376 76 C384 124 400 140 448 148 C400 156 384 172 376 220 C368 172 352 156 304 148 C352 140 368 124 376 76 Z' fill='#6EE7B7'/></svg>"
            + "<p id='m' style='margin-top:16px'>Iniciando…</p></div></body></html>";
    }

    // espera a que el servidor de Node responda y recién ahí abre la interfaz
    private void waitForServer(int tries) {
        new Thread(() -> {
            for (int i = tries; i < 240; i++) {
                if (NodeService.startError != null) { showError(NodeService.startError); return; }
                int p = NodeService.port;
                if (p > 0) {
                    try {
                        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + p + "/api/config").openConnection();
                        c.setConnectTimeout(500); c.setReadTimeout(1500);
                        c.setRequestProperty("X-Noni-Token", NodeService.TOKEN);
                        if (c.getResponseCode() == 200) {
                            base = "http://127.0.0.1:" + p + "/";
                            ui.post(() -> {
                                // el token viaja como cookie en cada pedido de la interfaz (fetch, SSE, archivos)
                                CookieManager cm = CookieManager.getInstance();
                                cm.setCookie(base, "noni=" + NodeService.TOKEN + "; HttpOnly; SameSite=Strict; Path=/");
                                cm.flush();
                                web.loadUrl(base);
                            });
                            return;
                        }
                    } catch (Exception ignored) { }
                }
                try { Thread.sleep(250); } catch (InterruptedException e) { return; }
            }
            showError("el servidor no respondió");
        }).start();
    }

    private void showError(String msg) {
        String safe = msg.replace("&", "&amp;").replace("<", "&lt;").replace("'", "&#39;");
        ui.post(() -> web.evaluateJavascript("document.getElementById('m').textContent='No se pudo iniciar: " + safe.replace("\\", "\\\\") + "'", null));
    }

    private void openExternal(String url) {
        if (!url.startsWith("https://")) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
    }

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() {
        // primero cierra ajustes o diálogos; si no hay nada abierto, la app pasa a segundo plano (la limpieza sigue)
        web.evaluateJavascript("window.noniBack ? window.noniBack() : false", v -> { if (!"true".equals(v)) moveTaskToBack(true); });
    }

    @Override protected void onDestroy() {
        if (current.get() == this) current = new WeakReference<>(null);
        web.destroy();
        super.onDestroy();
    }

    /** Lo que la interfaz web puede pedirle a Android. */
    class Bridge {
        @JavascriptInterface public void openExternal(String url) { ui.post(() -> MainActivity.this.openExternal(url)); }
        @JavascriptInterface public void progress(boolean busy, int pct, String title, String text) {
            Intent i = new Intent(MainActivity.this, NodeService.class).setAction(NodeService.ACTION_PROGRESS)
                .putExtra("busy", busy).putExtra("pct", pct).putExtra("title", title).putExtra("text", text);
            startService(i);
        }
        // reporte de una limpieza: al portapapeles o a otra app (correo, WhatsApp, Drive…)
        @JavascriptInterface public void copy(String text) {
            ui.post(() -> {
                ClipboardManager cm = getSystemService(ClipboardManager.class);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("NoniMail", text));
            });
        }
        @JavascriptInterface public void share(String title, String text) {
            // un Intent no aguanta textos enormes: los reportes muy largos se recortan (Copiar trae el completo)
            String body = text.length() > 100000 ? text.substring(0, 100000) + "\n… (recortado; usa Copiar reporte para el texto completo)" : text;
            ui.post(() -> {
                Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_SUBJECT, title).putExtra(Intent.EXTRA_TEXT, body);
                startActivity(Intent.createChooser(send, title));
            });
        }
    }
}
