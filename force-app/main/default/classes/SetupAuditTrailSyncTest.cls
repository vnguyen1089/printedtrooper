@IsTest
private class SetupAuditTrailSyncTest {
    @IsTest
    static void saveEntriesUpsertsByAuditTrailId() {
        SetupAuditTrailSync.AuditEntry entry = buildEntry('0Ym000000000001AAA', 'Created Custom Field');

        Test.startTest();
        Integer insertedCount = SetupAuditTrailSync.saveEntries(new List<SetupAuditTrailSync.AuditEntry>{ entry });

        entry.action = 'Updated Custom Field';
        Integer updatedCount = SetupAuditTrailSync.saveEntries(new List<SetupAuditTrailSync.AuditEntry>{ entry });
        Test.stopTest();

        List<Setup_Change__c> savedChanges = [
            SELECT Action__c,
                   Audit_Created_Date__c,
                   Audit_Trail_Id__c,
                   Created_By_Email__c,
                   Created_By_Id__c,
                   Created_By_Name__c,
                   Created_By_Profile_Name__c,
                   Delegate_User__c,
                   Display__c,
                   Responsible_Namespace_Prefix__c,
                   Section__c
            FROM Setup_Change__c
            WHERE Audit_Trail_Id__c = :entry.auditTrailId
        ];

        System.assertEquals(1, insertedCount, 'The first sync should insert one setup change.');
        System.assertEquals(1, updatedCount, 'The second sync should update the same setup change.');
        System.assertEquals(1, savedChanges.size(), 'The external id should prevent duplicate records.');
        System.assertEquals('Updated Custom Field', savedChanges[0].Action__c);
        System.assertEquals(entry.auditCreatedDate, savedChanges[0].Audit_Created_Date__c);
        System.assertEquals(entry.createdByEmail, savedChanges[0].Created_By_Email__c);
        System.assertEquals(entry.createdById, savedChanges[0].Created_By_Id__c);
        System.assertEquals(entry.createdByName, savedChanges[0].Created_By_Name__c);
        System.assertEquals(entry.createdByProfileName, savedChanges[0].Created_By_Profile_Name__c);
        System.assertEquals(entry.delegateUser, savedChanges[0].Delegate_User__c);
        System.assertEquals(entry.display, savedChanges[0].Display__c);
        System.assertEquals(entry.responsibleNamespacePrefix, savedChanges[0].Responsible_Namespace_Prefix__c);
        System.assertEquals(entry.section, savedChanges[0].Section__c);
    }

    @IsTest
    static void syncRecentUsesInjectedEntriesInTests() {
        SetupAuditTrailSync.AuditEntry entry = buildEntry('0Ym000000000002AAA', 'Changed Profile');
        SetupAuditTrailSync.testAuditEntries = new List<SetupAuditTrailSync.AuditEntry>{ entry };

        Test.startTest();
        Integer syncedCount = SetupAuditTrailSync.syncRecent(null);
        Test.stopTest();

        System.assertEquals(1, syncedCount);
        System.assertEquals(
            1,
            [SELECT COUNT() FROM Setup_Change__c WHERE Audit_Trail_Id__c = :entry.auditTrailId]
        );
    }

    @IsTest
    static void scheduleHourlyRegistersTheSchedulableJob() {
        SetupAuditTrailSync.testAuditEntries = new List<SetupAuditTrailSync.AuditEntry>();

        Test.startTest();
        String jobId = SetupAuditTrailSync.scheduleHourly();
        CronTrigger scheduledJob = [
            SELECT CronExpression,
                   CronJobDetail.Name
            FROM CronTrigger
            WHERE Id = :jobId
        ];
        Test.stopTest();

        System.assertEquals(SetupAuditTrailSync.HOURLY_CRON, scheduledJob.CronExpression);
        System.assertEquals(SetupAuditTrailSync.JOB_NAME, scheduledJob.CronJobDetail.Name);
    }

