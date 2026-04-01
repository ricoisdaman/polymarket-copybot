- [x] Verify that the copilot-instructions.md file in the .github directory is created.
- [x] Clarify Project Requirements.
- [x] Scaffold the Project.
- [x] Customize the Project.
- [x] Install Required Extensions. (No extensions required by project setup info.)
- [x] Compile the Project.
- [x] Create and Run Task.
- [x] Launch the Project.
- [x] Ensure Documentation is Complete.

Project summary:
- Monorepo root uses pnpm workspaces and Turborepo.
- Apps: api-server, bot-worker, guardian-worker, dashboard.
- Packages: core (types + schema), db (Prisma SQLite schema), polymarket (integration skeleton).
- Default bot config is in `configs/default.config.json`.
- VS Code task `dev:all` is configured and runnable.
- VS Code launch profile `API Server (TSX)` is configured.
