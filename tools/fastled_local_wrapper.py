#!/usr/bin/env python3
"""
FastLED Local Wrapper Script

This wrapper uses runtime patching to force the global FastLED package to use the
older Docker image (niteris/fastled-wasm:main from March 11, 2025) instead
of the latest image that produces incompatible WASM files for iPhone.
"""

import sys

def patch_fastled_docker_tag():
    """Patch the FastLED package to use 'main' tag instead of 'latest'"""
    # Import the global FastLED package
    import fastled.docker_manager
    import fastled.compile_server_impl
    
    # Patch the DockerManager class
    original_validate = fastled.docker_manager.DockerManager.validate_or_download_image
    
    def patched_validate(self, image_name: str, tag: str = "main", upgrade: bool = False) -> bool:
        """Patched version that defaults to 'main' tag"""
        return original_validate(self, image_name, tag, upgrade)
    
    # Apply the patch
    fastled.docker_manager.DockerManager.validate_or_download_image = patched_validate
    
    # Also patch any direct calls in compile_server_impl
    if hasattr(fastled.compile_server_impl, 'DockerManager'):
        fastled.compile_server_impl.DockerManager.validate_or_download_image = patched_validate
    
    print(f"✅ Patched FastLED to use 'main' Docker tag instead of 'latest'")

if __name__ == "__main__":
    # Apply the patch before running FastLED
    patch_fastled_docker_tag()
    
    # Now import and run the FastLED main function
    from fastled.cli import main
    sys.exit(main())
