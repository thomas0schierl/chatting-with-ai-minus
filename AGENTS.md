# Chatting with AI Minus: developer guide

> **Belongs here:** commands, rules and pointers that developers and coding
> agents need before changing code. **Elsewhere:** how the system is built
> (→ [docs/arc42](docs/arc42/)), how to run the test scripts
> (→ [test/README.md](test/README.md)).

## Commands

```bash
npm install
npm run dev            # build on change
npm run build          # production build (main.js)
npm test               # offline regression tests
npx tsc --noEmit       # type check
npm run svelte-check   # Svelte check
```

## Rules

- **Mobile parity:** use `requestUrl()` for HTTP, never `fetch`; no Node
  modules, no streaming. Read `response.json` inside `try`.
- **Secrets:** API keys and tokens go only to `SecretStorage`, never to
  `data.json`, logs or chat history.
- **System prompt stays static:** per-turn context goes into the user
  message.
- **No guessing from model names:** take capabilities from the provider's
  model catalog.
- **Settings repairs run once:** add a versioned migration, never a check
  that rewrites user data on every load.
- **KISS:** prefer the smallest change; no new providers, frameworks or
  abstractions without an ADR.

## Where things are

- Module map: [arc42 §5](docs/arc42/05-building-block-view.md)
- Flows (sending a message, login, model lists): [arc42 §6](docs/arc42/06-runtime-view.md)
- Persistence, errors, logging: [arc42 §8](docs/arc42/08-crosscutting-concepts.md)
- Known gaps to fix: [arc42 §11](docs/arc42/11-risks-and-technical-debt.md)

## Documentation

- Put each fact in the document that owns it ([docs/README.md](docs/README.md)).
- Start every new document with a sentence saying what belongs in it.
- Record decisions that are hard to reverse as an ADR in
  [arc42 §9](docs/arc42/09-architecture-decisions.md).
- Fixing a technical-debt item deletes its file and its row in §11.
