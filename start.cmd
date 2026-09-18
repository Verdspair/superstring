@echo off

rem  superstring one-click launcher (project root)

rem
rem WHAT THIS STARTS (all of it is ONE Bun process)
rem   1. frontend build      : vite output into dist/web, unless --no-build
rem   2. backend API         : Hono routes on http://127.0.0.1:17861
rem   3. static page hosting : the same Bun server serves dist/web
rem   4. business database   : SQLite file, auto-created and schema-gated
rem
rem WHAT THIS DOES NOT DO (approved boundary, do not add back)
rem   * no process-tree supervisor, no Windows Job Object, no browser-idle
rem     reaper: the single Bun server shuts down on Ctrl+C and that is all.
rem   * the external LM Studio model service is only PROBED, never started and
rem     never loaded. Stopping or loading models is the user's action.
rem
rem USAGE
rem   start.cmd                 build if needed, preflight, serve, open browser
rem   start.cmd --check         preflight only, no build, no server, no browser
rem   start.cmd --no-build      reuse the existing dist/web
rem   start.cmd --no-open       serve without opening the browser
rem   start.cmd --port 17862    bind another port, also SUPERSTRING_DEV_PORT
rem   start.cmd --db PATH       another business DB, also SUPERSTRING_DB_PATH
rem   start.cmd --help
rem
rem EXIT CODES: 0 server ran and exited normally, 1 preflight or build failed,
rem 2 bad usage.
rem
rem Bun resolution order: SUPERSTRING_BUN_EXE (must exist), then the repo-local
rem node_modules\bun\bin\bun.exe, then bun on PATH. An occupied port is refused;
rem this script never kills whatever occupies it.
rem
rem Everything (helper, server, browser opener) runs with cwd = project root so
rem that dist\web, data\ and artifacts\state\ resolve to this project only.
rem
rem NOTE: this file must stay pure ASCII and must not use the pipe, redirect or
rem ampersand characters inside remarks. cmd splits a command line before it
rem evaluates "rem", so those characters inside a remark are still executed.
rem Likewise, never put a bare parenthesis inside an echo that sits in a
rem parenthesized if/else block: the ")" closes the block early and cmd fails
rem with "was unexpected at this time".

setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "HELPER=%ROOT%\tools\ops\start.ts"
set "OPENER=%ROOT%\tools\ops\open-when-ready.ts"
set "SERVER_ENTRY=%ROOT%\src\server\index.ts"

rem Bun resolution (an explicit path is validated; bad value fails loudly)
set "BUN_EXE="
if defined SUPERSTRING_BUN_EXE (
  if exist "%SUPERSTRING_BUN_EXE%" (
    set "BUN_EXE=%SUPERSTRING_BUN_EXE%"
  ) else (
    echo [start] ERROR: SUPERSTRING_BUN_EXE is set but not found: %SUPERSTRING_BUN_EXE%
    exit /b 2
  )
)
if not defined BUN_EXE (
  if exist "%ROOT%\node_modules\bun\bin\bun.exe" set "BUN_EXE=%ROOT%\node_modules\bun\bin\bun.exe"
)
if not defined BUN_EXE (
  where bun >nul 2>nul
  if not errorlevel 1 set "BUN_EXE=bun"
)
if not defined BUN_EXE (
  echo [start] ERROR: bun not found. Set SUPERSTRING_BUN_EXE or install bun under
  echo [start]        %ROOT%\node_modules\bun\bin\bun.exe
  exit /b 2
)

if not exist "%HELPER%" (
  echo [start] ERROR: launcher helper missing: %HELPER%
  exit /b 2
)
if not exist "%SERVER_ENTRY%" (
  echo [start] ERROR: server entry missing: %SERVER_ENTRY%
  exit /b 2
)

rem Strict argument parsing
set "MODE_CHECK=0"
set "NO_BUILD=0"
set "OPEN=1"
set "PORT="
set "DB_PATH="
set "BADARG="

