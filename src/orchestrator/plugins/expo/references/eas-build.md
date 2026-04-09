# EAS Build & Deployment

## Build Profiles

Define in `eas.json` at project root:

- **development** — installs `expo-dev-client`, `distribution: internal`
- **preview** — for TestFlight/internal testing, `distribution: internal`
- **production** — for app store submission, `autoIncrement: true`

## Commands

```bash
# Build for iOS
eas build --platform ios --profile preview

# Build for Android
eas build --platform android --profile preview

# Submit to App Store
eas submit --platform ios

# Submit to Google Play
eas submit --platform android
```

## EAS Update (OTA)

```bash
# Deploy JS-only update
eas update --channel production --message "Fix button alignment"

# Check update status
eas update:list
```

## Runtime Version Policy

Use fingerprint policy in `app.json`:

```json
{
  "expo": {
    "runtimeVersion": {
      "policy": "fingerprint"
    }
  }
}
```

This auto-detects binary-incompatible changes and forces a new build.

## EAS Workflows

Define CI/CD in `.eas/workflows/`:

```yaml
name: build-and-deploy
on:
  push:
    branches: [main]
jobs:
  build:
    type: build
    params:
      platform: ios
      profile: production
  submit:
    type: submit
    needs: [build]
    params:
      platform: ios
```
