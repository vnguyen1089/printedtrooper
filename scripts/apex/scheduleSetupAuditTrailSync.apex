// Run after deployment with:
// sf apex run --file scripts/apex/scheduleSetupAuditTrailSync.apex --target-org <alias>
//
// The scheduled user should be able to view setup and configuration so the
// SetupAuditTrail query can read audit rows.
String jobId = SetupAuditTrailSync.scheduleHourly();
System.debug('Scheduled Setup Audit Trail Sync job: ' + jobId);
