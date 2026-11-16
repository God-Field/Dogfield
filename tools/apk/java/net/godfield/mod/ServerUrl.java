package net.godfield.mod;

import java.net.URI;

public final class ServerUrl {
    private ServerUrl() {}

    public static String normalize(String input) {
        URI address;
        try {
            address = new URI(input.trim());
        } catch (Exception error) {
            throw new IllegalArgumentException("Enter a complete HTTP or HTTPS server URL.");
        }
        boolean validScheme = "http".equals(address.getScheme()) || "https".equals(address.getScheme());
        String path = address.getPath();
        boolean rootPath = path == null || path.isEmpty() || "/".equals(path);
        boolean validPort = address.getPort() == -1 || address.getPort() > 0 && address.getPort() <= 65535;
        boolean hasExtras = address.getUserInfo() != null || address.getQuery() != null || address.getFragment() != null;
        if (!validScheme || address.getHost() == null || !rootPath || !validPort || hasExtras) {
            throw new IllegalArgumentException("Use a server origin, for example http://192.168.1.20:8787, without a path or login.");
        }
        return address.getScheme() + "://" + address.getRawAuthority();
    }
}
