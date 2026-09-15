' Launches the M68 HE Controller with no console window at all.
' Usage:  wscript start-silent.vbs [--hidden]
Option Explicit

Dim fso, sh, env, base, exe, args, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
Set env = sh.Environment("Process")

' Clear ELECTRON_RUN_AS_NODE so electron.exe runs as a GUI app, not Node
env.Remove("ELECTRON_RUN_AS_NODE")

base = fso.GetParentFolderName(WScript.ScriptFullName)
exe  = base & "\node_modules\electron\dist\electron.exe"

args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next

If fso.FileExists(exe) Then
  ' 0 = hidden window, False = do not wait
  sh.Run """" & exe & """ """ & base & """" & args, 0, False
Else
  sh.Run "cmd /c npx electron """ & base & """" & args, 0, False
End If
