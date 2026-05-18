> Parent: [SKILL.md](./SKILL.md)

# Frontend Design Components

Extended component patterns, card variants, hero animations for **frontend-design** skill.

## Design Tokens (starter)

```css
:root {
	--color-bg: #0f1724;
	--color-ink: #e6eef8;
	--color-accent: #ff7a59;
	--space-1: 4px;
	--space-2: 8px;
	--space-3: 16px;
	--radius-1: 6px;
}
```

## Entrance Animation (starter)

```css
@keyframes fadeUp {
	from { opacity: 0; transform: translateY(8px); }
	to   { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: no-preference) {
	.fade-in-up { animation: fadeUp 420ms cubic-bezier(.2,.9,.2,1) both; }
}
```

## Card Patterns

### Glass Card

```css
.card-glass {
	background: rgba(255, 255, 255, 0.05);
	backdrop-filter: blur(12px);
	border: 1px solid rgba(255, 255, 255, 0.1);
	border-radius: var(--radius-1);
	padding: var(--space-3);
}
```

### Elevated Card

```css
.card-elevated {
	background: var(--color-bg);
	border-radius: var(--radius-1);
	padding: var(--space-3);
	box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12);
	transition: transform 200ms ease, box-shadow 200ms ease;
}
.card-elevated:hover {
	transform: translateY(-2px);
	box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
}
```

## Hero Animations

### Staggered Fade-In

```css
.hero-stagger > * {
	opacity: 0;
	transform: translateY(12px);
	animation: fadeUp 500ms cubic-bezier(.2,.9,.2,1) forwards;
}
.hero-stagger > *:nth-child(1) { animation-delay: 0ms; }
.hero-stagger > *:nth-child(2) { animation-delay: 80ms; }
.hero-stagger > *:nth-child(3) { animation-delay: 160ms; }
```

### Gradient Shift

```css
.hero-gradient {
	background: linear-gradient(135deg, var(--color-accent), var(--color-bg));
	background-size: 200% 200%;
	animation: gradientShift 6s ease infinite;
}
@keyframes gradientShift {
	0%, 100% { background-position: 0% 50%; }
	50% { background-position: 100% 50%; }
}
```

## Button Variants

```css
.btn-primary {
	background: var(--color-accent);
	color: #fff;
	padding: var(--space-2) var(--space-3);
	border-radius: var(--radius-1);
	font-weight: 600;
	transition: opacity 150ms ease;
}
.btn-primary:hover { opacity: 0.9; }

.btn-ghost {
	background: transparent;
	color: var(--color-ink);
	border: 1px solid currentColor;
	padding: var(--space-2) var(--space-3);
	border-radius: var(--radius-1);
}
```
