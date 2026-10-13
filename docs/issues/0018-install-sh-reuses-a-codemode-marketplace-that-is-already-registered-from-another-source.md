---
type: Issue
title: install.sh reuses a codemode marketplace that is already registered from another source
description: When a marketplace named codemode is already registered, install.sh installs codemode@codemode from it instead of failing on a source mismatch with extraKnownMarketplaces.
status: closed
timestamp: 2026-10-13T21:37:21Z
---

## 0018. install.sh reuses a codemode marketplace that is already registered from another source

On 2026-10-12 a reinstall in the owner's config failed. Its `settings.json` declares `extraKnownMarketplaces.codemode` as the git source `https://github.com/ejklock/claude-code-mode.git` at ref `v0.7.2`. `install.sh` runs `claude plugin install codemode --marketplace ejklock/claude-code-mode`, which tries to add the marketplace from another source, and Claude Code refuses: "Cannot add marketplace "codemode": its source doesn't match its extraKnownMarketplaces entry in user or managed settings". In the same config, `claude plugin install codemode@codemode` and `npm ci --omit=dev` in the install folder work.

### Scope

Included:
- `install.sh` reads `claude plugin marketplace list --json`. When a marketplace named exactly `codemode` is listed, it installs `codemode@codemode` from it, prints one line naming that marketplace and its source, and ignores `MARKETPLACE`. Otherwise the current path is unchanged.
- A non-JSON marketplace list ends with one plain line, as the plugin list already does.
- New cases in `scripts/install-check.sh`, each in a throwaway config.

Out:
- Updating or replacing the ref a registered marketplace pins. That ref is the owner's choice.
- Removing or re-adding the owner's marketplace.

### Decision

**Reuse the registered marketplace**, over failing with a message that tells the owner what to run. The registered entry is the owner's own pin, and installing from it is what the owner did by hand on 2026-10-12.

### Acceptance

- C1: with a throwaway config where `codemode` is already registered from another source, `install.sh` exits 0, installs `codemode@codemode` with its dependency, and names the reused marketplace. A second run also exits 0. Before the fix, this case fails on the marketplace add.
- C2: a non-JSON `claude plugin marketplace list --json` fails with one plain line, without a stack trace.
- C3: every earlier `install-check.sh` case still passes. With no `codemode` marketplace registered, the script still installs with `--marketplace "$MARKETPLACE"`.
- C4: `npm run typecheck`, `npm test`, `living-docs check docs` and `se-gates check` pass.

### Results

- The owner's exact message, from a mismatch with `extraKnownMarketplaces`, could not be reproduced in a throwaway config. The case registers `codemode` from a `git archive` copy with `claude plugin marketplace add`, and before the fix it failed with "Marketplace "codemode" is already added from a different source". That is the same defect, and the fix reads the marketplace list before any add, so it covers both messages.
- Empty output from `claude plugin marketplace list --json` counts as no marketplace registered, so the earlier stub case keeps passing unchanged. Only non-empty output that does not parse ends with the plain line.
- `sh scripts/install-check.sh`, run on 2026-10-13 with claude 2.1.292: 7 PASS, the five earlier cases and the two new ones.
