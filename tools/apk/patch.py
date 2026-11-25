#!/usr/bin/env python3
"""Patch the 1.5.32 ARM64 XAPK without replacing its Flutter client."""

import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / '.local-apk'
TOOLS = CACHE / 'tools'
BUILD_TOOLS = TOOLS / 'android-16'
ANDROID_JAR = TOOLS / 'android-36/android.jar'
ANDROID = '{http://schemas.android.com/apk/res/android}'
MODDED_PACKAGE = 'net.dogfield'
ORIGINAL_URL = b'https://asia-northeast1-godfield.cloudfunctions.net/'
PATCHED_URL = b'http://127.0.0.1:18787/dogfield-local-action-bridge/'
DOWNLOADS = [
    ('apktool.jar', 'https://github.com/iBotPeaches/Apktool/releases/download/v2.12.1/apktool_2.12.1.jar',
     '66cf4524a4a45a7f56567d08b2c9b6ec237bcdd78cee69fd4a59c8a0243aeafa'),
    ('build-tools.zip', 'https://dl.google.com/android/repository/build-tools_r36_linux.zip',
     '5d9ac77fb6ff43d9da518a337b4fcf8f9097113df531d99ccefe80ef7ce8250b'),
    ('platform.zip', 'https://dl.google.com/android/repository/platform-36_r02.zip',
     '37607369a28c5b640b3a7998868d45898ebcb777565a0e85f9acf36f29631d2e'),
]


def run(*arguments):
    subprocess.run([str(argument) for argument in arguments], cwd=ROOT, check=True)


def setup():
    TOOLS.mkdir(parents=True, exist_ok=True)
    for filename, url, expected_digest in DOWNLOADS:
        archive_path = TOOLS / filename
        if not archive_path.exists():
            print(f'Downloading {filename}', flush=True)
            urllib.request.urlretrieve(url, archive_path)
        actual_digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
        if actual_digest != expected_digest:
            raise ValueError(f'Checksum mismatch for {archive_path}')
        if filename.endswith('.zip'):
            with zipfile.ZipFile(archive_path) as archive:
                archive.extractall(TOOLS)
    for executable in ['aapt2', 'd8', 'zipalign', 'apksigner']:
        (BUILD_TOOLS / executable).chmod(0o755)


def replace_once(path, before, after):
    source = path.read_text()
    if source.count(before) != 1:
        raise ValueError(f'Unsupported APK: expected one patch point in {path}')
    path.write_text(source.replace(before, after, 1))


def patch_manifest(decoded):
    ET.register_namespace('android', ANDROID[1:-1])
    manifest_path = decoded / 'AndroidManifest.xml'
    tree = ET.parse(manifest_path)
    manifest = tree.getroot()
    original_package = manifest.get('package')
    manifest.set('package', MODDED_PACKAGE)
    component_tags = {'application', 'activity', 'activity-alias', 'service', 'receiver', 'provider'}
    permission_tags = {'permission', 'uses-permission', 'uses-permission-sdk-23', 'permission-tree', 'permission-group'}
    for element in manifest.iter():
        # Class names still refer to the original DEX; Android otherwise resolves
        # relative names against the new application ID.
        if element.tag in component_tags:
            for attribute in ['name', 'targetActivity']:
                value = element.get(ANDROID + attribute)
                if value and value.startswith('.'):
                    element.set(ANDROID + attribute, original_package + value)
                elif value and '.' not in value:
                    element.set(ANDROID + attribute, original_package + '.' + value)
        attributes = ['permission', 'readPermission', 'writePermission', 'taskAffinity', 'process']
        if element.tag in permission_tags:
            attributes.append('name')
        for attribute in attributes:
            value = element.get(ANDROID + attribute, '')
            if value == original_package or value.startswith(original_package + '.'):
                element.set(ANDROID + attribute, MODDED_PACKAGE + value[len(original_package):])
        authorities = element.get(ANDROID + 'authorities')
        if authorities:
            renamed_authorities = []
            for authority in authorities.split(';'):
                if authority == original_package or authority.startswith(original_package + '.'):
                    authority = MODDED_PACKAGE + authority[len(original_package):]
                renamed_authorities.append(authority)
            element.set(ANDROID + 'authorities', ';'.join(renamed_authorities))
    manifest.attrib.pop(ANDROID + 'requiredSplitTypes', None)
    manifest.attrib.pop(ANDROID + 'splitTypes', None)
    advertising_permissions = {
        'com.google.android.gms.permission.AD_ID',
        'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE',
    }
    for permission in list(manifest):
        name = permission.get(ANDROID + 'name', '')
        is_advertising_permission = name in advertising_permissions or name.startswith('android.permission.ACCESS_ADSERVICES_')
        if permission.tag.startswith('uses-permission') and is_advertising_permission:
            manifest.remove(permission)
    application = manifest.find('application')
    application.set(ANDROID + 'name', 'android.app.Application')
    application.set(ANDROID + 'label', 'Dogfield')
    launcher_icons = list((decoded / 'res').glob('mipmap-*/ic_launcher.png'))
    if not launcher_icons:
        raise ValueError('Unsupported APK: official launcher PNG resources are missing')
    for launcher_icon in launcher_icons:
        renamed_icon = launcher_icon.with_name('dogfield_launcher.png')
        shutil.copyfile(launcher_icon, renamed_icon)
    application.set(ANDROID + 'icon', '@mipmap/dogfield_launcher')
    application.set(ANDROID + 'usesCleartextTraffic', 'true')
    for component in list(application):
        name = component.get(ANDROID + 'name', '')
        automatic_network_provider = name in [
            'com.google.firebase.provider.FirebaseInitProvider',
            'com.google.android.gms.ads.MobileAdsInitProvider',
        ]
        split_metadata = name.startswith('com.android.vending.') or name.startswith('com.android.stamp.')
        advertising_component = name.startswith((
            'com.google.android.gms.ads.',
            'com.google.android.gms.measurement.',
            'com.google.android.gms.adservices.',
        )) or name == 'android.ext.adservices'
        if automatic_network_provider or split_metadata or advertising_component:
            application.remove(component)
    tree.write(manifest_path, encoding='utf-8', xml_declaration=True)


