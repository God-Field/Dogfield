#!/usr/bin/env python3
"""Offline checks of the native protocol codec and URL validation; no APK fixtures."""
from pathlib import Path
import subprocess
import tempfile
import sys
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
from patch import ANDROID, MODDED_PACKAGE, patch_manifest, remove_ad_plugin

DIRECTORY = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='dogfield-apk-tests-') as temporary:
    sources = [DIRECTORY / 'java/net/godfield/mod/FlutterCodec.java',
               DIRECTORY / 'java/net/godfield/mod/ServerUrl.java',
               DIRECTORY / 'java/net/godfield/mod/HomeMenu.java', DIRECTORY / 'BridgeTest.java']
    sources.append(DIRECTORY / 'java/net/godfield/mod/DisabledAds.java')
    subprocess.run(['javac', '--release', '8', '-d', temporary, *map(str, sources)], check=True)
    subprocess.run(['java', '-cp', temporary, 'BridgeTest'], check=True)

with tempfile.TemporaryDirectory(prefix='dogfield-manifest-tests-') as temporary:
    decoded = Path(temporary)
    icon_directory = decoded / 'res/mipmap-mdpi'
    icon_directory.mkdir(parents=True)
    (icon_directory / 'ic_launcher.png').write_bytes(b'official-icon-fixture')
    manifest_path = decoded / 'AndroidManifest.xml'
    manifest_path.write_text('''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="net.godfield">
      <permission android:name="net.godfield.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" />
      <uses-permission android:name="net.godfield.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" />
      <uses-permission android:name="android.permission.INTERNET" />
      <uses-permission android:name="com.google.android.gms.permission.AD_ID" />
      <uses-permission android:name="android.permission.ACCESS_ADSERVICES_TOPICS" />
      <uses-permission android:name="com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE" />
      <application android:name="android.app.Application">
        <activity android:name=".MainActivity" />
        <provider android:name="androidx.startup.InitializationProvider"
          android:authorities="net.godfield.androidx-startup;external.fixture" />
        <activity android:name="com.google.android.gms.ads.AdActivity" />
        <service android:name="com.google.android.gms.ads.AdService" />
        <provider android:name="com.google.android.gms.ads.MobileAdsInitProvider" />
        <service android:name="com.google.android.gms.measurement.AppMeasurementJobService" />
        <meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="fixture" />
        <uses-library android:name="android.ext.adservices" />
      </application>
    </manifest>''')
    patch_manifest(decoded)
    manifest = ET.parse(manifest_path).getroot()
    assert manifest.get('package') == MODDED_PACKAGE
    application = manifest.find('application')
    assert application.get(ANDROID + 'label') == 'Dogfield'
    assert application.get(ANDROID + 'icon') == '@mipmap/dogfield_launcher'
    assert (icon_directory / 'dogfield_launcher.png').read_bytes() == b'official-icon-fixture'
    assert application.find('activity').get(ANDROID + 'name') == 'net.godfield.MainActivity'
    assert application.find('provider').get(ANDROID + 'authorities') == MODDED_PACKAGE + '.androidx-startup;external.fixture'
    for tag in ['permission', 'uses-permission']:
        assert manifest.find(tag).get(ANDROID + 'name') == MODDED_PACKAGE + '.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
    assert manifest.findall('uses-permission')[1].get(ANDROID + 'name') == 'android.permission.INTERNET'
    assert len(manifest.findall('uses-permission')) == 2
    assert len(list(application)) == 2
    print('Side-by-side package, provider, permission, and entry-point checks passed')
    registrant = decoded / 'smali/io/flutter/plugins/GeneratedPluginRegistrant.smali'
    registrant.parent.mkdir(parents=True)
    registrant.write_text('''other-plugin-before
    :try_start_5
    new-instance v2, Lfixture/AdPlugin;
    invoke-virtual {v1, v2}, Lfixture/Registry;->register(Ljava/lang/Object;)V
    :try_end_5
    .catch Ljava/lang/Exception; {:try_start_5 .. :try_end_5} :catch_5
    goto :goto_5
    :catch_5
    const-string v2, "Error registering plugin google_mobile_ads, fixture.AdPlugin"
    :goto_5
other-plugin-after
''')
    remove_ad_plugin(decoded)
    assert registrant.read_text() == 'other-plugin-before\nother-plugin-after\n'
    print('Advertising components, permissions, and plugin registration removed')
