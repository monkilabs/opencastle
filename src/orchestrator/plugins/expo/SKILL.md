---
name: expo-development
description: "Scaffolds Expo/React Native apps, configures EAS Build profiles, manages native modules via CNG, sets up Expo Router navigation, and uses EAS Update for OTA deployments. Use when creating React Native apps with Expo, configuring EAS builds, setting up Expo Router, managing native modules, or deploying OTA updates."
---

# Expo Development

## Continuous Native Generation

- Never eject, never edit `ios/` or `android/` — `npx expo prebuild` regenerates both from `app.json` / `app.config.ts`, so hand edits vanish. Gitignore both directories. `npx expo prebuild --clean` when native state is suspect.
- Native config changes go through config plugins (`app.plugin.js`, registered in `expo.plugins`) applied at prebuild time. `npx create-expo-module` scaffolds a Swift + Kotlin module.
- Install with `npx expo install`, not `npm install`, so versions resolve against the SDK. `npx expo install --fix` repairs an SDK version mismatch.

## EAS Build / Update

- `eas.json` profiles: development = `developmentClient: true` + `distribution: internal`; preview = `distribution: internal` + `channel`; production = `channel` + `autoIncrement: true`.
- Set `runtimeVersion: { policy: "fingerprint" }` in app.json. `eas update --channel production` ships JS only — a runtimeVersion mismatch forces a new binary build, and native changes can never go OTA.
- Rollback: `eas update:republish --group <previous-group-id>`. Diagnose failures via `eas build:list` then `eas build:view <id>`.
- Secrets belong in EAS Secrets (`eas secret:create`), never `app.json`; device-side storage via `expo-secure-store`.
- iOS signing failures: `eas credentials`. CI/CD lives in `.eas/workflows/`.

## Expo Router

Files under `app/` are routes; a `_layout.tsx` per directory supplies `<Stack>` / `<Tabs>` / `<Drawer>`. Parenthesized directories are groups and do not appear in the URL — `app/(auth)/login.tsx` serves `/login`. Read dynamic segments with `useLocalSearchParams()`. Deep links require `scheme` in app.json; `myapp://user/123` then resolves to `app/user/[id].tsx`.

Docs: https://docs.expo.dev/
