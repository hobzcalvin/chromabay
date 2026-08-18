# PlatformIO pre-build hook: hand sentry-micro the identity of the binary being linked.
#
# Symbolication works by subtraction. A crash arrives carrying raw addresses; Sentry
# subtracts the image's load address and looks the result up in the debug files uploaded
# under this build's id. Every number in that sentence has to come from the same build, so
# none of them can be written down by hand — they are chosen (and measured) by
# sentry-micro's scripts/release.sh, exported as SENTRY_MICRO_*, and turned into macros
# here. `sentry_options_defaults()` in the SDK picks the macros up on its own.
#
# Nothing to configure for a normal build: with none of the variables set this injects
# nothing, the SDK leaves the fields empty, and events arrive with unresolved addresses —
# which is exactly what a local `pio run` should produce, since no debug files were uploaded
# for it either.
#
# The release chain that sets them is .github/workflows/esp32-release.yml, via
# getsentry/sentry-micro's upload-debug-files action.
Import("env")  # noqa: F821  (provided by PlatformIO/SCons)
import os

# Environment variable -> preprocessor macro. Names on the right are the SDK's.
MACROS = (
    ("SENTRY_MICRO_BUILD_ID", "SENTRY_BUILD_ID_HEX"),
    ("SENTRY_MICRO_RELEASE", "SENTRY_RELEASE"),
    ("SENTRY_MICRO_IMAGE_ADDR", "SENTRY_IMAGE_ADDR"),
    ("SENTRY_MICRO_IMAGE_SIZE", "SENTRY_IMAGE_SIZE"),
    ("SENTRY_MICRO_IMAGE_NAME", "SENTRY_IMAGE_NAME"),
)

# The two that are numbers. They go in as bare integer literals; everything else is a
# quoted string, and getting that backwards produces a compile error in the SDK rather
# than anything subtle.
NUMERIC = {"SENTRY_IMAGE_ADDR", "SENTRY_IMAGE_SIZE"}

defines = []
for variable, macro in MACROS:
    value = os.environ.get(variable)
    if not value:
        continue
    # StringifyMacro does the quoting/escaping that survives both the shell and the
    # compiler command line.
    defines.append((macro, value if macro in NUMERIC else env.StringifyMacro(value)))  # noqa: F821
    print(f"[sentry_build_env] {macro} <- {variable} ({value})")

if defines:
    env.Append(CPPDEFINES=defines)  # noqa: F821
else:
    print("[sentry_build_env] no SENTRY_MICRO_* variables set; "
          "this build's crashes will not be symbolicated")
