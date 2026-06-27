@echo off
REM Aficax wrapper for Windows. Resolves bun on PATH and launches
REM the bundled CLI; yoga.wasm is loaded from the same directory as
REM the bundle (set up by scripts/copy-yoga.ts).
setlocal
set "AFICAX_HOME=%~dp0"
bun "%AFICAX_HOME%packages\cli\dist\index.js" %*
endlocal
