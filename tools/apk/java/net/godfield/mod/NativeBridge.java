package net.godfield.mod;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import org.json.JSONTokener;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/** Intercepts only Firebase platform messages; rendering stays in the original Flutter engine. */
public final class NativeBridge {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService WORKERS = Executors.newCachedThreadPool();
    private static final Map<String, Watch> WATCHES = new ConcurrentHashMap<>();
    private static final Map<String, Object> AUTH_STREAMS = new ConcurrentHashMap<>();
    private static final AtomicInteger NEXT_WATCH = new AtomicInteger();
    private static volatile LocalServer selectedServer;
    private static volatile Activity activity;
    private static volatile Object currentEngine;
    private static volatile String bridgeError;
    private static boolean visibilityUpdatePending;

    private NativeBridge() {}

    public static void initialize(Activity owner) {
        activity = owner;
        currentEngine = null;
        for (Watch watch : WATCHES.values()) {
            watch.cancel();
        }
        WATCHES.clear();
        AUTH_STREAMS.clear();
        SharedPreferences preferences = owner.getSharedPreferences("dogfield.server", 0);
        selectedServer = new LocalServer(preferences.getString("url", ""), preferences);
        try {
            ActionProxy.start(WORKERS);
            bridgeError = null;
        } catch (Exception error) {
            bridgeError = "Cannot start the local action bridge: " + error.getMessage();
            Log.e("Dogfield", bridgeError, error);
        }
    }

    public static LocalServer server() {
        return selectedServer;
    }

    public static void attachButton(Activity owner) {
        ServerButton.attach(owner, bridgeError);
    }

    public static void onSemanticsUpdate(Object engine) {
        if (engine != currentEngine || visibilityUpdatePending) {
            return;
        }
        visibilityUpdatePending = true;
        MAIN.postDelayed(() -> {
            visibilityUpdatePending = false;
            if (engine == currentEngine) {
                ServerButton.refreshVisibility(activity, engine);
            }
        }, 50);
    }

    public static void reportConnectionError(Exception error) {
        Activity owner = activity;
        MAIN.post(() -> {
            if (owner != null && !owner.isFinishing()) {
                ServerButton.showConnectionError(owner, error.getMessage());
            }
        });
    }

    /** Called at FlutterJNI's incoming platform-message boundary, before plugin dispatch. */
    public static boolean handle(Object engine, String channel, ByteBuffer message, int responseId, long messageData) {
        boolean firebasePigeon = channel.startsWith("dev.flutter.pigeon.firebase_core_platform_interface.")
            || channel.startsWith("dev.flutter.pigeon.firebase_auth_platform_interface.")
            || channel.startsWith("dev.flutter.pigeon.cloud_firestore_platform_interface.");
        boolean firebaseEvents = channel.startsWith("plugins.flutter.io/firebase_auth/")
            || channel.startsWith("plugins.flutter.io/firebase_firestore/");
        boolean ads = channel.startsWith("plugins.flutter.io/google_mobile_ads");
        if (!firebasePigeon && !firebaseEvents && !ads) {
            return false;
        }
        // The stock app must use the official Firebase/API endpoints. Only
        // custom server selections are routed through the local compatibility bridge.
        LocalServer active = selectedServer;
        if ((firebasePigeon || firebaseEvents) && (active == null || active.origin.isEmpty())) {
            return false;
        }
        if (engine != currentEngine) {
            currentEngine = engine;
            call(engine, "setSemanticsEnabled", new Class<?>[]{boolean.class}, true);
        }
        try {
            ByteBuffer copy = message == null ? null : message.duplicate();
            if (ads) {
                Object result = null;
                if (copy != null) {
                    String operation = (String) FlutterCodec.read(copy);
                    result = DisabledAds.response(operation);
                }
                reply(engine, responseId, FlutterCodec.envelope(result));
            } else if (firebaseEvents) {
                handleEvent(engine, channel, copy, responseId);
            } else {
                List<?> arguments = copy == null ? Collections.emptyList() : (List<?>) FlutterCodec.read(copy);
                LocalServer server = selectedServer;
                WORKERS.execute(() -> {
                    try {
                        Object result = invoke(engine, channel, arguments, server);
                        reply(engine, responseId, FlutterCodec.encode(Collections.singletonList(result)));
                    } catch (Exception error) {
                        Log.e("Dogfield", "Platform request failed: " + channel, error);
                        List<Object> failure = Arrays.asList("unavailable", error.getMessage(), null);
                        reply(engine, responseId, FlutterCodec.encode(failure));
                        reportConnectionError(error);
                    }
                });
            }
        } catch (Exception error) {
            Log.e("Dogfield", "Platform message could not be decoded: " + channel, error);
            reply(engine, responseId, FlutterCodec.encode(Arrays.asList("bridge-error", error.getMessage(), null)));
        } finally {
            call(engine, "cleanupMessageData", new Class<?>[]{long.class}, messageData);
        }
        return true;
    }

