---
name: expo-development
description: "Scaffolds Expo/React Native apps, configures EAS Build profiles, manages native modules via CNG, sets up Expo Router navigation, and uses EAS Update for OTA deployments. Use when creating React Native apps with Expo, configuring EAS builds, setting up Expo Router, managing native modules, or deploying OTA updates."
---

# Expo Development

## Topic Routing

Read the matching reference before writing code for any of these topics:

| Topic | Reference |
|-------|-----------|
| EAS Build & deployment | `references/eas-build.md` |
| Expo Router & navigation | `references/routing.md` |
| Native modules & CNG | `references/native-modules.md` |

## Critical Rules

**Project Setup**
- Use `npx create-expo-app@latest` for new projects — always target the latest SDK
- Use Continuous Native Generation (CNG) — never eject; prefer `npx expo prebuild` when native config is needed
- Configure `app.json` / `app.config.ts` for all project metadata — never modify native projects directly when using CNG

**Expo Router**
- File-based routing in `app/` — define `_layout.tsx` in each directory for `<Stack>`, `<Tabs>`, or `<Drawer>`
- Use `Link` for declarative navigation, `useRouter()` for imperative — configure `scheme` in app.json for deep links

**EAS Build**
- Define `development` / `preview` / `production` profiles in `eas.json`
- Preview: `"distribution": "internal"` + `"channel": "preview"` — Development: add `"developmentClient": true`
- Production: `"channel": "production"` + `"autoIncrement": true`

**EAS Update (OTA)**
- `eas update --channel production` for JS-only changes — no app store review
- Set `"runtimeVersion": { "policy": "fingerprint" }` — mismatched runtimeVersion forces a new binary build

**Native Modules**
- Prefer Expo SDK packages over community alternatives — install with `npx expo install` for version resolution
- Config plugins (`app.plugin.js`) modify native projects at prebuild time — never edit `ios/` or `android/` directly
- Custom native code: `npx create-expo-module` scaffolds Swift + Kotlin module

**Security**
- Store API keys and secrets in EAS Secrets — never hardcode in `app.json` or source code
- Use `expo-secure-store` for device-side secret storage

## Workflow: New Project → Build → Deploy

1. **Scaffold** — `npx create-expo-app@latest my-app --template default@sdk-55`
2. **Verify local** — `cd my-app && npx expo start` → confirm app loads in simulator
3. **Init EAS** — `eas init && eas build:configure` → creates `eas.json` with profiles
4. **Build preview** — `eas build --profile preview --platform ios`
5. **Check status** — `eas build:list` → wait for `finished` status; if `errored` → `eas build:view <id>` → fix config → rebuild
6. **Test** — install preview build on device via QR code or TestFlight
7. **Build production** — `eas build --profile production --platform all`
8. **Submit** — `eas submit --platform ios && eas submit --platform android`

## Workflow: OTA Update

1. **Make JS-only changes** — modify components, styles, or logic (no native module changes)
2. **Deploy** — `eas update --channel production --message "Fix: button alignment"`
3. **Verify** — `eas update:list` → confirm update published with correct `runtimeVersion`
4. **Rollback if needed** — `eas update:republish --group <previous-group-id>`

> If `runtimeVersion` mismatch: a new binary build is required — OTA cannot bridge native changes.

## Build Failure Recovery

```
Build failed → check logs
├── "Provisioning profile" error → eas credentials → fix iOS signing
├── "SDK version mismatch" → npx expo install --fix → rebuild
├── "Metro bundler" error → check JS syntax → npx expo start to reproduce
├── "Native module" error → npx expo prebuild --clean → verify config plugins
└── "EAS secret" missing → eas secret:create → rebuild
```

## Screen with Expo Router

```tsx
// app/user/[id].tsx
import { useLocalSearchParams } from 'expo-router';
import { View, Text } from 'react-native';

export default function UserScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text>User {id}</Text>
    </View>
  );
}
```

## EAS Build Profile

```json
{
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal",
      "channel": "preview"
    },
    "production": {
      "channel": "production",
      "autoIncrement": true
    }
  }
}
```
