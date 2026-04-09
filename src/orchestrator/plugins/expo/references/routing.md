# Expo Router & Navigation

## File-Based Routing

Routes map to files in the `app/` directory:

| File | Route |
|------|-------|
| `app/index.tsx` | `/` |
| `app/about.tsx` | `/about` |
| `app/user/[id].tsx` | `/user/:id` |
| `app/(tabs)/_layout.tsx` | Tab navigator |
| `app/(auth)/login.tsx` | `/login` (grouped) |

## Layout Files

Every directory can have a `_layout.tsx` that wraps its children:

```tsx
import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Home' }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}
```

## Navigation

```tsx
import { Link, useRouter } from 'expo-router';

// Declarative
<Link href="/user/123">View Profile</Link>

// Imperative
const router = useRouter();
router.push('/user/123');
router.replace('/home');
router.back();
```

## Deep Linking

Configure in `app.json`:

```json
{
  "expo": {
    "scheme": "myapp",
    "web": {
      "bundler": "metro"
    }
  }
}
```

URLs like `myapp://user/123` automatically resolve to `app/user/[id].tsx`.

## Tab Navigation

```tsx
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export default function TabLayout() {
  return (
    <Tabs>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <Ionicons name="home" color={color} size={24} />,
        }}
      />
    </Tabs>
  );
}
```