def remove_ad_plugin(decoded):
    registrant_path = decoded / 'smali/io/flutter/plugins/GeneratedPluginRegistrant.smali'
    source = registrant_path.read_text()
    marker = 'Error registering plugin google_mobile_ads, '
    if source.count(marker) != 1:
        raise ValueError('Unsupported APK: expected one advertising plugin registration')
    marker_position = source.index(marker)
    start = source.rfind('\n    :try_start_', 0, marker_position)
    next_label = source.index('\n    :goto_', marker_position)
    end = source.index('\n', next_label + 1)
    if start == -1:
        raise ValueError('Unsupported APK: advertising plugin registration block is missing')
    registrant_path.write_text(source[:start] + source[end:])


def patch_entry_points(decoded):
    activity_path = decoded / 'smali/ea/c.smali'
    source = activity_path.read_text()
    start = source.index('.method public final onCreate(Landroid/os/Bundle;)V')
    end = source.index('.end method', start)
    method = source[start:end]
    method = method.replace('    .locals 17', '    .locals 17\n\n'
        '    invoke-static/range {p0 .. p0}, Lnet/godfield/mod/NativeBridge;->initialize(Landroid/app/Activity;)V', 1)
    last_return = method.rindex('    return-void')
    method = method[:last_return] + (
        '    invoke-static/range {p0 .. p0}, Lnet/godfield/mod/NativeBridge;->attachButton(Landroid/app/Activity;)V\n\n'
    ) + method[last_return:]
    activity_path.write_text(source[:start] + method + source[end:])
    jni_path = decoded / 'smali/io/flutter/embedding/engine/FlutterJNI.smali'
    header = '.method public handlePlatformMessage(Ljava/lang/String;Ljava/nio/ByteBuffer;IJ)V\n    .locals 8'
    injection = header + '''

    invoke-static/range {p0 .. p5}, Lnet/godfield/mod/NativeBridge;->handle(Ljava/lang/Object;Ljava/lang/String;Ljava/nio/ByteBuffer;IJ)Z
    move-result v0
    if-eqz v0, :dogfield_original_dispatch
    return-void
    :dogfield_original_dispatch'''
    replace_once(jni_path, header, injection)
    semantics_start = '.method private updateSemantics(Ljava/nio/ByteBuffer;[Ljava/lang/String;[Ljava/nio/ByteBuffer;)V'
    source = jni_path.read_text()
    start = source.index(semantics_start)
    end = source.index('.end method', start)
    method = source[start:end]
    method = method.replace('    return-void',
        '    invoke-static {p0}, Lnet/godfield/mod/NativeBridge;->onSemanticsUpdate(Ljava/lang/Object;)V\n\n'
        '    return-void', 1)
    jni_path.write_text(source[:start] + method + source[end:])
    # Keep the page-detection tree available without enabling Android screen-reader services.
    header = '.method public setSemanticsEnabled(Z)V\n    .locals 1'
    replace_once(jni_path, header, header + '\n\n    const/4 p1, 0x1')


