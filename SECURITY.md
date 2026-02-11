# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.7.x   | :white_check_mark: |
| < 0.7   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in Claude Terminal, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please send an email to: **contact@yanis-benyacine.fr**

Include:
- A description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 7 days
- **Fix release**: as soon as possible, depending on severity

## Scope

The following are in scope:
- Electron main process vulnerabilities
- Credential storage and handling (keytar, GitHub tokens)
- IPC message injection or privilege escalation
- Remote code execution via terminal or MCP servers
- Dependency vulnerabilities with exploitable impact

The following are out of scope:
- Issues requiring physical access to the machine
- Social engineering attacks
- Denial of service on the local application

## Acknowledgments

We appreciate responsible disclosure and will credit reporters in release notes (unless anonymity is requested).
