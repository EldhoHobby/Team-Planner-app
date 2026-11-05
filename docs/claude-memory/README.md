# Claude Code memory for this project

A copy of the notes Claude Code keeps between sessions for Team Planner (who you
are, how you like to work, project status, lessons learned). Claude reads them
automatically at the start of every session — but only from its own folder
under your user profile, not from here. Copy them there on a new PC.

`MEMORY.md` is the index; each other `.md` file is one note.

> This repository is **public**, so this copy leaves out staff names, customer
> names and internal paths (mainly in `sales-order-domain.md`). For the complete
> notes, also copy the original folder from the old PC by USB:
> `C:\Users\eldho\.claude\projects\C--Users-eldho-Claude-Projects-Team-Planner-app\memory\`

## Install on the new PC

1. Clone the repo to `C:\Users\<you>\Claude\Projects\Team Planner app` and open
   that folder in Claude Code once (this creates Claude's project folder).
2. In PowerShell, from the project folder:

```powershell
$mem = Join-Path $env:USERPROFILE ".claude\projects\$((Get-Location).Path -replace '[:\\ ]','-')\memory"; New-Item -ItemType Directory -Force $mem | Out-Null; Copy-Item docs\claude-memory\*.md $mem -Exclude README.md; Get-ChildItem $mem
```

   The folder name is the project path with `:`, `\` and spaces turned into `-`
   (e.g. `C--Users-eldho-Claude-Projects-Team-Planner-app`). If the list printed
   is empty, check `%USERPROFILE%\.claude\projects\` for the folder Claude
   created and copy the files there instead.
3. If you brought the full original notes by USB, copy those over the top
   afterwards (they replace the trimmed versions).
4. Start a new Claude session in the project — it will list these memories.

## Keeping this copy current

The live notes change as you work. Before switching machines again, ask Claude
to "refresh docs/claude-memory from your memory folder" and commit the result.