def build(input_path, output_path):
    required = [TOOLS / 'apktool.jar', ANDROID_JAR, BUILD_TOOLS / 'd8', BUILD_TOOLS / 'apksigner']
    if not all(path.exists() for path in required):
        raise RuntimeError('Android tools are missing. Run npm run apk:setup once first.')
    workspace = CACHE / 'build'
    shutil.rmtree(workspace, ignore_errors=True)
    workspace.mkdir(parents=True)
    with zipfile.ZipFile(input_path) as package:
        base = workspace / 'base.apk'
        base.write_bytes(package.read('net.godfield.apk'))
        architecture = package.read('config.arm64_v8a.apk')
    decoded = workspace / 'decoded'
    run('java', '-jar', TOOLS / 'apktool.jar', 'd', base, '-o', decoded, '-f')
    patch_manifest(decoded)
    patch_entry_points(decoded)
    remove_ad_plugin(decoded)
    classes = workspace / 'classes'
    classes.mkdir()
    java_sources = sorted((ROOT / 'tools/apk/java').rglob('*.java'))
    run('javac', '--release', '8', '-classpath', ANDROID_JAR, '-d', classes, *java_sources)
    dex = workspace / 'dex'
    dex.mkdir()
    run(BUILD_TOOLS / 'd8', '--min-api', '32', '--lib', ANDROID_JAR, '--output', dex,
        *sorted(classes.rglob('*.class')))
    unsigned = workspace / 'rebuilt.apk'
    run('java', '-jar', TOOLS / 'apktool.jar', 'b', decoded, '-o', unsigned)
    merged = workspace / 'merged.apk'
    with zipfile.ZipFile(merged, 'w') as result:
        with zipfile.ZipFile(unsigned) as archive:
            for entry in archive.infolist():
                if not entry.filename.startswith('META-INF/') and entry.filename != 'stamp-cert-sha256':
                    result.writestr(entry, archive.read(entry))
        result.write(dex / 'classes.dex', 'classes2.dex', compress_type=zipfile.ZIP_STORED)
        arm_path = workspace / 'arm64.apk'
        arm_path.write_bytes(architecture)
        with zipfile.ZipFile(arm_path) as archive:
            for entry in archive.infolist():
                if not entry.filename.startswith('lib/'):
                    continue
                payload = archive.read(entry)
                if entry.filename.endswith('/libapp.so'):
                    if len(ORIGINAL_URL) != len(PATCHED_URL) or payload.count(ORIGINAL_URL) != 1:
                        raise ValueError('Unsupported Dart snapshot: expected one same-length action URL patch')
                    payload = payload.replace(ORIGINAL_URL, PATCHED_URL)
                result.writestr(entry.filename, payload, compress_type=zipfile.ZIP_STORED)
    aligned = workspace / 'aligned.apk'
    run(BUILD_TOOLS / 'zipalign', '-P', '16', '-f', '4', merged, aligned)
    keystore = CACHE / 'modded.keystore'
    if not keystore.exists():
        run('keytool', '-genkeypair', '-keystore', keystore, '-storepass', 'dogfield-local',
            '-keypass', 'dogfield-local', '-alias', 'dogfield', '-keyalg', 'RSA', '-keysize', '2048',
            '-validity', '10000', '-dname', 'CN=Dogfield local APK mod')
    output_path.parent.mkdir(parents=True, exist_ok=True)
    run(BUILD_TOOLS / 'apksigner', 'sign', '--ks', keystore, '--ks-pass', 'pass:dogfield-local',
        '--key-pass', 'pass:dogfield-local', '--out', output_path, aligned)
    run(BUILD_TOOLS / 'apksigner', 'verify', '--verbose', output_path)
    run(BUILD_TOOLS / 'zipalign', '-c', '-P', '16', '4', output_path)
    print(f'Patched native Flutter APK: {output_path}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--setup', action='store_true', help='Download pinned Android build tools (requires network)')
    parser.add_argument('--input', type=Path, default=ROOT / 'original/apk/God Field 1.5.32.xapk')
    parser.add_argument('--output', type=Path, default=ROOT / 'public/apk/God-Field-1.5.32-modded.apk')
    arguments = parser.parse_args()
    if arguments.setup:
        setup()
    else:
        build(arguments.input.resolve(), arguments.output.resolve())


if __name__ == '__main__':
    main()
