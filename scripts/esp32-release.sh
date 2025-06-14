#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration ---
ESP32_VERSION_FILE="esp32/src/firmware_version.h" # Assumed file to store firmware version
VERSION_DEFINE_PATTERN="FIRMWARE_VERSION" # The #define name in the version file

# --- Helper Functions ---
show_usage() {
  echo "Usage: $(basename "$0")"
  echo "This script automates the ESP32 firmware release process:"
  echo "1. Prompts for a new firmware version (e.g., esp32-v1.0.0)."
  echo "2. Validates the version format."
  echo "3. Updates the version in '$ESP32_VERSION_FILE'."
  echo "4. Commits the version change."
  echo "5. Creates a new git tag with the provided version."
  echo "6. Pushes the new tag to the remote repository to trigger the release GHA."
  echo ""
  echo "Important: Ensure you have committed all other changes for this release"
  echo "           and are on the main branch before running this script."
}

# --- Main Script ---

# Display usage if requested
if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  show_usage
  exit 0
fi

echo "Starting ESP32 Firmware Release Process..."
echo "-----------------------------------------"

# 1. Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
  echo "Error: You have uncommitted changes. Please commit or stash them before creating a release."
  exit 1
fi

echo "Current branch: $(git rev-parse --abbrev-ref HEAD)"
if [[ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]]; then
  read -r -p "Warning: You are not on the main branch. Continue anyway? (y/N): " confirm_branch
  if [[ "$confirm_branch" != "y" && "$confirm_branch" != "Y" ]]; then
    echo "Release aborted by user."
    exit 1
  fi
fi


# 2. Prompt for the new ESP32 firmware version
read -r -p "Enter the new ESP32 firmware version (e.g., esp32-v1.0.0): " new_version

# 3. Validate the version format (esp32-vX.Y.Z)
version_regex="^esp32-v([0-9]+)\.([0-9]+)\.([0-9]+)$"
if [[ ! "$new_version" =~ $version_regex ]]; then
  echo "Error: Invalid version format. Expected format: esp32-vX.Y.Z (e.g., esp32-v1.0.0)"
  exit 1
fi

echo "New ESP32 firmware version: $new_version"

# 4. Update version in the ESP32 source file
if [ ! -f "$ESP32_VERSION_FILE" ]; then
  echo "Error: Version file '$ESP32_VERSION_FILE' not found."
  echo "Please create it with a line like: #define $VERSION_DEFINE_PATTERN \"esp32-v0.0.0\""
  exit 1
fi

# Check if the version define pattern exists
if ! grep -q "#define $VERSION_DEFINE_PATTERN" "$ESP32_VERSION_FILE"; then
    echo "Error: Pattern '#define $VERSION_DEFINE_PATTERN' not found in '$ESP32_VERSION_FILE'."
    exit 1
fi

# Using sed to update the version string. This assumes a specific format.
# Format: #define FIRMWARE_VERSION "esp32-vX.Y.Z"
sed -i.bak "s/#define $VERSION_DEFINE_PATTERN \".*\"/#define $VERSION_DEFINE_PATTERN \"$new_version\"/" "$ESP32_VERSION_FILE"
rm "${ESP32_VERSION_FILE}.bak" # Remove backup file created by sed -i on macOS

echo "Updated version in '$ESP32_VERSION_FILE'."

# 5. Git operations: add, commit, tag, push
echo "Committing version update..."
git add "$ESP32_VERSION_FILE"
git commit -m "release(esp32): Bump firmware version to $new_version"

echo "Creating git tag '$new_version'..."
if git rev-parse "$new_version" >/dev/null 2>&1; then
  echo "Error: Tag '$new_version' already exists."
  # Optionally, offer to delete and recreate, or just exit.
  # For now, exiting to prevent accidental overwrite.
  read -r -p "Tag '$new_version' already exists locally. Delete and recreate? (y/N): " confirm_delete_tag
  if [[ "$confirm_delete_tag" == "y" || "$confirm_delete_tag" == "Y" ]]; then
    git tag -d "$new_version"
    echo "Deleted local tag '$new_version'."
  else
    echo "Release aborted. Please use a different version or manually manage the existing tag."
    exit 1
  fi
fi
git tag "$new_version"

echo "Pushing new tag '$new_version' to remote..."
git push origin "$new_version"

echo "-----------------------------------------"
echo "ESP32 Firmware Release Process Complete!"
echo "Version: $new_version"
echo "Tag pushed to remote. This should trigger the ESP32 release GitHub Action."
echo "-----------------------------------------"

exit 0
