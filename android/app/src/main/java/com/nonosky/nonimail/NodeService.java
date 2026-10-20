package com.nonosky.nonimail;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Servicio en primer plano que corre el servidor de NoniMail (Node.js) dentro de la app.
 * Mantiene viva la limpieza con la pantalla apagada y muestra el avance en la notificación.
 */
public class NodeService extends Service {
    static { System.loadLibrary("native-lib"); }
    static native int startNode(String[] args);

    static final String ACTION_PROGRESS = "com.nonosky.nonimail.PROGRESS";
    static final String ACTION_EXIT = "com.nonosky.nonimail.EXIT";
    private static final String CHANNEL = "nonimail";
    private static final int NOTIF_ID = 1;
    private static final String TAG = "NoniMail";

    static volatile int port = 0;
    static volatile String startError = null;
    /** Secreto por arranque: el servidor rechaza a quien no lo tenga (otras apps del celular). */
    static final String TOKEN = newToken();
    private static volatile boolean started = false;
    private PowerManager.WakeLock wake;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Limpieza", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
        Notification n = build(false, 0, "NoniMail Cleaner", "Listo");
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(NOTIF_ID, n);
        if (!started) {
            started = true;
            new Thread(null, this::runNode, "node", 16L * 1024 * 1024).start();
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_PROGRESS.equals(intent.getAction())) {
            boolean busy = intent.getBooleanExtra("busy", false);
            int pct = intent.getIntExtra("pct", 0);
            String title = intent.getStringExtra("title");
            String text = intent.getStringExtra("text");
            getSystemService(NotificationManager.class).notify(NOTIF_ID,
                build(busy, pct, busy && title != null ? title : "NoniMail Cleaner", busy ? (pct + "% · " + (text == null ? "" : text)) : "Listo"));
            setAwake(busy);
        } else if (intent != null && ACTION_EXIT.equals(intent.getAction())) {
            exitApp();
        }
        return START_NOT_STICKY;
    }

    private Notification build(boolean busy, int pct, String title, String text) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pOpen = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent exit = new Intent(this, NodeService.class).setAction(ACTION_EXIT);
        PendingIntent pExit = PendingIntent.getService(this, 1, exit, PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = new Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setColor(0xFF2563EB)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pOpen)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(new Notification.Action.Builder(null, "Salir", pExit).build());
        if (busy) b.setProgress(100, Math.max(0, Math.min(100, pct)), pct <= 0);
        return b.build();
    }

    // con la pantalla apagada la limpieza sigue: CPU despierta solo mientras hay trabajo
    private void setAwake(boolean busy) {
        if (wake == null) wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NoniMail:limpieza");
        if (busy && !wake.isHeld()) wake.acquire(6 * 60 * 60 * 1000L);
        else if (!busy && wake.isHeld()) wake.release();
    }

    private void runNode() {
        try {
            File project = prepareProject();
            File data = new File(getFilesDir(), "data");
            data.mkdirs();
            try (ServerSocket s = new ServerSocket(0)) { port = s.getLocalPort(); }
            String libDir = getApplicationInfo().nativeLibraryDir;
            Log.i(TAG, "Node en el puerto " + port);
            int code = startNode(new String[] { "node", new File(project, "main.js").getAbsolutePath(), data.getAbsolutePath(), String.valueOf(port), libDir, TOKEN });
            startError = "el servidor terminó (código " + code + ")";
        } catch (Throwable e) {
            startError = e.toString();
            Log.e(TAG, "no arrancó Node", e);
        }
    }

    // Copia el proyecto de Node (assets/nodejs-project.zip) a la memoria interna; se repite solo si la app cambió.
    private File prepareProject() throws Exception {
        File dir = new File(getFilesDir(), "nodejs-project");
        File stamp = new File(dir, ".version");
        PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
        String want = pi.versionCode + "-" + pi.lastUpdateTime;
        if (stamp.exists() && want.equals(new String(Files.readAllBytes(stamp.toPath()), StandardCharsets.UTF_8))) return dir;
        deleteTree(dir);
        dir.mkdirs();
        String root = dir.getCanonicalPath() + File.separator;
        byte[] buf = new byte[65536];
        try (InputStream in = getAssets().open("nodejs-project.zip"); ZipInputStream zip = new ZipInputStream(in)) {
            for (ZipEntry e; (e = zip.getNextEntry()) != null; ) {
                File f = new File(dir, e.getName());
                if (!f.getCanonicalPath().startsWith(root)) throw new SecurityException("ruta inválida en el zip: " + e.getName());
                if (e.isDirectory()) { f.mkdirs(); continue; }
                f.getParentFile().mkdirs();
                try (FileOutputStream out = new FileOutputStream(f)) { for (int n; (n = zip.read(buf)) > 0; ) out.write(buf, 0, n); }
            }
        }
        Files.write(stamp.toPath(), want.getBytes(StandardCharsets.UTF_8));
        return dir;
    }

    private static String newToken() {
        byte[] b = new byte[32];
        new java.security.SecureRandom().nextBytes(b);
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    // "Salir": cierra el motor de IA (si quedó vivo) y termina la app; Node no se puede reiniciar en el mismo proceso
    private void exitApp() {
        try {
            File pid = new File(new File(getFilesDir(), "data"), "llama.pid");
            if (pid.exists()) android.os.Process.killProcess(Integer.parseInt(new String(Files.readAllBytes(pid.toPath()), StandardCharsets.UTF_8).trim()));
        } catch (Exception ignored) { }
        if (wake != null && wake.isHeld()) wake.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        MainActivity.finishAll();
        System.exit(0);
    }
}
