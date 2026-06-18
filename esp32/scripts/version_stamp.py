# PlatformIO pre-build hook: stamp a unique version into LOCAL dev builds so you can
# tell builds apart and confirm exactly what's flashed on a device.
#
# Writes src/firmware_build.h (gitignored) with:
#   #define FIRMWARE_VERSION "fwv0.0.19+<git-short>[-dirty].<MMDD-HHMMSS>"
# which firmware_version.h includes (via __has_include) and prefers over its default.
#
# In CI it does NOTHING: the release workflow rewrites the #define in
# firmware_version.h to the published version and firmware_build.h is never created,
# so production versioning/OTA is untouched and never clobbered.
Import("env")  # noqa: F821  (provided by PlatformIO/SCons)
import os
import subprocess
import time

PROJECT_DIR = env.subst("$PROJECT_DIR")
GENERATED = os.path.join(PROJECT_DIR, "src", "firmware_build.h")


def _git(*args):
    try:
        return subprocess.check_output(
            ["git", *args], cwd=PROJECT_DIR, stderr=subprocess.DEVNULL
        ).decode().strip()
    except Exception:
        return ""


def _base_version():
    # Read the canonical base version from firmware_version.h's #define.
    try:
        with open(os.path.join(PROJECT_DIR, "src", "firmware_version.h")) as f:
            for line in f:
                s = line.strip()
                if s.startswith("#define FIRMWARE_VERSION") and '"' in s:
                    return s.split('"')[1]
    except Exception as e:
        print(f"[version_stamp] could not read base version: {e}")
    return "fwv0.0.0"


if os.environ.get("GITHUB_ACTIONS") or os.environ.get("CI"):
    print("[version_stamp] CI build — leaving FIRMWARE_VERSION to the release workflow")
    # Make sure no stray local header shadows the CI-stamped version.
    try:
        if os.path.exists(GENERATED):
            os.remove(GENERATED)
    except Exception:
        pass
else:
    base = _base_version()
    short = _git("rev-parse", "--short", "HEAD") or "nogit"
    # Only consider firmware-relevant dirs dirty (so editing the web app doesn't flip it).
    dirty = "-dirty" if _git("status", "--porcelain", "--", "src", "../native") else ""
    stamp = time.strftime("%m%d-%H%M%S")
    version = f"{base}+{short}{dirty}.{stamp}"
    with open(GENERATED, "w") as f:
        f.write("// AUTO-GENERATED per local build by scripts/version_stamp.py — do not commit.\n")
        f.write("#pragma once\n")
        f.write(f'#define FIRMWARE_VERSION "{version}"\n')
    print(f"[version_stamp] local build version: {version}")
