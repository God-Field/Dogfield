package net.godfield.mod;

import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** One immutable server selection; identities are kept separately for each origin. */
public final class LocalServer {
    public final String origin;
    private final SharedPreferences preferences;
    private JSONObject identity;

    public static final class Response {
        public final int status;
        public final byte[] body;

        Response(int status, byte[] body) {
            this.status = status;
            this.body = body;
        }

        Object json() throws Exception {
            return fromJson(new JSONTokener(new String(body, StandardCharsets.UTF_8)).nextValue());
        }
    }

    public LocalServer(String origin, SharedPreferences preferences) {
        this.origin = origin;
        this.preferences = preferences;
        try {
            identity = new JSONObject(preferences.getString("identity." + origin, ""));
            identity.getString("uid");
            identity.getString("token");
        } catch (Exception error) {
            identity = null;
        }
    }

    public synchronized String uid() {
        return identity == null ? null : identity.optString("uid", null);
    }

    public synchronized String token() {
        return identity == null ? "" : identity.optString("token", "");
    }

    public synchronized void validateIdentity() throws Exception {
        if (identity != null && request("GET", "/api/doc?path=status/user_count", null).status == 403) {
            clearIdentity();
        }
    }

    public synchronized void ensureIdentity() throws Exception {
        if (identity != null) {
            return;
        }
        Response response = request("POST", "/api/auth", "{}".getBytes(StandardCharsets.UTF_8));
        requireSuccess(response);
        identity = new JSONObject(new String(response.body, StandardCharsets.UTF_8));
        identity.getString("uid");
        identity.getString("token");
        preferences.edit().putString("identity." + origin, identity.toString()).commit();
    }

    public synchronized void deleteIdentity() throws Exception {
        requireSuccess(request("DELETE", "/api/auth", null));
        clearIdentity();
    }

    public synchronized void clearIdentity() {
        identity = null;
        preferences.edit().remove("identity." + origin).commit();
    }

    public HttpURLConnection open(String method, String path) throws Exception {
        if (origin.isEmpty()) {
            throw new IllegalStateException("Set your custom server URL first.");
        }
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        connection.setRequestMethod(method);
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(30000);
        connection.setRequestProperty("Authorization", "Bearer " + token());
        connection.setRequestProperty("Accept", "application/json");
        return connection;
    }

    public Response request(String method, String path, byte[] body) throws Exception {
        HttpURLConnection connection = open(method, path);
        try {
            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(body.length);
                try (java.io.OutputStream output = connection.getOutputStream()) {
                    output.write(body);
                }
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            byte[] bytes = new byte[0];
            if (stream != null) {
                try (InputStream input = stream) {
                    bytes = readAll(input, 4 * 1024 * 1024);
                }
            }
            return new Response(status, bytes);
        } finally {
            connection.disconnect();
        }
    }

    public Object document(String path) throws Exception {
        ensureIdentity();
        Response response = request("GET", "/api/doc?path=" + encode(path), null);
        requireSuccess(response);
        return response.json();
    }

    public static String encode(String value) throws Exception {
        return URLEncoder.encode(value, "UTF-8");
    }

    public static void requireSuccess(Response response) {
        if (response.status != 200) {
            throw new IllegalStateException("Server returned HTTP " + response.status);
        }
    }

    public static byte[] readAll(InputStream input, int limit) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int length;
        while ((length = input.read(buffer)) != -1) {
            if (output.size() + length > limit) {
                throw new IllegalArgumentException("Server response is too large");
            }
            output.write(buffer, 0, length);
        }
        return output.toByteArray();
    }

    public static Object fromJson(Object value) throws Exception {
        if (value == JSONObject.NULL) {
            return null;
        }
        if (value instanceof JSONObject) {
            Map<String, Object> mapping = new LinkedHashMap<>();
            JSONObject object = (JSONObject) value;
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                mapping.put(key, fromJson(object.get(key)));
            }
            return mapping;
        }
        if (value instanceof JSONArray) {
            List<Object> values = new ArrayList<>();
            JSONArray array = (JSONArray) value;
            for (int index = 0; index < array.length(); index++) {
                values.add(fromJson(array.get(index)));
            }
            return values;
        }
        return value;
    }
}
