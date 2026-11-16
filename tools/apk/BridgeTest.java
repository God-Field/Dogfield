import net.godfield.mod.FlutterCodec;
import net.godfield.mod.ServerUrl;
import net.godfield.mod.HomeMenu;
import net.godfield.mod.DisabledAds;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.HashSet;
import java.util.Collections;

public final class BridgeTest {
    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    private static Object roundTrip(Object value) {
        ByteBuffer buffer = FlutterCodec.encode(value);
        buffer.flip();
        return FlutterCodec.read(buffer);
    }

    public static void main(String[] arguments) {
        require(Boolean.FALSE.equals(DisabledAds.response("ConsentInformation#canRequestAds")), "Ad requests stay disabled");
        require(Boolean.FALSE.equals(DisabledAds.response("ConsentInformation#isConsentFormAvailable")), "Ad consent forms stay disabled");
        require(DisabledAds.response("MobileAds#initialize").equals(Collections.emptyMap()), "No ad adapters are initialized");
        require(DisabledAds.response("loadBannerAd") == null, "Banner requests do not load ads");
        require(DisabledAds.response("showAdWithoutView") == null, "Fullscreen requests do not show ads");

        ByteBuffer fixture = ByteBuffer.wrap(new byte[]{12, 2, 7, 3, 117, 105, 100, 4, 1, 0, 0, 0, 0, 0, 0, 0});
        require(FlutterCodec.read(fixture).equals(Arrays.asList("uid", 1L)), "Standard Flutter list fixture");
        ByteBuffer pigeon = ByteBuffer.wrap(new byte[]{(byte) 149, 12, 1, 7, 3, 97, 47, 98});
        FlutterCodec.Tagged request = (FlutterCodec.Tagged) FlutterCodec.read(pigeon);
        require(request.tag == 149 && request.value.equals(Arrays.asList("a/b")), "Pigeon document fixture");
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("name", "神場 🌍");
        document.put("health", 100);
        document.put("timestamp", 9007199254740991L);
        document.put("values", Arrays.asList(null, true, false, 2.5));
        require(document.equals(roundTrip(document)), "Document values and numeric precision");
        String longText = String.join("", java.util.Collections.nCopies(70000, "x"));
        require(longText.equals(roundTrip(longText)), "Extended string length");
        ByteBuffer envelope = FlutterCodec.envelope(Arrays.asList(2.5, 4.25));
        envelope.flip();
        require(envelope.get() == 0, "Event success envelope");
        require(FlutterCodec.read(envelope).equals(Arrays.asList(2.5, 4.25)), "Envelope double alignment");
        require(ServerUrl.normalize(" http://192.168.1.20:8787/ ").equals("http://192.168.1.20:8787"), "LAN origin");
        require(ServerUrl.normalize("https://game.example").equals("https://game.example"), "HTTPS origin");
        require(ServerUrl.normalize("http://[::1]:8787").equals("http://[::1]:8787"), "IPv6 origin");
        List<String> invalidUrls = Arrays.asList("", "localhost:8787", "file:///tmp/a", "ftp://host", "https://host/path",
            "https://name:password@host", "http://host:65536", "http://host:0", "http://host/?token=secret", "http://host/#fragment");
        for (String address : invalidUrls) {
            boolean rejected = false;
            try {
                ServerUrl.normalize(address);
            } catch (IllegalArgumentException error) {
                rejected = true;
            }
            require(rejected, "Invalid server URL accepted: " + address);
        }
        Set<String> genesis = Collections.singleton("Genesis");
        Set<String> modeMenu = new HashSet<>(Arrays.asList("Training", "Hidden Melee", "Royal Duel"));
        Set<String> otherPages = new HashSet<>(Arrays.asList("Bible", "Settings", "Room Password"));
        require(HomeMenu.isVisible(genesis, genesis, otherPages), "Server setting on name-entry home screen");
        require(!HomeMenu.isVisible(modeMenu, genesis, otherPages), "Hidden on mode listing");
        require(!HomeMenu.isVisible(Collections.singleton("Training"), genesis, otherPages), "Hidden in training lobby");
        require(!HomeMenu.isVisible(new HashSet<>(Arrays.asList("G.F.1", "Forgive", "HP")), genesis, otherPages), "Hidden during battle");
        Set<String> referenceOverlay = new HashSet<>(Arrays.asList("Bible", "Genesis"));
        require(!HomeMenu.isVisible(referenceOverlay, genesis, otherPages), "Hidden when reference overlays home");
        Set<String> passwordOverlay = new HashSet<>(modeMenu);
        passwordOverlay.add("Room Password");
        require(!HomeMenu.isVisible(passwordOverlay, genesis, otherPages), "Hidden when room entry overlays mode menu");
        System.out.println("Native bridge codec and URL checks passed");
    }
}
