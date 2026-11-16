package net.godfield.mod;

import java.util.Collections;

public final class DisabledAds {
    private DisabledAds() {}

    public static Object response(String operation) {
        switch (operation) {
            case "ConsentInformation#isConsentFormAvailable":
            case "ConsentInformation#canRequestAds":
            case "MobileAds#isTestDevice":
                return false;
            case "ConsentInformation#getConsentStatus":
            case "ConsentInformation#getPrivacyOptionsRequirementStatus":
                return 1;
            case "MobileAds#initialize":
                return Collections.emptyMap();
            default:
                // Loading, showing, consent dialogs, and SDK configuration are no-ops.
                return null;
        }
    }
}
