@echo off
rem Starts the controller with no console window (see start-silent.vbs)
set ELECTRON_RUN_AS_NODE=
start "" wscript.exe "%~dp0start-silent.vbs" %*
