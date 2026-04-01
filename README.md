# Copybot v1 Beginner Setup Guide

This guide is written for people with little or no coding experience.

Read every step in order.
Do not skip steps.

## 1. Important safety rules

1. Start in PAPER mode only.
2. Do not use LIVE mode until PAPER mode works for multiple days.
3. Never share private keys, API secrets, or passphrases.
4. Never upload env files anywhere.
5. If unsure, stop and ask for help before continuing.

## 2. What this project is

1. Bot worker: reads leader activity and places copy trades.
2. Guardian worker: safety checks, pause protection, alerts.
3. API server: data backend for dashboard.
4. Dashboard: visual UI to monitor bot status.
5. Database package: stores runtime state in local SQLite.

## 3. Software you must install

This project now supports both Windows and macOS from the same codebase.

Install these in this exact order:

1. Google Chrome
	- https://www.google.com/chrome/
2. Git for Windows
	- https://git-scm.com/download/win
	- During setup, keep default options.
3. Node.js LTS (version 20 or newer)
	- https://nodejs.org/
	- Download the LTS installer, not Current.
4. Visual Studio Code
	- https://code.visualstudio.com/

After installing Node.js, open terminal and run:

npm install -g pnpm

Then run:

node -v
pnpm -v
git --version

If all three commands print versions, continue.

## 4. Download this project

If you are cloning from GitHub:

1. Open terminal.
2. Go to your chosen folder, example:

Windows example:

cd C:\Users\YourName\Documents

macOS example:

cd ~/Documents

3. Clone repo:

git clone https://github.com/ricoisdaman/polymarket-copybot.git

4. Enter folder:

cd polymarket-copybot

5. Open in VS Code:

code .

## 5. First project setup

In VS Code terminal, run these one by one (same commands on Windows and Mac):

pnpm install
pnpm db:generate
pnpm db:push

Wait for each command to finish before running the next one.

## 6. Configure paper mode (safe mode)

You must create your own local env file.

1. In project root, copy .env.example to .env
2. Open .env
3. Make sure these values exist:

BOT_MODE=PAPER
ENABLE_LIVE_EXECUTION=false

4. Set leader wallet you want to follow:

LEADER_WALLET=0x...

5. Set paper starting balance:

STARTING_USDC=25

6. Save file.

## 7. Start the bot in paper mode

Option A (simplest):

pnpm dev

Option B (separate windows):

Windows:

start-api.bat
start-bot.bat

macOS:

pnpm --filter @copybot/api-server dev
pnpm --filter @copybot/bot-worker dev
pnpm --filter @copybot/guardian-worker dev
pnpm --filter @copybot/dashboard dev

Dashboard should open at:

http://localhost:3000

API health check:

http://localhost:4000/health

## 8. Optional profiles (leader2, leader3, leader4)

If using additional profiles:

1. Copy each example env file to matching real file.
2. Set each PROFILE_ID and LEADER_WALLET.
3. Keep each in PAPER mode first.
4. Start with their launcher batch files:
	- start-leader2.bat
	- start-leader3.bat
	- start-leader4.bat

On macOS, start each profile worker directly with pnpm filter commands and the matching env file strategy.

## 9. Hooking up to a real Polymarket account (LIVE mode, advanced)

Do this only after paper mode is stable.

You need all of these from your own account:

1. POLYMARKET_WALLET_ADDRESS
2. POLYMARKET_PRIVATE_KEY
3. POLYMARKET_API_KEY
4. POLYMARKET_API_SECRET
5. POLYMARKET_API_PASSPHRASE

Then in your local .env:

BOT_MODE=LIVE
ENABLE_LIVE_EXECUTION=true

Keep trade sizes very small at first.

If any credential is missing, the bot should refuse live execution.

## 10. Common problems and quick fixes

1. Dashboard shows wrong cash after reset:
	- Restart the profile worker.
2. Command not found for pnpm:
	- Run npm install -g pnpm again, then reopen terminal.
3. Port already in use:
	- Close old terminals and restart.
	- On macOS, you can also stop a port with: lsof -i :3000 or lsof -i :4000
4. Bot paused itself:
	- Check alerts in dashboard and fix cause before resuming.

## 11. macOS notes

1. .bat and .ps1 launchers are Windows helpers only.
2. Use pnpm commands directly on macOS.
3. Core scripts are cross-platform now:
	- pnpm dev
	- pnpm soak:overnight

## 12. Ultra-simple AI helper instructions for non-technical users

If user gets stuck, they can copy this prompt into an AI coding assistant:

I am not technical. Help me run this bot project safely in PAPER mode only.
I am on Windows.
I am in the project folder.
Please give me one command at a time.
After each command, wait and ask me to paste the output.
Do not ask me to expose any private key or secret.
If there is an error, explain it in plain English and give one safe fix.

## 13. AI prompt for maintainers (you)

Use this when helping friends/family remotely:

Help me onboard a beginner user on Windows for this repo.
Rules:
1. PAPER mode only.
2. One step at a time, no jargon.
3. Ask for command output after each step.
4. Never ask user to share secrets.
5. If setup succeeds, run a final safety checklist.

## 14. Final safety checklist before sharing this repo

Run these commands:

git ls-files ".env*"
git ls-files | findstr /i ".db"
git ls-files | findstr /i "logs/"
git ls-files | findstr /i ".next-build .next-dev .turbo"

All commands above should return no output.

If any command prints files, stop and fix before sharing.
