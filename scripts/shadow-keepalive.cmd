@echo off
REM shadow-keepalive.cmd — Task Scheduler's entry point for the C4 shadow loop.
REM
REM It simply runs the loop. The loop's own single-instance lock is the guard: if an instance is
REM already alive, this one exits immediately with code 3 and nothing is duplicated. That keeps the
REM wrapper trivial — there is no pid bookkeeping here to get wrong, and no second mechanism that
REM could disagree with the lock.
REM
REM Every start and exit is appended to logs\shadow-keepalive.log, so "the keepalive is running" and
REM "the loop is running" stay distinguishable: a wrapper that starts successfully and a loop that
REM dies immediately would otherwise look the same from Task Scheduler's side.

setlocal
set NODE="C:\Program Files\nodejs\node.exe"
set V2=D:\code\orca-supervisor
set LOG=%V2%\logs\shadow-keepalive.log

echo [%DATE% %TIME%] keepalive tick >> "%LOG%"
%NODE% "%V2%\src\shadow.js" >> "%LOG%" 2>&1
echo [%DATE% %TIME%] keepalive exit code=%ERRORLEVEL% >> "%LOG%"

endlocal
