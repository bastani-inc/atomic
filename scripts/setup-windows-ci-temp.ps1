# Namespace's runner service can run as SYSTEM while TEMP points at runneradmin's
# profile. Its inherited runneradmin ACE is correctly refused by session storage.
# Give this job a fresh private temp parent; never relax the runtime ACL checks.
$ErrorActionPreference = 'Stop'

if (-not $env:RUNNER_TEMP -or -not $env:GITHUB_ENV) {
    throw 'RUNNER_TEMP and GITHUB_ENV are required'
}

# Keep fixtures outside the checkout: context and git discovery walk ancestors.
$tempDir = Join-Path $env:RUNNER_TEMP ('.ci-temp-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir -ErrorAction Stop | Out-Null

# Build a new protected DACL rather than retaining inherited or explicit grants.
# Use the process token, not USERNAME (which need not identify the runner service).
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($user.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new($sid),
        'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'
    )
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $tempDir -AclObject $acl

# Publish only after securing the directory. Descendant fixtures inherit this ACL.
foreach ($name in @('TEMP', 'TMP', 'TMPDIR')) {
    [Environment]::SetEnvironmentVariable($name, $tempDir, 'Process')
    "$name=$tempDir" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
}
