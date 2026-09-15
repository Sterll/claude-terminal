# Reliability and data protection

Cloud agent execution requires one user per instance and dedicated volumes. Set
`CLOUD_ENABLED=false` for a multi-user relay/sync without agent execution. Imports
are staged, existing destinations are preserved, and concurrent metadata writes
share a lock. Failed sync writes remain queued. Database passwords are resolved
from the OS keychain; MCP synchronization preserves local secret values.
