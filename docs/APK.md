# Android app

The patcher builds a standalone APK from `original/apk/God Field 1.5.32.xapk`. The source XAPK is local and ignored by Git; the patched APK is published at `public/apk/God-Field-1.5.32-modded.apk`. The app keeps the original Flutter game and adds a **Server** control.

## Build and install

Run the setup once to download the pinned Android build tools, then patch and install:

```sh
npm run apk:setup
npm run apk:patch
adb install public/apk/God-Field-1.5.32-modded.apk
```

The build requires Linux, Python 3, Java 17 or later, and a compatible XAPK. Generated tools, signing keys, and intermediate files are kept in `.local-apk/`. Keep `.local-apk/modded.keystore` to sign future updates with the same key.

## Connect

The app uses the official God Field server by default. Leave the address blank to return to it. To use Dogfield, enter its origin and tap **Connect**. On a phone, use the computer's LAN address, such as `http://192.168.1.20:8787`; in the Android emulator, use `http://10.0.2.2:8787`. The address is saved on the device, and each custom server has a separate account.

For a custom server, **Connect** checks `status/min_version` through the Dogfield document API. Firebase-compatible authentication, document reads and subscriptions, and game actions are routed through the local bridge only while a custom server is selected. With no custom server set, the original app connects to the official service. The APK is ARM64, like the supplied XAPK.

Run the self-contained bridge checks with:

```sh
npm run test:apk
```
