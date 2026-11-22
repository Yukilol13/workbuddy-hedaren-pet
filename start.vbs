' hedaren-pet launcher (no console window, no cmd window left open)
' Double-click this file to start the pet. Nothing stays in the tray but the pet.
Option Explicit

Dim sh, fso, here, exe, app, cmdline, q
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here

exe = here & "\vendor\electron\electron.exe"
app = here & "\app"

If fso.FileExists(exe) Then
  ' Launch Electron directly: no node, no cmd, no console window at all.
  cmdline = Chr(34) & exe & Chr(34) & " --pet-edition=workbuddy " & Chr(34) & app & Chr(34)
  sh.Run cmdline, 0, False
Else
  ' Runtime missing: run the bootstrap visibly so the download progress can be seen.
  q = Chr(34)
  If fso.FileExists(here & "\bin\hedaren-node.cmd") Then
    cmdline = "cmd /c " & q & q & here & "\bin\hedaren-node.cmd" & q & " " & q & here & "\start.js" & q & q
  Else
    cmdline = "cmd /c node --no-warnings " & q & here & "\start.js" & q
  End If
  sh.Run cmdline, 1, False
End If
