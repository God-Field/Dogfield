# Android app

The patcher builds a standalone APK from a user-provided God Field 1.5.31 XAPK (version code 160). The XAPK and generated APK are not included in the repository. The patched app keeps the original Flutter game and adds a **Server URL** control.

## Build and install

Run the setup once to download the pinned Android build tools, then patch and install:

```sh
npm run apk:setup
npm run apk:patch -- --input '/path/to/God Field 1.5.31.xapk' --output public/apk/God-Field-1.5.31-modded.apk
adb install public/apk/God-Field-1.5.31-modded.apk
```

The build requires Linux, Python 3, Java 17 or later, and a compatible XAPK. Generated tools, signing keys, and intermediate files are kept in `.local-apk/`. Keep `.local-apk/modded.keystore` to sign future updates with the same key.

## Connect

Start Dogfield, then enter its origin in the app and tap **Connect**. Use the computer's LAN address on a phone, such as `http://192.168.1.20:8787`, or `http://10.0.2.2:8787` in the Android emulator. The address is saved on the device. The local account is separate from accounts on other servers.

The **Connect** check reads `status/min_version` through the local document API. It creates or reuses the app's local account for that server, which the client then uses for authentication, document reads and subscriptions, and game actions. It does not connect to production Firebase or Cloud Functions. The APK is ARM64, like the supplied XAPK.

Run the self-contained bridge checks with:

```sh
npm run test:apk
```
