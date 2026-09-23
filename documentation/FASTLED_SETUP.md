# FastLED WASM Compilation Setup

## Problem
The latest FastLED web compiler (September 2025) produces WASM files that work on desktop but fail on iPhone. The working files (111KB JS, 1.5MB WASM) are different from what the latest compiler produces (89KB JS, 916KB WASM).

## Working Solution
Modified the global FastLED Python package to use the March 11, 2025 Docker image instead of the latest version. This produces iPhone-compatible WASM files.

## Required Global Modifications
The following global FastLED Python package files were modified to use "main" tag instead of "latest":

1. `/Users/grant/.pyenv/versions/3.11.5/lib/python3.11/site-packages/fastled/compile_server_impl.py`
   - Changed `tag="latest"` to `tag="main"` (all occurrences)

2. `/Users/grant/.pyenv/versions/3.11.5/lib/python3.11/site-packages/fastled/docker_manager.py`
   - Changed default tag from `"latest"` to `"main"`

## NPM Scripts
- `npm run wasm:compile` → **Working version** (111KB JS, 1.5MB WASM, works on iPhone)
- `npm run wasm:compile:newbroken` → **Broken version** (uses latest web service)

## How It Works
1. **Global pyenv modifications** force FastLED to use March 11 Docker image
2. **March 11 image** uses PlatformIO + FastLED @ 3.9.14 
3. **Local Docker compilation** (`--localhost`) instead of web service
4. **Result**: iPhone-compatible WASM files

## File Comparison
| Version | JS Size | WASM Size | iPhone Compatible |
|---------|---------|-----------|-------------------|
| Current Working (March 11) | 111KB | 1.5MB | ✅ Yes |
| Latest Web Service | 89KB | 916KB | ❌ No |
| Original Mystery | 78KB | 283KB | ✅ Yes |

## Usage
Simply run `npm run wasm:compile` to get iPhone-compatible WASM files. The global pyenv modifications ensure it uses the working March 11 Docker image.

## Technical Details
The key differences in the working March 11 version:
- **PlatformIO compilation** (not direct emcc)
- **FastLED @ 3.9.14** (older, stable version)
- **Docker image: niteris/fastled-wasm:main** (March 11, 2025)
- **Local Docker compilation** (`--localhost`) instead of web service

## Troubleshooting
- If compilation fails, ensure Docker is running
- To reset, delete Docker images: `docker rmi niteris/fastled-wasm:latest`
- Check Docker logs if container startup fails

## Investigation History
This setup was created by systematically testing different FastLED versions and Docker images to find a configuration that produces iPhone-compatible WASM files. Multiple repo-based approaches were attempted but failed due to Python import system complexities. The global modification approach is the only reliable method that consistently produces working files.

The investigation tested:
1. Multiple Docker image versions (latest, main, nightly)
2. Different FastLED CLI versions (1.2.50, 1.3.29)
3. Web vs local compilation methods
4. Git history searches for matching source code
5. Local package modifications (failed due to import conflicts)
6. Runtime patching approaches (failed to reach correct code paths)

## Future Work
The original 78KB JS, 283KB WASM files remain a mystery. The current working solution (111KB JS, 1.5MB WASM) successfully resolves iPhone compatibility issues and should be used for production deployments.