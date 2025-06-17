#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration ---
ESP32_VERSION_FILE="esp32/src/firmware_version.h" # File to store firmware version
VERSION_DEFINE_PATTERN="FIRMWARE_VERSION" # The #define name in the version file

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# --- Helper Functions ---
show_usage() {
  echo -e "${BLUE}🔵 ESP32 Firmware Release Script${NC}"
  echo -e "${BLUE}==================================${NC}"
  echo ""
  echo "Usage: $(basename "$0") [patch|minor|major|version]"
  echo ""
  echo "This script automates the ESP32 firmware release process:"
  echo "1. Increments version (patch/minor/major) or sets specific version"
  echo "2. Updates the version in '$ESP32_VERSION_FILE'"
  echo "3. Commits the version change"
  echo "4. Creates a new git tag with the provided version"
  echo "5. Pushes the tag to trigger GitHub Actions release"
  echo ""
  echo -e "${YELLOW}Examples:${NC}"
  echo "  $0 patch     # fwv0.0.1 -> fwv0.0.2"
  echo "  $0 minor     # fwv0.0.1 -> fwv0.1.0" 
  echo "  $0 major     # fwv0.0.1 -> fwv1.0.0"
  echo "  $0 fwv1.2.3  # Set specific version"
  echo ""
  echo -e "${RED}Important:${NC} Ensure you have committed all other changes for this release"
  echo "and are on the main branch before running this script."
}

# --- Main Script ---

# Display usage if requested
if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  show_usage
  exit 0
fi

echo -e "${BLUE}🔵 ESP32 Firmware Release Process${NC}"
echo -e "${BLUE}===================================${NC}"

# Check if we're on main branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo -e "${RED}❌ Error: You must be on the main branch to create a release${NC}"
    echo -e "${YELLOW}Current branch: $CURRENT_BRANCH${NC}"
    exit 1
fi

# Check if working directory is clean
if [ -n "$(git status --porcelain)" ]; then
    echo -e "${RED}❌ Error: Working directory is not clean${NC}"
    echo -e "${YELLOW}Please commit or stash your changes before creating a release${NC}"
    git status --short
    exit 1
fi

# Check if current branch is ahead of origin/main
echo -e "${BLUE}🔍 Checking branch status...${NC}"
git fetch origin main
AHEAD=$(git rev-list --count origin/main..HEAD)
BEHIND=$(git rev-list --count HEAD..origin/main)

if [ "$BEHIND" -gt 0 ]; then
    echo -e "${RED}❌ Error: Your branch is $BEHIND commits behind origin/main${NC}"
    echo -e "${YELLOW}Please pull latest changes first: git pull origin main${NC}"
    exit 1
fi

if [ "$AHEAD" -gt 0 ]; then
    echo -e "${YELLOW}⚠️  Your branch is $AHEAD commits ahead of origin/main${NC}"
    echo -e "${BLUE}🚀 Will push local commits to origin before creating release...${NC}"
fi

# Get current version from git tags (only firmware versions starting with 'fwv')
CURRENT_VERSION=$(git tag --sort=-version:refname | grep "^fwv" | head -1 || echo "fwv0.0.0")
if [ -z "$CURRENT_VERSION" ]; then
    echo -e "${RED}❌ Error: Could not find any firmware version tags (fwv*)${NC}"
    exit 1
fi

echo -e "${BLUE}📋 Current version: ${YELLOW}$CURRENT_VERSION${NC}"

# Determine new version
if [ $# -eq 0 ]; then
    show_usage
    exit 1
fi

# Parse current version (remove 'fwv' prefix)
CURRENT_VERSION_NUM=${CURRENT_VERSION#fwv}
IFS='.' read -ra VERSION_PARTS <<< "$CURRENT_VERSION_NUM"
MAJOR=${VERSION_PARTS[0]:-0}
MINOR=${VERSION_PARTS[1]:-0}  
PATCH=${VERSION_PARTS[2]:-0}

case $1 in
    patch)
        NEW_VERSION="fwv$MAJOR.$MINOR.$((PATCH + 1))"
        ;;
    minor)
        NEW_VERSION="fwv$MAJOR.$((MINOR + 1)).0"
        ;;
    major)
        NEW_VERSION="fwv$((MAJOR + 1)).0.0"
        ;;
    fwv*.*.*)
        NEW_VERSION="$1"
        ;;
    *)
        echo -e "${RED}❌ Error: Invalid version argument '$1'${NC}"
        echo -e "${YELLOW}Use: patch, minor, major, or a specific version like fwv1.2.3${NC}"
        exit 1
        ;;
esac

echo -e "${GREEN}🎯 New version: ${YELLOW}$NEW_VERSION${NC}"

# Confirm release
echo -e "${BLUE}🤔 Ready to create ESP32 firmware release $NEW_VERSION?${NC}"
read -p "Press Enter to continue or Ctrl+C to cancel..."

# Push any local commits first if we're ahead
if [ "$AHEAD" -gt 0 ]; then
    echo -e "${BLUE}📤 Pushing local commits to origin/main...${NC}"
    git push origin main
fi

# Update version in the ESP32 source file
echo -e "${BLUE}📝 Updating version in '$ESP32_VERSION_FILE'...${NC}"

# Using sed to update the version string
# Format: #define FIRMWARE_VERSION "fwvX.Y.Z"
sed -i.bak "s/#define $VERSION_DEFINE_PATTERN \".*\"/#define $VERSION_DEFINE_PATTERN \"$NEW_VERSION\"/" "$ESP32_VERSION_FILE"
rm "${ESP32_VERSION_FILE}.bak" # Remove backup file created by sed -i on macOS

echo -e "${GREEN}✅ Updated version in '$ESP32_VERSION_FILE'${NC}"

# Git operations: add, commit, tag, push
echo -e "${BLUE}📝 Committing version update...${NC}"
git add "$ESP32_VERSION_FILE"
git commit -m "release(esp32): Bump firmware version to $NEW_VERSION"

echo -e "${BLUE}🏷️  Creating git tag '$NEW_VERSION'...${NC}"
if git rev-parse "$NEW_VERSION" >/dev/null 2>&1; then
  echo -e "${YELLOW}⚠️  Tag '$NEW_VERSION' already exists locally.${NC}"
  echo -n "Delete and recreate? (y/N): "
  read -r confirm_delete_tag || { echo -e "\n${RED}❌ Operation cancelled${NC}"; exit 1; }
  if [[ "$confirm_delete_tag" == "y" || "$confirm_delete_tag" == "Y" ]]; then
    git tag -d "$NEW_VERSION"
    echo -e "${GREEN}✅ Deleted local tag '$NEW_VERSION'${NC}"
  else
    echo -e "${RED}❌ Release aborted. Please use a different version or manually manage the existing tag.${NC}"
    exit 1
  fi
fi

git tag -a "$NEW_VERSION" -m "ESP32 Firmware Release $NEW_VERSION"

echo -e "${BLUE}📤 Pushing tag '$NEW_VERSION' to remote...${NC}"
git push origin "$NEW_VERSION"

echo -e "${GREEN}🎉 ESP32 Firmware Release $NEW_VERSION created successfully!${NC}"
echo -e "${BLUE}📋 What happens next:${NC}"
echo -e "  1. GitHub Actions will build, sign, and create release"
echo -e "  2. Check deployment status: https://github.com/hobzcalvin/blumon/actions"
echo -e "  3. Signed firmware will be available in GitHub releases"
echo -e "  4. Use BLE OTA client to update ESP32 devices securely"

echo -e "${GREEN}✅ Done!${NC}"

exit 0