:parse_args
if "%~1"=="" goto :end_parse
if /i "%~1"=="--check" ( set "MODE_CHECK=1" & shift & goto :parse_args )
if /i "%~1"=="--no-build" ( set "NO_BUILD=1" & shift & goto :parse_args )
if /i "%~1"=="--open" ( set "OPEN=1" & shift & goto :parse_args )
if /i "%~1"=="--no-open" ( set "OPEN=0" & shift & goto :parse_args )
if /i "%~1"=="--help" ( goto :show_help )
if /i "%~1"=="-h" ( goto :show_help )
if /i "%~1"=="--port" (
  set "PORT=%~2"
  if "!PORT!"=="" set "BADARG=port"
  shift & shift & goto :parse_args
)
if /i "%~1"=="--db" (
  set "DB_PATH=%~2"
  if "!DB_PATH!"=="" set "BADARG=db"
  shift & shift & goto :parse_args
)
echo [start] ERROR: unknown argument: %~1
echo [start]        Run "%~nx0 --help" for supported options.
exit /b 2
:end_parse

rem Validate on standalone lines: a bare "exit /b" inside a parenthesized
rem block loses its exit code in cmd, and an empty "--port"/"--db" value
rem un-defines the variable, so both are guarded here instead. ----
if defined BADARG (
  echo [start] ERROR: --%BADARG% requires a value.
  exit /b 2
)
if defined PORT (
  if "!PORT:~0,2!"=="--" ( echo [start] ERROR: --port requires a numeric value. & exit /b 2 )
)
if defined DB_PATH (
  if "!DB_PATH:~0,2!"=="--" ( echo [start] ERROR: --db requires a path value. & exit /b 2 )
)

rem Environment, then cd, BEFORE anything runs: the helper, the server and
rem the browser opener must all resolve paths from the project root, and the
rem port the helper probes must be the port the server binds. ----
set "SUPERSTRING_SERVE_WEB=1"
if defined PORT set "SUPERSTRING_DEV_PORT=%PORT%"
if defined DB_PATH set "SUPERSTRING_DB_PATH=%DB_PATH%"
set "DISPLAY_PORT=%SUPERSTRING_DEV_PORT%"
if not defined DISPLAY_PORT set "DISPLAY_PORT=17861"

cd /d "%ROOT%"

if "%MODE_CHECK%"=="1" goto :run_check
goto :run_prepare

rem Preflight only
:run_check
"%BUN_EXE%" "%HELPER%" --check
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [start] preflight FAILED. exit code %RC%.
  exit /b %RC%
)
echo [start] preflight passed. Nothing was built, started or opened.
exit /b 0

rem Preflight + build, then serve
:run_prepare
if "%NO_BUILD%"=="1" (
  "%BUN_EXE%" "%HELPER%" --no-build
) else (
  "%BUN_EXE%" "%HELPER%"
)
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [start] prepare failed with exit %RC%. The server was NOT started.
  exit /b %RC%
)

if "%OPEN%"=="1" goto :spawn_opener
goto :serve

rem The opener is a short-lived helper: it polls /health, opens the page and
rem exits by itself. It is NOT a supervisor and never outlives the wait window.
:spawn_opener
start "" /b "%BUN_EXE%" "%OPENER%" --port %DISPLAY_PORT% --timeout 30000

:serve
echo.
echo [start] superstring is serving at http://127.0.0.1:%DISPLAY_PORT%/
echo [start] Press Ctrl+C in this window to stop it.
echo.
"%BUN_EXE%" run "%SERVER_ENTRY%"
set "RC=%ERRORLEVEL%"
exit /b %RC%

rem Help
:show_help
echo superstring one-click launcher
echo.
echo Usage: start.cmd [--check] [--no-build] [--no-open] [--open]
echo                  [--port ^<n^>] [--db ^<path^>] [--help]
echo.
echo   (no option)  Build the frontend, preflight, serve, then open the browser.
echo   --check      Preflight only: no build, no server, no browser.
echo   --no-build   Skip the frontend build; dist/web must already exist.
echo   --open       Open the browser once /health is ready (this is the default).
echo   --no-open    Serve without opening a browser.
echo   --port ^<n^>   Bind port (default 17861; also SUPERSTRING_DEV_PORT).
echo   --db ^<path^>  Business DB (also SUPERSTRING_DB_PATH). Existing data is kept.
echo   --help       Show this help.
echo.
echo The backend, the API and the web page are ONE Bun process on one port.
echo LM Studio is only probed; this script never starts or loads a model.
echo.
echo Resolved bun: %BUN_EXE%
exit /b 0
