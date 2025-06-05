#!/bin/bash

# Blumon Release Script
# Usage: ./scripts/release.sh [patch|minor|major|version]
# Examples:
#   ./scripts/release.sh patch    # 1.0.0 -> 1.0.1
#   ./scripts/release.sh minor    # 1.0.0 -> 1.1.0  
#   ./scripts/release.sh major    # 1.0.0 -> 2.0.0
#   ./scripts/release.sh v1.2.3   # Specific version

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔵 Blumon Release Script${NC}"
echo -e "${BLUE}========================${NC}"

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

# Pull latest changes
echo -e "${BLUE}📥 Pulling latest changes...${NC}"
git pull origin main

# Get current version
CURRENT_VERSION=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
echo -e "${BLUE}📋 Current version: ${YELLOW}$CURRENT_VERSION${NC}"

# Determine new version
if [ $# -eq 0 ]; then
    echo -e "${YELLOW}Usage: $0 [patch|minor|major|version]${NC}"
    echo -e "${YELLOW}Examples:${NC}"
    echo -e "  $0 patch    # $CURRENT_VERSION -> next patch version"
    echo -e "  $0 minor    # $CURRENT_VERSION -> next minor version"
    echo -e "  $0 major    # $CURRENT_VERSION -> next major version"
    echo -e "  $0 v1.2.3   # specific version"
    exit 1
fi

# Parse current version (remove 'v' prefix)
CURRENT_VERSION_NUM=${CURRENT_VERSION#v}
IFS='.' read -ra VERSION_PARTS <<< "$CURRENT_VERSION_NUM"
MAJOR=${VERSION_PARTS[0]:-0}
MINOR=${VERSION_PARTS[1]:-0}
PATCH=${VERSION_PARTS[2]:-0}

case $1 in
    patch)
        NEW_VERSION="v$MAJOR.$MINOR.$((PATCH + 1))"
        ;;
    minor)
        NEW_VERSION="v$MAJOR.$((MINOR + 1)).0"
        ;;
    major)
        NEW_VERSION="v$((MAJOR + 1)).0.0"
        ;;
    v*.*.*)
        NEW_VERSION="$1"
        ;;
    *)
        echo -e "${RED}❌ Error: Invalid version argument '$1'${NC}"
        echo -e "${YELLOW}Use: patch, minor, major, or a specific version like v1.2.3${NC}"
        exit 1
        ;;
esac

echo -e "${GREEN}🎯 New version: ${YELLOW}$NEW_VERSION${NC}"

# Confirm release
echo -e "${BLUE}🤔 Ready to create release $NEW_VERSION?${NC}"
read -p "Press Enter to continue or Ctrl+C to cancel..."

# Create and push tag
echo -e "${BLUE}🏷️  Creating tag...${NC}"
git tag -a "$NEW_VERSION" -m "Release $NEW_VERSION"

echo -e "${BLUE}📤 Pushing tag...${NC}"
git push origin "$NEW_VERSION"

echo -e "${GREEN}🎉 Release $NEW_VERSION created successfully!${NC}"
echo -e "${BLUE}📋 What happens next:${NC}"
echo -e "  1. GitHub Actions will build and deploy to Pages"
echo -e "  2. Check deployment status: https://github.com/hobzcalvin/blumon/actions"
echo -e "  3. Visit your app: https://hobzcalvin.github.io/blumon"
echo -e "  4. The app will show version $NEW_VERSION in the footer"

echo -e "${GREEN}✅ Done!${NC}" 