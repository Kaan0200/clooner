<#
.SYNOPSIS
  Runs a command at normal (medium) integrity even from an elevated shell.

.DESCRIPTION
  Windows refuses drag and drop from Explorer into a window owned by an
  elevated process, so an app started from an "Run as administrator"
  terminal can't accept dropped files. This script starts the command with
  a copy of Explorer's own token, which is the signed-in user's ordinary,
  unelevated token. The child keeps this console, the working directory and
  the environment, and its exit code is passed back.

  When the shell isn't elevated the command simply runs in place.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/unelevated.ps1 pnpm tauri dev
#>
param(
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
  [string[]] $Command
)

$ErrorActionPreference = 'Stop'

function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal] $identity
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-InPlace([string[]] $cmd) {
  $rest = @($cmd | Select-Object -Skip 1)
  & $cmd[0] @rest
  exit $LASTEXITCODE
}

if (-not (Test-Elevated)) { Invoke-InPlace $Command }

# Explorer in this desktop session holds the unelevated token we want.
$session = (Get-Process -Id $PID).SessionId
$explorer = Get-Process explorer -ErrorAction SilentlyContinue |
  Where-Object { $_.SessionId -eq $session } |
  Select-Object -First 1
if (-not $explorer) {
  Write-Warning 'Explorer is not running, so the command stays elevated. Drag and drop from Explorer will not work.'
  Invoke-InPlace $Command
}

Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Runtime.InteropServices;
using System.Text;

public static class UnelevatedLauncher {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  const uint PROCESS_QUERY_INFORMATION = 0x0400;
  const uint TOKEN_DUPLICATE = 0x0002, TOKEN_QUERY = 0x0008;
  const uint MAXIMUM_ALLOWED = 0x02000000;
  const int SecurityImpersonation = 2, TokenPrimary = 1;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
  const uint INFINITE = 0xFFFFFFFF;

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessWithTokenW(IntPtr token, uint logonFlags, string application, string commandLine, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

  static Exception Fail(string what) {
    return new Exception(what + " failed (Win32 error " + Marshal.GetLastWin32Error() + ")");
  }

  // A Unicode environment block: "A=1\0B=2\0\0".
  static IntPtr EnvironmentBlock() {
    var sb = new StringBuilder();
    var vars = Environment.GetEnvironmentVariables();
    var keys = new ArrayList(vars.Keys);
    keys.Sort(StringComparer.OrdinalIgnoreCase);
    foreach (string key in keys) sb.Append(key).Append('=').Append(vars[key]).Append('\0');
    sb.Append('\0');
    return Marshal.StringToHGlobalUni(sb.ToString());
  }

  /// Runs commandLine with a copy of the given process's primary token and returns its exit code.
  public static int RunAs(int tokenSourcePid, string commandLine, string currentDirectory) {
    IntPtr process = OpenProcess(PROCESS_QUERY_INFORMATION, false, tokenSourcePid);
    if (process == IntPtr.Zero) throw Fail("OpenProcess");
    IntPtr token;
    if (!OpenProcessToken(process, TOKEN_DUPLICATE | TOKEN_QUERY, out token)) throw Fail("OpenProcessToken");
    IntPtr primary;
    if (!DuplicateTokenEx(token, MAXIMUM_ALLOWED, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out primary)) throw Fail("DuplicateTokenEx");

    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(si);
    PROCESS_INFORMATION pi;
    IntPtr env = EnvironmentBlock();
    try {
      if (!CreateProcessWithTokenW(primary, 0, null, commandLine, CREATE_UNICODE_ENVIRONMENT, env, currentDirectory, ref si, out pi)) throw Fail("CreateProcessWithTokenW");
    } finally {
      Marshal.FreeHGlobal(env);
      CloseHandle(primary);
      CloseHandle(token);
      CloseHandle(process);
    }

    WaitForSingleObject(pi.hProcess, INFINITE);
    uint code;
    GetExitCodeProcess(pi.hProcess, out code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return (int)code;
  }
}
'@

# Quote each argument the way CommandLineToArgvW expects, then hand the
# whole line to cmd.exe so .cmd shims such as pnpm.cmd resolve as usual.
function ConvertTo-ArgString([string[]] $items) {
  ($items | ForEach-Object {
    if ($_ -match '[\s"]') { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' } else { $_ }
  }) -join ' '
}

$line = 'cmd.exe /d /s /c "' + (ConvertTo-ArgString $Command) + '"'
Write-Host "Starting without elevation: $(ConvertTo-ArgString $Command)" -ForegroundColor DarkGray

# Ctrl+C reaches the child through the shared console; the parent just waits.
[Console]::TreatControlCAsInput = $false
$code = [UnelevatedLauncher]::RunAs($explorer.Id, $line, (Get-Location).Path)
exit $code
