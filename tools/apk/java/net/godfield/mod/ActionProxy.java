package net.godfield.mod;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;

public final class ActionProxy {
    public static final int PORT = 18787;
    public static final String PREFIX = "/dogfield-local-action-bridge/";
    private static ServerSocket listener;

    private ActionProxy() {}

    public static synchronized void start(ExecutorService workers) throws Exception {
        if (listener != null) {
            return;
        }
        listener = new ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1"));
        workers.execute(() -> {
            while (!listener.isClosed()) {
                try {
                    Socket connection = listener.accept();
                    workers.execute(() -> serve(connection));
                } catch (Exception error) {
                    android.util.Log.e("Dogfield", "Action bridge listener failed", error);
                }
            }
        });
    }

    private static void serve(Socket connection) {
        try (Socket socket = connection) {
            socket.setSoTimeout(15000);
            InputStream input = new BufferedInputStream(socket.getInputStream());
            String[] request = line(input).split(" ");
            int length = 0;
            String authorization = "";
            String header;
            while (!(header = line(input)).isEmpty()) {
                String lowerHeader = header.toLowerCase(Locale.ROOT);
                if (lowerHeader.startsWith("content-length:")) {
                    length = Integer.parseInt(header.substring(header.indexOf(':') + 1).trim());
                }
                if (lowerHeader.startsWith("authorization:")) {
                    authorization = header.substring(header.indexOf(':') + 1).trim();
                }
                if (lowerHeader.startsWith("transfer-encoding:")) {
                    throw new IllegalArgumentException("Chunked requests are unsupported");
                }
            }
            boolean validRequest = request.length == 3 && "POST".equals(request[0])
                && request[1].startsWith(PREFIX) && length >= 0 && length <= 65536;
            if (!validRequest) {
                respond(socket.getOutputStream(), 400, new byte[0]);
                return;
            }
            String action = request[1].substring(PREFIX.length());
            if (!action.matches("[a-z][a-z-]{1,80}")) {
                respond(socket.getOutputStream(), 404, new byte[0]);
                return;
            }
            LocalServer server = NativeBridge.server();
            String token = server.token();
            if (token.isEmpty() || !authorization.equals("Bearer " + token)) {
                respond(socket.getOutputStream(), 403, new byte[0]);
                return;
            }
            byte[] body = new byte[length];
            int position = 0;
            while (position < length) {
                int received = input.read(body, position, length - position);
                if (received < 0) {
                    throw new IllegalArgumentException("Truncated action request");
                }
                position += received;
            }
            LocalServer.Response response = server.request("POST", "/api/functions/" + action, body);
            respond(socket.getOutputStream(), response.status, response.body);
        } catch (Exception error) {
            android.util.Log.e("Dogfield", "Action request failed", error);
            NativeBridge.reportConnectionError(error);
        }
    }

    private static String line(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        int value;
        while ((value = input.read()) != -1 && value != '\n') {
            if (output.size() >= 8192) {
                throw new IllegalArgumentException("HTTP header is too long");
            }
            if (value != '\r') {
                output.write(value);
            }
        }
        if (value == -1) {
            throw new IllegalArgumentException("Truncated HTTP request");
        }
        return output.toString("UTF-8");
    }

    private static void respond(OutputStream output, int status, byte[] body) throws Exception {
        String headers = "HTTP/1.1 " + status + " Response\r\n"
            + "Content-Type: application/json; charset=utf-8\r\n"
            + "Content-Length: " + body.length + "\r\nConnection: close\r\n\r\n";
        output.write(headers.getBytes(StandardCharsets.UTF_8));
        output.write(body);
        output.flush();
    }
}
