# Changelog

## 0.1.4 - 2026-08-22

### Added

- WinRM/PowerShell Remoting host management: host config store, PowerShell exec, streaming console sessions, service and process management, base64-chunked file transfer, cluster execution.
- Seven agent tools: winrm_list, winrm_exec, winrm_service, winrm_process, winrm_upload, winrm_download, winrm_cluster.
- Web sidebar panel with host/console/service/process/transfer tabs.
- UTF-8 base64 command envelope so Chinese output survives WinRM code page handling.
- One-shot target preparation script (scripts/enable-winrm.ps1).

### Security

- Credentials are stored in ~/.dsh/dsh-winrm.json with mode 0600 and passed to pywinrm via stdin, never in process arguments.
- Cluster execution filters targets by aliases, environment, and tags.
