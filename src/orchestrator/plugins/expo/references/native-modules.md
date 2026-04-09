# Native Modules & CNG

## Continuous Native Generation (CNG)

CNG regenerates native projects from `app.json` config:

```bash
# Generate native projects (don't commit these)
npx expo prebuild

# Clean and regenerate
npx expo prebuild --clean
```

Add `ios/` and `android/` to `.gitignore` when using CNG.

## Installing Expo SDK Packages

Always use `npx expo install` — it resolves compatible versions:

```bash
npx expo install expo-camera expo-location expo-notifications
```

## Config Plugins

Modify native projects at prebuild time without manual edits:

```js
// app.plugin.js
const { withInfoPlist } = require('@expo/config-plugins');

module.exports = function myPlugin(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.NSCameraUsageDescription = 'App needs camera access';
    return config;
  });
};
```

Register in `app.json`:

```json
{
  "expo": {
    "plugins": ["./app.plugin.js"]
  }
}
```

## Creating Custom Modules

```bash
npx create-expo-module my-native-module
```

This scaffolds a module with iOS (Swift) and Android (Kotlin) native code.

## Expo SDK Package Selection

| Need | Package |
|------|---------|
| Camera | `expo-camera` |
| Location | `expo-location` |
| Push notifications | `expo-notifications` |
| File system | `expo-file-system` |
| Secure storage | `expo-secure-store` |
| Auth | `expo-auth-session` |
| SQLite | `expo-sqlite` |
| Haptics | `expo-haptics` |
| Image picker | `expo-image-picker` |
