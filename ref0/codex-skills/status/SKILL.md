---
name: status
description: Shows whether ref0 follows this Codex session, and what to do next if it doesn’t. Use when the person runs $ref0:status or asks whether ref0 is working.
---

Run ref0’s check and show the person what it says.

1. This file is `<plugin>/codex-skills/status/SKILL.md`. Run this command, with `<plugin>` replaced by that folder’s absolute path:

   ```sh
   /bin/sh "<plugin>/bin/ref0" status
   ```

   Run it outside Codex’s sandbox, with `sandbox_permissions: "require_escalated"`, since in the sandbox it can’t ask Codex, this machine’s keychain or ref0. If that isn’t allowed, run it in the sandbox.
2. Show every line it prints as it is, and add nothing. It exits 1 when a line says no: that’s its answer, not an error to fix.