    private static Object invoke(Object engine, String channel, List<?> arguments, LocalServer server) throws Exception {
        String operation = channel.substring(channel.lastIndexOf('.') + 1);
        if (channel.contains("firebase_core_platform_interface")) {
            if (operation.equals("initializeCore")) {
                try {
                    server.validateIdentity();
                } catch (Exception error) {
                    // Preserve the saved account while offline; live requests still report errors.
                    Log.w("Dogfield", "Session validation deferred", error);
                }
                return Collections.singletonList(coreApp(server));
            }
            if (operation.equals("initializeApp")) {
                return coreApp(server);
            }
            if (operation.equals("optionsFromResource")) {
                return coreOptions();
            }
            return null;
        }
        if (channel.contains("firebase_auth_platform_interface")) {
            switch (operation) {
                case "registerIdTokenListener":
                    return "plugins.flutter.io/firebase_auth/id-token/[DEFAULT]";
                case "registerAuthStateListener":
                    return "plugins.flutter.io/firebase_auth/auth-state/[DEFAULT]";
                case "signInAnonymously":
                    server.ensureIdentity();
                    notifyAuthentication(server);
                    return new FlutterCodec.Tagged(140, Arrays.asList(user(server), null, null));
                case "getIdToken":
                    server.ensureIdentity();
                    long now = System.currentTimeMillis();
                    return new FlutterCodec.Tagged(146, Arrays.asList(server.token(), now + 31536000000L, now, now,
                        "anonymous", Collections.emptyMap(), null));
                case "delete":
                    server.deleteIdentity();
                    notifyAuthentication(server);
                    return null;
                case "signOut":
                    server.clearIdentity();
                    notifyAuthentication(server);
                    return null;
                case "setLanguageCode":
                case "setSettings":
                    return null;
                default:
                    throw new UnsupportedOperationException("Unsupported local authentication operation: " + operation);
            }
        }
        switch (operation) {
            case "documentReferenceGet": {
                String path = documentPath(arguments);
                return documentSnapshot(path, server.document(path));
            }
            case "documentReferenceSnapshot": {
                String identifier = "dogfield-" + NEXT_WATCH.incrementAndGet();
                String eventChannel = "plugins.flutter.io/firebase_firestore/document/" + identifier;
                WATCHES.put(eventChannel, new Watch(engine, eventChannel, documentPath(arguments), server));
                return identifier;
            }
            case "setLoggingEnabled":
            case "enableNetwork":
            case "disableNetwork":
            case "terminate":
            case "clearPersistence":
                return null;
            default:
                throw new UnsupportedOperationException("Unsupported local document operation: " + operation);
        }
    }

    private static String documentPath(List<?> arguments) {
        FlutterCodec.Tagged request = (FlutterCodec.Tagged) arguments.get(1);
        if (request.tag != 149) {
            throw new IllegalArgumentException("Expected a 1.5.31 DocumentReferenceRequest");
        }
        return (String) ((List<?>) request.value).get(0);
    }

    private static Object documentSnapshot(String path, Object document) {
        return new FlutterCodec.Tagged(141, Arrays.asList(path, document,
            new FlutterCodec.Tagged(140, Arrays.asList(false, false))));
    }

    private static Object coreOptions() {
        Activity owner = activity;
        String[] resourceNames = {"google_api_key", "google_app_id", "gcm_defaultSenderId", "project_id"};
        Object[] options = new Object[14];
        for (int index = 0; index < resourceNames.length; index++) {
            int resource = owner.getResources().getIdentifier(resourceNames[index], "string", owner.getPackageName());
            options[index] = resource == 0 ? "godfield" : owner.getString(resource);
        }
        return new FlutterCodec.Tagged(129, Arrays.asList(options));
    }

    private static Object coreApp(LocalServer server) {
        Map<String, Object> auth = new LinkedHashMap<>();
        if (server.uid() != null) {
            auth.put("APP_CURRENT_USER", userList(server));
        }
        Map<String, Object> constants = new LinkedHashMap<>();
        constants.put("plugins.flutter.io/firebase_auth", auth);
        constants.put("plugins.flutter.io/firebase_firestore", Collections.emptyMap());
        return new FlutterCodec.Tagged(130, Arrays.asList("[DEFAULT]", coreOptions(), false, constants));
    }

    private static List<Object> userInfo(LocalServer server) {
        return Arrays.asList(server.uid(), null, null, null, null, true, false, "firebase", null, "", 0L, 0L);
    }

