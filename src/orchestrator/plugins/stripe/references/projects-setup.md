# Stripe Projects Setup

Guide for initializing Stripe Projects repositories and configuring the Projects CLI for local development.

## Installation

```bash
# macOS (Homebrew)
brew install stripe/stripe-cli/stripe && stripe plugin install projects

# Verify installation
stripe projects --version
```

For other platforms, see the [Stripe CLI install docs](https://docs.stripe.com/stripe-cli/install).

## Getting Started

1. Run `stripe projects init` in your target directory — common stacks include `next`, `rails`, `python`
2. Follow the interactive prompts to select your stack and configure the project
3. Verify setup succeeded:
   - `stripe-project.json` exists in the project root
   - A `.stripe/` directory with local skills was created
   - Run the local dev command shown in init output (e.g., `npm run dev`) to confirm the stack works

If `stripe projects init` fails: verify `stripe projects --version` works, check you're logged in with `stripe login`, and ensure you have write permissions in the target directory.

## Next Steps

After init, prefer the local project skills it creates — they contain project-specific patterns and configurations. For full documentation, see the [Stripe Projects docs](https://docs.stripe.com/projects).
