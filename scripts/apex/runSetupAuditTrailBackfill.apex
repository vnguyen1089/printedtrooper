// Optional one-time backfill. Adjust the lookback window before running if needed.
Integer syncedCount = SetupAuditTrailSync.syncRecent(168);
System.debug('Synced setup audit trail rows: ' + syncedCount);