    @IsTest
    static void saveEntriesSkipsInvalidAndDuplicateAuditIds() {
        SetupAuditTrailSync.AuditEntry validEntry = buildEntry('0Ym000000000003AAA', repeat('A', 300));
        SetupAuditTrailSync.AuditEntry duplicateEntry = buildEntry(validEntry.auditTrailId, 'Duplicate');
        SetupAuditTrailSync.AuditEntry invalidEntry = buildEntry(null, 'Missing Id');

        Test.startTest();
        Integer syncedCount = SetupAuditTrailSync.saveEntries(
            new List<SetupAuditTrailSync.AuditEntry>{ validEntry, duplicateEntry, invalidEntry }
        );
        Test.stopTest();

        Setup_Change__c savedChange = [
            SELECT Action__c
            FROM Setup_Change__c
            WHERE Audit_Trail_Id__c = :validEntry.auditTrailId
            LIMIT 1
        ];

        System.assertEquals(1, syncedCount);
        System.assertEquals(255, savedChange.Action__c.length(), 'Text fields should be truncated safely.');
    }

    @IsTest
    static void toAuditEntryMapsSetupAuditTrailFields() {
        SetupAuditTrail auditRow = (SetupAuditTrail) JSON.deserialize(
            '{' +
                '"attributes":{"type":"SetupAuditTrail"},' +
                '"Id":"0Ym000000000004AAA",' +
                '"Action":"Updated Apex Class",' +
                '"CreatedById":"005000000000001AAA",' +
                '"CreatedDate":"2026-05-16T19:00:00.000+0000",' +
                '"CreatedBy":{' +
                    '"attributes":{"type":"User"},' +
                    '"Name":"Admin User",' +
                    '"Email":"admin@example.com",' +
                    '"Profile":{"attributes":{"type":"Profile"},"Name":"System Administrator"}' +
                '},' +
                '"DelegateUser":"Delegated User",' +
                '"Display":"Updated class SetupAuditTrailSync",' +
                '"ResponsibleNamespacePrefix":"pkg",' +
                '"Section":"Apex Classes"' +
            '}',
            SetupAuditTrail.class
        );

        SetupAuditTrailSync.AuditEntry entry = SetupAuditTrailSync.toAuditEntry(auditRow);

        System.assertEquals('0Ym000000000004AAA', entry.auditTrailId);
        System.assertEquals('Updated Apex Class', entry.action);
        System.assertEquals('005000000000001AAA', entry.createdById);
        System.assertEquals('Admin User', entry.createdByName);
        System.assertEquals('admin@example.com', entry.createdByEmail);
        System.assertEquals('System Administrator', entry.createdByProfileName);
        System.assertEquals('Delegated User', entry.delegateUser);
        System.assertEquals('Updated class SetupAuditTrailSync', entry.display);
        System.assertEquals('pkg', entry.responsibleNamespacePrefix);
        System.assertEquals('Apex Classes', entry.section);
    }

    @IsTest
    static void syncSinceRequiresStartDate() {
        try {
            SetupAuditTrailSync.syncSince(null);
            System.assert(false, 'syncSince should require a starting date.');
        } catch (SetupAuditTrailSync.SetupAuditTrailSyncException error) {
            System.assertEquals('A starting date is required.', error.getMessage());
        }
    }

    private static SetupAuditTrailSync.AuditEntry buildEntry(String auditTrailId, String action) {
        SetupAuditTrailSync.AuditEntry entry = new SetupAuditTrailSync.AuditEntry();
        entry.action = action;
        entry.auditTrailId = auditTrailId;
        entry.auditCreatedDate = Datetime.newInstance(2026, 5, 16, 19, 0, 0);
        entry.createdByEmail = 'admin@example.com';
        entry.createdById = '005000000000001AAA';
        entry.createdByName = 'Admin User';
        entry.createdByProfileName = 'System Administrator';
        entry.delegateUser = 'Delegated User';
        entry.display = 'Created field Account.Sample__c';
        entry.responsibleNamespacePrefix = 'pkg';
        entry.section = 'Custom Fields';
        return entry;
    }

    private static String repeat(String value, Integer times) {
        String result = '';
        for (Integer index = 0; index < times; index++) {
            result += value;
        }
        return result;
    }
}
