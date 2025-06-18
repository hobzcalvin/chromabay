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

# Check if there are staged changes (which should be committed before release)
STAGED_CHANGES=$(git diff --cached --name-only)
if [ -n "$STAGED_CHANGES" ]; then
    echo -e "${RED}❌ Error: You have staged changes that haven't been committed${NC}"
    echo -e "${YELLOW}Please commit your staged changes before creating a release:${NC}"
    git diff --cached --name-status
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

# Get current version (only app versions starting with 'v' but not 'fwv')
CURRENT_VERSION=$(git tag --sort=-version:refname | grep "^v[0-9]" | grep -v "^fwv" | head -1 || echo "v0.0.0")
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
echo -e "${YELLOW}Press Enter to continue or Ctrl+C to cancel...${NC}"
read -r confirmation || { echo -e "\n${RED}❌ Release cancelled by user${NC}"; exit 1; }

# Push any local commits first if we're ahead
if [ "$AHEAD" -gt 0 ]; then
    echo -e "${BLUE}📤 Pushing local commits to origin/main...${NC}"
    git push origin main
fi

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