    private static List<Object> userList(LocalServer server) {
        return Arrays.asList(userInfo(server), Collections.emptyList());
    }

    private static Object user(LocalServer server) {
        return new FlutterCodec.Tagged(139, Arrays.asList(new FlutterCodec.Tagged(138, userInfo(server)), Collections.emptyList()));
    }

    private static void handleEvent(Object engine, String channel, ByteBuffer message, int responseId) {
        String operation = (String) FlutterCodec.read(message);
        FlutterCodec.read(message);
        if (channel.startsWith("plugins.flutter.io/firebase_auth/")) {
            if (operation.equals("listen")) {
                AUTH_STREAMS.put(channel, engine);
            } else {
                AUTH_STREAMS.remove(channel);
            }
            reply(engine, responseId, FlutterCodec.envelope(null));
            if (operation.equals("listen")) {
                MAIN.post(() -> notifyAuthentication(selectedServer));
            }
            return;
        }
        Watch watch = WATCHES.get(channel);
        if (watch != null) {
            if (operation.equals("listen")) {
                WORKERS.execute(watch);
            } else {
                watch.cancel();
                WATCHES.remove(channel);
            }
        }
        reply(engine, responseId, FlutterCodec.envelope(null));
    }

    private static void notifyAuthentication(LocalServer server) {
        if (server != selectedServer) {
            return;
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("appName", "[DEFAULT]");
        data.put("user", server.uid() == null ? null : userList(server));
        for (Map.Entry<String, Object> stream : AUTH_STREAMS.entrySet()) {
            event(stream.getValue(), stream.getKey(), data);
        }
    }

    private static void reply(Object engine, int responseId, ByteBuffer buffer) {
        MAIN.post(() -> call(engine, "invokePlatformMessageResponseCallback",
            new Class<?>[]{int.class, ByteBuffer.class, int.class}, responseId, buffer, buffer.position()));
    }

    private static void event(Object engine, String channel, Object data) {
        ByteBuffer buffer = FlutterCodec.envelope(data);
        MAIN.post(() -> call(engine, "dispatchPlatformMessage",
            new Class<?>[]{String.class, ByteBuffer.class, int.class, int.class}, channel, buffer, buffer.position(), 0));
    }

    private static void call(Object engine, String method, Class<?>[] types, Object... arguments) {
        try {
            engine.getClass().getMethod(method, types).invoke(engine, arguments);
        } catch (Exception error) {
            Log.e("Dogfield", "Flutter engine call failed: " + method, error);
        }
    }

    private static final class Watch implements Runnable {
        private final Object engine;
        private final String channel;
        private final String path;
        private final LocalServer server;
        private volatile boolean cancelled;
        private volatile HttpURLConnection connection;

        Watch(Object engine, String channel, String path, LocalServer server) {
            this.engine = engine;
            this.channel = channel;
            this.path = path;
            this.server = server;
        }

        void cancel() {
            cancelled = true;
            HttpURLConnection current = connection;
            if (current != null) {
                current.disconnect();
            }
        }

        @Override
        public void run() {
            long retryDelay = 500;
            while (!cancelled) {
                try {
                    server.ensureIdentity();
                    String endpoint = "/api/watch?path=" + LocalServer.encode(path)
                        + "&token=" + LocalServer.encode(server.token());
                    connection = server.open("GET", endpoint);
                    connection.setRequestProperty("Accept", "text/event-stream");
                    if (connection.getResponseCode() != 200) {
                        throw new IllegalStateException("Document stream returned HTTP " + connection.getResponseCode());
                    }
                    try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                            connection.getInputStream(), StandardCharsets.UTF_8))) {
                        StringBuilder payload = new StringBuilder();
                        String line;
                        while (!cancelled && (line = reader.readLine()) != null) {
                            if (line.isEmpty() && payload.length() > 0) {
                                Object document = LocalServer.fromJson(new JSONTokener(payload.toString()).nextValue());
                                if (!cancelled) {
                                    event(engine, channel, documentSnapshot(path, document));
                                }
                                payload.setLength(0);
                                retryDelay = 500;
                            } else if (line.startsWith("data:")) {
                                if (payload.length() > 0) {
                                    payload.append('\n');
                                }
                                payload.append(line.substring(5).trim());
                            }
                        }
                    }
                } catch (Exception error) {
                    if (!cancelled) {
                        Log.w("Dogfield", "Reconnecting document stream: " + path, error);
                    }
                } finally {
                    if (connection != null) {
                        connection.disconnect();
                    }
                    connection = null;
                }
                if (!cancelled) {
                    try {
                        Thread.sleep(retryDelay);
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                    retryDelay = Math.min(10000, retryDelay * 2);
                }
            }
        }
    }
}
