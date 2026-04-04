# backbone-scaffolding Examples

## Convoy Scaffolding Task

```json
{
  "id": "scaffolding",
  "description": "Scaffold monorepo with backbone CLI",
  "agent": "developer",
  "complexity": 2,
  "prompt": "Scaffold the project monorepo using the backbone CLI. Ensure Node.js >= 22.5.0 is available. Run: `npx @monkilabs/backbone my-project` and select the following options when prompted:\n- Monorepo: Turborepo\n- Framework: Next.js\n- Backend: Supabase\n- CMS: Sanity\n- Testing: Playwright\n- Deployment: Vercel\n- Mobile: None\n- Packages: Email Library, LLM Library\n\nAfter scaffolding completes, run `npm install` in the generated `my-project/` directory. Then run `npx turbo build` and verify it exits 0.",
  "files": ["my-project/"]
}
```

All subsequent tasks should declare `depends_on: ["scaffolding"]` and build on the generated structure.
