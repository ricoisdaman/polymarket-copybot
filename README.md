# Copybot v1

Paper-first Polymarket copy-trading bot monorepo.

This guide is written for non-technical users. Follow it in order and do not skip steps.

## 1) What this project includes

- apps/bot-worker: main copy-trading worker
- apps/guardian-worker: safety checks and auto-pause logic
- apps/api-server: backend for dashboard APIs
- apps/dashboard: web dashboard (Next.js)
- packages/db: Prisma + SQLite storage
- configs/default.config.json: default config template

## 2) Safety first (read this)

- Start in PAPER mode only.
- Never commit .env files.
- Never commit database files (.db) or logs.
- Never share wallet private keys or API secrets in chat/screenshots.

This repository is configured to ignore sensitive/local files by default.

## 3) First-time setup (Windows)

1. Install Node.js LTS (v20+ recommended):
	- https://nodejs.org/
2. Install pnpm globally:
	- `npm install -g pnpm`
3. Open this folder in VS Code.
4. In terminal at repo root, run:
	- `pnpm install`
	- `pnpm db:generate`
	- `pnpm db:push`

If all commands finish without errors, your machine is ready.

## 4) Configure your env files

1. Duplicate an example file (for each profile you want):
	- `.env.example` -> `.env`
	- `.env.leader2.example` -> `.env.leader2` (if used)
2. Edit values carefully:
	- `PROFILE_ID`
	- `BOT_MODE` (keep `PAPER` for testing)
	- `LEADER_WALLET`
	- `STARTING_USDC`
3. For LIVE mode (later), you must set wallet/API credentials in your local .env only.

## 5) Run the bot

Option A: run whole stack
- `pnpm dev`

Option B: run with launcher scripts
- API only: `start-api.bat`
- Main bot profile: `start-bot.bat`
- Extra profile workers: `start-leader2.bat`, `start-leader3.bat`, `start-leader4.bat`

Dashboard URL:
- http://localhost:3000

API URL:
- http://localhost:4000

## 6) Health checks

- Build/type check:
  - `pnpm typecheck`
  - `pnpm build`
- DB schema sync:
  - `pnpm db:push`
- Overnight soak test:
  - `pnpm soak:overnight`

## 7) Git setup for v1 release

This project already has git initialized. To publish a clean v1:

1. Review changes:
	- `git status`
2. Stage all safe files:
	- `git add .`
3. Commit:
	- `git commit -m "v1: initial public-safe copybot release"`
4. Create a new empty GitHub repo, then connect remote:
	- `git remote add origin <your-repo-url>`
5. Push:
	- `git branch -M main`
	- `git push -u origin main`

## 8) Before sharing with friends/family (checklist)

- Confirm no .env files are tracked:
  - `git ls-files ".env*"`
- Confirm no DB files are tracked:
  - `git ls-files | findstr /i ".db"`
- Confirm no logs are tracked:
  - `git ls-files | findstr /i "logs/"`
- Confirm no local build artifacts are tracked:
  - `git ls-files | findstr /i ".next-dev .turbo"`
- Run app once after cloning on a clean machine.

If any command shows sensitive files, stop and remove them from git before sharing.

## 9) Common mistakes to avoid

- Running LIVE mode too early.
- Sharing screenshots that include wallet/API keys.
- Copying your local .env into chat or commits.
- Committing local DB/log files and then sharing the repo.

## 10) Support note

If the dashboard numbers look wrong after a reset, restart the profile worker so in-memory state re-hydrates from DB.
