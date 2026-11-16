package net.godfield.mod;

import java.util.Set;

/** Match menu actions, rather than a room title which can share a mode name. */
public final class HomeMenu {
    private HomeMenu() {}

    public static boolean isVisible(Set<String> labels, Set<String> genesisLabels,
            Set<String> otherPageLabels) {
        // Flutter keeps the underlying home actions in the semantics tree for overlays.
        for (String page : otherPageLabels) {
            if (labels.contains(page)) {
                return false;
            }
        }
        for (String genesis : genesisLabels) {
            if (labels.contains(genesis)) {
                return true;
            }
        }
        return false;
    }
}
