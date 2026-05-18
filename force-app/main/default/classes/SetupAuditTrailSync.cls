public without sharing class SetupAuditTrailSync implements Schedulable {
    public static final String JOB_NAME = 'Setup Audit Trail Sync';
    public static final String HOURLY_CRON = '0 0 * * * ?';
    private static final Integer DEFAULT_LOOKBACK_HOURS = 26;
    private static final Integer MAX_TEXT_LENGTH = 255;
    private static final Integer MAX_DISPLAY_LENGTH = 32768;

    @TestVisible
    private static List<AuditEntry> testAuditEntries;

    public void execute(SchedulableContext context) {
        syncRecent(DEFAULT_LOOKBACK_HOURS);
    }

    public static String scheduleHourly() {
        abortExistingSchedule();
        return System.schedule(JOB_NAME, HOURLY_CRON, new SetupAuditTrailSync());
    }

    public static Integer syncRecent(Integer lookbackHours) {
        Integer safeLookbackHours = lookbackHours;
        if (safeLookbackHours == null || safeLookbackHours < 1) {
            safeLookbackHours = DEFAULT_LOOKBACK_HOURS;
        }

        return syncSince(System.now().addHours(-safeLookbackHours));
    }

    public static Integer syncSince(Datetime sinceWhen) {
        if (sinceWhen == null) {
            throw new SetupAuditTrailSyncException('A starting date is required.');
        }

        List<AuditEntry> entries = Test.isRunningTest() && testAuditEntries != null
            ? testAuditEntries
            : queryAuditEntries(sinceWhen);

        return saveEntries(entries);
    }

    private static List<AuditEntry> queryAuditEntries(Datetime sinceWhen) {
        List<AuditEntry> entries = new List<AuditEntry>();

        for (SetupAuditTrail auditRow : [
            SELECT Id,
                   Action,
                   CreatedById,
                   CreatedBy.Name,
                   CreatedBy.Email,
                   CreatedBy.Profile.Name,
                   CreatedDate,
                   DelegateUser,
                   Display,
                   ResponsibleNamespacePrefix,
                   Section
            FROM SetupAuditTrail
            WHERE CreatedDate >= :sinceWhen
            ORDER BY CreatedDate ASC
            LIMIT 10000
        ]) {
            entries.add(toAuditEntry(auditRow));
        }

        return entries;
    }

    @TestVisible
    private static AuditEntry toAuditEntry(SetupAuditTrail auditRow) {
        AuditEntry entry = new AuditEntry();
        entry.action = auditRow.Action;
        entry.auditTrailId = auditRow.Id;
        entry.auditCreatedDate = auditRow.CreatedDate;
        entry.createdByEmail = auditRow.CreatedBy == null ? null : auditRow.CreatedBy.Email;
        entry.createdById = auditRow.CreatedById;
        entry.createdByName = auditRow.CreatedBy == null ? null : auditRow.CreatedBy.Name;
        entry.createdByProfileName = auditRow.CreatedBy == null || auditRow.CreatedBy.Profile == null
            ? null
            : auditRow.CreatedBy.Profile.Name;
        entry.delegateUser = auditRow.DelegateUser;
        entry.display = auditRow.Display;
        entry.responsibleNamespacePrefix = auditRow.ResponsibleNamespacePrefix;
        entry.section = auditRow.Section;
        return entry;
    }

    @TestVisible
    private static Integer saveEntries(List<AuditEntry> entries) {
        if (entries == null || entries.isEmpty()) {
            return 0;
        }

        Set<String> seenAuditIds = new Set<String>();
        List<Setup_Change__c> recordsToSave = new List<Setup_Change__c>();

        for (AuditEntry entry : entries) {
            if (entry == null || String.isBlank(entry.auditTrailId) || seenAuditIds.contains(entry.auditTrailId)) {
                continue;
            }

            seenAuditIds.add(entry.auditTrailId);
            recordsToSave.add(toSetupChange(entry));
        }

        if (recordsToSave.isEmpty()) {
            return 0;
        }

        Database.UpsertResult[] results = Database.upsert(
            recordsToSave,
            Setup_Change__c.Fields.Audit_Trail_Id__c,
            false
        );

        Integer successCount = 0;
        List<String> errors = new List<String>();
        for (Integer index = 0; index < results.size(); index++) {
            Database.UpsertResult result = results[index];
            if (result.isSuccess()) {
                successCount++;
                continue;
            }

            for (Database.Error error : result.getErrors()) {
                errors.add(recordsToSave[index].Audit_Trail_Id__c + ': ' + error.getMessage());
            }
        }

        if (!errors.isEmpty()) {
            throw new SetupAuditTrailSyncException(
                'Failed to save setup change records: ' + String.join(errors, '; ')
            );
        }

        return successCount;
    }

    @TestVisible
    private static Setup_Change__c toSetupChange(AuditEntry entry) {
        return new Setup_Change__c(
            Audit_Trail_Id__c = truncate(entry.auditTrailId, 18),
            Action__c = truncate(entry.action, MAX_TEXT_LENGTH),
            Audit_Created_Date__c = entry.auditCreatedDate,
            Created_By_Email__c = truncate(entry.createdByEmail, MAX_TEXT_LENGTH),
            Created_By_Id__c = truncate(entry.createdById, 18),
            Created_By_Name__c = truncate(entry.createdByName, MAX_TEXT_LENGTH),
            Created_By_Profile_Name__c = truncate(entry.createdByProfileName, MAX_TEXT_LENGTH),
            Delegate_User__c = truncate(entry.delegateUser, MAX_TEXT_LENGTH),
            Display__c = truncate(entry.display, MAX_DISPLAY_LENGTH),
            Responsible_Namespace_Prefix__c = truncate(entry.responsibleNamespacePrefix, MAX_TEXT_LENGTH),
            Section__c = truncate(entry.section, MAX_TEXT_LENGTH)
        );
    }

    private static void abortExistingSchedule() {
        for (CronTrigger scheduledJob : [
            SELECT Id
            FROM CronTrigger
            WHERE CronJobDetail.Name = :JOB_NAME
        ]) {
            System.abortJob(scheduledJob.Id);
        }
    }

    private static String truncate(String value, Integer maxLength) {
        if (value == null || value.length() <= maxLength) {
            return value;
        }

        return value.substring(0, maxLength);
    }

    public class AuditEntry {
        public String action;
        public String auditTrailId;
        public Datetime auditCreatedDate;
        public String createdByEmail;
        public String createdById;
        public String createdByName;
        public String createdByProfileName;
        public String delegateUser;
        public String display;
        public String responsibleNamespacePrefix;
        public String section;
    }

    public class SetupAuditTrailSyncException extends Exception {
    }
}
