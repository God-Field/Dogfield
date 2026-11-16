package net.godfield.mod;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.text.InputType;
import android.view.Gravity;
import android.view.ContextThemeWrapper;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.util.Map;
import java.util.Set;
import java.util.List;
import java.util.HashSet;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Native overlay; the original Flutter home screen remains underneath it. */
public final class ServerButton {
    private static long lastError;
    private static Button currentButton;
    private static Activity buttonOwner;
    private static final Set<String> GENESIS_LABELS = new HashSet<>();
    private static final Set<String> OTHER_PAGE_LABELS = new HashSet<>();

    private ServerButton() {}

    public static void attach(Activity owner, String bridgeError) {
        buttonOwner = owner;
        loadMenuLabels(owner);
        Button button = new Button(owner);
        currentButton = button;
        button.setVisibility(View.GONE);
        button.setText("Server URL");
        button.setTextSize(12);
        button.setAllCaps(false);
        button.setTextColor(Color.rgb(10, 75, 58));
        button.setContentDescription("Set custom server URL");
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.rgb(215, 249, 232));
        background.setCornerRadius(dp(owner, 8));
        background.setStroke(dp(owner, 1), Color.rgb(39, 133, 98));
        button.setBackground(background);
        FrameLayout.LayoutParams layout = new FrameLayout.LayoutParams(dp(owner, 104), dp(owner, 36));
        layout.gravity = Gravity.BOTTOM | Gravity.RIGHT;
        layout.setMargins(dp(owner, 8), dp(owner, 8), dp(owner, 10), dp(owner, 8));
        owner.addContentView(button, layout);
        button.setOnClickListener(view -> open(owner, bridgeError));
        if (NativeBridge.server().origin.isEmpty() || bridgeError != null) {
            button.post(() -> open(owner, bridgeError));
        }
    }

    private static void loadMenuLabels(Activity owner) {
        if (!GENESIS_LABELS.isEmpty()) {
            return;
        }
        String directory = "flutter_assets/assets/i18n";
        try {
            for (String filename : owner.getAssets().list(directory)) {
                if (!filename.endsWith(".json")) {
                    continue;
                }
                try (InputStream input = owner.getAssets().open(directory + "/" + filename)) {
                    String json = new String(LocalServer.readAll(input, 1024 * 1024), StandardCharsets.UTF_8);
                    JSONObject texts = new JSONObject(json).getJSONObject("texts");
                    GENESIS_LABELS.add(texts.getJSONObject("home").getString("setUserName"));
                    OTHER_PAGE_LABELS.add(texts.getJSONObject("reference").getString("reference"));
                    OTHER_PAGE_LABELS.add(texts.getJSONObject("settings").getString("settings"));
                    OTHER_PAGE_LABELS.add(texts.getJSONObject("duel").getString("ranking"));
                    OTHER_PAGE_LABELS.add(texts.getJSONObject("menu").getString("roomPassword"));
                    OTHER_PAGE_LABELS.add(texts.getJSONObject("home").getString("underMaintenance"));
                    OTHER_PAGE_LABELS.add(texts.getJSONObject("home").getString("versionInvalid"));
                }
            }
        } catch (Exception error) {
            android.util.Log.e("Dogfield", "Cannot read native menu labels", error);
        }
    }

    /** Read the already decoded, reachable semantics tree for this exact APK version. */
    public static void refreshVisibility(Activity owner, Object engine) {
        if (currentButton == null || owner != buttonOwner || owner.isDestroyed()) {
            return;
        }
        boolean show = false;
        try {
            Field delegateField = engine.getClass().getDeclaredField("accessibilityDelegate");
            delegateField.setAccessible(true);
            Object delegate = delegateField.get(engine);
            if (delegate != null) {
                Object tree = delegate.getClass().getField("a").get(delegate);
                Map<?, ?> nodes = (Map<?, ?>) tree.getClass().getField("g").get(tree);
                Set<String> labels = new HashSet<>();
                collectLabels(nodes.get(0), labels);
                show = HomeMenu.isVisible(labels, GENESIS_LABELS, OTHER_PAGE_LABELS);
            }
        } catch (Exception error) {
            android.util.Log.e("Dogfield", "Cannot determine native page", error);
        }
        currentButton.setVisibility(show ? View.VISIBLE : View.GONE);
    }

    private static void collectLabels(Object node, Set<String> labels) throws Exception {
        if (node == null) {
            return;
        }
        Class<?> nodeType = node.getClass();
        boolean hidden = (Boolean) nodeType.getMethod("h", int.class).invoke(node, 14);
        if (hidden) {
            return;
        }
        String label = (String) nodeType.getField("p").get(node);
        if (label != null) {
            labels.add(label);
        }
        for (Object child : (List<?>) nodeType.getField("W").get(node)) {
            collectLabels(child, labels);
        }
    }

    private static int dp(Activity owner, int value) {
        return Math.round(value * owner.getResources().getDisplayMetrics().density);
    }

    private static void open(Activity owner, String bridgeError) {
        SharedPreferences preferences = owner.getSharedPreferences("dogfield.server", 0);
        Context theme = new ContextThemeWrapper(owner, android.R.style.Theme_Material_Light_Dialog_Alert);
        LinearLayout content = new LinearLayout(theme);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = dp(owner, 22);
        content.setPadding(padding, dp(owner, 8), padding, dp(owner, 4));
        TextView instructions = new TextView(theme);
        instructions.setText("Enter your server address. The game reloads when you connect. Each server has its own account.");
        content.addView(instructions);
        EditText address = new EditText(theme);
        address.setSingleLine(true);
        address.setTextSize(16);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("http://192.168.1.20:8787");
        address.setText(preferences.getString("url", ""));
        address.setSelectAllOnFocus(true);
        address.setContentDescription("Custom server URL");
        content.addView(address, new LinearLayout.LayoutParams(-1, dp(owner, 56)));
        TextView status = new TextView(theme);
        status.setTextSize(13);
        status.setText(bridgeError == null
            ? "On a phone, use your computer's local address. In an emulator, use http://10.0.2.2:8787."
            : bridgeError);
        content.addView(status);
        AlertDialog dialog = new AlertDialog.Builder(theme)
            .setTitle("Custom server")
            .setView(content)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Connect", null)
            .create();
        dialog.setOnShowListener(ignored -> {
            Button connect = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            connect.setOnClickListener(view -> {
                final String origin;
                try {
                    origin = ServerUrl.normalize(address.getText().toString());
                } catch (IllegalArgumentException error) {
                    address.setError(error.getMessage());
                    return;
                }
                connect.setEnabled(false);
                status.setText("Checking server…");
                new Thread(() -> {
                    try {
                        LocalServer candidate = new LocalServer(origin, preferences);
                        Object versionStatus = candidate.document("status/min_version");
                        boolean hasAndroidMinimum = versionStatus instanceof Map
                            && ((Map<?, ?>) versionStatus).get("android") instanceof String;
                        if (!hasAndroidMinimum) {
                            throw new IllegalArgumentException("This address did not return Dogfield minimum-version status.");
                        }
                        preferences.edit().putString("url", origin).commit();
                        owner.runOnUiThread(() -> {
                            dialog.dismiss();
                            owner.recreate();
                        });
                    } catch (Exception error) {
                        owner.runOnUiThread(() -> {
                            status.setText("Could not connect: " + error.getMessage());
                            connect.setEnabled(true);
                        });
                    }
                }, "dogfield-connect").start();
            });
        });
        dialog.show();
    }

    public static void showConnectionError(Activity owner, String message) {
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - lastError > 8000) {
            lastError = now;
            Toast.makeText(owner, "Server connection failed. Use Server URL to check the address. " + message, Toast.LENGTH_LONG).show();
        }
    }
}
